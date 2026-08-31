import { DatabaseSync } from "node:sqlite";
import { educationHash, type ComputationReceipt, type VisualActivitySpec, verifyComputationReceipt } from "./index.ts";
import { EducationModeError } from "./index.ts";

export type VisualArtifactStatus = "draft" | "verified" | "published";

export interface VisualArtifactRevision {
	version: 1;
	artifactId: string;
	revision: number;
	courseVersionId: string;
	sessionId: string;
	modePackContentHash: string;
	status: VisualArtifactStatus;
	spec: VisualActivitySpec;
	receipt: ComputationReceipt | null;
	result: unknown;
	accessibleFallback: string;
	createdAt: string;
	contentHash: string;
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class VisualArtifactStore {
	private readonly database: DatabaseSync;
	private poisoned: Error | null = null;

	constructor(databasePath: string) {
		this.database = new DatabaseSync(databasePath);
		this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS visual_artifact_revision (
				artifact_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				course_version_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				mode_pack_content_hash TEXT NOT NULL,
				status TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (artifact_id, revision),
				UNIQUE (artifact_id, content_hash)
			);
		`);
	}

	close(): void {
		this.database.close();
	}

	private assertHealthy(): void {
		if (this.poisoned) throw new EducationModeError("VISUAL_STORE_REOPEN_REQUIRED", this.poisoned.message);
	}

	private transaction<T>(operation: () => T): T {
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

	createDraft(input: Omit<VisualArtifactRevision, "version" | "revision" | "status" | "receipt" | "createdAt" | "contentHash"> & { createdAt?: string }): VisualArtifactRevision {
		if (!ID.test(input.artifactId)) throw new EducationModeError("INVALID_ARTIFACT_ID", input.artifactId);
		if (!HASH.test(input.modePackContentHash)) throw new EducationModeError("INVALID_HASH", "modePackContentHash");
		if (!input.accessibleFallback.trim()) throw new EducationModeError("ACCESSIBLE_FALLBACK_REQUIRED", input.artifactId);
		const createdAt = input.createdAt ?? new Date().toISOString();
		if (!Number.isFinite(Date.parse(createdAt))) throw new EducationModeError("INVALID_TIMESTAMP", createdAt);
		const draftWithoutHash = {
			version: 1 as const,
			artifactId: input.artifactId,
			revision: 1,
			courseVersionId: input.courseVersionId,
			sessionId: input.sessionId,
			modePackContentHash: input.modePackContentHash,
			status: "draft" as const,
			spec: structuredClone(input.spec),
			receipt: null,
			result: structuredClone(input.result),
			accessibleFallback: input.accessibleFallback,
			createdAt,
		};
		const draft: VisualArtifactRevision = { ...draftWithoutHash, contentHash: educationHash(draftWithoutHash) };
		return this.insert(draft);
	}

	verify(artifactId: string, expectedRevision: number, result: unknown, receipt: ComputationReceipt, createdAt = new Date().toISOString()): VisualArtifactRevision {
		const current = this.get(artifactId, expectedRevision);
		if (current.status !== "draft") throw new EducationModeError("ARTIFACT_NOT_DRAFT", `${artifactId}:${expectedRevision}`);
		verifyComputationReceipt(current.spec, receipt);
		if (receipt.outputHash !== educationHash(result)) throw new EducationModeError("VISUAL_RESULT_HASH_MISMATCH", artifactId);
		return this.nextRevision(current, "verified", result, receipt, createdAt);
	}

	publish(artifactId: string, expectedRevision: number, createdAt = new Date().toISOString()): VisualArtifactRevision {
		const current = this.get(artifactId, expectedRevision);
		if (current.status === "published") return current;
		if (current.status !== "verified" || !current.receipt) {
			throw new EducationModeError("PUBLISH_BEFORE_VERIFY", `${artifactId}:${expectedRevision}`);
		}
		verifyComputationReceipt(current.spec, current.receipt);
		return this.nextRevision(current, "published", current.result, current.receipt, createdAt);
	}

	get(artifactId: string, revision: number): VisualArtifactRevision {
		this.assertHealthy();
		const row = this.database
			.prepare("SELECT payload_json, content_hash FROM visual_artifact_revision WHERE artifact_id=? AND revision=?")
			.get(artifactId, revision) as { payload_json: string; content_hash: string } | undefined;
		if (!row) throw new EducationModeError("ARTIFACT_NOT_FOUND", `${artifactId}:${revision}`);
		const parsed = parseVisualArtifactRevision(JSON.parse(row.payload_json));
		if (parsed.contentHash !== row.content_hash) throw new EducationModeError("CORRUPT_ARTIFACT", `${artifactId}:${revision}`);
		return parsed;
	}

	latest(artifactId: string): VisualArtifactRevision | null {
		this.assertHealthy();
		const row = this.database
			.prepare("SELECT payload_json, content_hash FROM visual_artifact_revision WHERE artifact_id=? ORDER BY revision DESC LIMIT 1")
			.get(artifactId) as { payload_json: string; content_hash: string } | undefined;
		if (!row) return null;
		const parsed = parseVisualArtifactRevision(JSON.parse(row.payload_json));
		if (parsed.contentHash !== row.content_hash) throw new EducationModeError("CORRUPT_ARTIFACT", artifactId);
		return parsed;
	}

	listPublished(courseVersionId: string, sessionId: string): VisualArtifactRevision[] {
		this.assertHealthy();
		return (
			this.database
				.prepare(
					"SELECT payload_json FROM visual_artifact_revision WHERE course_version_id=? AND session_id=? AND status='published' ORDER BY artifact_id, revision",
				)
				.all(courseVersionId, sessionId) as Array<{ payload_json: string }>
		).map((row) => parseVisualArtifactRevision(JSON.parse(row.payload_json)));
	}

	private nextRevision(
		current: VisualArtifactRevision,
		status: VisualArtifactStatus,
		result: unknown,
		receipt: ComputationReceipt,
		createdAt: string,
	): VisualArtifactRevision {
		const nextWithoutHash = {
			...current,
			revision: current.revision + 1,
			status,
			result: structuredClone(result),
			receipt: structuredClone(receipt),
			createdAt,
		};
		const next: VisualArtifactRevision = {
			...nextWithoutHash,
			contentHash: educationHash({ ...nextWithoutHash, contentHash: undefined }),
		};
		return this.insert(next, current.revision);
	}

	private insert(value: VisualArtifactRevision, expectedPreviousRevision: number | null = null): VisualArtifactRevision {
		return this.transaction(() => {
			const latest = this.latest(value.artifactId);
			if (expectedPreviousRevision === null) {
				if (latest) throw new EducationModeError("ARTIFACT_ALREADY_EXISTS", value.artifactId);
			} else if (!latest || latest.revision !== expectedPreviousRevision || value.revision !== latest.revision + 1) {
				throw new EducationModeError("ARTIFACT_REVISION_CONFLICT", value.artifactId);
			}
			this.database
				.prepare(
					"INSERT INTO visual_artifact_revision (artifact_id, revision, course_version_id, session_id, mode_pack_content_hash, status, content_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					value.artifactId,
					value.revision,
					value.courseVersionId,
					value.sessionId,
					value.modePackContentHash,
					value.status,
					value.contentHash,
					JSON.stringify(value),
					value.createdAt,
				);
			return structuredClone(value);
		});
	}
}

export function parseVisualArtifactRevision(value: unknown): VisualArtifactRevision {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new EducationModeError("INVALID_ARTIFACT", "Visual artifact must be an object");
	}
	const item = value as Record<string, unknown>;
	const fields = [
		"version",
		"artifactId",
		"revision",
		"courseVersionId",
		"sessionId",
		"modePackContentHash",
		"status",
		"spec",
		"receipt",
		"result",
		"accessibleFallback",
		"createdAt",
		"contentHash",
	];
	for (const key of Object.keys(item)) if (!fields.includes(key)) throw new EducationModeError("UNKNOWN_ARTIFACT_FIELD", key);
	for (const key of fields) if (!(key in item)) throw new EducationModeError("MISSING_ARTIFACT_FIELD", key);
	if (item.version !== 1 || !Number.isInteger(item.revision) || Number(item.revision) < 1) {
		throw new EducationModeError("INVALID_ARTIFACT", "version/revision");
	}
	for (const key of ["artifactId", "courseVersionId", "sessionId", "modePackContentHash", "status", "accessibleFallback", "createdAt", "contentHash"]) {
		if (typeof item[key] !== "string") throw new EducationModeError("INVALID_ARTIFACT", key);
	}
	if (!ID.test(item.artifactId as string) || !HASH.test(item.modePackContentHash as string) || !HASH.test(item.contentHash as string)) {
		throw new EducationModeError("INVALID_ARTIFACT", "identity/hash");
	}
	if (!["draft", "verified", "published"].includes(item.status as string)) throw new EducationModeError("INVALID_ARTIFACT", "status");
	if (!Number.isFinite(Date.parse(item.createdAt as string))) throw new EducationModeError("INVALID_ARTIFACT", "createdAt");
	return structuredClone(item) as unknown as VisualArtifactRevision;
}
