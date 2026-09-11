import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentHash, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import {
	type CodeRun,
	choice,
	type DocumentKind,
	documentHash,
	type ExperimentPlan,
	identifier,
	integer,
	object,
	parseAnchor,
	parseExperiment,
	parseManifest,
	parseProposal,
	parseRoadmap,
	type ResearchProposal,
	type SourceAnchor,
	type SourceEntry,
	type StudyDocument,
	StudyError,
	type StudyNote,
	type StudyProject,
	type StudyRoadmap,
	text,
} from "./contracts.ts";
import { STUDY_SCHEMA } from "./schema.ts";

interface PayloadRow {
	payload: string;
}
interface SourceRow {
	sourceHash: string;
	textHash: string;
	body: string;
	adapter: string;
}
interface ApprovalRow {
	planHash: string;
	consumed: number;
}
export interface StudyProgress {
	nodeId: string;
	roadmapRevision: number;
	stage: "queued" | "learning" | "can-explain";
	attempt: string;
	createdAt: string;
}

/** Product state only. Native Pi JSONL continues to own every conversation. */
export class StudyResearchHost {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) {
		this.database = database;
		database.exec(`
		 CREATE TABLE IF NOT EXISTS study_project (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		 CREATE TABLE IF NOT EXISTS study_binding (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES study_project(id));
		 CREATE TABLE IF NOT EXISTS study_source (
		  project_id TEXT NOT NULL REFERENCES study_project(id), manifest_version INTEGER NOT NULL,
		  source_id TEXT NOT NULL, source_hash TEXT NOT NULL, text_hash TEXT NOT NULL, body TEXT NOT NULL, adapter TEXT NOT NULL,
		  PRIMARY KEY(project_id, manifest_version, source_id));
		 CREATE TABLE IF NOT EXISTS study_read (
		  project_id TEXT NOT NULL, manifest_version INTEGER NOT NULL, source_id TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
		  PRIMARY KEY(project_id, manifest_version, source_id, start_line, end_line));
		 CREATE TABLE IF NOT EXISTS study_document (
		  project_id TEXT NOT NULL REFERENCES study_project(id), kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
		  PRIMARY KEY(project_id, kind, id, revision));
		 CREATE TABLE IF NOT EXISTS study_approval (
		  project_id TEXT NOT NULL, experiment_id TEXT NOT NULL, revision INTEGER NOT NULL, plan_hash TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
		  PRIMARY KEY(project_id, experiment_id, revision));
		 CREATE TABLE IF NOT EXISTS study_run (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
		 CREATE TABLE IF NOT EXISTS study_progress (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
		`);
	}

	private transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const value = operation();
			this.database.exec("COMMIT");
			return value;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	createProject(requestId: string, title: string, root: string, sources: SourceEntry[]): StudyProject {
		const id = `study_${identifier(requestId, "requestId")}`;
		const manifest = parseManifest(sources);
		const value: StudyProject = {
			id,
			title: text(title, "title", 300),
			root: text(root, "root", 4096),
			revision: 1,
			manifestVersion: 1,
			manifestHash: contentHash(manifest),
			sources: manifest,
		};
		return this.transaction(() => {
			const row = this.database.prepare("SELECT payload FROM study_project WHERE id=?").get(id) as
				| PayloadRow
				| undefined;
			if (row) {
				const prior = this.decodeProject(row);
				if (prior.title !== value.title || prior.root !== value.root)
					throw new StudyError("REQUEST_CONFLICT", "Creation request already used for a different project");
				return prior;
			}
			this.database.prepare("INSERT INTO study_project(id,payload) VALUES(?,?)").run(id, stableStringify(value));
			return value;
		});
	}

	private decodeProject(row: PayloadRow): StudyProject {
		const value = JSON.parse(row.payload) as StudyProject;
		identifier(value.id);
		integer(value.revision, "revision", 1);
		integer(value.manifestVersion, "manifestVersion", 1);
		if (contentHash(parseManifest(value.sources)) !== value.manifestHash)
			throw new StudyError("CORRUPT_STATE", "Source manifest hash mismatch");
		return value;
	}
	project(id: string): StudyProject {
		const row = this.database.prepare("SELECT payload FROM study_project WHERE id=?").get(identifier(id)) as
			| PayloadRow
			| undefined;
		if (!row) throw new StudyError("PROJECT_NOT_FOUND", "Study project not found");
		return this.decodeProject(row);
	}
	listProjects(): StudyProject[] {
		return (
			this.database.prepare("SELECT payload FROM study_project ORDER BY id").all() as unknown as PayloadRow[]
		).map((row) => this.decodeProject(row));
	}
	bindings(): { sessionId: string; projectId: string }[] {
		return this.database
			.prepare("SELECT session_id AS sessionId, project_id AS projectId FROM study_binding")
			.all() as unknown as { sessionId: string; projectId: string }[];
	}
	bindSession(sessionId: string, projectId: string): void {
		this.project(projectId);
		identifier(sessionId, "sessionId");
		this.transaction(() => {
			const existing = this.database
				.prepare("SELECT project_id AS projectId FROM study_binding WHERE session_id=?")
				.get(sessionId) as { projectId: string } | undefined;
			if (existing && existing.projectId !== projectId)
				throw new StudyError("SESSION_BOUND", "Session is already bound to another study project");
			this.database
				.prepare("INSERT OR IGNORE INTO study_binding(session_id,project_id) VALUES(?,?)")
				.run(sessionId, projectId);
		});
	}
	findProjectForSession(sessionId: string): StudyProject | null {
		const row = this.database
			.prepare("SELECT project_id AS projectId FROM study_binding WHERE session_id=?")
			.get(sessionId) as { projectId: string } | undefined;
		return row ? this.project(row.projectId) : null;
	}
	projectForSession(sessionId: string): StudyProject {
		const project = this.findProjectForSession(sessionId);
		if (!project) throw new StudyError("SESSION_UNBOUND", "Select a study project for this Pi session");
		return project;
	}
	reindex(sessionId: string, expectedRevision: number, sources: SourceEntry[]): StudyProject {
		const manifest = parseManifest(sources);
		return this.transaction(() => {
			const prior = this.projectForSession(sessionId);
			if (prior.revision !== expectedRevision)
				throw new StudyError("REVISION_CONFLICT", "Project revision changed; reload before reindexing");
			const next = {
				...prior,
				revision: prior.revision + 1,
				manifestVersion: prior.manifestVersion + 1,
				manifestHash: contentHash(manifest),
				sources: manifest,
			};
			this.database.prepare("UPDATE study_project SET payload=? WHERE id=?").run(stableStringify(next), prior.id);
			return next;
		});
	}

	recordSource(
		sessionId: string,
		sourceId: string,
		manifestVersion: number,
		sourceHash: string,
		body: string,
		adapter: string,
	): void {
		if (!/^[a-f0-9]{64}$/u.test(sourceHash)) throw new StudyError("INVALID_HASH", "Expected source SHA-256");
		text(body, "extracted source", 2 * 1024 * 1024);
		text(adapter, "adapter", 80);
		this.transaction(() => {
			const project = this.projectForSession(sessionId);
			if (project.manifestVersion !== manifestVersion)
				throw new StudyError("STALE_SOURCE", "Source manifest changed during extraction");
			if (!project.sources.some((source) => source.id === sourceId))
				throw new StudyError("SOURCE_NOT_FOUND", "Source is not in this study project");
			const prior = this.sourceRow(project.id, manifestVersion, sourceId, false);
			if (prior) {
				if (prior.sourceHash !== sourceHash || prior.textHash !== sha256Hex(body))
					throw new StudyError("SOURCE_CHANGED", "Source changed; reindex before using the new version");
				return;
			}
			const size = this.database
				.prepare(
					"SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM study_source WHERE project_id=? AND manifest_version=?",
				)
				.get(project.id, manifestVersion) as { bytes: number };
			if (size.bytes + Buffer.byteLength(body) > 16 * 1024 * 1024)
				throw new StudyError("SOURCE_BUDGET", "Project extracted-text budget exceeded (16 MiB)");
			this.database
				.prepare("INSERT INTO study_source VALUES(?,?,?,?,?,?,?)")
				.run(project.id, manifestVersion, sourceId, sourceHash, sha256Hex(body), body, adapter);
		});
	}
	private sourceRow(projectId: string, version: number, sourceId: string, required = true): SourceRow | undefined {
		const row = this.database
			.prepare(
				"SELECT source_hash AS sourceHash,text_hash AS textHash,body,adapter FROM study_source WHERE project_id=? AND manifest_version=? AND source_id=?",
			)
			.get(projectId, version, sourceId) as SourceRow | undefined;
		if (!row && required) throw new StudyError("SOURCE_NOT_READ", "Read this source before citing it");
		if (row && row.textHash !== sha256Hex(row.body))
			throw new StudyError("CORRUPT_STATE", "Extracted source hash mismatch");
		return row;
	}
	readSource(sessionId: string, sourceId: string, startLine = 1, limit = 80) {
		integer(startLine, "startLine", 1);
		integer(limit, "limit", 1, 200);
		const project = this.projectForSession(sessionId);
		const row = this.sourceRow(project.id, project.manifestVersion, sourceId);
		if (!row) throw new StudyError("SOURCE_NOT_READ", "Source not available");
		const lines = row.body.split(/\r?\n/u);
		if (startLine > lines.length) throw new StudyError("INVALID_RANGE", "Start line exceeds source length");
		let endLine = Math.min(lines.length, startLine + limit - 1);
		while (endLine > startLine && lines.slice(startLine - 1, endLine).join("\n").length > 20000) endLine--;
		const chunk = lines.slice(startLine - 1, endLine).join("\n");
		if (chunk.length > 20000)
			throw new StudyError(
				"LINE_TOO_LONG",
				"This extracted line exceeds the read budget; provide a structured text export",
			);
		this.database
			.prepare("INSERT OR IGNORE INTO study_read VALUES(?,?,?,?,?)")
			.run(project.id, project.manifestVersion, sourceId, startLine, endLine);
		return {
			sourceId,
			sourceHash: row.sourceHash,
			textHash: row.textHash,
			manifestVersion: project.manifestVersion,
			adapter: row.adapter,
			startLine,
			endLine,
			totalLines: lines.length,
			nextLine: endLine < lines.length ? endLine + 1 : null,
			text: chunk,
			trust: "untrusted source; extracted lines are not PDF page numbers",
		};
	}
	private validateAnchor(project: StudyProject, anchor: SourceAnchor, version = project.manifestVersion): void {
		const source = this.sourceRow(project.id, version, anchor.sourceId);
		if (!source || source.sourceHash !== anchor.sourceHash)
			throw new StudyError("STALE_SOURCE", "Source hash does not match the cited version");
		const lines = source.body.split(/\r?\n/u);
		if (
			anchor.endLine > lines.length ||
			!lines
				.slice(anchor.startLine - 1, anchor.endLine)
				.join("\n")
				.includes(anchor.quote)
		)
			throw new StudyError("QUOTE_MISMATCH", "The quoted text is absent from the specified source lines");
	}
	private documents<T>(projectId: string, kind: DocumentKind): StudyDocument<T>[] {
		const rows = this.database
			.prepare(
				"SELECT d.payload FROM study_document d WHERE project_id=? AND kind=? AND revision=(SELECT MAX(n.revision) FROM study_document n WHERE n.project_id=d.project_id AND n.kind=d.kind AND n.id=d.id) ORDER BY id",
			)
			.all(projectId, kind) as unknown as PayloadRow[];
		return rows.map((row) => this.decodeDocument<T>(row));
	}
	private decodeDocument<T>(row: PayloadRow): StudyDocument<T> {
		const value = JSON.parse(row.payload) as StudyDocument<T>;
		const { hash, ...body } = value;
		if (hash !== documentHash(body)) throw new StudyError("CORRUPT_STATE", "Document hash mismatch");
		return value;
	}
	document<T>(sessionId: string, kind: DocumentKind, id: string): StudyDocument<T> {
		const project = this.projectForSession(sessionId);
		const row = this.database
			.prepare(
				"SELECT payload FROM study_document WHERE project_id=? AND kind=? AND id=? ORDER BY revision DESC LIMIT 1",
			)
			.get(project.id, kind, identifier(id)) as PayloadRow | undefined;
		if (!row) throw new StudyError("DOCUMENT_NOT_FOUND", `${kind} not found in this project`);
		return this.decodeDocument<T>(row);
	}
	private roadmap(projectId: string): StudyDocument<StudyRoadmap> | null {
		return this.documents<StudyRoadmap>(projectId, "roadmap")[0] ?? null;
	}
	private currentRoadmap(project: StudyProject): StudyDocument<StudyRoadmap> {
		const map = this.roadmap(project.id);
		if (!map || map.manifestVersion !== project.manifestVersion)
			throw new StudyError("STALE_ROADMAP", "Create a current source-grounded roadmap first");
		return map;
	}
	private writeDocument<T>(
		project: StudyProject,
		kind: DocumentKind,
		id: string,
		expectedRevision: number,
		data: T,
		proposalRevision: number | null = null,
	): StudyDocument<T> {
		integer(expectedRevision, "expectedRevision");
		const last = this.database
			.prepare("SELECT MAX(revision) AS revision FROM study_document WHERE project_id=? AND kind=? AND id=?")
			.get(project.id, kind, id) as { revision: number | null };
		if ((last.revision ?? 0) !== expectedRevision)
			throw new StudyError("REVISION_CONFLICT", `${kind} revision changed; reload without overwriting your draft`);
		const value = {
			id,
			revision: expectedRevision + 1,
			manifestVersion: project.manifestVersion,
			roadmapRevision: this.roadmap(project.id)?.revision ?? 0,
			proposalRevision,
			data,
			createdAt: new Date().toISOString(),
		};
		const result = { ...value, hash: documentHash(value) };
		const serialized = stableStringify(result);
		if (Buffer.byteLength(serialized) > 1024 * 1024)
			throw new StudyError("DOCUMENT_BUDGET", "Document exceeds 1 MiB; split the study scope");
		this.database
			.prepare("INSERT INTO study_document VALUES(?,?,?,?,?)")
			.run(project.id, kind, id, result.revision, serialized);
		return result;
	}
	saveRoadmap(sessionId: string, expectedRevision: number, value: unknown): StudyDocument<StudyRoadmap> {
		const map = parseRoadmap(value);
		return this.transaction(() => {
			const project = this.projectForSession(sessionId);
			for (const node of map.nodes) for (const anchor of node.sources) this.validateAnchor(project, anchor);
			return this.writeDocument(project, "roadmap", "roadmap", expectedRevision, map);
		});
	}
	saveNote(
		sessionId: string,
		author: "user" | "agent",
		noteId: string | null,
		expectedRevision: number,
		value: unknown,
	): StudyDocument<StudyNote> {
		const row = object(value, ["nodeId", "anchor", "body"], "note");
		const note: StudyNote = {
			author,
			nodeId: row.nodeId === null ? null : identifier(row.nodeId),
			anchor: row.anchor === null ? null : parseAnchor(row.anchor),
			body: text(row.body, "note body", 64000),
		};
		return this.transaction(() => {
			const project = this.projectForSession(sessionId);
			if (note.anchor) this.validateAnchor(project, note.anchor);
			if (note.nodeId && !this.currentRoadmap(project).data.nodes.some((node) => node.id === note.nodeId))
				throw new StudyError("UNKNOWN_NODE", "Note node is not in the current roadmap");
			if (noteId) {
				const prior = this.document<StudyNote>(sessionId, "note", noteId);
				if (prior.data.author !== author)
					throw new StudyError("AUTHOR_MISMATCH", "You cannot replace a note from another author");
			}
			return this.writeDocument(
				project,
				"note",
				noteId ? identifier(noteId) : `note_${randomUUID()}`,
				expectedRevision,
				note,
			);
		});
	}
	saveProposal(
		sessionId: string,
		proposalId: string | null,
		expectedRevision: number,
		value: unknown,
	): StudyDocument<ResearchProposal> {
		const data = parseProposal(value);
		return this.transaction(() => {
			const project = this.projectForSession(sessionId);
			const map = this.currentRoadmap(project);
			for (const id of data.nodeIds)
				if (!map.data.nodes.some((node) => node.id === id))
					throw new StudyError("UNKNOWN_NODE", "Proposal must reference a current roadmap node");
			for (const anchor of data.sources) this.validateAnchor(project, anchor);
			return this.writeDocument(
				project,
				"proposal",
				proposalId ? identifier(proposalId) : `proposal_${randomUUID()}`,
				expectedRevision,
				data,
			);
		});
	}
	saveExperiment(
		sessionId: string,
		experimentId: string | null,
		expectedRevision: number,
		value: unknown,
	): StudyDocument<ExperimentPlan> {
		const data = parseExperiment(value);
		return this.transaction(() => {
			const project = this.projectForSession(sessionId);
			const map = this.currentRoadmap(project);
			let proposalRevision: number | null = null;
			if (data.proposalId) {
				const proposal = this.document<ResearchProposal>(sessionId, "proposal", data.proposalId);
				if (proposal.manifestVersion !== project.manifestVersion || proposal.roadmapRevision !== map.revision)
					throw new StudyError("STALE_PROPOSAL", "Proposal is stale");
				proposalRevision = proposal.revision;
			}
			return this.writeDocument(
				project,
				"experiment",
				experimentId ? identifier(experimentId) : `experiment_${randomUUID()}`,
				expectedRevision,
				data,
				proposalRevision,
			);
		});
	}
	private runnable(sessionId: string, experimentId: string, revision: number): StudyDocument<ExperimentPlan> {
		const project = this.projectForSession(sessionId);
		const plan = this.document<ExperimentPlan>(sessionId, "experiment", experimentId);
		if (plan.revision !== revision) throw new StudyError("REVISION_CONFLICT", "Experiment revision changed");
		if (
			plan.manifestVersion !== project.manifestVersion ||
			plan.roadmapRevision !== this.currentRoadmap(project).revision
		)
			throw new StudyError("STALE_PLAN", "Experiment source/roadmap is stale");
		if (
			plan.data.proposalId &&
			this.document<ResearchProposal>(sessionId, "proposal", plan.data.proposalId).revision !== plan.proposalRevision
		)
			throw new StudyError("STALE_PLAN", "Proposal changed; revise the experiment and approve it again");
		return plan;
	}
	/** Called only by the explicit human workspace route, never by agentCommand. */
	approveExperiment(sessionId: string, experimentId: string, revision: number): void {
		this.transaction(() => {
			const project = this.projectForSession(sessionId);
			const plan = this.runnable(sessionId, experimentId, revision);
			const existing = this.database
				.prepare(
					"SELECT plan_hash AS planHash,consumed FROM study_approval WHERE project_id=? AND experiment_id=? AND revision=?",
				)
				.get(project.id, experimentId, revision) as ApprovalRow | undefined;
			if (existing?.consumed)
				throw new StudyError(
					"APPROVAL_CONSUMED",
					"Approval already consumed; save a new plan revision for an explicit rerun",
				);
			this.database
				.prepare("INSERT OR IGNORE INTO study_approval VALUES(?,?,?,?,0)")
				.run(project.id, experimentId, revision, plan.hash);
		});
	}
	beginRun(sessionId: string, experimentId: string, revision: number): CodeRun {
		return this.transaction(() => {
			const project = this.projectForSession(sessionId);
			const plan = this.runnable(sessionId, experimentId, revision);
			const approved = this.database
				.prepare(
					"SELECT plan_hash AS planHash,consumed FROM study_approval WHERE project_id=? AND experiment_id=? AND revision=?",
				)
				.get(project.id, experimentId, revision) as ApprovalRow | undefined;
			if (!approved || approved.planHash !== plan.hash)
				throw new StudyError("APPROVAL_REQUIRED", "Human approval of this exact plan is required");
			if (approved.consumed) throw new StudyError("APPROVAL_CONSUMED", "Run approval already consumed");
			this.database
				.prepare("UPDATE study_approval SET consumed=1 WHERE project_id=? AND experiment_id=? AND revision=?")
				.run(project.id, experimentId, revision);
			const run: CodeRun = {
				id: `run_${randomUUID()}`,
				experimentId,
				experimentRevision: revision,
				planHash: plan.hash,
				codeHash: sha256Hex(plan.data.code),
				status: "started",
				exitCode: null,
				stdout: "",
				stderr: "",
				durationMs: 0,
				startedAt: new Date().toISOString(),
				finishedAt: null,
			};
			this.database.prepare("INSERT INTO study_run VALUES(?,?,?)").run(run.id, project.id, stableStringify(run));
			return run;
		});
	}
	finishRun(
		sessionId: string,
		runId: string,
		result: Pick<CodeRun, "status" | "exitCode" | "stdout" | "stderr" | "durationMs">,
	): CodeRun {
		return this.transaction(() => {
			const project = this.projectForSession(sessionId);
			const row = this.database
				.prepare("SELECT payload FROM study_run WHERE id=? AND project_id=?")
				.get(runId, project.id) as PayloadRow | undefined;
			if (!row) throw new StudyError("RUN_NOT_FOUND", "Run not found");
			const prior = JSON.parse(row.payload) as CodeRun;
			if (prior.status !== "started") throw new StudyError("RUN_FINISHED", "Run is already finalized");
			const status = choice(
				result.status,
				["succeeded", "failed", "timed-out", "output-limit", "aborted"],
				"run status",
			);
			if (status === "succeeded" && result.exitCode !== 0)
				throw new StudyError("INVALID_RECEIPT", "Successful execution requires exit code zero");
			if (result.exitCode !== null) integer(result.exitCode, "exitCode", 0, 2147483647);
			const next: CodeRun = {
				...prior,
				...result,
				status,
				stdout: text(result.stdout, "stdout", 512 * 1024, true),
				stderr: text(result.stderr, "stderr", 512 * 1024, true),
				durationMs: integer(result.durationMs, "durationMs", 0, 3600000),
				finishedAt: new Date().toISOString(),
			};
			this.database
				.prepare("UPDATE study_run SET payload=? WHERE id=? AND project_id=?")
				.run(stableStringify(next), runId, project.id);
			return next;
		});
	}
	recordProgress(
		sessionId: string,
		nodeId: string,
		roadmapRevision: number,
		stage: unknown,
		attempt: unknown,
	): StudyProgress {
		return this.transaction(() => {
			const project = this.projectForSession(sessionId);
			const map = this.currentRoadmap(project);
			if (map.revision !== roadmapRevision || !map.data.nodes.some((node) => node.id === nodeId))
				throw new StudyError("STALE_NODE", "Learning node changed");
			const data: StudyProgress = {
				nodeId,
				roadmapRevision,
				stage: choice(stage, ["queued", "learning", "can-explain"], "stage"),
				attempt: text(attempt, "user attempt", 16000),
				createdAt: new Date().toISOString(),
			};
			this.database
				.prepare("INSERT INTO study_progress VALUES(?,?,?)")
				.run(randomUUID(), project.id, stableStringify(data));
			return data;
		});
	}
	state(sessionId: string) {
		const project = this.projectForSession(sessionId);
		const roadmap = this.roadmap(project.id);
		const stale = <T>(doc: StudyDocument<T>) => ({
			...doc,
			stale: doc.manifestVersion !== project.manifestVersion || doc.roadmapRevision !== (roadmap?.revision ?? 0),
		});
		const notes = this.documents<StudyNote>(project.id, "note").map(stale);
		const experiments = this.documents<ExperimentPlan>(project.id, "experiment").map((doc) => {
			const approval = this.database
				.prepare(
					"SELECT plan_hash AS planHash,consumed FROM study_approval WHERE project_id=? AND experiment_id=? AND revision=?",
				)
				.get(project.id, doc.id, doc.revision) as ApprovalRow | undefined;
			const proposalStale =
				!!doc.data.proposalId &&
				this.document<ResearchProposal>(sessionId, "proposal", doc.data.proposalId).revision !==
					doc.proposalRevision;
			return {
				...stale(doc),
				stale: stale(doc).stale || proposalStale,
				approved: approval?.planHash === doc.hash && !approval.consumed,
				consumed: approval?.consumed === 1,
			};
		});
		const sources = this.database
			.prepare(
				"SELECT source_id AS sourceId,source_hash AS sourceHash,text_hash AS textHash,adapter FROM study_source WHERE project_id=? AND manifest_version=?",
			)
			.all(project.id, project.manifestVersion);
		const reads = this.database
			.prepare(
				"SELECT source_id AS sourceId,start_line AS startLine,end_line AS endLine FROM study_read WHERE project_id=? AND manifest_version=?",
			)
			.all(project.id, project.manifestVersion);
		const runs = (
			this.database
				.prepare("SELECT payload FROM study_run WHERE project_id=? ORDER BY rowid DESC LIMIT 100")
				.all(project.id) as unknown as PayloadRow[]
		).map((row) => JSON.parse(row.payload) as CodeRun);
		const progress = (
			this.database
				.prepare("SELECT payload FROM study_progress WHERE project_id=? ORDER BY rowid DESC LIMIT 300")
				.all(project.id) as unknown as PayloadRow[]
		).map((row) => JSON.parse(row.payload) as StudyProgress);
		return {
			project,
			sources,
			reads,
			roadmap: roadmap ? { ...roadmap, stale: roadmap.manifestVersion !== project.manifestVersion } : null,
			notes,
			proposals: this.documents<ResearchProposal>(project.id, "proposal").map(stale),
			experiments,
			runs,
			progress,
		};
	}
	agentCommand(sessionId: string, input: unknown): unknown {
		const cmd = object(input, ["action", "id", "expectedRevision", "startLine", "limit", "draft"], "command");
		const action = text(cmd.action, "action", 80);
		switch (action) {
			case "schema":
				return STUDY_SCHEMA;
			case "state": {
				const state = this.state(sessionId);
				return {
					project: state.project,
					sources: state.sources,
					reads: state.reads,
					roadmap: state.roadmap
						? {
								id: state.roadmap.id,
								revision: state.roadmap.revision,
								stale: state.roadmap.stale,
								scope: state.roadmap.data.scope,
								story: state.roadmap.data.story,
								contribution: state.roadmap.data.contribution,
								uncertainties: state.roadmap.data.uncertainties,
								nodes: state.roadmap.data.nodes.map(({ explanation, ...node }) => ({
									...node,
									explanationCharacters: explanation.length,
								})),
							}
						: null,
					notes: state.notes.map(({ data, ...note }) => ({ ...note, author: data.author, nodeId: data.nodeId })),
					proposals: state.proposals,
					experiments: state.experiments.map(({ data, ...experiment }) => ({
						...experiment,
						title: data.title,
						codeHash: sha256Hex(data.code),
					})),
					runs: state.runs.map(({ stdout, stderr, ...run }) => ({
						...run,
						stdoutCharacters: stdout.length,
						stderrCharacters: stderr.length,
					})),
					progress: state.progress,
				};
			}
			case "read_source":
				return this.readSource(
					sessionId,
					identifier(cmd.id),
					cmd.startLine === undefined ? 1 : integer(cmd.startLine, "startLine", 1),
					cmd.limit === undefined ? 80 : integer(cmd.limit, "limit", 1, 200),
				);
			case "read_node": {
				const map = this.currentRoadmap(this.projectForSession(sessionId));
				const node = map.data.nodes.find((entry) => entry.id === cmd.id);
				if (!node) throw new StudyError("UNKNOWN_NODE", "Study node not found");
				return { roadmapRevision: map.revision, node };
			}
			case "read_note":
				return this.document<StudyNote>(sessionId, "note", identifier(cmd.id));
			case "read_experiment":
				return this.document<ExperimentPlan>(sessionId, "experiment", identifier(cmd.id));
			case "read_run": {
				const run = this.state(sessionId).runs.find((entry) => entry.id === cmd.id);
				if (!run) throw new StudyError("RUN_NOT_FOUND", "Run not found");
				return run;
			}
			case "save_roadmap":
				return this.saveRoadmap(sessionId, integer(cmd.expectedRevision, "expectedRevision"), cmd.draft);
			case "save_note":
				return this.saveNote(
					sessionId,
					"agent",
					cmd.id ? identifier(cmd.id) : null,
					integer(cmd.expectedRevision, "expectedRevision"),
					cmd.draft,
				);
			case "save_proposal":
				return this.saveProposal(
					sessionId,
					cmd.id ? identifier(cmd.id) : null,
					integer(cmd.expectedRevision, "expectedRevision"),
					cmd.draft,
				);
			case "save_experiment":
				return this.saveExperiment(
					sessionId,
					cmd.id ? identifier(cmd.id) : null,
					integer(cmd.expectedRevision, "expectedRevision"),
					cmd.draft,
				);
			default:
				throw new StudyError("ACTION_DENIED", `Agent action not allowed: ${action}`);
		}
	}
}
