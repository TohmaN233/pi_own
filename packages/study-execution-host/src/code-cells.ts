import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentHash, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import {
	type RunManifest,
	requiredHash,
	requiredRevision,
	requiredText,
	type Scope,
	StudyResearchError,
	type StudyResearchHost,
} from "../../study-research-host/src/index.ts";

export interface StudyCellInput {
	name: string;
	sourceId: string;
	sourceHash: string;
}

export interface StudyCellDraft {
	title: string;
	purpose: string;
	language: "python" | "r";
	code: string;
	parameters: Record<string, unknown>;
	inputs: StudyCellInput[];
}

export interface StudyCodeCell extends StudyCellDraft {
	cellId: string;
	projectId: string;
	revision: number;
	codeHash: string;
	parameterHash: string;
	contentHash: string;
	createdAt: string;
	updatedAt: string;
}

export interface StudyCellRunSnapshot {
	taskId: string;
	cell: StudyCodeCell;
	manifest: RunManifest;
	createdAt: string;
	contentHash: string;
}

interface PayloadRow {
	payload: string;
	payloadHash: string;
}

function assertCellJson(value: unknown, depth = 0): void {
	if (depth > 24) throw new StudyResearchError("INVALID_CELL_PARAMETERS", "Parameters exceed the nesting limit");
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return;
	if (Array.isArray(value)) {
		for (const item of value) assertCellJson(item, depth + 1);
		return;
	}
	if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		for (const key of Reflect.ownKeys(value)) {
			const property = Object.getOwnPropertyDescriptor(value, key);
			if (typeof key !== "string" || !property || !("value" in property) || !property.enumerable)
				throw new StudyResearchError("INVALID_CELL_PARAMETERS", "Parameters require plain JSON properties");
			assertCellJson(property.value, depth + 1);
		}
		return;
	}
	throw new StudyResearchError("INVALID_CELL_PARAMETERS", "Parameters require finite plain JSON values");
}

/** Immutable code revisions in the Harness database. Editing never changes a reserved run. */
export class StudyCodeCells {
	private readonly database: DatabaseSync;
	private readonly host: StudyResearchHost;
	private transactionSequence = 0;

	constructor(database: DatabaseSync, host: StudyResearchHost) {
		this.database = database;
		this.host = host;
		database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_code_cell (
				cell_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
				payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
				PRIMARY KEY(cell_id, revision)
			);
			CREATE INDEX IF NOT EXISTS pi_study_code_cell_project ON pi_study_code_cell(project_id, cell_id, revision);
			CREATE TABLE IF NOT EXISTS pi_study_cell_run (
				task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
				payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
		`);
	}

	list(scope: Scope): StudyCodeCell[] {
		this.host.projectRevision(scope);
		const rows = this.database
			.prepare(`SELECT c.payload, c.payload_hash AS payloadHash FROM pi_study_code_cell c
			WHERE c.project_id = ? AND c.revision = (SELECT MAX(v.revision) FROM pi_study_code_cell v WHERE v.cell_id = c.cell_id AND v.project_id = c.project_id)
			ORDER BY c.rowid`)
			.all(scope.projectId) as unknown as PayloadRow[];
		return rows.map((row) => this.decode<StudyCodeCell>(row));
	}

	get(scope: Scope, cellId: string, revision?: number): StudyCodeCell {
		this.host.projectRevision(scope);
		if (revision !== undefined) requiredRevision(revision, "cell revision");
		const row = this.database
			.prepare(`SELECT payload, payload_hash AS payloadHash FROM pi_study_code_cell
			WHERE project_id = ? AND cell_id = ? ${revision === undefined ? "" : "AND revision = ?"} ORDER BY revision DESC LIMIT 1`)
			.get(scope.projectId, cellId, ...(revision === undefined ? [] : [revision])) as PayloadRow | undefined;
		if (!row) throw new StudyResearchError("CELL_NOT_FOUND", "Code cell or version was not found in this project");
		return this.decode<StudyCodeCell>(row);
	}

	save(scope: Scope, input: { draft: StudyCellDraft; cellId?: string; expectedCellRevision?: number }): StudyCodeCell {
		return this.transaction(() => {
			this.host.projectRevision(scope);
			this.validateDraft(scope, input.draft);
			const previous = input.cellId ? this.get(scope, input.cellId) : null;
			if (previous ? previous.revision !== input.expectedCellRevision : input.expectedCellRevision !== undefined) {
				throw new StudyResearchError(
					"CELL_CONFLICT",
					"Code cell changed; preserve the editor draft and reload the saved version",
				);
			}
			const now = new Date().toISOString();
			const value = {
				title: input.draft.title,
				purpose: input.draft.purpose,
				language: input.draft.language,
				code: input.draft.code,
				parameters: structuredClone(input.draft.parameters),
				inputs: input.draft.inputs.map(({ name, sourceId, sourceHash }) => ({ name, sourceId, sourceHash })),
				cellId: previous?.cellId ?? `cell-${randomUUID()}`,
				projectId: scope.projectId,
				revision: (previous?.revision ?? 0) + 1,
				codeHash: `sha256:${sha256Hex(input.draft.code)}`,
				parameterHash: contentHash(input.draft.parameters),
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
			};
			const cell: StudyCodeCell = { ...value, contentHash: contentHash(value) };
			this.database
				.prepare(
					"INSERT INTO pi_study_code_cell(cell_id, project_id, revision, payload, payload_hash) VALUES (?, ?, ?, ?, ?)",
				)
				.run(cell.cellId, cell.projectId, cell.revision, stableStringify(cell), contentHash(cell));
			return cell;
		});
	}

	/** A trusted coordinator calls this inside the same transaction as queue admission. */
	bindRunFromTrustedAdmission(
		scope: Scope,
		input: { cellId: string; expectedCellRevision: number; taskId: string },
	): StudyCellRunSnapshot {
		return this.transaction(() => {
			const cell = this.get(scope, input.cellId, input.expectedCellRevision);
			const task = this.host.listTasks(scope).find((entry) => entry.taskId === input.taskId);
			if (
				!task ||
				task.kind !== "execution" ||
				!task.producerContextId ||
				task.authorization.sessionId !== scope.sessionId
			) {
				throw new StudyResearchError(
					"CELL_RUN_TASK_MISMATCH",
					"Code execution must use this session's reserved Host task and trusted producer",
				);
			}
			const expected = this.manifest(cell, task.manifest.environmentHash);
			if (
				task.authorization.kind === "learning" &&
				(task.authorization.admission.language !== cell.language ||
					task.authorization.admission.purpose !== cell.purpose)
			)
				throw new StudyResearchError(
					"CELL_RUN_ADMISSION_MISMATCH",
					"Learning admission language and purpose must match the selected code cell",
				);
			if (contentHash(task.manifest) !== contentHash(expected))
				throw new StudyResearchError(
					"CELL_RUN_MANIFEST_MISMATCH",
					"Reserved run does not match the selected code, parameters and inputs",
				);
			const existing = this.database
				.prepare("SELECT payload, payload_hash AS payloadHash FROM pi_study_cell_run WHERE task_id = ?")
				.get(task.taskId) as PayloadRow | undefined;
			if (existing) {
				const saved = this.decode<StudyCellRunSnapshot>(existing);
				if (saved.cell.contentHash !== cell.contentHash)
					throw new StudyResearchError("CELL_RUN_CONFLICT", "Task already belongs to another code revision");
				return saved;
			}
			this.validateDraft(scope, cell);
			if (task.status !== "queued" && task.status !== "admitted")
				throw new StudyResearchError("CELL_RUN_ALREADY_STARTED", "Bind immutable code before the launch boundary");
			const value = { taskId: task.taskId, cell, manifest: task.manifest, createdAt: new Date().toISOString() };
			const saved: StudyCellRunSnapshot = { ...value, contentHash: contentHash(value) };
			this.database
				.prepare("INSERT INTO pi_study_cell_run(task_id, project_id, payload, payload_hash) VALUES (?, ?, ?, ?)")
				.run(saved.taskId, scope.projectId, stableStringify(saved), contentHash(saved));
			return saved;
		});
	}

	readRun(scope: Scope, taskId: string): StudyCellRunSnapshot {
		this.host.projectRevision(scope);
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_cell_run WHERE project_id = ? AND task_id = ?",
			)
			.get(scope.projectId, taskId) as PayloadRow | undefined;
		if (!row) throw new StudyResearchError("CELL_RUN_NOT_FOUND", "Run snapshot was not found in this project");
		return this.decode<StudyCellRunSnapshot>(row);
	}

	manifest(cell: StudyCodeCell, environmentHash: string): RunManifest {
		requiredHash(environmentHash, "environment hash");
		return {
			codeHash: cell.codeHash,
			parameterHash: cell.parameterHash,
			inputHashes: Object.fromEntries(cell.inputs.map((input) => [input.name, input.sourceHash])),
			environmentHash,
		};
	}

	private validateDraft(scope: Scope, draft: StudyCellDraft): void {
		requiredText(draft.title, "cell title", 1000);
		requiredText(draft.purpose, "cell purpose", 6000);
		requiredText(draft.code, "cell code", 131072);
		if (draft.language !== "python" && draft.language !== "r")
			throw new StudyResearchError("INVALID_CELL_LANGUAGE", "Only R and Python code cells are supported");
		if (!draft.parameters || typeof draft.parameters !== "object" || Array.isArray(draft.parameters))
			throw new StudyResearchError("INVALID_CELL_PARAMETERS", "Parameters must be a JSON object");
		assertCellJson(draft.parameters);
		const parameterText = JSON.stringify(draft.parameters);
		if (
			Buffer.byteLength(parameterText) > 65536 ||
			stableStringify(JSON.parse(parameterText)) !== stableStringify(draft.parameters)
		)
			throw new StudyResearchError("INVALID_CELL_PARAMETERS", "Parameters must be bounded finite JSON values");
		if (!Array.isArray(draft.inputs) || draft.inputs.length > 64)
			throw new StudyResearchError("INVALID_CELL_INPUTS", "At most 64 registered inputs may be bound");
		const names = new Set<string>();
		const sources = this.host.listSources(scope).filter((source) => source.current);
		for (const input of draft.inputs) {
			if (
				!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.name) ||
				input.name.endsWith(".") ||
				/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.name) ||
				names.has(input.name.toLowerCase())
			) {
				throw new StudyResearchError(
					"INVALID_CELL_INPUT_NAME",
					"Input names must be unique portable filenames without path components",
				);
			}
			names.add(input.name.toLowerCase());
			if (!sources.some((source) => source.sourceId === input.sourceId && source.contentHash === input.sourceHash))
				throw new StudyResearchError(
					"CELL_INPUT_STALE",
					"Code cell input is not a current registered source version",
				);
		}
	}

	private decode<T extends { contentHash: string }>(row: PayloadRow): T {
		const parsed = JSON.parse(row.payload) as T;
		const { contentHash: identity, ...body } = parsed;
		if (contentHash(parsed) !== row.payloadHash || contentHash(body) !== identity)
			throw new StudyResearchError("CELL_CORRUPT_STATE", "Code cell storage integrity check failed");
		return parsed;
	}

	private transaction<T>(work: () => T): T {
		const savepoint = `study_cells_${++this.transactionSequence}`;
		this.database.exec(`SAVEPOINT ${savepoint}`);
		try {
			const result = work();
			this.database.exec(`RELEASE ${savepoint}`);
			return result;
		} catch (error) {
			this.database.exec(`ROLLBACK TO ${savepoint}`);
			this.database.exec(`RELEASE ${savepoint}`);
			throw error;
		}
	}
}
