import { DatabaseSync } from "node:sqlite";
import {
	modePackHash,
	parseModePackDefinition,
	type ModePackDefinition,
	ModePackError,
} from "../../profile-resource-host/src/mode-packs.ts";

const STORE_VERSION = 1;
const WORKFLOW_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;

export interface StoredModeWorkflow {
	version: 1;
	workflowId: string;
	kind: string;
	sessionId: string;
	courseVersionId: string | null;
	modePackId: string;
	modePackRevision: number;
	modePackContentHash: string;
	state: string;
	status: "active" | "waiting-for-learner" | "completed" | "blocked";
	revision: number;
	learnerTurnIds: string[];
	payload: Record<string, unknown>;
	updatedAt: string;
}

export interface ModePackRegistryOptions {
	databasePath: string;
}

export class ModePackRegistry {
	private readonly database: DatabaseSync;
	private poisoned: Error | null = null;

	constructor(options: ModePackRegistryOptions) {
		if (!options.databasePath) throw new ModePackError("DATABASE_PATH_REQUIRED", "databasePath is required");
		this.database = new DatabaseSync(options.databasePath);
		try {
			this.database.exec("PRAGMA foreign_keys = ON");
			this.database.exec("PRAGMA journal_mode = WAL");
			this.database.exec("PRAGMA synchronous = FULL");
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS mode_pack_meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS mode_pack_version (
					id TEXT NOT NULL,
					revision INTEGER NOT NULL,
					content_hash TEXT NOT NULL,
					payload_json TEXT NOT NULL,
					retired INTEGER NOT NULL DEFAULT 0,
					created_at TEXT NOT NULL,
					PRIMARY KEY (id, revision),
					UNIQUE (id, content_hash)
				);
				CREATE TABLE IF NOT EXISTS mode_workflow_state (
					workflow_id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					course_version_id TEXT,
					mode_pack_id TEXT NOT NULL,
					mode_pack_revision INTEGER NOT NULL,
					mode_pack_content_hash TEXT NOT NULL,
					revision INTEGER NOT NULL,
					payload_json TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
			`);
			const version = this.database.prepare("SELECT value FROM mode_pack_meta WHERE key='store-version'").get() as
				| { value: string }
				| undefined;
			if (!version) {
				this.database.prepare("INSERT INTO mode_pack_meta (key, value) VALUES ('store-version', ?)").run(String(STORE_VERSION));
			} else if (version.value !== String(STORE_VERSION)) {
				throw new ModePackError("UNSUPPORTED_STORE_VERSION", version.value);
			}
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	close(): void {
		this.database.close();
	}

	private assertHealthy(): void {
		if (this.poisoned) throw new ModePackError("REGISTRY_REOPEN_REQUIRED", this.poisoned.message);
	}

	private writeTransaction<T>(operation: () => T): T {
		this.assertHealthy();
		try {
			this.database.exec("BEGIN IMMEDIATE");
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the original failure.
			}
			this.poisoned = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}

	publishCustom(value: unknown): ModePackDefinition {
		const parsed = parseModePackDefinition(value);
		if (parsed.provenance.source !== "user") {
			throw new ModePackError("CUSTOM_SOURCE_REQUIRED", parsed.id);
		}
		const latest = this.latest(parsed.id, true);
		const expectedRevision = latest ? latest.revision + 1 : 1;
		if (parsed.revision !== expectedRevision) {
			throw new ModePackError("REVISION_CONFLICT", `${parsed.id}: expected ${expectedRevision}`);
		}
		if (latest) {
			const expectedParentHash = modePackHash(latest);
			if (parsed.provenance.parentContentHash !== expectedParentHash) {
				throw new ModePackError("PARENT_HASH_MISMATCH", parsed.id);
			}
		} else if (parsed.provenance.parentContentHash !== undefined) {
			throw new ModePackError("UNEXPECTED_PARENT_HASH", parsed.id);
		}

		const contentHash = modePackHash(parsed);
		return this.writeTransaction(() => {
			this.database
				.prepare(
					"INSERT INTO mode_pack_version (id, revision, content_hash, payload_json, retired, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					parsed.id,
					parsed.revision,
					contentHash,
					JSON.stringify(parsed),
					parsed.retired ? 1 : 0,
					parsed.provenance.createdAt,
				);
			return structuredClone(parsed);
		});
	}

	get(id: string, revision: number): ModePackDefinition {
		this.assertHealthy();
		if (!Number.isInteger(revision) || revision < 1) throw new ModePackError("INVALID_REVISION", String(revision));
		const row = this.database
			.prepare("SELECT payload_json, content_hash FROM mode_pack_version WHERE id=? AND revision=?")
			.get(id, revision) as { payload_json: string; content_hash: string } | undefined;
		if (!row) throw new ModePackError("MODE_PACK_NOT_FOUND", `${id}:${revision}`);
		const parsed = parseModePackDefinition(JSON.parse(row.payload_json));
		if (modePackHash(parsed) !== row.content_hash) throw new ModePackError("CORRUPT_MODE_PACK", `${id}:${revision}`);
		return parsed;
	}

	latest(id: string, includeRetired = false): ModePackDefinition | null {
		this.assertHealthy();
		const row = this.database
			.prepare(
				`SELECT payload_json, content_hash FROM mode_pack_version WHERE id=? ${includeRetired ? "" : "AND retired=0"} ORDER BY revision DESC LIMIT 1`,
			)
			.get(id) as { payload_json: string; content_hash: string } | undefined;
		if (!row) return null;
		const parsed = parseModePackDefinition(JSON.parse(row.payload_json));
		if (modePackHash(parsed) !== row.content_hash) throw new ModePackError("CORRUPT_MODE_PACK", id);
		return parsed;
	}

	list(includeRetired = false): ModePackDefinition[] {
		this.assertHealthy();
		const rows = this.database
			.prepare(
				`SELECT v.payload_json, v.content_hash
				 FROM mode_pack_version v
				 JOIN (SELECT id, MAX(revision) AS revision FROM mode_pack_version GROUP BY id) latest
				   ON latest.id=v.id AND latest.revision=v.revision
				 ${includeRetired ? "" : "WHERE v.retired=0"}
				 ORDER BY v.id`,
			)
			.all() as Array<{ payload_json: string; content_hash: string }>;
		return rows.map((row) => {
			const parsed = parseModePackDefinition(JSON.parse(row.payload_json));
			if (modePackHash(parsed) !== row.content_hash) throw new ModePackError("CORRUPT_MODE_PACK", parsed.id);
			return parsed;
		});
	}

	retire(id: string, createdAt = new Date().toISOString()): ModePackDefinition {
		const latest = this.latest(id, true);
		if (!latest) throw new ModePackError("MODE_PACK_NOT_FOUND", id);
		return this.publishCustom({
			...latest,
			revision: latest.revision + 1,
			retired: true,
			provenance: {
				source: "user",
				createdAt,
				parentContentHash: modePackHash(latest),
			},
		});
	}

	putWorkflow(value: StoredModeWorkflow, expectedRevision: number | null): StoredModeWorkflow {
		const parsed = parseStoredWorkflow(value);
		return this.writeTransaction(() => {
			const existing = this.database
				.prepare("SELECT revision, payload_json FROM mode_workflow_state WHERE workflow_id=?")
				.get(parsed.workflowId) as { revision: number; payload_json: string } | undefined;
			if (existing) {
				if (expectedRevision === null || existing.revision !== expectedRevision) {
					throw new ModePackError("WORKFLOW_REVISION_CONFLICT", parsed.workflowId);
				}
				const current = parseStoredWorkflow(JSON.parse(existing.payload_json));
				if (
					current.sessionId !== parsed.sessionId ||
					current.courseVersionId !== parsed.courseVersionId ||
					current.modePackContentHash !== parsed.modePackContentHash
				) {
					throw new ModePackError("WORKFLOW_REBIND_FORBIDDEN", parsed.workflowId);
				}
				if (parsed.revision !== current.revision + 1) {
					throw new ModePackError("WORKFLOW_REVISION_CONFLICT", parsed.workflowId);
				}
				this.database
					.prepare(
						"UPDATE mode_workflow_state SET revision=?, payload_json=?, updated_at=? WHERE workflow_id=? AND revision=?",
					)
					.run(parsed.revision, JSON.stringify(parsed), parsed.updatedAt, parsed.workflowId, current.revision);
			} else {
				if (expectedRevision !== null || parsed.revision !== 1) {
					throw new ModePackError("WORKFLOW_REVISION_CONFLICT", parsed.workflowId);
				}
				this.database
					.prepare(
						"INSERT INTO mode_workflow_state (workflow_id, session_id, course_version_id, mode_pack_id, mode_pack_revision, mode_pack_content_hash, revision, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						parsed.workflowId,
						parsed.sessionId,
						parsed.courseVersionId,
						parsed.modePackId,
						parsed.modePackRevision,
						parsed.modePackContentHash,
						parsed.revision,
						JSON.stringify(parsed),
						parsed.updatedAt,
					);
			}
			return structuredClone(parsed);
		});
	}

	getWorkflow(workflowId: string): StoredModeWorkflow | null {
		this.assertHealthy();
		const row = this.database
			.prepare("SELECT payload_json FROM mode_workflow_state WHERE workflow_id=?")
			.get(workflowId) as { payload_json: string } | undefined;
		return row ? parseStoredWorkflow(JSON.parse(row.payload_json)) : null;
	}

	listWorkflows(sessionId: string): StoredModeWorkflow[] {
		this.assertHealthy();
		return (
			this.database.prepare("SELECT payload_json FROM mode_workflow_state WHERE session_id=? ORDER BY updated_at, workflow_id").all(
				sessionId,
			) as Array<{ payload_json: string }>
		).map((row) => parseStoredWorkflow(JSON.parse(row.payload_json)));
	}
}

function parseStoredWorkflow(value: unknown): StoredModeWorkflow {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ModePackError("INVALID_WORKFLOW", "Workflow must be an object");
	}
	const item = value as Record<string, unknown>;
	const allowed = [
		"version",
		"workflowId",
		"kind",
		"sessionId",
		"courseVersionId",
		"modePackId",
		"modePackRevision",
		"modePackContentHash",
		"state",
		"status",
		"revision",
		"learnerTurnIds",
		"payload",
		"updatedAt",
	];
	for (const key of Object.keys(item)) {
		if (!allowed.includes(key)) throw new ModePackError("UNKNOWN_WORKFLOW_FIELD", key);
	}
	for (const key of allowed) {
		if (!(key in item)) throw new ModePackError("MISSING_WORKFLOW_FIELD", key);
	}
	if (item.version !== 1) throw new ModePackError("UNSUPPORTED_WORKFLOW_VERSION", String(item.version));
	for (const field of ["workflowId", "kind", "sessionId", "modePackId", "modePackContentHash", "state", "status", "updatedAt"]) {
		if (typeof item[field] !== "string" || !(item[field] as string).trim()) {
			throw new ModePackError("INVALID_WORKFLOW_FIELD", field);
		}
	}
	if (!WORKFLOW_ID.test(item.workflowId as string)) throw new ModePackError("INVALID_WORKFLOW_ID", item.workflowId as string);
	if (item.courseVersionId !== null && typeof item.courseVersionId !== "string") {
		throw new ModePackError("INVALID_WORKFLOW_FIELD", "courseVersionId");
	}
	if (!Number.isInteger(item.modePackRevision) || Number(item.modePackRevision) < 1) {
		throw new ModePackError("INVALID_WORKFLOW_FIELD", "modePackRevision");
	}
	if (!Number.isInteger(item.revision) || Number(item.revision) < 1) {
		throw new ModePackError("INVALID_WORKFLOW_FIELD", "revision");
	}
	if (!Array.isArray(item.learnerTurnIds) || item.learnerTurnIds.some((turn) => typeof turn !== "string" || !WORKFLOW_ID.test(turn))) {
		throw new ModePackError("INVALID_WORKFLOW_FIELD", "learnerTurnIds");
	}
	if (new Set(item.learnerTurnIds).size !== item.learnerTurnIds.length) {
		throw new ModePackError("DUPLICATE_LEARNER_TURN", item.workflowId as string);
	}
	if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
		throw new ModePackError("INVALID_WORKFLOW_FIELD", "payload");
	}
	if (!Number.isFinite(Date.parse(item.updatedAt as string))) {
		throw new ModePackError("INVALID_WORKFLOW_FIELD", "updatedAt");
	}
	const statuses = ["active", "waiting-for-learner", "completed", "blocked"];
	if (!statuses.includes(item.status as string)) throw new ModePackError("INVALID_WORKFLOW_STATUS", item.status as string);
	return structuredClone(item) as unknown as StoredModeWorkflow;
}

export { parseStoredWorkflow };
