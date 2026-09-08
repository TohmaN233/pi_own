import type { DatabaseSync } from "node:sqlite";
import { parseResourceSnapshot, type ResourceSnapshot } from "../../harness-contracts/src/index.ts";

export interface ProjectWorkspace {
	id: string;
	title: string;
	cwd: string;
	courseProjectId: string | null;
	defaults: ResourceSnapshot | null;
	revision: number;
}

/** Project organization and defaults share the Harness database; chats stay in Pi JSONL. */
export class ProjectWorkspaceHost {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) {
		this.database = database;
		database.exec(`
			CREATE TABLE IF NOT EXISTS pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES pi_project_workspace(id));
			CREATE TABLE IF NOT EXISTS pi_project_creation (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, session_id TEXT NOT NULL);
		`);
	}

	list(): ProjectWorkspace[] {
		return this.database
			.prepare("SELECT payload FROM pi_project_workspace ORDER BY id")
			.all()
			.map((row) => {
				const project = JSON.parse(String(row.payload)) as ProjectWorkspace;
				if (project.defaults) project.defaults = parseResourceSnapshot(project.defaults);
				return project;
			});
	}

	get(id: string): ProjectWorkspace {
		const project = this.list().find((item) => item.id === id);
		if (!project) throw new Error("Project not found");
		return project;
	}

	create(project: Omit<ProjectWorkspace, "revision">): ProjectWorkspace {
		if (!project.id || !project.title.trim() || !project.cwd.trim())
			throw new Error("Project identity, title and directory are required");
		if (project.defaults) parseResourceSnapshot(project.defaults);
		const existing = this.list().find((item) => item.id === project.id);
		if (existing) {
			if (
				existing.courseProjectId !== project.courseProjectId ||
				existing.cwd !== project.cwd ||
				existing.title !== project.title
			)
				throw new Error("Project creation conflict");
			return existing;
		}
		const saved = { ...project, revision: 1 };
		this.database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run(project.id, JSON.stringify(saved));
		return saved;
	}

	update(id: string, patch: Pick<ProjectWorkspace, "title" | "defaults">, expectedRevision: number): ProjectWorkspace {
		if (!patch.title.trim()) throw new Error("Project title is required");
		if (patch.defaults) parseResourceSnapshot(patch.defaults);
		const current = this.get(id);
		if (current.revision !== expectedRevision)
			throw new Error("Project settings revision conflict; reload before saving");
		const next = { ...current, ...patch, revision: current.revision + 1 };
		const result = this.database
			.prepare("UPDATE pi_project_workspace SET payload = ? WHERE id = ? AND payload = ?")
			.run(JSON.stringify(next), id, JSON.stringify(current));
		if (result.changes !== 1) throw new Error("Project settings changed before saving");
		return next;
	}

	members(): Array<{ sessionId: string; projectId: string }> {
		return this.database
			.prepare("SELECT session_id AS sessionId, project_id AS projectId FROM pi_project_member")
			.all() as unknown as Array<{ sessionId: string; projectId: string }>;
	}

	move(sessionId: string, projectId: string | null): void {
		if (!sessionId) throw new Error("Session is required");
		if (projectId === null)
			this.database.prepare("DELETE FROM pi_project_member WHERE session_id = ?").run(sessionId);
		else {
			this.get(projectId);
			this.database
				.prepare(
					"INSERT INTO pi_project_member VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id",
				)
				.run(sessionId, projectId);
		}
	}

	/** Synchronous reservation: retries reuse the persisted empty JSONL even after a later binding failure. */
	createSession(projectId: string, requestId: string, requestHash: string, create: () => string): string {
		this.get(projectId);
		const prior = this.database
			.prepare("SELECT request_hash AS hash, session_id AS id FROM pi_project_creation WHERE request_id = ?")
			.get(requestId);
		if (prior) {
			if (prior.hash !== requestHash) throw new Error("Conversation creation request conflict");
			return String(prior.id);
		}
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const sessionId = create();
			this.move(sessionId, projectId);
			this.database
				.prepare("INSERT INTO pi_project_creation VALUES (?, ?, ?)")
				.run(requestId, requestHash, sessionId);
			this.database.exec("COMMIT");
			return sessionId;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}
}
