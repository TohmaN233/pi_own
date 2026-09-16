import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentHash, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import type {
	FrozenCheckTarget,
	FrozenLearningTaskAuthorization,
	FrozenResearchTaskAuthorization,
	FrozenTaskAuthorization,
	IndependentReview,
	KnowledgeChange,
	KnowledgeNode,
	KnowledgeNodeEdit,
	KnowledgeNote,
	KnowledgeNoteEdit,
	KnowledgeRelation,
	KnowledgeRelationInput,
	PhaseBinding,
	PlanKind,
	ReadCheckpoint,
	ResearchAnalysisDraft,
	ResearchPlan,
	ResearchPlanInput,
	ResearchResult,
	ResearchResultOrigin,
	ReservationResult,
	RunManifest,
	Scope,
	ScopeGrant,
	SourceChunk,
	SourceReference,
	SourceUpdateAffectedKnowledge,
	SourceUpdateDetails,
	SourceUpdateProposal,
	SourceVersion,
	SourceVersionInput,
	StudyAgentSourceEvidence,
	StudyPaperMap,
	StudyPhase,
	StudyTask,
	StudyTaskAdmission,
	TaskEvent,
	TaskKind,
	TaskStatus,
	TerminalResearchTaskStatus,
	TrustedRunnerContext,
	VersionCheck,
	VisualizationDraft,
	VisualizationDraftInput,
} from "./types.ts";
import {
	assertPhase,
	assertTaskKind,
	assertTaskStatus,
	requiredHash,
	requiredJsonLocator,
	requiredRevision,
	requiredText,
	StudyResearchError,
	validateKnowledgeChange,
	validateManifest,
	validatePlanDetail,
	validateSourceInput,
} from "./validation.ts";

interface ProjectRow {
	revision: number;
	scopeEpoch: number;
}

interface MembershipRow {
	projectId: string;
}

interface PayloadRow {
	payload: string;
	payloadHash: string;
}

interface RelationRow {
	relationId: string;
	projectId: string;
	fromNodeId: string;
	toNodeId: string;
	kind: KnowledgeRelation["kind"];
	revision: number;
	author: KnowledgeRelation["author"];
	manuallyEdited: number;
	sourceId: string | null;
	sourceHash: string | null;
	stale: number;
	requiresReview: number;
	createdAt: string;
}

interface SourceRow {
	sourceId: string;
	sourceRoot: string;
	relativePath: string;
	kind: SourceVersion["kind"];
}

interface CurrentSourceRow extends SourceRow {
	version: number;
	contentHash: string;
	parser: string;
	sourceRole: SourceVersion["sourceRole"];
	diagnosticsJson: string;
	createdAt: string;
}

interface ProposalRecord {
	proposal: SourceUpdateProposal;
	source: SourceVersionInput;
	knowledge: KnowledgeChange;
	/** The expected post-proposal versions detect a human edit before resolution. */
	marked: SourceUpdateAffectedKnowledge;
}

interface KnowledgeSnapshot {
	notes: KnowledgeNote[];
	nodes: KnowledgeNode[];
	relations: KnowledgeRelation[];
}

type VersionedArtifactTarget = FrozenCheckTarget;

export interface StudyResearchHostOptions {
	clock?: () => Date;
}

export interface SourceUpdateInput {
	sourceId: string;
	candidate: SourceVersionInput;
	knowledge: KnowledgeChange;
	changeSummary: string;
	expectedProjectRevision: number;
}

export interface RegisterSourcesResult {
	sources: SourceVersion[];
	created: SourceVersion[];
	idempotent: SourceVersion[];
}

export interface CreatePlanInput {
	plan: ResearchPlanInput;
	expectedProjectRevision: number;
}

export interface RevisePlanInput extends CreatePlanInput {
	planId: string;
	expectedPlanRevision: number;
}

export interface ReserveTaskInput {
	planId: string;
	grantId: string;
	expectedPlanRevision: number;
	dispatchKey: string;
	kind: TaskKind;
	manifest: RunManifest;
	/** Required for validation/review reservations; issued by registerTrustedRunnerContext. */
	producerContextId?: string;
	target?: Omit<FrozenCheckTarget, "executionTaskId" | "executionProducerContextId" | "executionProducerIdentity">;
}

export interface ReserveStudyTaskInput {
	dispatchKey: string;
	kind: TaskKind;
	manifest: RunManifest;
	admission: StudyTaskAdmission;
	producerContextId?: string;
	target?: Omit<FrozenCheckTarget, "executionTaskId" | "executionProducerContextId" | "executionProducerIdentity">;
}

export interface TaskTransitionInput {
	taskId: string;
	expectedTaskRevision: number;
	nextStatus: TaskStatus;
	detail: string;
}

export interface RecordResultInput {
	taskId: string;
	expectedTaskRevision: number;
	classification: ResearchResult["classification"];
	summary: string;
	limitations: string[];
}

/** A new analysis is only created from a frozen execution/theory origin. */
export interface CreateResearchAnalysisInput {
	expectedProjectRevision: number;
	origin: ResearchResultOrigin;
	draft: ResearchAnalysisDraft;
}

/** Subsequent analysis edits are explicit CAS writes and keep the original origin unchanged. */
export interface EditResearchAnalysisInput {
	resultId: string;
	expectedResultRevision: number;
	expectedProjectRevision: number;
	draft: ResearchAnalysisDraft;
}

export interface VersionCheckInput {
	taskId: string;
	expectedTaskRevision: number;
	targetKind: VersionCheck["targetKind"];
	targetId: string;
	targetRevision: number;
	targetHash: string;
	status: VersionCheck["status"];
	findings: string[];
}

export type ReviewInput = VersionCheckInput;

export interface ReviseVisualizationInput {
	visualizationId: string;
	expectedVisualizationRevision: number;
	expectedProjectRevision: number;
	draft: VisualizationDraftInput;
}

export interface RecordFrozenAgentArtifactsInput {
	taskId: string;
	evidence: readonly StudyAgentSourceEvidence[];
	checkpoints: readonly {
		sourceId: string;
		sourceHash: string;
		locator: string;
		note: string;
	}[];
	knowledge: KnowledgeChange;
	/** A paper-map report has no direct chunk payload; this verifies its frozen source scope at commit time. */
	paperMap?: StudyPaperMap;
}

/**
 * Scientific identity is intentionally independent of confirmation/publication workflow metadata.
 * Storage still protects the complete mutable payload with its own payload hash.
 */
export function scientificResultHash(
	result: Pick<
		ResearchResult,
		| "resultId"
		| "projectId"
		| "taskId"
		| "revision"
		| "classification"
		| "summary"
		| "limitations"
		| "claims"
		| "manifest"
	> &
		Partial<Pick<ResearchResult, "claims" | "origin">>,
): string {
	const legacy = !result.origin;
	return contentHash({
		resultId: result.resultId,
		projectId: result.projectId,
		taskId: result.taskId,
		revision: result.revision,
		classification: result.classification,
		summary: result.summary,
		limitations: result.limitations,
		manifest: result.manifest,
		...(legacy ? {} : { claims: result.claims, origin: result.origin }),
	});
}

/**
 * Durable Study/Research domain state in the existing Harness SQLite connection.
 * It deliberately has no process, filesystem, or user-event authentication implementation.
 */
export class StudyResearchHost {
	private readonly database: DatabaseSync;
	private readonly clock: () => Date;
	private transactionSequence = 0;

	constructor(database: DatabaseSync, options: StudyResearchHostOptions = {}) {
		this.database = database;
		this.clock = options.clock ?? (() => new Date());
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_research_project (
				project_id TEXT PRIMARY KEY,
				revision INTEGER NOT NULL,
				scope_epoch INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_phase (
				session_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_source (
				source_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				source_root TEXT NOT NULL,
				relative_path TEXT NOT NULL,
				kind TEXT NOT NULL,
				UNIQUE(project_id, source_root, relative_path)
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_source_version (
				project_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				content_hash TEXT NOT NULL,
				parser TEXT NOT NULL,
				source_role TEXT NOT NULL,
				diagnostics_json TEXT NOT NULL,
				is_current INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY(project_id, source_id, version),
				UNIQUE(project_id, source_id, content_hash)
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_chunk (
				chunk_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				source_hash TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				locator TEXT NOT NULL,
				text TEXT NOT NULL,
				text_hash TEXT NOT NULL,
				created_at TEXT NOT NULL,
				UNIQUE(project_id, source_id, source_hash, ordinal)
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_checkpoint (
				checkpoint_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				source_hash TEXT NOT NULL,
				kind TEXT NOT NULL,
				locator TEXT NOT NULL,
				note TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_note (
				project_id TEXT NOT NULL,
				note_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL,
				PRIMARY KEY(project_id, note_id)
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_node (
				project_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL,
				PRIMARY KEY(project_id, node_id)
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_relation (
				relation_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				from_node_id TEXT NOT NULL,
				to_node_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				revision INTEGER NOT NULL DEFAULT 1,
				author TEXT NOT NULL DEFAULT 'unknown',
				manually_edited INTEGER NOT NULL DEFAULT 0,
				source_id TEXT,
				source_hash TEXT,
				stale INTEGER NOT NULL DEFAULT 0,
				requires_review INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_source_update (
				proposal_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_source_backup (
				proposal_id TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_plan (
				plan_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_grant (
				grant_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_task (
				task_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				dispatch_key TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL,
				UNIQUE(project_id, dispatch_key)
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_task_event (
				event_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				task_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_runner_context (
				context_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_result (
				result_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				task_id TEXT NOT NULL UNIQUE,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_result_history (
				result_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				revision INTEGER NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL,
				PRIMARY KEY(result_id, revision)
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_validation (
				check_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_review (
				check_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_research_visualization (
				visualization_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
		`);
		this.ensureRelationColumn("revision", "INTEGER NOT NULL DEFAULT 1");
		this.ensureRelationColumn("author", "TEXT NOT NULL DEFAULT 'unknown'");
		this.ensureRelationColumn("manually_edited", "INTEGER NOT NULL DEFAULT 0");
		this.ensureRelationColumn("source_id", "TEXT");
		this.ensureRelationColumn("source_hash", "TEXT");
		this.ensureRelationColumn("stale", "INTEGER NOT NULL DEFAULT 0");
		this.ensureRelationColumn("requires_review", "INTEGER NOT NULL DEFAULT 1");
	}

	bindSession(projectId: string, sessionId: string, phase: StudyPhase = "study"): PhaseBinding {
		requiredText(projectId, "projectId", 128);
		requiredText(sessionId, "sessionId", 128);
		assertPhase(phase);
		return this.transaction(() => {
			this.assertProjectMembership(projectId, sessionId);
			this.ensureProject(projectId);
			const prior = this.phaseForSession(sessionId);
			if (prior) {
				if (prior.projectId !== projectId) {
					throw new StudyResearchError("SESSION_PROJECT_CONFLICT", "session is already bound to another project");
				}
				return prior;
			}
			const binding: PhaseBinding = {
				projectId,
				sessionId,
				phase,
				revision: 1,
				changedAt: this.timestamp(),
			};
			this.savePayload("pi_study_research_phase", "session_id", sessionId, binding, projectId, binding.revision);
			return this.copy(binding);
		});
	}

	getPhase(scope: Scope): PhaseBinding {
		return this.copy(this.assertScope(scope));
	}

	/** Read-only bootstrap lookup for an already-bound session; it still verifies shared project membership. */
	currentPhase(projectId: string, sessionId: string): PhaseBinding | null {
		requiredText(projectId, "projectId", 128);
		requiredText(sessionId, "sessionId", 128);
		this.assertProjectMembership(projectId, sessionId);
		const binding = this.phaseForSession(sessionId);
		if (binding && binding.projectId !== projectId) {
			throw new StudyResearchError("SESSION_PROJECT_CONFLICT", "session phase binding belongs to another project");
		}
		return binding ? this.copy(binding) : null;
	}

	/**
	 * The authenticated Host adapter mints this durable identity before task reservation.
	 * This package cannot authenticate UI events; Agent callback parameters never create one.
	 */
	registerTrustedRunnerContext(scope: Scope, producerIdentity: string): TrustedRunnerContext {
		return this.transaction(() => {
			this.assertScope(scope);
			requiredText(producerIdentity, "producerIdentity", 256);
			const context: TrustedRunnerContext = {
				contextId: this.newId("runner-context"),
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				producerIdentity: producerIdentity.trim(),
				createdAt: this.timestamp(),
			};
			this.savePayload(
				"pi_study_research_runner_context",
				"context_id",
				context.contextId,
				context,
				scope.projectId,
			);
			return this.copy(context);
		});
	}

	setPhase(scope: Scope, nextPhase: StudyPhase): PhaseBinding {
		assertPhase(nextPhase);
		return this.transaction(() => {
			const current = this.assertScope(scope);
			if (current.phase === nextPhase) return this.copy(current);
			const next: PhaseBinding = {
				...current,
				phase: nextPhase,
				revision: current.revision + 1,
				changedAt: this.timestamp(),
			};
			const result = this.database
				.prepare(
					"UPDATE pi_study_research_phase SET revision = ?, payload = ?, payload_hash = ? WHERE session_id = ? AND project_id = ? AND revision = ?",
				)
				.run(
					next.revision,
					stableStringify(next),
					contentHash(next),
					current.sessionId,
					current.projectId,
					current.revision,
				);
			if (result.changes !== 1) throw new StudyResearchError("PHASE_CONFLICT", "phase changed before saving");
			return this.copy(next);
		});
	}

	registerSource(scope: Scope, input: SourceVersionInput, expectedProjectRevision: number): SourceVersion {
		return this.registerSources(scope, [input], expectedProjectRevision).sources[0];
	}

	/**
	 * Import a user-selected document set atomically. Existing identical versions are
	 * idempotent; a changed linked identity must go through the reviewable update flow.
	 */
	registerSources(
		scope: Scope,
		inputs: readonly SourceVersionInput[],
		expectedProjectRevision: number,
	): RegisterSourcesResult {
		if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 10_000) {
			throw new StudyResearchError("INVALID_INPUT", "sources must be a non-empty bounded array");
		}
		const valid = inputs.map((input) => validateSourceInput(input));
		const identities = new Set<string>();
		for (const source of valid) {
			const identity = `${source.sourceRoot}\u0000${source.relativePath}`;
			if (identities.has(identity))
				throw new StudyResearchError("DUPLICATE_VALUE", "source import has duplicate identities");
			identities.add(identity);
		}
		return this.transaction(() => {
			this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, expectedProjectRevision);
			const now = this.timestamp();
			const sources: SourceVersion[] = [];
			const created: SourceVersion[] = [];
			const idempotent: SourceVersion[] = [];
			for (const sourceInput of valid) {
				const existing = this.database
					.prepare(
						"SELECT source_id AS sourceId, source_root AS sourceRoot, relative_path AS relativePath, kind FROM pi_study_research_source WHERE project_id = ? AND source_root = ? AND relative_path = ?",
					)
					.get(scope.projectId, sourceInput.sourceRoot, sourceInput.relativePath) as SourceRow | undefined;
				if (existing) {
					const current = this.currentSource(scope.projectId, existing.sourceId);
					if (current.contentHash !== sourceInput.contentHash) {
						throw new StudyResearchError(
							"SOURCE_UPDATE_REQUIRED",
							"changed source identity requires a source update proposal",
						);
					}
					const restored = this.sourceVersionFromRow(scope.projectId, current, true);
					sources.push(restored);
					idempotent.push(restored);
					continue;
				}
				const sourceId = this.newId("source");
				this.database
					.prepare(
						"INSERT INTO pi_study_research_source (source_id, project_id, source_root, relative_path, kind) VALUES (?, ?, ?, ?, ?)",
					)
					.run(sourceId, scope.projectId, sourceInput.sourceRoot, sourceInput.relativePath, sourceInput.kind);
				const saved = this.insertSourceVersion(scope.projectId, sourceId, 1, true, sourceInput, now);
				sources.push(saved);
				created.push(saved);
			}
			if (created.length > 0) this.advanceProject(scope.projectId, expectedProjectRevision, false);
			return { sources: this.copy(sources), created: this.copy(created), idempotent: this.copy(idempotent) };
		});
	}

	listSources(scope: Scope): SourceVersion[] {
		this.assertScope(scope);
		return (
			this.database
				.prepare(
					"SELECT s.source_id AS sourceId, s.source_root AS sourceRoot, s.relative_path AS relativePath, s.kind, v.version, v.content_hash AS contentHash, v.parser, v.source_role AS sourceRole, v.diagnostics_json AS diagnosticsJson, v.created_at AS createdAt FROM pi_study_research_source s JOIN pi_study_research_source_version v ON v.project_id = s.project_id AND v.source_id = s.source_id WHERE s.project_id = ? ORDER BY s.source_root, s.relative_path, v.version",
				)
				.all(scope.projectId) as unknown as CurrentSourceRow[]
		).map((row) =>
			this.sourceVersionFromRow(
				scope.projectId,
				row,
				this.isCurrentSource(scope.projectId, row.sourceId, row.version),
			),
		);
	}

	listChunks(scope: Scope, sourceId: string, sourceHash: string): SourceChunk[] {
		this.assertScope(scope);
		requiredText(sourceId, "sourceId", 128);
		requiredHash(sourceHash, "sourceHash");
		this.assertSourceVersion(scope.projectId, sourceId, sourceHash);
		const chunks = this.database
			.prepare(
				"SELECT chunk_id AS chunkId, project_id AS projectId, source_id AS sourceId, source_hash AS sourceHash, ordinal, locator, text, text_hash AS textHash, created_at AS createdAt FROM pi_study_research_chunk WHERE project_id = ? AND source_id = ? AND source_hash = ? ORDER BY ordinal",
			)
			.all(scope.projectId, sourceId, sourceHash) as unknown as SourceChunk[];
		return chunks.map((chunk) => this.assertChunkIntegrity(chunk));
	}

	readChunks(
		scope: Scope,
		sourceId: string,
		sourceHash: string,
		offset: number,
		limit: number,
	): { chunks: SourceChunk[]; nextOffset: number | null } {
		this.assertScope(scope);
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new StudyResearchError("INVALID_PAGE", "chunk offset and limit are invalid");
		}
		requiredText(sourceId, "sourceId", 128);
		requiredHash(sourceHash, "sourceHash");
		this.assertSourceVersion(scope.projectId, sourceId, sourceHash);
		const chunks = (
			this.database
				.prepare(
					"SELECT chunk_id AS chunkId, project_id AS projectId, source_id AS sourceId, source_hash AS sourceHash, ordinal, locator, text, text_hash AS textHash, created_at AS createdAt FROM pi_study_research_chunk WHERE project_id = ? AND source_id = ? AND source_hash = ? ORDER BY ordinal LIMIT ? OFFSET ?",
				)
				.all(scope.projectId, sourceId, sourceHash, limit, offset) as unknown as SourceChunk[]
		).map((chunk) => this.assertChunkIntegrity(chunk));
		const total = this.database
			.prepare(
				"SELECT COUNT(*) AS count FROM pi_study_research_chunk WHERE project_id = ? AND source_id = ? AND source_hash = ?",
			)
			.get(scope.projectId, sourceId, sourceHash) as { count: number };
		const nextOffset = offset + chunks.length < total.count ? offset + chunks.length : null;
		return { chunks, nextOffset };
	}

	/**
	 * Admission-time source validation for the agent queue. The queue retains these
	 * exact source/hash/locator triples and never receives a local source path.
	 */
	assertStudyAgentEvidence(scope: Scope, evidence: readonly StudyAgentSourceEvidence[]): StudyAgentSourceEvidence[] {
		return this.transaction(() => {
			this.assertScope(scope);
			return this.copy(this.validateStudyAgentEvidence(scope.projectId, evidence));
		});
	}

	/**
	 * Review reports normally cite frozen source chunks. A TheoryPlan or terminal-run
	 * result can instead be reviewed from its already-validated immutable plan/code/output
	 * packet, so its exact reserved result target is the only case allowed to carry no
	 * source evidence. This does not accept an empty evidence list for any other report.
	 */
	assertStudyAgentReviewEvidence(
		scope: Scope,
		evidence: readonly StudyAgentSourceEvidence[],
		target: Pick<VersionCheck, "targetKind" | "targetId" | "targetRevision" | "targetHash">,
	): StudyAgentSourceEvidence[] {
		return this.transaction(() => {
			this.assertScope(scope);
			return this.copy(this.validateStudyAgentReviewEvidence(scope.projectId, evidence, target));
		});
	}

	/**
	 * Background Agent reports retain their reservation-time authorization. This
	 * method intentionally verifies membership but does not consult the current
	 * interactive phase, so a later Study/Research switch cannot discard work.
	 */
	recordFrozenAgentArtifacts(input: RecordFrozenAgentArtifactsInput): void {
		this.transaction(() => {
			requiredText(input.taskId, "agent taskId", 128);
			const task = this.readTask(input.taskId);
			if (!["reading", "paper-map", "review", "explanation"].includes(task.kind)) {
				throw new StudyResearchError(
					"INVALID_AGENT_TASK",
					"only reading, paper-map, review, and explanation tasks accept Agent reports",
				);
			}
			if (task.producerContextId === null) {
				throw new StudyResearchError(
					"TRUSTED_PRODUCER_REQUIRED",
					"Agent reports require a trusted producer context",
				);
			}
			this.readTrustedRunnerContext(task.producerContextId);
			this.assertProjectMembership(task.projectId, task.authorization.sessionId);
			if (task.target !== null) {
				const currentTarget = this.assertVersionTarget(
					task.projectId,
					task.target.targetKind,
					task.target.targetId,
					task.target.targetRevision,
					task.target.targetHash,
				);
				if (stableStringify(currentTarget) !== stableStringify(task.target)) {
					throw new StudyResearchError(
						"AGENT_TARGET_CONFLICT",
						"Agent target producer provenance changed after reservation",
					);
				}
			}
			// A frozen report may only create fresh artifacts from the source versions
			// that are current at commit time. Historical chunks remain readable for
			// audit/reconciliation, but accepting an update must make an old report
			// fail before it can write checkpoints or knowledge.
			const paperMap = task.kind === "paper-map" ? this.validatePaperMap(task.projectId, input.paperMap) : undefined;
			if (task.kind === "paper-map" && input.evidence.length !== 0) {
				throw new StudyResearchError(
					"AGENT_EVIDENCE_CONFLICT",
					"paper-map reports retain report links, not copied source chunks",
				);
			}
			const evidence =
				task.kind === "paper-map"
					? []
					: task.kind === "review" && task.target !== null
						? this.validateStudyAgentReviewEvidence(task.projectId, input.evidence, task.target)
						: this.validateStudyAgentEvidence(task.projectId, input.evidence, true);
			const evidenceKeys = new Set(evidence.map((item) => this.studyAgentEvidenceKey(item)));
			const evidenceSourceKeys = new Set(evidence.map((item) => this.studyAgentSourceKey(item)));
			if (!Array.isArray(input.checkpoints) || input.checkpoints.length > evidence.length) {
				throw new StudyResearchError(
					"INVALID_AGENT_CHECKPOINT",
					"Agent checkpoints must be bounded by frozen evidence",
				);
			}
			const checkpointKeys = new Set<string>();
			for (const checkpointInput of input.checkpoints) {
				requiredText(checkpointInput.sourceId, "agent checkpoint.sourceId", 128);
				requiredHash(checkpointInput.sourceHash, "agent checkpoint.sourceHash");
				requiredJsonLocator(checkpointInput.locator, "agent checkpoint.locator");
				requiredText(checkpointInput.note, "agent checkpoint.note", 20_000);
				const checkpointKey = this.studyAgentEvidenceKey({
					sourceId: checkpointInput.sourceId,
					sourceHash: checkpointInput.sourceHash,
					locator: checkpointInput.locator,
				});
				if (!evidenceKeys.has(checkpointKey) || checkpointKeys.has(checkpointKey)) {
					throw new StudyResearchError(
						"AGENT_SOURCE_CONFLICT",
						"checkpoint must use each frozen report evidence at most once",
					);
				}
				checkpointKeys.add(checkpointKey);
				this.database
					.prepare("INSERT INTO pi_study_research_checkpoint VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
					.run(
						this.newId("checkpoint"),
						task.projectId,
						task.authorization.sessionId,
						checkpointInput.sourceId,
						checkpointInput.sourceHash,
						"read",
						checkpointInput.locator,
						checkpointInput.note.trim(),
						this.timestamp(),
					);
			}
			const knowledge = validateKnowledgeChange(input.knowledge);
			if (
				paperMap &&
				(input.checkpoints.length !== 0 ||
					knowledge.nodes.length !== 0 ||
					knowledge.notes.length !== 0 ||
					knowledge.relations.length !== 0)
			) {
				throw new StudyResearchError(
					"PAPER_MAP_ARTIFACT_CONFLICT",
					"paper-map reports cannot create checkpoints or knowledge artifacts",
				);
			}
			if (
				evidence.length === 0 &&
				(knowledge.nodes.length > 0 || knowledge.notes.length > 0 || knowledge.relations.length > 0)
			) {
				throw new StudyResearchError(
					"EMPTY_REVIEW_EVIDENCE_KNOWLEDGE_FORBIDDEN",
					"a source-free result review may retain findings only; it cannot create knowledge artifacts",
				);
			}
			for (const node of knowledge.nodes) {
				if (node.manuallyEdited || node.replaceNodeId !== undefined) {
					throw new StudyResearchError(
						"AGENT_HUMAN_EDIT_FORBIDDEN",
						"Agent reports may only append automatic nodes",
					);
				}
				this.assertAgentKnowledgeSource(node.sourceId, node.sourceHash, evidenceSourceKeys, "node");
			}
			for (const note of knowledge.notes) {
				if (note.author !== "agent" || note.replaceNoteId !== undefined) {
					throw new StudyResearchError(
						"AGENT_HUMAN_EDIT_FORBIDDEN",
						"Agent reports may only append automatic notes",
					);
				}
				this.assertAgentKnowledgeSource(note.sourceId, note.sourceHash, evidenceSourceKeys, "note");
			}
			if (knowledge.nodes.length > 0 || knowledge.notes.length > 0 || knowledge.relations.length > 0) {
				this.appendKnowledge(task.projectId, knowledge);
				const advanced = this.database
					.prepare("UPDATE pi_study_research_project SET revision = revision + 1 WHERE project_id = ?")
					.run(task.projectId);
				if (advanced.changes !== 1)
					throw new StudyResearchError("CORRUPT_STATE", "Agent knowledge update lost its project state");
			}
		});
	}

	saveReadCheckpoint(
		scope: Scope,
		input: Omit<ReadCheckpoint, "checkpointId" | "projectId" | "sessionId" | "createdAt">,
	): ReadCheckpoint {
		return this.transaction(() => {
			this.assertScope(scope);
			requiredText(input.sourceId, "checkpoint.sourceId", 128);
			requiredHash(input.sourceHash, "checkpoint.sourceHash");
			this.assertSourceVersion(scope.projectId, input.sourceId, input.sourceHash);
			if (!["extracted", "read", "checked"].includes(input.kind)) {
				throw new StudyResearchError("INVALID_CHECKPOINT", "checkpoint kind is invalid");
			}
			requiredJsonLocator(input.locator, "checkpoint.locator");
			requiredText(input.note, "checkpoint.note", 20_000);
			const checkpoint: ReadCheckpoint = {
				checkpointId: this.newId("checkpoint"),
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				...input,
				createdAt: this.timestamp(),
			};
			this.database
				.prepare("INSERT INTO pi_study_research_checkpoint VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(
					checkpoint.checkpointId,
					checkpoint.projectId,
					checkpoint.sessionId,
					checkpoint.sourceId,
					checkpoint.sourceHash,
					checkpoint.kind,
					checkpoint.locator,
					checkpoint.note,
					checkpoint.createdAt,
				);
			return checkpoint;
		});
	}

	listReadCheckpoints(scope: Scope, sourceId: string): ReadCheckpoint[] {
		this.assertScope(scope);
		requiredText(sourceId, "sourceId", 128);
		return this.database
			.prepare(
				"SELECT checkpoint_id AS checkpointId, project_id AS projectId, session_id AS sessionId, source_id AS sourceId, source_hash AS sourceHash, kind, locator, note, created_at AS createdAt FROM pi_study_research_checkpoint WHERE project_id = ? AND source_id = ? ORDER BY created_at, checkpoint_id",
			)
			.all(scope.projectId, sourceId) as unknown as ReadCheckpoint[];
	}

	commitKnowledgeChange(scope: Scope, change: KnowledgeChange, expectedProjectRevision: number): KnowledgeSnapshot {
		const valid = validateKnowledgeChange(change);
		return this.transaction(() => {
			this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, expectedProjectRevision);
			this.assertKnowledgeSources(scope.projectId, valid);
			this.appendKnowledge(scope.projectId, valid);
			this.advanceProject(scope.projectId, expectedProjectRevision, false);
			return this.copy(this.readKnowledge(scope.projectId));
		});
	}

	/** User and agent edits use item-level CAS; a change set cannot overwrite existing knowledge. */
	editKnowledgeNote(scope: Scope, input: KnowledgeNoteEdit): KnowledgeNote {
		return this.transaction(() => {
			this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			requiredText(input.noteId, "noteId", 128);
			requiredRevision(input.expectedNoteRevision, "expectedNoteRevision");
			requiredText(input.body, "note.body", 200_000);
			this.assertSourceBinding(scope.projectId, input.sourceId, input.sourceHash, "note");
			if (!Array.isArray(input.nodeIds) || input.nodeIds.length > 1_000) {
				throw new StudyResearchError("INVALID_NOTE", "note nodeIds must be a bounded array");
			}
			for (const nodeId of input.nodeIds) this.readNode(scope.projectId, requiredText(nodeId, "note.nodeId", 128));
			const current = this.readNote(scope.projectId, input.noteId);
			if (current.revision !== input.expectedNoteRevision) {
				throw new StudyResearchError("KNOWLEDGE_CONFLICT", "note changed before saving");
			}
			const raw = {
				...current,
				revision: current.revision + 1,
				manuallyEdited: true,
				body: input.body.trim(),
				sourceId: input.sourceId,
				sourceHash: input.sourceHash,
				nodeIds: [...input.nodeIds],
				stale: !this.isCurrentSourceBinding(scope.projectId, input.sourceId, input.sourceHash),
				updatedAt: this.timestamp(),
			};
			const { contentHash: _hash, ...withoutHash } = raw;
			const next: KnowledgeNote = { ...withoutHash, contentHash: contentHash(withoutHash) };
			this.saveEntity("pi_study_research_note", "note_id", next.noteId, scope.projectId, next);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, false);
			return this.copy(next);
		});
	}

	editKnowledgeNode(scope: Scope, input: KnowledgeNodeEdit): KnowledgeNode {
		return this.transaction(() => {
			this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			requiredText(input.nodeId, "nodeId", 128);
			requiredRevision(input.expectedNodeRevision, "expectedNodeRevision");
			if (!["concept", "claim", "proof", "assumption", "implementation", "question"].includes(input.kind)) {
				throw new StudyResearchError("INVALID_NODE", "node kind is invalid");
			}
			requiredText(input.title, "node.title", 2_000);
			requiredText(input.statement, "node.statement", 200_000);
			requiredText(input.scope, "node.scope", 4_000);
			if (typeof input.manuallyEdited !== "boolean")
				throw new StudyResearchError("INVALID_NODE", "node manuallyEdited must be boolean");
			this.assertSourceBinding(scope.projectId, input.sourceId, input.sourceHash, "node");
			const current = this.readNode(scope.projectId, input.nodeId);
			if (current.revision !== input.expectedNodeRevision) {
				throw new StudyResearchError("KNOWLEDGE_CONFLICT", "knowledge node changed before saving");
			}
			const raw = {
				...current,
				revision: current.revision + 1,
				kind: input.kind,
				title: input.title.trim(),
				statement: input.statement.trim(),
				scope: input.scope.trim(),
				sourceId: input.sourceId,
				sourceHash: input.sourceHash,
				manuallyEdited: input.manuallyEdited,
				stale: !this.isCurrentSourceBinding(scope.projectId, input.sourceId, input.sourceHash),
				updatedAt: this.timestamp(),
			};
			const { contentHash: _hash, ...withoutHash } = raw;
			const next: KnowledgeNode = { ...withoutHash, contentHash: contentHash(withoutHash) };
			this.saveEntity("pi_study_research_node", "node_id", next.nodeId, scope.projectId, next);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, false);
			return this.copy(next);
		});
	}

	addKnowledgeRelation(scope: Scope, input: KnowledgeRelationInput): KnowledgeRelation {
		return this.transaction(() => {
			this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			requiredText(input.fromNodeId, "relation.fromNodeId", 128);
			requiredText(input.toNodeId, "relation.toNodeId", 128);
			if (!["prerequisite", "supports", "contradicts", "refers-to", "implements"].includes(input.kind)) {
				throw new StudyResearchError("INVALID_RELATION", "relation kind is invalid");
			}
			this.readNode(scope.projectId, input.fromNodeId);
			this.readNode(scope.projectId, input.toNodeId);
			if (
				input.kind === "prerequisite" &&
				this.wouldCreatePrerequisiteCycle(scope.projectId, input.fromNodeId, input.toNodeId)
			) {
				throw new StudyResearchError("PREREQUISITE_CYCLE", "prerequisite relations must remain acyclic");
			}
			const relation: KnowledgeRelation = {
				relationId: this.newId("relation"),
				projectId: scope.projectId,
				revision: 1,
				fromNodeId: input.fromNodeId,
				toNodeId: input.toNodeId,
				kind: input.kind,
				author: "user",
				manuallyEdited: true,
				sourceId: null,
				sourceHash: null,
				stale: false,
				requiresReview: false,
				createdAt: this.timestamp(),
			};
			this.saveRelation(relation);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, false);
			return this.copy(relation);
		});
	}

	getKnowledge(scope: Scope): KnowledgeSnapshot {
		this.assertScope(scope);
		return this.copy(this.readKnowledge(scope.projectId));
	}

	proposeSourceUpdate(scope: Scope, input: SourceUpdateInput): SourceUpdateProposal {
		const candidate = validateSourceInput(input.candidate);
		const knowledge = validateKnowledgeChange(input.knowledge);
		return this.transaction(() => {
			this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			requiredText(input.sourceId, "sourceId", 128);
			requiredText(input.changeSummary, "changeSummary", 20_000);
			const source = this.currentSource(scope.projectId, input.sourceId);
			if (
				source.sourceRoot !== candidate.sourceRoot ||
				source.relativePath !== candidate.relativePath ||
				source.kind !== candidate.kind ||
				source.sourceRole !== candidate.sourceRole
			) {
				throw new StudyResearchError(
					"SOURCE_IDENTITY_CONFLICT",
					"source candidates must retain source root, path, kind, and role",
				);
			}
			if (source.contentHash === candidate.contentHash) {
				throw new StudyResearchError("SOURCE_UNCHANGED", "candidate source hash is already current");
			}
			let backup = this.sourceBoundKnowledge(scope.projectId, source.sourceId, source.contentHash);
			this.assertSourceCandidateMapping(
				scope.projectId,
				source.sourceId,
				source.contentHash,
				candidate.contentHash,
				knowledge,
				backup,
			);
			const pending = this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_source_update WHERE project_id = ? AND source_id = ?",
				)
				.all(scope.projectId, input.sourceId) as unknown as PayloadRow[];
			for (const row of pending) {
				const record = this.decode<ProposalRecord>(row, "source update");
				if (record.proposal.status !== "pending") continue;
				try {
					this.assertAffectedUnchanged(scope.projectId, record.marked);
					backup = this.readBackup(record.proposal.proposalId);
				} catch (error) {
					if (!(error instanceof StudyResearchError) || error.code !== "SOURCE_UPDATE_CONFLICT") throw error;
					// The user changed an affected entity. A replacement proposal starts from the current state, not this stale backup.
				}
				this.saveProposal({
					...record,
					proposal: { ...record.proposal, status: "superseded", resolvedAt: this.timestamp() },
				});
				this.deleteBackup(record.proposal.proposalId);
			}
			this.ensureCandidateSourceVersion(scope.projectId, source.sourceId, candidate);
			this.assertKnowledgeSources(scope.projectId, knowledge);
			const proposal: SourceUpdateProposal = {
				proposalId: this.newId("source-update"),
				projectId: scope.projectId,
				sourceId: source.sourceId,
				previousHash: source.contentHash,
				candidateHash: candidate.contentHash,
				baseProjectRevision: input.expectedProjectRevision + 1,
				status: "pending",
				changeSummary: input.changeSummary.trim(),
				createdAt: this.timestamp(),
				resolvedAt: null,
			};
			const marked = this.markSourceKnowledgeStale(scope.projectId, source.sourceId, source.contentHash);
			this.saveProposal({ proposal, source: candidate, knowledge, marked });
			this.saveBackup(proposal.proposalId, backup);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, false);
			return this.copy(proposal);
		});
	}

	acceptSourceUpdate(scope: Scope, proposalId: string, expectedProjectRevision: number): SourceUpdateProposal {
		return this.resolveSourceUpdate(scope, proposalId, expectedProjectRevision, "accepted");
	}

	rejectSourceUpdate(scope: Scope, proposalId: string, expectedProjectRevision: number): SourceUpdateProposal {
		return this.resolveSourceUpdate(scope, proposalId, expectedProjectRevision, "rejected");
	}

	getSourceUpdate(scope: Scope, proposalId: string): SourceUpdateProposal {
		this.assertScope(scope);
		const proposal = this.readProposal(proposalId).proposal;
		if (proposal.projectId !== scope.projectId) {
			throw new StudyResearchError("CROSS_PROJECT", "source update belongs to another project");
		}
		return this.copy(proposal);
	}

	listSourceUpdates(scope: Scope): SourceUpdateProposal[] {
		this.assertScope(scope);
		const rows = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_source_update WHERE project_id = ? ORDER BY proposal_id",
			)
			.all(scope.projectId) as unknown as PayloadRow[];
		return rows.map((row) => this.copy(this.decode<ProposalRecord>(row, "source update").proposal));
	}

	getSourceUpdateDetails(scope: Scope, proposalId: string): SourceUpdateDetails {
		this.assertScope(scope);
		const record = this.readProposal(proposalId);
		if (record.proposal.projectId !== scope.projectId) {
			throw new StudyResearchError("CROSS_PROJECT", "source update belongs to another project");
		}
		return this.copy({
			proposal: record.proposal,
			candidate: this.sourceVersionFor(scope.projectId, record.proposal.sourceId, record.proposal.candidateHash),
			candidateKnowledge: record.knowledge,
			affected: record.proposal.status === "pending" ? this.readBackup(record.proposal.proposalId) : record.marked,
		});
	}

	createVisualizationDraft(
		scope: Scope,
		draft: VisualizationDraftInput,
		expectedProjectRevision: number,
	): VisualizationDraft {
		return this.transaction(() => {
			const phase = this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, expectedProjectRevision);
			const creator = this.requireTrustedRunnerContext(scope, draft.creatorContextId, "visualization creator");
			const visualization = this.makeVisualization(
				scope.projectId,
				this.newId("visualization"),
				1,
				phase.phase,
				draft,
				creator,
				this.timestamp(),
				this.timestamp(),
			);
			this.savePayload(
				"pi_study_research_visualization",
				"visualization_id",
				visualization.visualizationId,
				visualization,
				scope.projectId,
			);
			this.advanceProject(scope.projectId, expectedProjectRevision, false);
			return this.copy(visualization);
		});
	}

	reviseVisualizationDraft(scope: Scope, input: ReviseVisualizationInput): VisualizationDraft {
		return this.transaction(() => {
			const phase = this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			const current = this.readVisualization(scope.projectId, input.visualizationId);
			if (current.revision !== input.expectedVisualizationRevision) {
				throw new StudyResearchError("VISUALIZATION_CONFLICT", "visualization changed before saving");
			}
			const creator = this.requireTrustedRunnerContext(scope, input.draft.creatorContextId, "visualization creator");
			const next = this.makeVisualization(
				scope.projectId,
				current.visualizationId,
				current.revision + 1,
				phase.phase,
				input.draft,
				creator,
				current.createdAt,
				this.timestamp(),
			);
			this.savePayload(
				"pi_study_research_visualization",
				"visualization_id",
				next.visualizationId,
				next,
				scope.projectId,
			);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, false);
			return this.copy(next);
		});
	}

	getVisualizationDraft(scope: Scope, visualizationId: string): VisualizationDraft {
		this.assertScope(scope);
		return this.copy(this.readVisualization(scope.projectId, visualizationId));
	}

	listVisualizations(scope: Scope): VisualizationDraft[] {
		this.assertScope(scope);
		const rows = this.database
			.prepare(
				"SELECT visualization_id AS id FROM pi_study_research_visualization WHERE project_id = ? ORDER BY visualization_id",
			)
			.all(scope.projectId) as { id: string }[];
		return rows.map((row) => this.copy(this.readVisualization(scope.projectId, row.id)));
	}

	listResearchPlans(scope: Scope): ResearchPlan[] {
		this.assertScope(scope);
		const rows = this.database
			.prepare("SELECT plan_id AS id FROM pi_study_research_plan WHERE project_id = ? ORDER BY plan_id")
			.all(scope.projectId) as { id: string }[];
		return rows.map((row) => this.copy(this.readPlan(scope.projectId, row.id)));
	}

	createResearchPlan(scope: Scope, input: CreatePlanInput): ResearchPlan {
		return this.transaction(() => {
			this.assertResearchScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			const plan = this.makePlan(
				scope.projectId,
				this.newId("plan"),
				1,
				input.plan,
				this.timestamp(),
				this.timestamp(),
			);
			this.savePayload("pi_study_research_plan", "plan_id", plan.planId, plan, scope.projectId);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, true);
			return this.copy(plan);
		});
	}

	reviseResearchPlan(scope: Scope, input: RevisePlanInput): ResearchPlan {
		return this.transaction(() => {
			this.assertResearchScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			const current = this.readPlan(scope.projectId, input.planId);
			if (current.revision !== input.expectedPlanRevision) {
				throw new StudyResearchError("PLAN_CONFLICT", "research plan changed before saving");
			}
			const next = this.makePlan(
				scope.projectId,
				current.planId,
				current.revision + 1,
				input.plan,
				current.createdAt,
				this.timestamp(),
			);
			this.savePayload("pi_study_research_plan", "plan_id", next.planId, next, scope.projectId);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, true);
			return this.copy(next);
		});
	}

	getResearchPlan(scope: Scope, planId: string): ResearchPlan {
		this.assertScope(scope);
		return this.copy(this.readPlan(scope.projectId, planId));
	}

	grantScopeFromTrustedUserEvent(
		scope: Scope,
		planId: string,
		expectedPlanRevision: number,
		userEventId: string,
		expiresAt: string,
	): ScopeGrant {
		return this.transaction(() => {
			this.assertResearchScope(scope);
			requiredText(userEventId, "userEventId", 256);
			if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.clock().getTime()) {
				throw new StudyResearchError("INVALID_EXPIRY", "grant expiry must be in the future");
			}
			const plan = this.readPlan(scope.projectId, planId);
			if (plan.revision !== expectedPlanRevision) {
				throw new StudyResearchError("PLAN_CONFLICT", "research plan changed before approval");
			}
			const grant: ScopeGrant = {
				grantId: this.newId("scope-grant"),
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				planId,
				planRevision: plan.revision,
				semanticDigest: plan.semanticDigest,
				scopeEpoch: this.projectState(scope.projectId).scopeEpoch,
				referencedSources: this.currentSourceBindings(scope.projectId, plan),
				userEventId,
				expiresAt,
				revokedAt: null,
				createdAt: this.timestamp(),
			};
			this.savePayload("pi_study_research_grant", "grant_id", grant.grantId, grant, scope.projectId);
			return this.copy(grant);
		});
	}

	revokeScopeGrant(scope: Scope, grantId: string): ScopeGrant {
		return this.transaction(() => {
			this.assertScope(scope);
			const grant = this.readGrant(scope.projectId, grantId);
			if (grant.revokedAt !== null) return this.copy(grant);
			const revoked = { ...grant, revokedAt: this.timestamp() };
			this.savePayload("pi_study_research_grant", "grant_id", grantId, revoked, scope.projectId);
			return this.copy(revoked);
		});
	}

	/**
	 * Revalidates a queued Research task's frozen plan and grant without consulting the
	 * interactive phase. Queue admission uses this as a read-only integrity gate; it
	 * cannot mint, renew, or otherwise change authorization.
	 */
	assertFrozenResearchAuthorizationCurrent(authorization: FrozenResearchTaskAuthorization): void {
		const normalized = this.normalizeTaskAuthorization(authorization);
		if (normalized.kind !== "research-grant") {
			throw new StudyResearchError("RESEARCH_AUTHORIZATION_REQUIRED", "authorization is not a Research grant");
		}
		this.assertProjectMembership(normalized.projectId, normalized.sessionId);
		const plan = this.readPlan(normalized.projectId, normalized.planId);
		if (plan.revision !== normalized.planRevision || plan.semanticDigest !== normalized.semanticDigest) {
			throw new StudyResearchError("GRANT_STALE", "frozen Research plan no longer matches its approved scope");
		}
		const grant = this.readGrant(normalized.projectId, normalized.grantId);
		this.assertGrantCurrent(grant, plan, normalized.sessionId);
	}

	reserveTask(scope: Scope, input: ReserveTaskInput): ReservationResult {
		const manifest = validateManifest(input.manifest);
		assertTaskKind(input.kind);
		return this.transaction(() => {
			const phase = this.assertResearchScope(scope);
			requiredText(input.dispatchKey, "dispatchKey", 256);
			const producerContextId = this.resolveProducerContext(scope, input.producerContextId);
			const target = this.reserveCheckTarget(scope.projectId, input.kind, input.target);
			this.assertCheckProducer(input.kind, producerContextId);
			this.assertExecutionProducer(input.kind, producerContextId);
			const fingerprint = contentHash({
				planId: input.planId,
				grantId: input.grantId,
				kind: input.kind,
				manifest,
				producerContextId,
				target,
			});
			const replay = this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_task WHERE project_id = ? AND dispatch_key = ?",
				)
				.get(scope.projectId, input.dispatchKey) as PayloadRow | undefined;
			if (replay) {
				const task = this.decodeTask(replay);
				if (task.authorization.sessionId !== scope.sessionId)
					throw new StudyResearchError("IDEMPOTENCY_CONFLICT", "dispatch key belongs to a different session");
				if (task.dispatchFingerprint !== fingerprint) {
					throw new StudyResearchError("IDEMPOTENCY_CONFLICT", "dispatch key was reused for a different task");
				}
				return { task: this.copy(task), replay: true };
			}
			const plan = this.readPlan(scope.projectId, input.planId);
			if (plan.revision !== input.expectedPlanRevision) {
				throw new StudyResearchError("PLAN_CONFLICT", "research plan changed before task reservation");
			}
			const grant = this.readGrant(scope.projectId, input.grantId);
			this.assertGrantCurrent(grant, plan, phase.sessionId);
			const task: StudyTask = {
				taskId: this.newId("task"),
				projectId: scope.projectId,
				dispatchKey: input.dispatchKey,
				dispatchFingerprint: fingerprint,
				kind: input.kind,
				status: "queued",
				revision: 1,
				authorization: {
					kind: "research-grant",
					projectId: scope.projectId,
					sessionId: scope.sessionId,
					phase: "research",
					phaseRevision: phase.revision,
					grantId: grant.grantId,
					planId: plan.planId,
					planRevision: plan.revision,
					semanticDigest: plan.semanticDigest,
				},
				manifest,
				producerContextId,
				target,
				createdAt: this.timestamp(),
				updatedAt: this.timestamp(),
			};
			this.savePayload(
				"pi_study_research_task",
				"task_id",
				task.taskId,
				task,
				scope.projectId,
				undefined,
				input.dispatchKey,
			);
			this.addTaskEvent(task, "queued", "reserved");
			return { task: this.copy(task), replay: false };
		});
	}

	reserveStudyTask(scope: Scope, input: ReserveStudyTaskInput): ReservationResult {
		const manifest = validateManifest(input.manifest);
		assertTaskKind(input.kind);
		return this.transaction(() => {
			const phase = this.assertScope(scope);
			requiredText(input.dispatchKey, "dispatchKey", 256);
			const admission = this.validateStudyAdmission(input.admission);
			const producerContextId = this.resolveProducerContext(scope, input.producerContextId);
			const target = this.reserveCheckTarget(scope.projectId, input.kind, input.target);
			this.assertCheckProducer(input.kind, producerContextId);
			this.assertExecutionProducer(input.kind, producerContextId);
			const fingerprint = contentHash({ kind: input.kind, manifest, admission, producerContextId, target });
			const replay = this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_task WHERE project_id = ? AND dispatch_key = ?",
				)
				.get(scope.projectId, input.dispatchKey) as PayloadRow | undefined;
			if (replay) {
				const task = this.decodeTask(replay);
				if (task.authorization.sessionId !== scope.sessionId)
					throw new StudyResearchError("IDEMPOTENCY_CONFLICT", "dispatch key belongs to a different session");
				if (task.dispatchFingerprint !== fingerprint) {
					throw new StudyResearchError(
						"IDEMPOTENCY_CONFLICT",
						"dispatch key was reused for a different Study task",
					);
				}
				return { task: this.copy(task), replay: true };
			}
			const authorization: FrozenLearningTaskAuthorization = {
				kind: "learning",
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				phase: phase.phase,
				phaseRevision: phase.revision,
				admission,
			};
			const task: StudyTask = {
				taskId: this.newId("task"),
				projectId: scope.projectId,
				dispatchKey: input.dispatchKey,
				dispatchFingerprint: fingerprint,
				kind: input.kind,
				status: "queued",
				revision: 1,
				authorization,
				manifest,
				producerContextId,
				target,
				createdAt: this.timestamp(),
				updatedAt: this.timestamp(),
			};
			this.savePayload(
				"pi_study_research_task",
				"task_id",
				task.taskId,
				task,
				scope.projectId,
				undefined,
				input.dispatchKey,
			);
			this.addTaskEvent(task, "queued", "reserved from bounded learning admission");
			return { task: this.copy(task), replay: false };
		});
	}

	transitionTaskFromFrozenAuthorization(input: TaskTransitionInput): StudyTask {
		assertTaskStatus(input.nextStatus);
		return this.transaction(() => {
			const task = this.readTask(input.taskId);
			if (task.revision !== input.expectedTaskRevision) {
				throw new StudyResearchError("TASK_CONFLICT", "task changed before callback");
			}
			if (!this.canTransition(task.status, input.nextStatus)) {
				throw new StudyResearchError(
					"INVALID_TASK_TRANSITION",
					`${task.status} cannot transition to ${input.nextStatus}`,
				);
			}
			if (
				task.status === "queued" &&
				input.nextStatus === "admitted" &&
				task.authorization.kind === "research-grant"
			) {
				this.assertFrozenResearchAuthorizationCurrent(task.authorization);
			}
			requiredText(input.detail, "task event detail", 20_000);
			const next: StudyTask = {
				...task,
				status: input.nextStatus,
				revision: task.revision + 1,
				updatedAt: this.timestamp(),
			};
			const result = this.database
				.prepare(
					"UPDATE pi_study_research_task SET payload = ?, payload_hash = ? WHERE task_id = ? AND project_id = ? AND dispatch_key = ? AND json_extract(payload, '$.revision') = ?",
				)
				.run(
					stableStringify(next),
					contentHash(next),
					task.taskId,
					task.projectId,
					task.dispatchKey,
					task.revision,
				);
			if (result.changes !== 1) throw new StudyResearchError("TASK_CONFLICT", "task changed before callback");
			this.addTaskEvent(next, input.nextStatus, input.detail);
			return this.copy(next);
		});
	}

	listTasks(scope: Scope): StudyTask[] {
		this.assertScope(scope);
		return (
			this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_task WHERE project_id = ? ORDER BY task_id",
				)
				.all(scope.projectId) as unknown as PayloadRow[]
		).map((row) => this.copy(this.decodeTask(row)));
	}

	/**
	 * Trusted coordinator read that deliberately does not require the interactive phase to remain
	 * unchanged. It validates durable payload integrity, frozen task/session identity, and current
	 * membership before returning a task that was already reserved.
	 */
	readTaskForCoordinator(taskId: string): StudyTask {
		requiredText(taskId, "taskId", 128);
		const task = this.readTask(taskId);
		if (task.projectId !== task.authorization.projectId) {
			throw new StudyResearchError("CORRUPT_STATE", "task project differs from its frozen authorization");
		}
		this.assertProjectMembership(task.projectId, task.authorization.sessionId);
		return this.copy(task);
	}

	listTaskEvents(scope: Scope, taskId: string): TaskEvent[] {
		this.assertScope(scope);
		const task = this.readTask(taskId);
		if (task.projectId !== scope.projectId)
			throw new StudyResearchError("CROSS_PROJECT", "task belongs to another project");
		return (
			this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_task_event WHERE project_id = ? AND task_id = ? ORDER BY CAST(json_extract(payload, '$.sequence') AS INTEGER), event_id",
				)
				.all(scope.projectId, taskId) as unknown as PayloadRow[]
		).map((row) => this.copy(this.decode<TaskEvent>(row, "task event")));
	}

	recordResultFromFrozenTask(input: RecordResultInput): ResearchResult {
		return this.transaction(() => {
			const task = this.readTask(input.taskId);
			this.assertFrozenTaskCompletion(task, input.expectedTaskRevision, "execution");
			if (task.authorization.kind !== "research-grant") {
				throw new StudyResearchError(
					"RESEARCH_AUTHORIZATION_REQUIRED",
					"Study executions are not research results",
				);
			}
			if (task.producerContextId === null) {
				throw new StudyResearchError(
					"EXECUTION_PROVENANCE_REQUIRED",
					"Research results require a trusted execution context",
				);
			}
			this.readTrustedRunnerContext(task.producerContextId);
			if (!["positive", "negative", "inconclusive"].includes(input.classification)) {
				throw new StudyResearchError("INVALID_RESULT", "result classification is invalid");
			}
			requiredText(input.summary, "result.summary", 200_000);
			const limitations = this.stringList(input.limitations, "result.limitations");
			const prior = this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_result WHERE task_id = ?",
				)
				.get(task.taskId) as PayloadRow | undefined;
			if (prior) {
				const result = this.decodeResult(prior, "result");
				if (
					result.classification !== input.classification ||
					result.summary !== input.summary.trim() ||
					stableStringify(result.limitations) !== stableStringify(limitations)
				) {
					throw new StudyResearchError("RESULT_CONFLICT", "task already has a different result");
				}
				return this.copy(result);
			}
			const raw = {
				resultId: this.newId("result"),
				projectId: task.projectId,
				taskId: task.taskId,
				revision: 1,
				origin: {
					kind: "legacy-execution" as const,
					taskId: task.taskId,
					taskRevision: task.revision,
					manifest: task.manifest,
				},
				classification: input.classification,
				summary: input.summary.trim(),
				limitations,
				// The legacy API has no separate claim field. Its asserted summary is retained as
				// the one explicit claim so old execution-only callers remain reviewable.
				claims: [input.summary.trim()],
				state: "draft" as const,
				manifest: task.manifest,
				confirmedAt: null,
				confirmedUserEventId: null,
				publishedAt: null,
				createdAt: this.timestamp(),
				updatedAt: this.timestamp(),
			};
			const result: ResearchResult = { ...raw, contentHash: scientificResultHash(raw) };
			this.savePayload("pi_study_research_result", "result_id", result.resultId, result, task.projectId);
			return this.copy(result);
		});
	}

	/**
	 * Creates a Research analysis draft from an immutable terminal run or the
	 * current exact TheoryPlan revision. This never changes task status and
	 * cannot turn a failed/cancelled run into a successful process.
	 */
	createResearchAnalysisDraft(scope: Scope, input: CreateResearchAnalysisInput): ResearchResult {
		return this.transaction(() => {
			this.assertResearchScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			const origin = this.validateResearchResultOrigin(scope, input.origin);
			const draft = this.validateResearchAnalysisDraft(input.draft);
			const storageKey = this.resultStorageKey(origin);
			const prior = this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_result WHERE task_id = ?",
				)
				.get(storageKey) as PayloadRow | undefined;
			if (prior) {
				throw new StudyResearchError(
					"RESULT_ORIGIN_EXISTS",
					"This immutable run or TheoryPlan revision already has an analysis draft",
				);
			}
			const raw = {
				resultId: this.newId("result"),
				projectId: scope.projectId,
				taskId: this.resultTaskId(origin),
				revision: 1,
				origin,
				...draft,
				state: "draft" as const,
				manifest: this.resultManifest(origin),
				confirmedAt: null,
				confirmedUserEventId: null,
				publishedAt: null,
				createdAt: this.timestamp(),
				updatedAt: this.timestamp(),
			};
			const result: ResearchResult = { ...raw, contentHash: scientificResultHash(raw) };
			this.savePayload("pi_study_research_result", "result_id", result.resultId, result, scope.projectId);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, false);
			return this.copy(result);
		});
	}

	/** A result draft is mutable only with both result- and project-level CAS guards. */
	editResearchAnalysisDraft(scope: Scope, input: EditResearchAnalysisInput): ResearchResult {
		return this.transaction(() => {
			this.assertResearchScope(scope);
			this.assertProjectRevision(scope.projectId, input.expectedProjectRevision);
			const current = this.readResult(scope.projectId, input.resultId);
			if (current.revision !== input.expectedResultRevision) {
				throw new StudyResearchError("RESULT_CONFLICT", "result analysis changed before saving");
			}
			if (current.state !== "draft" || current.confirmedAt !== null) {
				throw new StudyResearchError("RESULT_CONFIRMED", "confirmed results are immutable; create a new analysis");
			}
			const draft = this.validateResearchAnalysisDraft(input.draft);
			this.saveResultHistory(current);
			const raw = {
				...current,
				revision: current.revision + 1,
				...draft,
				updatedAt: this.timestamp(),
			};
			const result: ResearchResult = { ...raw, contentHash: scientificResultHash(raw) };
			this.savePayload("pi_study_research_result", "result_id", result.resultId, result, scope.projectId);
			this.advanceProject(scope.projectId, input.expectedProjectRevision, false);
			return this.copy(result);
		});
	}

	recordValidationFromFrozenTask(input: VersionCheckInput): VersionCheck {
		return this.recordVersionCheck("validation", input);
	}

	recordIndependentReviewFromFrozenTask(input: ReviewInput): IndependentReview {
		return this.transaction(() => {
			const task = this.readTask(input.taskId);
			this.assertFrozenTaskCompletion(task, input.expectedTaskRevision, "review");
			const target = this.assertReservedTaskTarget(task, input);
			if (task.producerContextId === null) {
				throw new StudyResearchError(
					"REVIEW_NOT_INDEPENDENT",
					"review must use a trusted context independent from the execution producer",
				);
			}
			const reviewer = this.readTrustedRunnerContext(task.producerContextId);
			if (
				target.executionTaskId === task.taskId ||
				target.executionProducerContextId === task.producerContextId ||
				(target.executionProducerIdentity !== null &&
					target.executionProducerIdentity === reviewer.producerIdentity)
			) {
				throw new StudyResearchError(
					"REVIEW_NOT_INDEPENDENT",
					"review must use an independent context from the execution task",
				);
			}
			const status = this.validateCheckInput(input);
			const review: IndependentReview = {
				checkId: this.newId("review"),
				projectId: task.projectId,
				targetKind: target.targetKind,
				targetId: target.targetId,
				targetRevision: target.targetRevision,
				targetHash: target.targetHash,
				taskId: task.taskId,
				taskAuthorization: task.authorization,
				manifest: task.manifest,
				producerContextId: task.producerContextId,
				status,
				findings: this.stringList(input.findings, "review.findings"),
				createdAt: this.timestamp(),
				reviewerContextId: task.producerContextId,
			};
			this.savePayload("pi_study_research_review", "check_id", review.checkId, review, task.projectId);
			return this.copy(review);
		});
	}

	confirmResultFromTrustedUserEvent(
		scope: Scope,
		resultId: string,
		expectedResultRevision: number,
		userEventId: string,
	): ResearchResult {
		return this.transaction(() => {
			this.assertResearchScope(scope);
			requiredText(userEventId, "userEventId", 256);
			const result = this.readResult(scope.projectId, resultId);
			if (result.revision !== expectedResultRevision) {
				throw new StudyResearchError("RESULT_CONFLICT", "result changed before confirmation");
			}
			if (result.confirmedAt !== null) {
				if (result.confirmedUserEventId !== userEventId) {
					throw new StudyResearchError(
						"RESULT_CONFIRMATION_CONFLICT",
						"result was already confirmed by another trusted user event",
					);
				}
				return this.copy(result);
			}
			this.assertResultCanBeFormallyConfirmed(result);
			const confirmed = {
				...result,
				state: "confirmed" as const,
				confirmedAt: this.timestamp(),
				confirmedUserEventId: userEventId,
				updatedAt: this.timestamp(),
			};
			this.savePayload("pi_study_research_result", "result_id", resultId, confirmed, scope.projectId);
			return this.copy(confirmed);
		});
	}

	publishConfirmedResult(scope: Scope, resultId: string, expectedResultRevision: number): ResearchResult {
		return this.transaction(() => {
			this.assertResearchScope(scope);
			const result = this.readResult(scope.projectId, resultId);
			if (result.revision !== expectedResultRevision) {
				throw new StudyResearchError("RESULT_CONFLICT", "result changed before publication");
			}
			if (result.confirmedAt === null) {
				throw new StudyResearchError(
					"RESULT_UNCONFIRMED",
					"trusted user confirmation is required before publication",
				);
			}
			this.assertResultCanBeFormallyConfirmed(result);
			if (result.publishedAt !== null) return this.copy(result);
			const published = { ...result, publishedAt: this.timestamp(), updatedAt: this.timestamp() };
			this.savePayload("pi_study_research_result", "result_id", resultId, published, scope.projectId);
			return this.copy(published);
		});
	}

	getResult(scope: Scope, resultId: string): ResearchResult {
		this.assertScope(scope);
		return this.copy(this.readResult(scope.projectId, resultId));
	}

	listResults(scope: Scope): ResearchResult[] {
		this.assertScope(scope);
		const rows = this.database
			.prepare("SELECT result_id AS id FROM pi_study_research_result WHERE project_id = ? ORDER BY result_id")
			.all(scope.projectId) as { id: string }[];
		return rows.map((row) => this.copy(this.readResult(scope.projectId, row.id)));
	}

	listResearchAnalysisHistory(scope: Scope, resultId: string): ResearchResult[] {
		this.assertScope(scope);
		requiredText(resultId, "resultId", 128);
		this.readResult(scope.projectId, resultId);
		const rows = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_result_history WHERE project_id = ? AND result_id = ? ORDER BY revision",
			)
			.all(scope.projectId, resultId) as unknown as PayloadRow[];
		return rows.map((row) => this.copy(this.decodeResult(row, "research result history")));
	}

	listScopeGrants(scope: Scope): ScopeGrant[] {
		this.assertScope(scope);
		const rows = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_grant WHERE project_id = ? ORDER BY grant_id",
			)
			.all(scope.projectId) as unknown as PayloadRow[];
		return rows.map((row) => this.copy(this.decode<ScopeGrant>(row, "scope grant")));
	}

	listValidations(
		scope: Scope,
		target?: Pick<VersionCheck, "targetKind" | "targetId" | "targetRevision" | "targetHash">,
	): VersionCheck[] {
		return this.listChecks(scope, "pi_study_research_validation", "validation", target);
	}

	listIndependentReviews(
		scope: Scope,
		target?: Pick<VersionCheck, "targetKind" | "targetId" | "targetRevision" | "targetHash">,
	): IndependentReview[] {
		return this.listChecks(scope, "pi_study_research_review", "review", target) as IndependentReview[];
	}

	projectRevision(scope: Scope): { revision: number; scopeEpoch: number } {
		this.assertScope(scope);
		return this.copy(this.projectState(scope.projectId));
	}

	private transaction<T>(work: () => T): T {
		const savepoint = `pi_study_research_${++this.transactionSequence}`;
		this.database.exec(`SAVEPOINT ${savepoint}`);
		try {
			const result = work();
			this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
			return result;
		} catch (error) {
			this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
			this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
			throw error;
		}
	}

	private ensureRelationColumn(
		column: "revision" | "author" | "manually_edited" | "source_id" | "source_hash" | "stale" | "requires_review",
		definition: string,
	): void {
		const columns = this.database.prepare("PRAGMA table_info(pi_study_research_relation)").all() as {
			name: string;
		}[];
		if (columns.some((entry) => entry.name === column)) return;
		this.database.exec(`ALTER TABLE pi_study_research_relation ADD COLUMN ${column} ${definition}`);
	}

	private timestamp(): string {
		const value = this.clock();
		if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
			throw new StudyResearchError("INVALID_CLOCK", "clock returned an invalid date");
		}
		return value.toISOString();
	}

	private newId(prefix: string): string {
		return `${prefix}_${randomUUID()}`;
	}

	private copy<T>(value: T): T {
		return structuredClone(value);
	}

	private ensureProject(projectId: string): void {
		const existing = this.database
			.prepare("SELECT revision, scope_epoch AS scopeEpoch FROM pi_study_research_project WHERE project_id = ?")
			.get(projectId) as ProjectRow | undefined;
		if (!existing) {
			this.database.prepare("INSERT INTO pi_study_research_project VALUES (?, ?, ?)").run(projectId, 0, 0);
		}
	}

	private projectState(projectId: string): ProjectRow {
		const state = this.database
			.prepare("SELECT revision, scope_epoch AS scopeEpoch FROM pi_study_research_project WHERE project_id = ?")
			.get(projectId) as ProjectRow | undefined;
		if (!state) throw new StudyResearchError("UNKNOWN_PROJECT", "project has no Study/Research state");
		return state;
	}

	private advanceProject(projectId: string, expectedRevision: number, scopeChanged: boolean): void {
		const result = this.database
			.prepare(
				"UPDATE pi_study_research_project SET revision = revision + 1, scope_epoch = scope_epoch + ? WHERE project_id = ? AND revision = ?",
			)
			.run(scopeChanged ? 1 : 0, projectId, expectedRevision);
		if (result.changes !== 1) throw new StudyResearchError("PROJECT_CONFLICT", "project changed before saving");
	}

	private assertProjectRevision(projectId: string, expectedRevision: number): void {
		requiredRevision(expectedRevision + 1, "expectedProjectRevision plus one");
		const actual = this.projectState(projectId).revision;
		if (actual !== expectedRevision) {
			throw new StudyResearchError(
				"PROJECT_CONFLICT",
				`project revision conflict: expected ${expectedRevision}, got ${actual}`,
			);
		}
	}

	private assertProjectMembership(projectId: string, sessionId: string): void {
		const workspace = this.database.prepare("SELECT id FROM pi_project_workspace WHERE id = ?").get(projectId) as
			| { id: string }
			| undefined;
		if (!workspace) throw new StudyResearchError("UNKNOWN_PROJECT", "project workspace does not exist");
		const membership = this.database
			.prepare("SELECT project_id AS projectId FROM pi_project_member WHERE session_id = ?")
			.get(sessionId) as MembershipRow | undefined;
		if (!membership || membership.projectId !== projectId) {
			throw new StudyResearchError("PROJECT_ACCESS_DENIED", "session is not a member of this project");
		}
	}

	private assertScope(scope: Scope): PhaseBinding {
		requiredText(scope.projectId, "scope.projectId", 128);
		requiredText(scope.sessionId, "scope.sessionId", 128);
		requiredRevision(scope.expectedPhaseRevision, "scope.expectedPhaseRevision");
		this.assertProjectMembership(scope.projectId, scope.sessionId);
		const binding = this.phaseForSession(scope.sessionId);
		if (!binding || binding.projectId !== scope.projectId) {
			throw new StudyResearchError("PHASE_UNBOUND", "session has no phase binding for this project");
		}
		if (binding.revision !== scope.expectedPhaseRevision) {
			throw new StudyResearchError("PHASE_CONFLICT", "phase changed before this operation");
		}
		return binding;
	}

	private assertResearchScope(scope: Scope): PhaseBinding {
		const binding = this.assertScope(scope);
		if (binding.phase !== "research") {
			throw new StudyResearchError(
				"RESEARCH_PHASE_REQUIRED",
				"research operation requires an explicit Research phase",
			);
		}
		return binding;
	}

	private phaseForSession(sessionId: string): PhaseBinding | null {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_phase WHERE session_id = ?",
			)
			.get(sessionId) as PayloadRow | undefined;
		return row ? this.decode<PhaseBinding>(row, "phase binding") : null;
	}

	private savePayload(
		table: string,
		idColumn: string,
		id: string,
		value: object,
		projectId: string,
		revision?: number,
		dispatchKey?: string,
	): void {
		const payload = stableStringify(value);
		const hash = contentHash(value);
		if (table === "pi_study_research_phase") {
			if (revision === undefined) throw new StudyResearchError("INVALID_STATE", "phase revision is required");
			this.database
				.prepare(
					"INSERT INTO pi_study_research_phase (session_id, project_id, revision, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, revision = excluded.revision, payload = excluded.payload, payload_hash = excluded.payload_hash",
				)
				.run(id, projectId, revision, payload, hash);
			return;
		}
		if (table === "pi_study_research_task") {
			if (dispatchKey === undefined) throw new StudyResearchError("INVALID_STATE", "task dispatch key is required");
			this.database
				.prepare(
					"INSERT INTO pi_study_research_task (task_id, project_id, dispatch_key, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash",
				)
				.run(id, projectId, dispatchKey, payload, hash);
			return;
		}
		if (table === "pi_study_research_runner_context") {
			const context = value as TrustedRunnerContext;
			this.database
				.prepare(
					"INSERT INTO pi_study_research_runner_context (context_id, project_id, session_id, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(context_id) DO UPDATE SET project_id = excluded.project_id, session_id = excluded.session_id, payload = excluded.payload, payload_hash = excluded.payload_hash",
				)
				.run(id, projectId, context.sessionId, payload, hash);
			return;
		}
		if (table === "pi_study_research_result") {
			const result = value as ResearchResult;
			this.database
				.prepare(
					"INSERT INTO pi_study_research_result (result_id, project_id, task_id, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(result_id) DO UPDATE SET project_id = excluded.project_id, task_id = excluded.task_id, payload = excluded.payload, payload_hash = excluded.payload_hash",
				)
				.run(id, projectId, this.resultStorageKey(result.origin), payload, hash);
			return;
		}
		this.database
			.prepare(
				`INSERT INTO ${table} (${idColumn}, project_id, payload, payload_hash) VALUES (?, ?, ?, ?) ON CONFLICT(${idColumn}) DO UPDATE SET project_id = excluded.project_id, payload = excluded.payload, payload_hash = excluded.payload_hash`,
			)
			.run(id, projectId, payload, hash);
	}

	private decode<T>(row: PayloadRow | undefined, label: string): T {
		if (!row || typeof row.payload !== "string" || typeof row.payloadHash !== "string") {
			throw new StudyResearchError("CORRUPT_STATE", `${label} is missing or malformed`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.payload);
		} catch {
			throw new StudyResearchError("CORRUPT_STATE", `${label} has invalid JSON`);
		}
		if (contentHash(parsed) !== row.payloadHash) {
			throw new StudyResearchError("CORRUPT_STATE", `${label} failed its payload integrity check`);
		}
		return parsed as T;
	}

	private insertSourceVersion(
		projectId: string,
		sourceId: string,
		version: number,
		current: boolean,
		input: SourceVersionInput,
		createdAt: string,
	): SourceVersion {
		this.database
			.prepare("INSERT INTO pi_study_research_source_version VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(
				projectId,
				sourceId,
				version,
				input.contentHash,
				input.parser,
				input.sourceRole,
				stableStringify(input.diagnostics),
				current ? 1 : 0,
				createdAt,
			);
		for (const chunk of input.chunks) {
			this.database
				.prepare("INSERT INTO pi_study_research_chunk VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.run(
					this.newId("chunk"),
					projectId,
					sourceId,
					input.contentHash,
					chunk.ordinal,
					chunk.locator,
					chunk.text,
					`sha256:${sha256Hex(chunk.text)}`,
					createdAt,
				);
		}
		return {
			sourceId,
			projectId,
			sourceRoot: input.sourceRoot,
			relativePath: input.relativePath,
			kind: input.kind,
			sourceRole: input.sourceRole,
			diagnostics: this.copy(input.diagnostics),
			contentHash: input.contentHash,
			parser: input.parser,
			version,
			current,
			createdAt,
		};
	}

	private ensureCandidateSourceVersion(projectId: string, sourceId: string, input: SourceVersionInput): SourceVersion {
		const existing = this.database
			.prepare(
				"SELECT s.source_id AS sourceId, s.source_root AS sourceRoot, s.relative_path AS relativePath, s.kind, v.version, v.content_hash AS contentHash, v.parser, v.source_role AS sourceRole, v.diagnostics_json AS diagnosticsJson, v.created_at AS createdAt FROM pi_study_research_source s JOIN pi_study_research_source_version v ON v.project_id = s.project_id AND v.source_id = s.source_id WHERE s.project_id = ? AND s.source_id = ? AND v.content_hash = ?",
			)
			.get(projectId, sourceId, input.contentHash) as CurrentSourceRow | undefined;
		if (existing) {
			const stored = this.sourceVersionFromRow(projectId, existing, false);
			const storedChunks = (
				this.database
					.prepare(
						"SELECT chunk_id AS chunkId, project_id AS projectId, source_id AS sourceId, source_hash AS sourceHash, ordinal, locator, text, text_hash AS textHash, created_at AS createdAt FROM pi_study_research_chunk WHERE project_id = ? AND source_id = ? AND source_hash = ? ORDER BY ordinal",
					)
					.all(projectId, sourceId, input.contentHash) as unknown as SourceChunk[]
			).map((chunk) => this.assertChunkIntegrity(chunk));
			const persisted = {
				sourceRoot: stored.sourceRoot,
				relativePath: stored.relativePath,
				kind: stored.kind,
				sourceRole: stored.sourceRole,
				diagnostics: stored.diagnostics,
				contentHash: stored.contentHash,
				parser: stored.parser,
				chunks: storedChunks.map((chunk) => ({
					ordinal: chunk.ordinal,
					locator: chunk.locator,
					text: chunk.text,
				})),
			};
			if (stableStringify(persisted) !== stableStringify(input)) {
				throw new StudyResearchError(
					"SOURCE_CANDIDATE_CONTENT_MISMATCH",
					"a same-hash source candidate must retain its persisted metadata and chunks",
				);
			}
			return stored;
		}
		const latest = this.database
			.prepare(
				"SELECT MAX(version) AS version FROM pi_study_research_source_version WHERE project_id = ? AND source_id = ?",
			)
			.get(projectId, sourceId) as { version: number | null };
		if (latest.version === null) throw new StudyResearchError("CORRUPT_STATE", "source has no version history");
		return this.insertSourceVersion(projectId, sourceId, latest.version + 1, false, input, this.timestamp());
	}

	private sourceVersionFor(projectId: string, sourceId: string, sourceHash: string): SourceVersion {
		const row = this.database
			.prepare(
				"SELECT s.source_id AS sourceId, s.source_root AS sourceRoot, s.relative_path AS relativePath, s.kind, v.version, v.content_hash AS contentHash, v.parser, v.source_role AS sourceRole, v.diagnostics_json AS diagnosticsJson, v.created_at AS createdAt FROM pi_study_research_source s JOIN pi_study_research_source_version v ON v.project_id = s.project_id AND v.source_id = s.source_id WHERE s.project_id = ? AND s.source_id = ? AND v.content_hash = ?",
			)
			.get(projectId, sourceId, sourceHash) as CurrentSourceRow | undefined;
		if (!row) throw new StudyResearchError("CORRUPT_STATE", "source update candidate version is missing");
		return this.sourceVersionFromRow(projectId, row, this.isCurrentSource(projectId, sourceId, row.version));
	}

	private currentSource(projectId: string, sourceId: string): CurrentSourceRow {
		const row = this.database
			.prepare(
				"SELECT s.source_id AS sourceId, s.source_root AS sourceRoot, s.relative_path AS relativePath, s.kind, v.version, v.content_hash AS contentHash, v.parser, v.source_role AS sourceRole, v.diagnostics_json AS diagnosticsJson, v.created_at AS createdAt FROM pi_study_research_source s JOIN pi_study_research_source_version v ON v.project_id = s.project_id AND v.source_id = s.source_id AND v.is_current = 1 WHERE s.project_id = ? AND s.source_id = ?",
			)
			.get(projectId, sourceId) as CurrentSourceRow | undefined;
		if (!row) throw new StudyResearchError("UNKNOWN_SOURCE", "current source does not belong to this project");
		return row;
	}

	private sourceVersionFromRow(projectId: string, row: CurrentSourceRow, current: boolean): SourceVersion {
		let diagnostics: SourceVersion["diagnostics"];
		try {
			diagnostics = JSON.parse(row.diagnosticsJson) as SourceVersion["diagnostics"];
		} catch {
			throw new StudyResearchError("CORRUPT_STATE", "source diagnostics have invalid JSON");
		}
		if (!Array.isArray(diagnostics)) {
			throw new StudyResearchError("CORRUPT_STATE", "source diagnostics are not an array");
		}
		return {
			sourceId: row.sourceId,
			projectId,
			sourceRoot: row.sourceRoot,
			relativePath: row.relativePath,
			kind: row.kind,
			sourceRole: row.sourceRole,
			diagnostics: this.copy(diagnostics),
			contentHash: row.contentHash,
			parser: row.parser,
			version: row.version,
			current,
			createdAt: row.createdAt,
		};
	}

	private isCurrentSource(projectId: string, sourceId: string, version: number): boolean {
		const current = this.currentSource(projectId, sourceId);
		return current.version === version;
	}

	private assertSourceVersion(projectId: string, sourceId: string, sourceHash: string): void {
		const row = this.database
			.prepare(
				"SELECT version FROM pi_study_research_source_version WHERE project_id = ? AND source_id = ? AND content_hash = ?",
			)
			.get(projectId, sourceId, sourceHash) as { version: number } | undefined;
		if (!row)
			throw new StudyResearchError("UNKNOWN_SOURCE_VERSION", "source version does not belong to this project");
	}

	private assertSourceBinding(
		projectId: string,
		sourceId: string | null,
		sourceHash: string | null,
		label: string,
	): void {
		if ((sourceId === null) !== (sourceHash === null)) {
			throw new StudyResearchError("INVALID_INPUT", `${label} source id and hash must be both present or both null`);
		}
		if (sourceId !== null && sourceHash !== null) {
			requiredText(sourceId, `${label}.sourceId`, 128);
			requiredHash(sourceHash, `${label}.sourceHash`);
			this.assertSourceVersion(projectId, sourceId, sourceHash);
		}
	}

	private isCurrentSourceBinding(projectId: string, sourceId: string | null, sourceHash: string | null): boolean {
		if (sourceId === null || sourceHash === null) return true;
		const row = this.database
			.prepare(
				"SELECT 1 AS current FROM pi_study_research_source_version WHERE project_id = ? AND source_id = ? AND content_hash = ? AND is_current = 1",
			)
			.get(projectId, sourceId, sourceHash) as { current: number } | undefined;
		return row?.current === 1;
	}

	private validateStudyAgentEvidence(
		projectId: string,
		evidence: readonly StudyAgentSourceEvidence[],
		requireCurrent = false,
	): StudyAgentSourceEvidence[] {
		if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 64) {
			throw new StudyResearchError("INVALID_AGENT_EVIDENCE", "Agent evidence must be a non-empty bounded array");
		}
		const evidenceIds = new Set<string>();
		const locations = new Set<string>();
		return evidence.map((item, index) => {
			requiredText(item.id, `agent evidence[${index}].id`, 128);
			requiredText(item.sourceId, `agent evidence[${index}].sourceId`, 128);
			requiredHash(item.sourceHash, `agent evidence[${index}].sourceHash`);
			requiredJsonLocator(item.locator, `agent evidence[${index}].locator`);
			if (evidenceIds.has(item.id)) {
				throw new StudyResearchError("DUPLICATE_VALUE", "Agent evidence ids must be unique");
			}
			const locationKey = this.studyAgentEvidenceKey(item);
			if (locations.has(locationKey)) {
				throw new StudyResearchError("DUPLICATE_VALUE", "Agent evidence locations must be unique");
			}
			evidenceIds.add(item.id);
			locations.add(locationKey);
			this.assertSourceVersion(projectId, item.sourceId, item.sourceHash);
			if (requireCurrent && !this.isCurrentSourceBinding(projectId, item.sourceId, item.sourceHash)) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_CONFLICT",
					"Agent report evidence source version is no longer current",
				);
			}
			const chunk = this.database
				.prepare(
					"SELECT 1 AS found FROM pi_study_research_chunk WHERE project_id = ? AND source_id = ? AND source_hash = ? AND locator = ?",
				)
				.get(projectId, item.sourceId, item.sourceHash, item.locator) as { found: number } | undefined;
			if (!chunk) {
				throw new StudyResearchError(
					"SOURCE_LOCATOR_NOT_FOUND",
					"Agent evidence locator is not a stored source chunk",
				);
			}
			return this.copy(item);
		});
	}

	private validateStudyAgentReviewEvidence(
		projectId: string,
		evidence: readonly StudyAgentSourceEvidence[],
		target: Pick<VersionCheck, "targetKind" | "targetId" | "targetRevision" | "targetHash">,
	): StudyAgentSourceEvidence[] {
		if (!Array.isArray(evidence)) {
			throw new StudyResearchError("INVALID_AGENT_EVIDENCE", "Agent evidence must be an array");
		}
		if (evidence.length > 0) return this.validateStudyAgentEvidence(projectId, evidence, true);
		if (target.targetKind !== "result") {
			throw new StudyResearchError(
				"EMPTY_REVIEW_EVIDENCE_FORBIDDEN",
				"only an exact frozen result review can omit source evidence",
			);
		}
		const exact = this.assertVersionTarget(
			projectId,
			target.targetKind,
			target.targetId,
			target.targetRevision,
			target.targetHash,
		);
		if (
			exact.targetId !== target.targetId ||
			exact.targetRevision !== target.targetRevision ||
			exact.targetHash !== target.targetHash
		) {
			throw new StudyResearchError("AGENT_TARGET_CONFLICT", "review target is not the exact frozen result version");
		}
		const result = this.readResult(projectId, target.targetId);
		if (result.origin.kind !== "theory-plan" && result.origin.kind !== "terminal-run") {
			throw new StudyResearchError(
				"EMPTY_REVIEW_EVIDENCE_FORBIDDEN",
				"source-free review requires a fully retained theory or terminal-run result origin",
			);
		}
		return [];
	}

	/** Paper-map provenance is a durable queue report, but source freshness is Host-owned. */
	private validatePaperMap(projectId: string, value: StudyPaperMap | undefined): StudyPaperMap {
		if (!value || value.version !== 1)
			throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map report is missing its versioned payload");
		requiredHash(value.mapGroupHash, "paper-map group hash");
		requiredHash(value.rootInputHash, "paper-map root input hash");
		if (
			!Number.isSafeInteger(value.level) ||
			value.level < 0 ||
			value.level > 64 ||
			typeof value.final !== "boolean"
		) {
			throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map reduction level is invalid");
		}
		if (!Array.isArray(value.sourceScope) || value.sourceScope.length < 1 || value.sourceScope.length > 256) {
			throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map source scope must be bounded and non-empty");
		}
		const sourceIds = new Set<string>();
		for (const source of value.sourceScope) {
			requiredText(source.sourceId, "paper-map source id", 128);
			requiredHash(source.contentHash, "paper-map source hash");
			if (sourceIds.has(source.sourceId))
				throw new StudyResearchError("DUPLICATE_VALUE", "paper-map source scope repeats a source");
			sourceIds.add(source.sourceId);
			this.assertSourceVersion(projectId, source.sourceId, source.contentHash);
			if (!this.isCurrentSourceBinding(projectId, source.sourceId, source.contentHash)) {
				throw new StudyResearchError("SOURCE_UPDATE_CONFLICT", "paper-map source version is no longer current");
			}
		}
		if (!Array.isArray(value.inputReports) || value.inputReports.length < 1 || value.inputReports.length > 32) {
			throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map reduction inputs must be bounded and non-empty");
		}
		const reportTasks = new Set<string>();
		for (const report of value.inputReports) {
			requiredText(report.taskId, "paper-map input task id", 128);
			requiredHash(report.reportHash, "paper-map input report hash");
			if (report.kind !== "reading" && report.kind !== "paper-map")
				throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map input kind is invalid");
			if (reportTasks.has(report.taskId))
				throw new StudyResearchError("DUPLICATE_VALUE", "paper-map reduction repeats an input report");
			reportTasks.add(report.taskId);
		}
		const coverage = value.coverage;
		if (
			!coverage ||
			!Number.isSafeInteger(coverage.totalReadingTasks) ||
			coverage.totalReadingTasks < 1 ||
			coverage.totalReadingTasks > 20_000 ||
			!Array.isArray(coverage.completedReadingTaskIds) ||
			!Array.isArray(coverage.unavailableReadingTasks)
		) {
			throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map coverage is invalid");
		}
		const completed = new Set<string>();
		for (const taskId of coverage.completedReadingTaskIds) {
			requiredText(taskId, "paper-map completed task id", 128);
			if (completed.has(taskId))
				throw new StudyResearchError("DUPLICATE_VALUE", "paper-map coverage repeats a completed task");
			completed.add(taskId);
		}
		const unavailable = new Set<string>();
		for (const task of coverage.unavailableReadingTasks) {
			requiredText(task.taskId, "paper-map unavailable task id", 128);
			if (
				!["failed", "cancelled", "limit-reached", "needs-input", "missing-report", "oversized-report"].includes(
					task.status,
				)
			) {
				throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map unavailable task status is invalid");
			}
			if (completed.has(task.taskId) || unavailable.has(task.taskId))
				throw new StudyResearchError("DUPLICATE_VALUE", "paper-map coverage repeats a task");
			unavailable.add(task.taskId);
		}
		if (completed.size + unavailable.size !== coverage.totalReadingTasks) {
			throw new StudyResearchError(
				"INVALID_PAPER_MAP",
				"paper-map coverage does not account for every reading task",
			);
		}
		for (const [key, text] of Object.entries(value.sections ?? {})) {
			if (
				![
					"problem",
					"contributions",
					"assumptionsNotation",
					"argumentDependencies",
					"limitationsUnresolved",
				].includes(key) ||
				typeof text !== "string" ||
				!text.trim() ||
				text.length > 20_000 ||
				text.includes("\0")
			) {
				throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map sections are incomplete or invalid");
			}
		}
		if (Object.keys(value.sections ?? {}).length !== 5)
			throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map must contain exactly five sections");
		return this.copy(value);
	}

	private studyAgentEvidenceKey(value: Pick<StudyAgentSourceEvidence, "sourceId" | "sourceHash" | "locator">): string {
		return `${value.sourceId}\u0000${value.sourceHash}\u0000${value.locator}`;
	}

	private studyAgentSourceKey(value: Pick<StudyAgentSourceEvidence, "sourceId" | "sourceHash">): string {
		return `${value.sourceId}\u0000${value.sourceHash}`;
	}

	private assertAgentKnowledgeSource(
		sourceId: string | null,
		sourceHash: string | null,
		evidenceSourceKeys: ReadonlySet<string>,
		label: string,
	): void {
		if (sourceId === null || sourceHash === null) {
			throw new StudyResearchError(
				"AGENT_SOURCE_CONFLICT",
				`Agent ${label} must be bound to frozen source evidence`,
			);
		}
		if (!evidenceSourceKeys.has(this.studyAgentSourceKey({ sourceId, sourceHash }))) {
			throw new StudyResearchError("AGENT_SOURCE_CONFLICT", `Agent ${label} source differs from frozen evidence`);
		}
	}

	private assertKnowledgeSources(projectId: string, change: KnowledgeChange): void {
		for (const sourceBound of [...change.notes, ...change.nodes]) {
			if (sourceBound.sourceId && sourceBound.sourceHash) {
				this.assertSourceVersion(projectId, sourceBound.sourceId, sourceBound.sourceHash);
			}
		}
	}

	private readKnowledge(projectId: string): KnowledgeSnapshot {
		const notes = (
			this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_note WHERE project_id = ? ORDER BY note_id",
				)
				.all(projectId) as unknown as PayloadRow[]
		).map((row) => this.decode<KnowledgeNote>(row, "note"));
		const nodes = (
			this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_node WHERE project_id = ? ORDER BY node_id",
				)
				.all(projectId) as unknown as PayloadRow[]
		).map((row) => this.decode<KnowledgeNode>(row, "knowledge node"));
		const relations = this.database
			.prepare(
				"SELECT relation_id AS relationId, project_id AS projectId, from_node_id AS fromNodeId, to_node_id AS toNodeId, kind, revision, author, manually_edited AS manuallyEdited, source_id AS sourceId, source_hash AS sourceHash, stale, requires_review AS requiresReview, created_at AS createdAt FROM pi_study_research_relation WHERE project_id = ? ORDER BY relation_id",
			)
			.all(projectId) as unknown as RelationRow[];
		return { notes, nodes, relations: relations.map((relation) => this.relationFromRow(relation)) };
	}

	private readNote(projectId: string, noteId: string): KnowledgeNote {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_note WHERE project_id = ? AND note_id = ?",
			)
			.get(projectId, noteId) as PayloadRow | undefined;
		return this.decode<KnowledgeNote>(row, "note");
	}

	private readNode(projectId: string, nodeId: string): KnowledgeNode {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_node WHERE project_id = ? AND node_id = ?",
			)
			.get(projectId, nodeId) as PayloadRow | undefined;
		return this.decode<KnowledgeNode>(row, "knowledge node");
	}

	private wouldCreatePrerequisiteCycle(projectId: string, fromNodeId: string, toNodeId: string): boolean {
		if (fromNodeId === toNodeId) return true;
		const edges = this.readKnowledge(projectId).relations.filter(
			(relation) => relation.kind === "prerequisite" && !relation.stale,
		);
		const pending = [toNodeId];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const nodeId = pending.pop();
			if (!nodeId || visited.has(nodeId)) continue;
			if (nodeId === fromNodeId) return true;
			visited.add(nodeId);
			for (const edge of edges) if (edge.fromNodeId === nodeId) pending.push(edge.toNodeId);
		}
		return false;
	}

	private assertChunkIntegrity(chunk: SourceChunk): SourceChunk {
		if (`sha256:${sha256Hex(chunk.text)}` !== chunk.textHash) {
			throw new StudyResearchError("CORRUPT_STATE", "persisted source chunk failed its text hash check");
		}
		return this.copy(chunk);
	}

	private appendKnowledge(projectId: string, change: KnowledgeChange): KnowledgeSnapshot {
		const now = this.timestamp();
		const nodes: KnowledgeNode[] = [];
		const byLocalKey = new Map<string, KnowledgeNode>();
		for (const draft of change.nodes) {
			if (draft.replaceNodeId !== undefined) {
				throw new StudyResearchError(
					"INVALID_KNOWLEDGE_CHANGE",
					"only source-update candidates may replace an existing knowledge node",
				);
			}
			const raw = {
				nodeId: this.newId("node"),
				projectId,
				revision: 1,
				kind: draft.kind,
				title: draft.title.trim(),
				statement: draft.statement.trim(),
				scope: draft.scope.trim(),
				sourceId: draft.sourceId,
				sourceHash: draft.sourceHash,
				manuallyEdited: draft.manuallyEdited,
				stale: false,
				createdAt: now,
				updatedAt: now,
			};
			const node: KnowledgeNode = { ...raw, contentHash: contentHash(raw) };
			nodes.push(node);
			byLocalKey.set(draft.localKey, node);
			this.saveEntity("pi_study_research_node", "node_id", node.nodeId, projectId, node);
		}
		const notes: KnowledgeNote[] = [];
		for (const draft of change.notes) {
			if (draft.replaceNoteId !== undefined) {
				throw new StudyResearchError(
					"INVALID_KNOWLEDGE_CHANGE",
					"only source-update candidates may replace an existing note",
				);
			}
			const raw = {
				noteId: this.newId("note"),
				projectId,
				revision: 1,
				author: draft.author,
				manuallyEdited: draft.author === "user",
				body: draft.body.trim(),
				sourceId: draft.sourceId,
				sourceHash: draft.sourceHash,
				nodeIds: draft.nodeLocalKeys.map((key) => {
					const node = byLocalKey.get(key);
					if (!node) throw new StudyResearchError("INVALID_NOTE", "note references an unknown new node");
					return node.nodeId;
				}),
				stale: false,
				createdAt: now,
				updatedAt: now,
			};
			const note: KnowledgeNote = { ...raw, contentHash: contentHash(raw) };
			notes.push(note);
			this.saveEntity("pi_study_research_note", "note_id", note.noteId, projectId, note);
		}
		const relations: KnowledgeRelation[] = [];
		for (const draft of change.relations) {
			const from = byLocalKey.get(draft.fromNodeLocalKey);
			const to = byLocalKey.get(draft.toNodeLocalKey);
			if (!from || !to) {
				throw new StudyResearchError("INVALID_RELATION", "relation references an unknown new node");
			}
			const sourceBinding = this.generatedRelationSourceBinding(from, to);
			const relation: KnowledgeRelation = {
				relationId: this.newId("relation"),
				projectId,
				revision: 1,
				fromNodeId: from.nodeId,
				toNodeId: to.nodeId,
				kind: draft.kind,
				author: "agent",
				manuallyEdited: false,
				...sourceBinding,
				stale: false,
				requiresReview: false,
				createdAt: now,
			};
			relations.push(relation);
			this.saveRelation(relation);
		}
		return { notes, nodes, relations };
	}

	private saveEntity(table: string, idColumn: string, id: string, projectId: string, value: object): void {
		this.database
			.prepare(
				`INSERT INTO ${table} (${idColumn}, project_id, payload, payload_hash) VALUES (?, ?, ?, ?) ON CONFLICT(${idColumn}, project_id) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`,
			)
			.run(id, projectId, stableStringify(value), contentHash(value));
	}

	private generatedRelationSourceBinding(
		from: KnowledgeNode,
		to: KnowledgeNode,
	): Pick<KnowledgeRelation, "sourceId" | "sourceHash"> {
		if (
			from.sourceId !== null &&
			from.sourceId === to.sourceId &&
			from.sourceHash !== null &&
			from.sourceHash === to.sourceHash
		) {
			return { sourceId: from.sourceId, sourceHash: from.sourceHash };
		}
		return { sourceId: null, sourceHash: null };
	}

	private relationFromRow(row: RelationRow): KnowledgeRelation {
		if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
			throw new StudyResearchError("CORRUPT_STATE", "relation has an invalid revision");
		}
		if (!(["user", "agent", "unknown"] as const).includes(row.author)) {
			throw new StudyResearchError("CORRUPT_STATE", "relation has an invalid author");
		}
		if (![0, 1].includes(row.manuallyEdited) || ![0, 1].includes(row.stale) || ![0, 1].includes(row.requiresReview)) {
			throw new StudyResearchError("CORRUPT_STATE", "relation has invalid boolean provenance fields");
		}
		if ((row.sourceId === null) !== (row.sourceHash === null)) {
			throw new StudyResearchError("CORRUPT_STATE", "relation has a partial source binding");
		}
		if (row.sourceId !== null) requiredText(row.sourceId, "stored relation sourceId", 128);
		if (row.sourceHash !== null) requiredHash(row.sourceHash, "stored relation sourceHash");
		return {
			relationId: row.relationId,
			projectId: row.projectId,
			revision: row.revision,
			fromNodeId: row.fromNodeId,
			toNodeId: row.toNodeId,
			kind: row.kind,
			author: row.author,
			manuallyEdited: row.manuallyEdited === 1,
			sourceId: row.sourceId,
			sourceHash: row.sourceHash,
			stale: row.stale === 1,
			requiresReview: row.requiresReview === 1,
			createdAt: row.createdAt,
		};
	}

	private saveRelation(relation: KnowledgeRelation): void {
		this.database
			.prepare(
				"INSERT INTO pi_study_research_relation (relation_id, project_id, from_node_id, to_node_id, kind, revision, author, manually_edited, source_id, source_hash, stale, requires_review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(relation_id) DO UPDATE SET project_id = excluded.project_id, from_node_id = excluded.from_node_id, to_node_id = excluded.to_node_id, kind = excluded.kind, revision = excluded.revision, author = excluded.author, manually_edited = excluded.manually_edited, source_id = excluded.source_id, source_hash = excluded.source_hash, stale = excluded.stale, requires_review = excluded.requires_review, created_at = excluded.created_at",
			)
			.run(
				relation.relationId,
				relation.projectId,
				relation.fromNodeId,
				relation.toNodeId,
				relation.kind,
				relation.revision,
				relation.author,
				relation.manuallyEdited ? 1 : 0,
				relation.sourceId,
				relation.sourceHash,
				relation.stale ? 1 : 0,
				relation.requiresReview ? 1 : 0,
				relation.createdAt,
			);
	}

	private saveProposal(record: ProposalRecord): void {
		this.database
			.prepare(
				"INSERT INTO pi_study_research_source_update (proposal_id, project_id, source_id, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(proposal_id) DO UPDATE SET project_id = excluded.project_id, source_id = excluded.source_id, payload = excluded.payload, payload_hash = excluded.payload_hash",
			)
			.run(
				record.proposal.proposalId,
				record.proposal.projectId,
				record.proposal.sourceId,
				stableStringify(record),
				contentHash(record),
			);
	}

	private readProposal(proposalId: string): ProposalRecord {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_source_update WHERE proposal_id = ?",
			)
			.get(proposalId) as PayloadRow | undefined;
		return this.decode<ProposalRecord>(row, "source update");
	}

	private saveBackup(proposalId: string, snapshot: SourceUpdateAffectedKnowledge): void {
		this.database
			.prepare("INSERT INTO pi_study_research_source_backup VALUES (?, ?, ?)")
			.run(proposalId, stableStringify(snapshot), contentHash(snapshot));
	}

	private readBackup(proposalId: string): SourceUpdateAffectedKnowledge {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_source_backup WHERE proposal_id = ?",
			)
			.get(proposalId) as PayloadRow | undefined;
		return this.decode<SourceUpdateAffectedKnowledge>(row, "source update backup");
	}

	private deleteBackup(proposalId: string): void {
		this.database.prepare("DELETE FROM pi_study_research_source_backup WHERE proposal_id = ?").run(proposalId);
	}

	private sourceBoundKnowledge(
		projectId: string,
		sourceId: string,
		sourceHash: string,
	): SourceUpdateAffectedKnowledge {
		const knowledge = this.readKnowledge(projectId);
		const notes = knowledge.notes.filter((note) => note.sourceId === sourceId && note.sourceHash === sourceHash);
		const nodes = knowledge.nodes.filter((node) => node.sourceId === sourceId && node.sourceHash === sourceHash);
		const sourceNodeIds = new Set(nodes.map((node) => node.nodeId));
		return {
			notes,
			nodes,
			relations: knowledge.relations.filter((relation) => {
				if (this.isAutomaticSourceLocalRelation(relation, sourceId, sourceHash)) return true;
				// Automatically generated cross-source edges cannot carry two source
				// bindings in the legacy relation schema. Their endpoint nodes are the
				// durable provenance, so retire an edge when either changed source node
				// is invalidated.
				return (
					relation.author === "agent" &&
					!relation.manuallyEdited &&
					(sourceNodeIds.has(relation.fromNodeId) || sourceNodeIds.has(relation.toNodeId))
				);
			}),
		};
	}

	private markSourceKnowledgeStale(
		projectId: string,
		sourceId: string,
		sourceHash: string,
	): SourceUpdateAffectedKnowledge {
		const affected = this.sourceBoundKnowledge(projectId, sourceId, sourceHash);
		for (const note of affected.notes)
			this.saveEntity("pi_study_research_note", "note_id", note.noteId, projectId, this.staleNote(note));
		for (const node of affected.nodes)
			this.saveEntity("pi_study_research_node", "node_id", node.nodeId, projectId, this.staleNode(node));
		for (const relation of affected.relations) this.saveRelation(this.staleRelation(relation));
		return this.sourceBoundKnowledge(projectId, sourceId, sourceHash);
	}

	private staleNote(note: KnowledgeNote): KnowledgeNote {
		const { contentHash: _hash, ...raw } = note;
		const next = { ...raw, revision: raw.revision + 1, stale: true, updatedAt: this.timestamp() };
		return { ...next, contentHash: contentHash(next) };
	}

	private noteIsManuallyEdited(note: KnowledgeNote): boolean {
		return note.author === "user" || note.manuallyEdited !== false;
	}

	private isAutomaticSourceLocalRelation(relation: KnowledgeRelation, sourceId: string, sourceHash: string): boolean {
		return (
			relation.author === "agent" &&
			relation.manuallyEdited === false &&
			relation.sourceId === sourceId &&
			relation.sourceHash === sourceHash
		);
	}

	private staleRelation(relation: KnowledgeRelation): KnowledgeRelation {
		return { ...relation, revision: relation.revision + 1, stale: true };
	}

	private staleNode(node: KnowledgeNode): KnowledgeNode {
		const { contentHash: _hash, ...raw } = node;
		const next = { ...raw, revision: raw.revision + 1, stale: true, updatedAt: this.timestamp() };
		return { ...next, contentHash: contentHash(next) };
	}

	private assertAffectedUnchanged(projectId: string, marked: SourceUpdateAffectedKnowledge): void {
		for (const expected of marked.notes) {
			const current = this.readNote(projectId, expected.noteId);
			if (current.revision !== expected.revision || current.contentHash !== expected.contentHash) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_CONFLICT",
					"an affected note changed after the proposal was prepared",
				);
			}
		}
		for (const expected of marked.nodes) {
			const current = this.readNode(projectId, expected.nodeId);
			if (current.revision !== expected.revision || current.contentHash !== expected.contentHash) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_CONFLICT",
					"an affected knowledge node changed after the proposal was prepared",
				);
			}
		}
		const relationIds = new Set(marked.relations.map((relation) => relation.relationId));
		const currentRelations = this.readKnowledge(projectId).relations.filter((relation) =>
			relationIds.has(relation.relationId),
		);
		if (stableStringify(currentRelations) !== stableStringify(marked.relations)) {
			throw new StudyResearchError(
				"SOURCE_UPDATE_CONFLICT",
				"an affected relation changed after the proposal was prepared",
			);
		}
	}

	private restoreAffectedKnowledge(projectId: string, snapshot: SourceUpdateAffectedKnowledge): void {
		for (const node of snapshot.nodes) {
			const current = this.readNode(projectId, node.nodeId);
			const { contentHash: _hash, ...raw } = node;
			const restored = { ...raw, revision: current.revision + 1, stale: true, updatedAt: this.timestamp() };
			this.saveEntity("pi_study_research_node", "node_id", node.nodeId, projectId, {
				...restored,
				contentHash: contentHash(restored),
			});
		}
		for (const note of snapshot.notes) {
			const current = this.readNote(projectId, note.noteId);
			const { contentHash: _hash, ...raw } = note;
			const restored = { ...raw, revision: current.revision + 1, stale: true, updatedAt: this.timestamp() };
			this.saveEntity("pi_study_research_note", "note_id", note.noteId, projectId, {
				...restored,
				contentHash: contentHash(restored),
			});
		}
		for (const relation of snapshot.relations) {
			const current = this.readKnowledge(projectId).relations.find(
				(candidate) => candidate.relationId === relation.relationId,
			);
			if (!current) throw new StudyResearchError("CORRUPT_STATE", "source relation disappeared before rejection");
			this.saveRelation({ ...relation, revision: current.revision + 1 });
		}
	}

	private assertSourceCandidateMapping(
		projectId: string,
		sourceId: string,
		previousHash: string,
		candidateHash: string,
		change: KnowledgeChange,
		backup: SourceUpdateAffectedKnowledge,
	): void {
		const priorNodes = new Map(backup.nodes.map((node) => [node.nodeId, node]));
		const priorNotes = new Map(backup.notes.map((note) => [note.noteId, note]));
		const replacementNodeIds = new Set<string>();
		const replacementNoteIds = new Set<string>();
		for (const node of change.nodes) {
			if (node.sourceId !== sourceId || node.sourceHash !== candidateHash || node.manuallyEdited !== false) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_SCOPE",
					"source candidate nodes must be automatic and bound to its candidate version",
				);
			}
			if (node.replaceNodeId === undefined) continue;
			if (replacementNodeIds.has(node.replaceNodeId)) {
				throw new StudyResearchError("DUPLICATE_VALUE", "candidate node replacement ids must be unique");
			}
			replacementNodeIds.add(node.replaceNodeId);
			const prior = priorNodes.get(node.replaceNodeId);
			if (
				!prior ||
				prior.sourceId !== sourceId ||
				prior.sourceHash !== previousHash ||
				prior.manuallyEdited !== false
			) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_SCOPE",
					"candidate node replacement must reference one automatic backed-up node from this source",
				);
			}
		}
		for (const note of change.notes) {
			if (note.author !== "agent" || note.sourceId !== sourceId || note.sourceHash !== candidateHash) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_SCOPE",
					"source candidate notes must be agent-authored and bound to its candidate version",
				);
			}
			if (note.replaceNoteId === undefined) continue;
			if (replacementNoteIds.has(note.replaceNoteId)) {
				throw new StudyResearchError("DUPLICATE_VALUE", "candidate note replacement ids must be unique");
			}
			replacementNoteIds.add(note.replaceNoteId);
			const prior = priorNotes.get(note.replaceNoteId);
			if (
				!prior ||
				prior.sourceId !== sourceId ||
				prior.sourceHash !== previousHash ||
				this.noteIsManuallyEdited(prior)
			) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_SCOPE",
					"candidate note replacement must reference one automatic backed-up note from this source",
				);
			}
		}
		this.assertCandidatePrerequisites(projectId, sourceId, previousHash, change);
	}

	private assertCandidatePrerequisites(
		projectId: string,
		sourceId: string,
		previousHash: string,
		change: KnowledgeChange,
	): void {
		const localNodeIds = new Map(
			change.nodes.map((node) => [node.localKey, node.replaceNodeId ?? `candidate:${node.localKey}`]),
		);
		const edges: Pick<KnowledgeRelation, "fromNodeId" | "toNodeId">[] = this.readKnowledge(projectId)
			.relations.filter(
				(relation) =>
					relation.kind === "prerequisite" &&
					!relation.stale &&
					!this.isAutomaticSourceLocalRelation(relation, sourceId, previousHash),
			)
			.map((relation) => ({ fromNodeId: relation.fromNodeId, toNodeId: relation.toNodeId }));
		for (const relation of change.relations) {
			if (relation.kind !== "prerequisite") continue;
			const fromNodeId = localNodeIds.get(relation.fromNodeLocalKey);
			const toNodeId = localNodeIds.get(relation.toNodeLocalKey);
			if (!fromNodeId || !toNodeId) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_SCOPE",
					"candidate relation references an unknown candidate node",
				);
			}
			if (this.wouldCreatePrerequisiteCycleForEdges(edges, fromNodeId, toNodeId)) {
				throw new StudyResearchError("PREREQUISITE_CYCLE", "candidate prerequisite relations must remain acyclic");
			}
			edges.push({ fromNodeId, toNodeId });
		}
	}

	private wouldCreatePrerequisiteCycleForEdges(
		edges: readonly Pick<KnowledgeRelation, "fromNodeId" | "toNodeId">[],
		fromNodeId: string,
		toNodeId: string,
	): boolean {
		if (fromNodeId === toNodeId) return true;
		const pending = [toNodeId];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const nodeId = pending.pop();
			if (!nodeId || visited.has(nodeId)) continue;
			if (nodeId === fromNodeId) return true;
			visited.add(nodeId);
			for (const edge of edges) if (edge.fromNodeId === nodeId) pending.push(edge.toNodeId);
		}
		return false;
	}

	private applySourceCandidate(
		projectId: string,
		proposal: SourceUpdateProposal,
		backup: SourceUpdateAffectedKnowledge,
		change: KnowledgeChange,
	): void {
		this.assertSourceCandidateMapping(
			projectId,
			proposal.sourceId,
			proposal.previousHash,
			proposal.candidateHash,
			change,
			backup,
		);
		const nodeByLocalKey = new Map<string, KnowledgeNode>();
		const now = this.timestamp();
		for (const draft of change.nodes) {
			if (draft.replaceNodeId !== undefined) {
				const current = this.readNode(projectId, draft.replaceNodeId);
				const raw = {
					nodeId: current.nodeId,
					projectId,
					revision: current.revision + 1,
					kind: draft.kind,
					title: draft.title.trim(),
					statement: draft.statement.trim(),
					scope: draft.scope.trim(),
					sourceId: proposal.sourceId,
					sourceHash: proposal.candidateHash,
					manuallyEdited: false,
					stale: false,
					createdAt: current.createdAt,
					updatedAt: now,
				};
				const node: KnowledgeNode = { ...raw, contentHash: contentHash(raw) };
				this.saveEntity("pi_study_research_node", "node_id", node.nodeId, projectId, node);
				nodeByLocalKey.set(draft.localKey, node);
				continue;
			}
			const raw = {
				nodeId: this.newId("node"),
				projectId,
				revision: 1,
				kind: draft.kind,
				title: draft.title.trim(),
				statement: draft.statement.trim(),
				scope: draft.scope.trim(),
				sourceId: proposal.sourceId,
				sourceHash: proposal.candidateHash,
				manuallyEdited: false,
				stale: false,
				createdAt: now,
				updatedAt: now,
			};
			const node: KnowledgeNode = { ...raw, contentHash: contentHash(raw) };
			this.saveEntity("pi_study_research_node", "node_id", node.nodeId, projectId, node);
			nodeByLocalKey.set(draft.localKey, node);
		}
		for (const draft of change.notes) {
			const nodeIds = draft.nodeLocalKeys.map((key) => {
				const node = nodeByLocalKey.get(key);
				if (!node)
					throw new StudyResearchError(
						"SOURCE_UPDATE_SCOPE",
						"candidate note references an unknown candidate node",
					);
				return node.nodeId;
			});
			if (draft.replaceNoteId !== undefined) {
				const current = this.readNote(projectId, draft.replaceNoteId);
				const raw = {
					noteId: current.noteId,
					projectId,
					revision: current.revision + 1,
					author: "agent" as const,
					manuallyEdited: false,
					body: draft.body.trim(),
					sourceId: proposal.sourceId,
					sourceHash: proposal.candidateHash,
					nodeIds,
					stale: false,
					createdAt: current.createdAt,
					updatedAt: now,
				};
				const note: KnowledgeNote = { ...raw, contentHash: contentHash(raw) };
				this.saveEntity("pi_study_research_note", "note_id", note.noteId, projectId, note);
				continue;
			}
			const raw = {
				noteId: this.newId("note"),
				projectId,
				revision: 1,
				author: "agent" as const,
				manuallyEdited: false,
				body: draft.body.trim(),
				sourceId: proposal.sourceId,
				sourceHash: proposal.candidateHash,
				nodeIds,
				stale: false,
				createdAt: now,
				updatedAt: now,
			};
			const note: KnowledgeNote = { ...raw, contentHash: contentHash(raw) };
			this.saveEntity("pi_study_research_note", "note_id", note.noteId, projectId, note);
		}
		for (const draft of change.relations) {
			const from = nodeByLocalKey.get(draft.fromNodeLocalKey);
			const to = nodeByLocalKey.get(draft.toNodeLocalKey);
			if (!from || !to)
				throw new StudyResearchError(
					"SOURCE_UPDATE_SCOPE",
					"candidate relation references an unknown candidate node",
				);
			const existing = this.readKnowledge(projectId).relations.some(
				(relation) =>
					!relation.stale &&
					relation.fromNodeId === from.nodeId &&
					relation.toNodeId === to.nodeId &&
					relation.kind === draft.kind,
			);
			if (existing) continue;
			if (draft.kind === "prerequisite" && this.wouldCreatePrerequisiteCycle(projectId, from.nodeId, to.nodeId)) {
				throw new StudyResearchError("PREREQUISITE_CYCLE", "candidate prerequisite relations must remain acyclic");
			}
			this.saveRelation({
				relationId: this.newId("relation"),
				projectId,
				revision: 1,
				fromNodeId: from.nodeId,
				toNodeId: to.nodeId,
				kind: draft.kind,
				author: "agent",
				manuallyEdited: false,
				sourceId: proposal.sourceId,
				sourceHash: proposal.candidateHash,
				stale: false,
				requiresReview: false,
				createdAt: now,
			});
		}
	}

	private resolveSourceUpdate(
		scope: Scope,
		proposalId: string,
		expectedProjectRevision: number,
		decision: "accepted" | "rejected",
	): SourceUpdateProposal {
		return this.transaction(() => {
			this.assertScope(scope);
			this.assertProjectRevision(scope.projectId, expectedProjectRevision);
			const record = this.readProposal(proposalId);
			const proposal = record.proposal;
			if (proposal.projectId !== scope.projectId) {
				throw new StudyResearchError("CROSS_PROJECT", "source update belongs to another project");
			}
			if (proposal.status !== "pending") {
				throw new StudyResearchError("SOURCE_UPDATE_CONFLICT", "source update is stale or already resolved");
			}
			const source = this.currentSource(scope.projectId, proposal.sourceId);
			if (source.contentHash !== proposal.previousHash) {
				throw new StudyResearchError("SOURCE_UPDATE_CONFLICT", "source changed since this proposal was prepared");
			}
			this.assertAffectedUnchanged(scope.projectId, record.marked);
			const currentAffected = this.sourceBoundKnowledge(scope.projectId, proposal.sourceId, proposal.previousHash);
			if (contentHash(currentAffected) !== contentHash(record.marked)) {
				throw new StudyResearchError(
					"SOURCE_UPDATE_CONFLICT",
					"source-bound knowledge changed after this proposal; regenerate the affected candidate",
				);
			}
			const backup = this.readBackup(proposal.proposalId);
			if (decision === "accepted") {
				this.database
					.prepare(
						"UPDATE pi_study_research_source_version SET is_current = 0 WHERE project_id = ? AND source_id = ?",
					)
					.run(scope.projectId, source.sourceId);
				const result = this.database
					.prepare(
						"UPDATE pi_study_research_source_version SET is_current = 1 WHERE project_id = ? AND source_id = ? AND content_hash = ?",
					)
					.run(scope.projectId, source.sourceId, proposal.candidateHash);
				if (result.changes !== 1)
					throw new StudyResearchError("CORRUPT_STATE", "candidate source version is missing");
				this.assertKnowledgeSources(scope.projectId, record.knowledge);
				this.applySourceCandidate(scope.projectId, proposal, backup, record.knowledge);
			} else {
				this.restoreAffectedKnowledge(scope.projectId, backup);
			}
			const resolved: SourceUpdateProposal = { ...proposal, status: decision, resolvedAt: this.timestamp() };
			this.saveProposal({ ...record, proposal: resolved });
			this.deleteBackup(proposal.proposalId);
			this.advanceProject(scope.projectId, expectedProjectRevision, decision === "accepted");
			return this.copy(resolved);
		});
	}

	private makePlan(
		projectId: string,
		planId: string,
		revision: number,
		input: ResearchPlanInput,
		createdAt: string,
		updatedAt: string,
	): ResearchPlan {
		if (!["theory", "smoke", "formal", "exploration"].includes(input.kind)) {
			throw new StudyResearchError("INVALID_PLAN_KIND", "plan kind is invalid");
		}
		const kind = input.kind as PlanKind;
		const detail = validatePlanDetail(kind, input.detail);
		const sourceVersionHashes = this.hashList(
			input.sourceVersionHashes,
			"plan.sourceVersionHashes",
			input.sourceReferences !== undefined,
		);
		const sourceReferences = this.resolvePlanInputSourceReferences(
			projectId,
			sourceVersionHashes,
			input.sourceReferences,
		);
		const semanticDigest = contentHash({ kind, detail, sourceVersionHashes, sourceReferences });
		return {
			projectId,
			planId,
			revision,
			kind,
			detail,
			sourceReferences,
			sourceVersionHashes,
			semanticDigest,
			createdAt,
			updatedAt,
		};
	}

	private resolvePlanInputSourceReferences(
		projectId: string,
		sourceVersionHashes: readonly string[],
		inputReferences: ResearchPlanInput["sourceReferences"],
	): SourceReference[] {
		if (inputReferences === undefined) {
			return sourceVersionHashes.map((contentHash) => this.resolveUniqueSourceReference(projectId, contentHash));
		}
		if (!Array.isArray(inputReferences) || inputReferences.length > 1_000) {
			throw new StudyResearchError("INVALID_INPUT", "plan.sourceReferences must be a bounded array");
		}
		const sourceIds = new Set<string>();
		const references = inputReferences.map((reference, index) => {
			if (!reference || typeof reference !== "object") {
				throw new StudyResearchError("INVALID_INPUT", `plan.sourceReferences[${index}] must be an object`);
			}
			requiredText(reference.sourceId, `plan.sourceReferences[${index}].sourceId`, 128);
			requiredHash(reference.contentHash, `plan.sourceReferences[${index}].contentHash`);
			if (sourceIds.has(reference.sourceId)) {
				throw new StudyResearchError("DUPLICATE_VALUE", "plan.sourceReferences must not repeat a source id");
			}
			sourceIds.add(reference.sourceId);
			this.assertSourceVersion(projectId, reference.sourceId, reference.contentHash);
			return { sourceId: reference.sourceId, contentHash: reference.contentHash };
		});
		const expectedHashes = [...sourceVersionHashes].sort();
		const referencedHashes = references.map((reference) => reference.contentHash).sort();
		if (stableStringify(expectedHashes) !== stableStringify(referencedHashes)) {
			throw new StudyResearchError(
				"PLAN_SOURCE_REFERENCE_MISMATCH",
				"plan source hash list must exactly match its explicit source references",
			);
		}
		return this.sortSourceReferences(references);
	}

	/** Legacy hash-only plans are allowed only when a hash denotes exactly one project source. */
	private resolveUniqueSourceReference(projectId: string, contentHash: string): SourceReference {
		const rows = this.database
			.prepare(
				"SELECT source_id AS sourceId, content_hash AS contentHash FROM pi_study_research_source_version WHERE project_id = ? AND content_hash = ? ORDER BY source_id",
			)
			.all(projectId, contentHash) as { sourceId: string; contentHash: string }[];
		if (rows.length === 0) {
			throw new StudyResearchError("UNKNOWN_SOURCE_VERSION", "plan references another project's source hash");
		}
		if (rows.length !== 1) {
			throw new StudyResearchError(
				"AMBIGUOUS_SOURCE_HASH",
				"hash-only source dependency matches multiple project sources; use explicit source references",
			);
		}
		return rows[0];
	}

	private planSourceReferences(projectId: string, plan: ResearchPlan): SourceReference[] {
		const sourceVersionHashes = this.hashList(
			plan.sourceVersionHashes,
			"stored plan.sourceVersionHashes",
			plan.sourceReferences !== undefined,
		);
		return this.resolvePlanInputSourceReferences(projectId, sourceVersionHashes, plan.sourceReferences);
	}

	private sortSourceReferences(references: readonly SourceReference[]): SourceReference[] {
		return [...references].sort(
			(left, right) =>
				left.sourceId.localeCompare(right.sourceId) || left.contentHash.localeCompare(right.contentHash),
		);
	}

	/** Resolve an exact plan reference to its current linked source version for grant invalidation. */
	private currentSourceBindings(
		projectId: string,
		plan: ResearchPlan,
	): Array<{ sourceId: string; contentHash: string }> {
		const bindings = this.planSourceReferences(projectId, plan).map((reference) => {
			const row = this.database
				.prepare(
					"SELECT source_id AS sourceId, content_hash AS contentHash FROM pi_study_research_source_version WHERE project_id = ? AND source_id = ? AND content_hash = ? AND is_current = 1",
				)
				.get(projectId, reference.sourceId, reference.contentHash) as
				| { sourceId: string; contentHash: string }
				| undefined;
			if (!row) throw new StudyResearchError("GRANT_STALE", "a plan source is no longer the current linked version");
			return row;
		});
		return this.sortSourceReferences(bindings);
	}

	private makeVisualization(
		projectId: string,
		visualizationId: string,
		revision: number,
		owner: StudyPhase,
		input: VisualizationDraftInput,
		creator: TrustedRunnerContext,
		createdAt: string,
		updatedAt: string,
	): VisualizationDraft {
		requiredText(input.purpose, "visualization.purpose", 20_000);
		requiredText(input.code, "visualization.code", 500_000);
		requiredHash(input.environmentHash, "visualization.environmentHash");
		if (!input.inputs || typeof input.inputs !== "object" || Array.isArray(input.inputs)) {
			throw new StudyResearchError("INVALID_VISUALIZATION_INPUTS", "visualization inputs must be an object");
		}
		let canonicalInputs: string;
		try {
			canonicalInputs = stableStringify(input.inputs);
		} catch (error) {
			throw new StudyResearchError(
				"INVALID_VISUALIZATION_INPUTS",
				`visualization inputs must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (canonicalInputs.length > 200_000) {
			throw new StudyResearchError("INPUT_TOO_LARGE", "visualization inputs exceed 200000 serialized characters");
		}
		const manifest = validateManifest({
			codeHash: `sha256:${sha256Hex(input.code)}`,
			parameterHash: `sha256:${sha256Hex(input.purpose)}`,
			inputHashes: input.inputHashes,
			environmentHash: input.environmentHash,
		});
		const raw = {
			visualizationId,
			projectId,
			revision,
			owner,
			creatorContextId: creator.contextId,
			creatorIdentity: creator.producerIdentity,
			purpose: input.purpose.trim(),
			code: input.code,
			codeHash: manifest.codeHash,
			inputHash: contentHash(input.inputs),
			inputs: this.copy(input.inputs),
			inputHashes: manifest.inputHashes,
			environmentHash: manifest.environmentHash,
			createdAt,
			updatedAt,
		};
		return { ...raw, contentHash: contentHash(raw) };
	}

	private readVisualization(projectId: string, visualizationId: string): VisualizationDraft {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_visualization WHERE project_id = ? AND visualization_id = ?",
			)
			.get(projectId, visualizationId) as PayloadRow | undefined;
		const visualization = this.decode<VisualizationDraft>(row, "visualization draft");
		if (!visualization.creatorContextId || !visualization.creatorIdentity) {
			throw new StudyResearchError(
				"VISUALIZATION_PROVENANCE_REQUIRED",
				"visualization draft lacks trusted creator provenance",
			);
		}
		const creator = this.readTrustedRunnerContext(visualization.creatorContextId);
		if (creator.projectId !== projectId || creator.producerIdentity !== visualization.creatorIdentity) {
			throw new StudyResearchError("CORRUPT_STATE", "visualization creator provenance does not match its context");
		}
		return visualization;
	}

	private readPlan(projectId: string, planId: string): ResearchPlan {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_plan WHERE project_id = ? AND plan_id = ?",
			)
			.get(projectId, planId) as PayloadRow | undefined;
		return this.decode<ResearchPlan>(row, "research plan");
	}

	private readGrant(projectId: string, grantId: string): ScopeGrant {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_grant WHERE project_id = ? AND grant_id = ?",
			)
			.get(projectId, grantId) as PayloadRow | undefined;
		return this.decode<ScopeGrant>(row, "scope grant");
	}

	private resolveProducerContext(scope: Scope, contextId: string | undefined): string | null {
		if (contextId === undefined) return null;
		requiredText(contextId, "producerContextId", 256);
		const context = this.readTrustedRunnerContext(contextId);
		if (context.projectId !== scope.projectId || context.sessionId !== scope.sessionId) {
			throw new StudyResearchError(
				"RUNNER_CONTEXT_ACCESS_DENIED",
				"trusted runner context belongs to another scope",
			);
		}
		return context.contextId;
	}

	private requireTrustedRunnerContext(
		scope: Scope,
		contextId: string | undefined,
		label: string,
	): TrustedRunnerContext {
		const resolved = this.resolveProducerContext(scope, contextId);
		if (resolved === null) {
			throw new StudyResearchError("TRUSTED_PRODUCER_REQUIRED", `${label} requires a trusted runner context`);
		}
		return this.readTrustedRunnerContext(resolved);
	}

	private readTrustedRunnerContext(contextId: string): TrustedRunnerContext {
		requiredText(contextId, "producerContextId", 256);
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_runner_context WHERE context_id = ?",
			)
			.get(contextId) as PayloadRow | undefined;
		const context = this.decode<TrustedRunnerContext>(row, "trusted runner context");
		requiredText(context.producerIdentity, "trusted runner producerIdentity", 256);
		return context;
	}

	private reserveCheckTarget(
		projectId: string,
		kind: TaskKind,
		target: ReserveTaskInput["target"] | ReserveStudyTaskInput["target"],
	): FrozenCheckTarget | null {
		const needsTarget = kind === "validation" || kind === "review";
		if (!needsTarget) {
			if (target !== undefined)
				throw new StudyResearchError(
					"INVALID_TASK_TARGET",
					"only validation and review tasks can reserve a check target",
				);
			return null;
		}
		if (!target)
			throw new StudyResearchError(
				"CHECK_TARGET_REQUIRED",
				"validation and review tasks require a reservation-time target",
			);
		const resolved = this.assertVersionTarget(
			projectId,
			target.targetKind,
			target.targetId,
			target.targetRevision,
			target.targetHash,
		);
		return this.copy(resolved);
	}

	private assertCheckProducer(kind: TaskKind, producerContextId: string | null): void {
		if ((kind === "validation" || kind === "review") && producerContextId === null) {
			throw new StudyResearchError(
				"TRUSTED_PRODUCER_REQUIRED",
				"validation and review tasks require a trusted runner context",
			);
		}
	}

	private assertExecutionProducer(kind: TaskKind, producerContextId: string | null): void {
		if (kind === "execution" && producerContextId === null) {
			throw new StudyResearchError("TRUSTED_PRODUCER_REQUIRED", "execution tasks require a trusted runner context");
		}
	}

	private assertGrantCurrent(grant: ScopeGrant, plan: ResearchPlan, sessionId: string): void {
		if (grant.revokedAt !== null) throw new StudyResearchError("GRANT_REVOKED", "scope grant was revoked");
		if (Date.parse(grant.expiresAt) <= this.clock().getTime()) {
			throw new StudyResearchError("GRANT_EXPIRED", "scope grant expired");
		}
		if (
			grant.sessionId !== sessionId ||
			grant.planId !== plan.planId ||
			grant.planRevision !== plan.revision ||
			grant.semanticDigest !== plan.semanticDigest
		) {
			throw new StudyResearchError("GRANT_STALE", "scope grant no longer matches the semantic research scope");
		}
		const currentBindings = this.currentSourceBindings(grant.projectId, plan);
		if (stableStringify(currentBindings) !== stableStringify(grant.referencedSources)) {
			throw new StudyResearchError("GRANT_STALE", "a source referenced by the research scope changed");
		}
	}

	private readTask(taskId: string): StudyTask {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_task WHERE task_id = ?",
			)
			.get(taskId) as PayloadRow | undefined;
		return this.decodeTask(row);
	}

	private decodeTask(row: PayloadRow | undefined): StudyTask {
		const raw = this.decode<StudyTask>(row, "task");
		const authorization = this.normalizeTaskAuthorization(raw.authorization);
		if (
			["execution", "validation", "review"].includes(raw.kind) &&
			(typeof raw.producerContextId !== "string" || !raw.producerContextId.trim())
		)
			throw new StudyResearchError("CORRUPT_STATE", "stored executable or check task lacks its trusted producer");
		if (raw.projectId !== authorization.projectId) {
			throw new StudyResearchError("CORRUPT_STATE", "task project differs from its frozen authorization");
		}
		return { ...raw, authorization };
	}

	private normalizeTaskAuthorization(value: unknown): FrozenTaskAuthorization {
		try {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw new StudyResearchError("CORRUPT_STATE", "task authorization is not an object");
			}
			const raw = value as Record<string, unknown>;
			const hasAdmission = Object.hasOwn(raw, "admission");
			const researchFields = ["grantId", "planId", "planRevision", "semanticDigest"] as const;
			const hasResearchField = researchFields.some((field) => Object.hasOwn(raw, field));
			const hasCompleteResearchGrant = researchFields.every((field) => Object.hasOwn(raw, field));
			const kind = raw.kind;
			if (
				kind === "learning" ||
				(kind === undefined && raw.phase === "study" && hasAdmission && !hasResearchField)
			) {
				if (!hasAdmission || hasResearchField) {
					throw new StudyResearchError("CORRUPT_STATE", "learning authorization has an ambiguous grant shape");
				}
				const admission = raw.admission;
				if (!admission || typeof admission !== "object" || Array.isArray(admission)) {
					throw new StudyResearchError("CORRUPT_STATE", "learning authorization has no valid bounded admission");
				}
				return {
					kind: "learning",
					projectId: requiredText(raw.projectId as string, "stored learning authorization projectId", 128),
					sessionId: requiredText(raw.sessionId as string, "stored learning authorization sessionId", 128),
					phase: assertPhase(raw.phase as StudyPhase),
					phaseRevision: requiredRevision(
						raw.phaseRevision as number,
						"stored learning authorization phaseRevision",
					),
					admission: this.validateStudyAdmission(admission as StudyTaskAdmission),
				};
			}
			if (
				kind === "research-grant" ||
				(kind === undefined && raw.phase === "research" && !hasAdmission && hasCompleteResearchGrant)
			) {
				if (hasAdmission || !hasCompleteResearchGrant || raw.phase !== "research") {
					throw new StudyResearchError("CORRUPT_STATE", "Research authorization has an ambiguous learning shape");
				}
				return {
					kind: "research-grant",
					projectId: requiredText(raw.projectId as string, "stored Research authorization projectId", 128),
					sessionId: requiredText(raw.sessionId as string, "stored Research authorization sessionId", 128),
					phase: "research",
					phaseRevision: requiredRevision(
						raw.phaseRevision as number,
						"stored Research authorization phaseRevision",
					),
					grantId: requiredText(raw.grantId as string, "stored Research authorization grantId", 128),
					planId: requiredText(raw.planId as string, "stored Research authorization planId", 128),
					planRevision: requiredRevision(raw.planRevision as number, "stored Research authorization planRevision"),
					semanticDigest: requiredHash(
						raw.semanticDigest as string,
						"stored Research authorization semanticDigest",
					),
				};
			}
			throw new StudyResearchError("CORRUPT_STATE", "task authorization discriminator is missing or ambiguous");
		} catch (error) {
			if (error instanceof StudyResearchError && error.code === "CORRUPT_STATE") throw error;
			throw new StudyResearchError("CORRUPT_STATE", "task authorization is malformed");
		}
	}

	private addTaskEvent(task: StudyTask, status: TaskStatus, detail: string): void {
		const event: TaskEvent = {
			eventId: this.newId("task-event"),
			projectId: task.projectId,
			taskId: task.taskId,
			sequence: task.revision,
			status,
			detail,
			createdAt: this.timestamp(),
		};
		this.database
			.prepare("INSERT INTO pi_study_research_task_event VALUES (?, ?, ?, ?, ?)")
			.run(event.eventId, event.projectId, event.taskId, stableStringify(event), contentHash(event));
	}

	private canTransition(current: TaskStatus, next: TaskStatus): boolean {
		const allowed: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
			queued: ["admitted", "cancelled"],
			admitted: ["launching", "cancelled", "failed"],
			launching: ["running", "failed", "cancelled", "reconciling"],
			running: ["succeeded", "failed", "cancelled", "limit-reached", "reconciling", "needs-input"],
			succeeded: [],
			failed: [],
			cancelled: [],
			"limit-reached": [],
			reconciling: ["running", "succeeded", "failed", "cancelled", "needs-input"],
			"needs-input": ["queued", "cancelled"],
		};
		return allowed[current].includes(next);
	}

	private assertFrozenTaskCompletion(
		task: StudyTask,
		expectedRevision: number,
		kind: TaskKind,
	): FrozenTaskAuthorization {
		if (task.revision !== expectedRevision)
			throw new StudyResearchError("TASK_CONFLICT", "task changed before callback");
		if (task.kind !== kind || task.status !== "succeeded") {
			throw new StudyResearchError("TASK_NOT_COMPLETE", `${kind} callback requires a succeeded ${kind} task`);
		}
		return task.authorization;
	}

	private readResult(projectId: string, resultId: string): ResearchResult {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_result WHERE project_id = ? AND result_id = ?",
			)
			.get(projectId, resultId) as PayloadRow | undefined;
		const result = this.decodeResult(row, "research result");
		if (result.contentHash !== scientificResultHash(result)) {
			throw new StudyResearchError("CORRUPT_STATE", "research result failed its scientific integrity check");
		}
		return result;
	}

	private decodeResult(row: PayloadRow | undefined, label: string): ResearchResult {
		const raw = this.decode<ResearchResult>(row, label);
		if (raw.origin) return raw;
		if (!raw.taskId) {
			throw new StudyResearchError("CORRUPT_STATE", "legacy research result has no execution task");
		}
		if (raw.contentHash !== scientificResultHash(raw)) {
			throw new StudyResearchError("CORRUPT_STATE", "legacy research result failed its scientific integrity check");
		}
		const normalized = {
			...raw,
			origin: {
				kind: "legacy-execution" as const,
				taskId: raw.taskId,
				taskRevision: 1,
				manifest: raw.manifest,
			},
			claims: [],
			state: raw.confirmedAt === null ? ("draft" as const) : ("confirmed" as const),
		};
		return { ...normalized, contentHash: scientificResultHash(normalized) };
	}

	private validateResearchAnalysisDraft(input: ResearchAnalysisDraft): ResearchAnalysisDraft {
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			throw new StudyResearchError("INVALID_RESULT", "result analysis draft must be an object");
		}
		if (!(["positive", "negative", "inconclusive"] as const).includes(input.classification)) {
			throw new StudyResearchError("INVALID_RESULT", "result classification is invalid");
		}
		return {
			classification: input.classification,
			summary: requiredText(input.summary, "result.summary", 200_000),
			limitations: this.stringList(input.limitations, "result.limitations"),
			claims: this.stringList(input.claims, "result.claims"),
		};
	}

	private validateResearchResultOrigin(scope: Scope, input: ResearchResultOrigin): ResearchResultOrigin {
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "result origin must be an object");
		}
		if (input.kind === "theory-plan") {
			const plan = this.validateFrozenPlanSnapshot(scope.projectId, input.planSnapshot);
			if (plan.kind !== "theory") {
				throw new StudyResearchError("INVALID_RESULT_ORIGIN", "a theory result requires a TheoryPlan");
			}
			const current = this.readPlan(scope.projectId, plan.planId);
			if (stableStringify(current) !== stableStringify(plan)) {
				throw new StudyResearchError("PLAN_CONFLICT", "TheoryPlan changed before the analysis draft was saved");
			}
			return { kind: "theory-plan", planSnapshot: this.copy(plan) };
		}
		if (input.kind === "legacy-execution") {
			const task = this.readTask(input.taskId);
			this.assertLegacyExecutionResultTask(scope.projectId, task, input.taskRevision, input.manifest);
			return {
				kind: "legacy-execution",
				taskId: task.taskId,
				taskRevision: task.revision,
				manifest: validateManifest(input.manifest),
			};
		}
		if (input.kind !== "terminal-run") {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "result origin kind is invalid");
		}
		const task = this.readTask(input.taskId);
		const terminalStatus = this.validateTerminalResearchTaskStatus(input.terminalStatus);
		if (task.projectId !== scope.projectId || task.kind !== "execution" || task.status !== terminalStatus) {
			throw new StudyResearchError(
				"RESULT_TERMINAL_RUN_REQUIRED",
				"analysis requires the matching immutable terminal Research execution",
			);
		}
		if (task.revision !== input.taskRevision || task.producerContextId === null) {
			throw new StudyResearchError(
				"EXECUTION_PROVENANCE_REQUIRED",
				"terminal run lacks trusted execution provenance",
			);
		}
		this.readTrustedRunnerContext(task.producerContextId);
		const planSnapshot = this.validateFrozenPlanSnapshot(scope.projectId, input.planSnapshot);
		this.assertTerminalPlanAuthorizedByTask(task, planSnapshot);
		const manifest = validateManifest(input.manifest);
		if (stableStringify(manifest) !== stableStringify(task.manifest)) {
			throw new StudyResearchError("RESULT_MANIFEST_CONFLICT", "terminal run manifest differs from its task");
		}
		const cell = this.validateTerminalResultCell(input, manifest);
		const output = this.validateTerminalResultOutput(input, terminalStatus);
		return {
			kind: "terminal-run",
			taskId: task.taskId,
			taskRevision: task.revision,
			terminalStatus,
			planSnapshot,
			cell,
			manifest,
			output,
		};
	}

	private validateFrozenPlanSnapshot(projectId: string, value: ResearchPlan): ResearchPlan {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "result plan snapshot must be an object");
		}
		requiredText(value.planId, "result planSnapshot.planId", 128);
		if (value.projectId !== projectId) {
			throw new StudyResearchError("CROSS_PROJECT", "result plan snapshot belongs to another project");
		}
		requiredRevision(value.revision, "result planSnapshot.revision");
		if (!(["theory", "smoke", "formal", "exploration"] as const).includes(value.kind)) {
			throw new StudyResearchError("INVALID_PLAN_KIND", "result plan snapshot kind is invalid");
		}
		const kind = value.kind as PlanKind;
		const detail = validatePlanDetail(kind, value.detail);
		const sourceVersionHashes = this.hashList(
			value.sourceVersionHashes,
			"result planSnapshot.sourceVersionHashes",
			value.sourceReferences !== undefined,
		);
		const sourceReferences =
			value.sourceReferences === undefined
				? undefined
				: this.resolvePlanInputSourceReferences(projectId, sourceVersionHashes, value.sourceReferences);
		const semanticDigest = contentHash({ kind, detail, sourceVersionHashes, sourceReferences });
		if (value.semanticDigest !== semanticDigest) {
			throw new StudyResearchError("RESULT_PLAN_DIGEST_CONFLICT", "result plan snapshot semantic digest is invalid");
		}
		return {
			planId: value.planId,
			projectId,
			revision: value.revision,
			kind,
			detail,
			sourceReferences,
			sourceVersionHashes,
			semanticDigest,
			createdAt: requiredText(value.createdAt, "result planSnapshot.createdAt", 128),
			updatedAt: requiredText(value.updatedAt, "result planSnapshot.updatedAt", 128),
		};
	}

	private assertTerminalPlanAuthorizedByTask(task: StudyTask, plan: ResearchPlan): void {
		if (task.authorization.kind === "research-grant") {
			if (
				task.authorization.planId !== plan.planId ||
				task.authorization.planRevision !== plan.revision ||
				task.authorization.semanticDigest !== plan.semanticDigest
			) {
				throw new StudyResearchError(
					"RESULT_PLAN_CONFLICT",
					"terminal run plan differs from its frozen Research grant",
				);
			}
			return;
		}
		if (plan.kind !== "smoke") {
			throw new StudyResearchError(
				"RESULT_PLAN_CONFLICT",
				"a learning execution can only retain a smoke-plan terminal result",
			);
		}
	}

	private assertLegacyExecutionResultTask(
		projectId: string,
		task: StudyTask,
		expectedRevision: number,
		manifest: RunManifest,
	): void {
		if (
			task.projectId !== projectId ||
			task.kind !== "execution" ||
			task.status !== "succeeded" ||
			task.revision !== expectedRevision ||
			task.authorization.kind !== "research-grant" ||
			task.producerContextId === null
		) {
			throw new StudyResearchError(
				"EXECUTION_PROVENANCE_REQUIRED",
				"legacy result requires a succeeded Research execution",
			);
		}
		this.readTrustedRunnerContext(task.producerContextId);
		if (stableStringify(validateManifest(manifest)) !== stableStringify(task.manifest)) {
			throw new StudyResearchError("RESULT_MANIFEST_CONFLICT", "legacy result manifest differs from its task");
		}
	}

	private validateTerminalResultCell(
		origin: Extract<ResearchResultOrigin, { kind: "terminal-run" }>,
		manifest: RunManifest,
	): Extract<ResearchResultOrigin, { kind: "terminal-run" }>["cell"] {
		const cell = origin.cell;
		if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run cell must be an object");
		}
		requiredText(cell.cellId, "terminal run cellId", 128);
		requiredRevision(cell.revision, "terminal run cell revision");
		requiredHash(cell.contentHash, "terminal run cell content hash");
		if (cell.language !== "python" && cell.language !== "r") {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run language is invalid");
		}
		if (
			typeof cell.code !== "string" ||
			!cell.code.trim() ||
			cell.code.length > 2_000_000 ||
			cell.code.includes("\0")
		) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run code is invalid");
		}
		if (!cell.parameters || typeof cell.parameters !== "object" || Array.isArray(cell.parameters)) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run parameters must be an object");
		}
		if (
			`sha256:${sha256Hex(cell.code)}` !== manifest.codeHash ||
			contentHash(cell.parameters) !== manifest.parameterHash
		) {
			throw new StudyResearchError(
				"RESULT_MANIFEST_CONFLICT",
				"terminal run code or parameters differ from its manifest",
			);
		}
		if (!Array.isArray(cell.inputs) || cell.inputs.length > 1_000) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run inputs must be bounded");
		}
		const inputHashes: Record<string, string> = {};
		for (const [index, input] of cell.inputs.entries()) {
			if (!input || typeof input !== "object" || Array.isArray(input)) {
				throw new StudyResearchError("INVALID_RESULT_ORIGIN", `terminal run input ${index} is invalid`);
			}
			const name = requiredText(input.name, `terminal run input ${index} name`, 4_096);
			if (Object.hasOwn(inputHashes, name)) {
				throw new StudyResearchError("DUPLICATE_VALUE", "terminal run inputs repeat a name");
			}
			inputHashes[name] = requiredHash(input.sourceHash, `terminal run input ${index} hash`);
			requiredText(input.sourceId, `terminal run input ${index} source id`, 128);
		}
		if (stableStringify(inputHashes) !== stableStringify(manifest.inputHashes)) {
			throw new StudyResearchError("RESULT_MANIFEST_CONFLICT", "terminal run inputs differ from its manifest");
		}
		return this.copy({
			cellId: cell.cellId,
			revision: cell.revision,
			contentHash: cell.contentHash,
			language: cell.language,
			code: cell.code,
			parameters: cell.parameters,
			inputs: cell.inputs,
		});
	}

	private validateTerminalResultOutput(
		origin: Extract<ResearchResultOrigin, { kind: "terminal-run" }>,
		terminalStatus: TerminalResearchTaskStatus,
	): Extract<ResearchResultOrigin, { kind: "terminal-run" }>["output"] {
		const output = origin.output;
		if (!output || typeof output !== "object" || Array.isArray(output)) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run output must be an object");
		}
		requiredHash(output.outputHash, "terminal run output hash");
		if (output.status !== terminalStatus) {
			throw new StudyResearchError(
				"RESULT_TERMINAL_STATUS_CONFLICT",
				"terminal run output status differs from its task",
			);
		}
		if (output.usage !== null) {
			if (
				!Number.isSafeInteger(output.usage.wallTimeMs) ||
				output.usage.wallTimeMs < 0 ||
				!Number.isSafeInteger(output.usage.diskBytes) ||
				output.usage.diskBytes < 0
			) {
				throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run usage is invalid");
			}
		}
		for (const [label, value] of Object.entries({
			stdout: output.stdout,
			stderr: output.stderr,
			error: output.error,
		})) {
			if (value !== null && (typeof value !== "string" || value.length > 200_000 || value.includes("\0"))) {
				throw new StudyResearchError("INVALID_RESULT_ORIGIN", `terminal run ${label} is invalid`);
			}
		}
		if (typeof output.truncated !== "boolean") {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run truncation marker is invalid");
		}
		if (output.observedAt !== null && !Number.isFinite(Date.parse(output.observedAt))) {
			throw new StudyResearchError("INVALID_RESULT_ORIGIN", "terminal run observation time is invalid");
		}
		return this.copy(output);
	}

	private validateTerminalResearchTaskStatus(value: TerminalResearchTaskStatus): TerminalResearchTaskStatus {
		if (!(["succeeded", "failed", "cancelled", "limit-reached"] as const).includes(value)) {
			throw new StudyResearchError("RESULT_TERMINAL_RUN_REQUIRED", "result requires a terminal execution status");
		}
		return value;
	}

	private resultTaskId(origin: ResearchResultOrigin): string | null {
		return origin.kind === "theory-plan" ? null : origin.taskId;
	}

	private resultStorageKey(origin: ResearchResultOrigin): string {
		if (origin.kind !== "theory-plan") return origin.taskId;
		return `theory:${origin.planSnapshot.planId}:${origin.planSnapshot.revision}`;
	}

	private resultManifest(origin: ResearchResultOrigin): RunManifest {
		if (origin.kind !== "theory-plan") return this.copy(origin.manifest);
		return {
			codeHash: contentHash({
				kind: origin.kind,
				planId: origin.planSnapshot.planId,
				revision: origin.planSnapshot.revision,
			}),
			parameterHash: contentHash({ planId: origin.planSnapshot.planId, revision: origin.planSnapshot.revision }),
			inputHashes: {},
			environmentHash: origin.planSnapshot.semanticDigest,
		};
	}

	private saveResultHistory(result: ResearchResult): void {
		this.database
			.prepare(
				"INSERT INTO pi_study_research_result_history (result_id, project_id, revision, payload, payload_hash) VALUES (?, ?, ?, ?, ?)",
			)
			.run(result.resultId, result.projectId, result.revision, stableStringify(result), contentHash(result));
	}

	private assertVersionTarget(
		projectId: string,
		kind: VersionCheck["targetKind"],
		id: string,
		revision: number,
		hash: string,
	): VersionedArtifactTarget {
		requiredRevision(revision, "targetRevision");
		requiredHash(hash, "targetHash");
		if (kind === "result") {
			const result = this.readResult(projectId, id);
			if (result.revision !== revision || result.contentHash !== hash) {
				throw new StudyResearchError("VERSION_MISMATCH", "check target is not the claimed result version");
			}
			if (result.origin.kind === "theory-plan") {
				return {
					targetKind: "result",
					targetId: result.resultId,
					targetRevision: result.revision,
					targetHash: result.contentHash,
					executionTaskId: null,
					executionProducerContextId: null,
					executionProducerIdentity: null,
				};
			}
			const execution = this.readTask(result.origin.taskId);
			if (execution.producerContextId === null) {
				throw new StudyResearchError(
					"EXECUTION_PROVENANCE_REQUIRED",
					"result target lacks a trusted execution context",
				);
			}
			const producer = this.readTrustedRunnerContext(execution.producerContextId);
			return {
				targetKind: "result",
				targetId: result.resultId,
				targetRevision: result.revision,
				targetHash: result.contentHash,
				executionTaskId: result.origin.taskId,
				executionProducerContextId: producer.contextId,
				executionProducerIdentity: producer.producerIdentity,
			};
		}
		if (kind === "visualization") {
			const visualization = this.readVisualization(projectId, id);
			if (visualization.revision !== revision || visualization.contentHash !== hash) {
				throw new StudyResearchError("VERSION_MISMATCH", "check target is not the claimed visualization version");
			}
			return {
				targetKind: "visualization",
				targetId: visualization.visualizationId,
				targetRevision: visualization.revision,
				targetHash: visualization.contentHash,
				executionTaskId: null,
				executionProducerContextId: visualization.creatorContextId,
				executionProducerIdentity: visualization.creatorIdentity,
			};
		}
		throw new StudyResearchError("INVALID_CHECK", "check target kind is invalid");
	}

	private validateCheckInput(input: VersionCheckInput): VersionCheck["status"] {
		if (!["passed", "failed", "inconclusive"].includes(input.status)) {
			throw new StudyResearchError("INVALID_CHECK", "check status is invalid");
		}
		this.stringList(input.findings, "check.findings");
		return input.status;
	}

	private assertReservedTaskTarget(task: StudyTask, input: VersionCheckInput): FrozenCheckTarget {
		const target = task.target;
		if (!target) throw new StudyResearchError("CHECK_TARGET_REQUIRED", "task was not reserved with a check target");
		if (
			target.targetKind !== input.targetKind ||
			target.targetId !== input.targetId ||
			target.targetRevision !== input.targetRevision ||
			target.targetHash !== input.targetHash
		) {
			throw new StudyResearchError(
				"CHECK_TARGET_CONFLICT",
				"callback target differs from the task reservation target",
			);
		}
		const current = this.assertVersionTarget(
			task.projectId,
			target.targetKind,
			target.targetId,
			target.targetRevision,
			target.targetHash,
		);
		if (stableStringify(current) !== stableStringify(target)) {
			throw new StudyResearchError("CHECK_TARGET_CONFLICT", "target producer provenance changed after reservation");
		}
		return target;
	}

	private recordVersionCheck(table: "validation", input: VersionCheckInput): VersionCheck {
		return this.transaction(() => {
			const task = this.readTask(input.taskId);
			this.assertFrozenTaskCompletion(task, input.expectedTaskRevision, "validation");
			const target = this.assertReservedTaskTarget(task, input);
			const check: VersionCheck = {
				checkId: this.newId(table),
				projectId: task.projectId,
				targetKind: target.targetKind,
				targetId: target.targetId,
				targetRevision: target.targetRevision,
				targetHash: target.targetHash,
				taskId: task.taskId,
				taskAuthorization: task.authorization,
				manifest: task.manifest,
				producerContextId: task.producerContextId,
				status: this.validateCheckInput(input),
				findings: this.stringList(input.findings, "validation.findings"),
				createdAt: this.timestamp(),
			};
			this.savePayload("pi_study_research_validation", "check_id", check.checkId, check, task.projectId);
			return this.copy(check);
		});
	}

	private assertResultCanBeFormallyConfirmed(result: ResearchResult): void {
		if (result.claims.length === 0) {
			throw new StudyResearchError(
				"FORMAL_CLAIMS_REQUIRED",
				"formal confirmation requires at least one explicit claim",
			);
		}
		if (result.limitations.length === 0) {
			throw new StudyResearchError("RESULT_LIMITATIONS_REQUIRED", "formal confirmation requires stated limitations");
		}
		const reviews = (
			this.database
				.prepare(
					"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_research_review WHERE project_id = ?",
				)
				.all(result.projectId) as unknown as PayloadRow[]
		)
			.map((row) => this.decode<VersionCheck>(row, "review"))
			.filter(
				(check) =>
					check.targetKind === "result" &&
					check.targetId === result.resultId &&
					check.targetRevision === result.revision &&
					check.targetHash === result.contentHash,
			);
		if (!reviews.some((check) => check.status === "passed") || reviews.some((check) => check.status !== "passed")) {
			throw new StudyResearchError(
				"REVIEW_BLOCKS_CONFIRMATION",
				"formal confirmation requires a passing exact-version independent review with no failed or unresolved review",
			);
		}
	}

	private listChecks(
		scope: Scope,
		table: "pi_study_research_validation" | "pi_study_research_review",
		label: string,
		target?: Pick<VersionCheck, "targetKind" | "targetId" | "targetRevision" | "targetHash">,
	): VersionCheck[] {
		this.assertScope(scope);
		const checks = (
			this.database
				.prepare(
					`SELECT payload AS payload, payload_hash AS payloadHash FROM ${table} WHERE project_id = ? ORDER BY check_id`,
				)
				.all(scope.projectId) as unknown as PayloadRow[]
		).map((row) => this.copy(this.decode<VersionCheck>(row, label)));
		if (!target) return checks;
		return checks.filter(
			(check) =>
				check.targetKind === target.targetKind &&
				check.targetId === target.targetId &&
				check.targetRevision === target.targetRevision &&
				check.targetHash === target.targetHash,
		);
	}

	private validateStudyAdmission(value: StudyTaskAdmission): StudyTaskAdmission {
		requiredText(value.purpose, "study admission purpose", 20_000);
		if (value.language !== "python" && value.language !== "r" && value.language !== "none") {
			throw new StudyResearchError("INVALID_STUDY_ADMISSION", "Study admission language is invalid");
		}
		if (!Number.isSafeInteger(value.maxWallSeconds) || value.maxWallSeconds < 1 || value.maxWallSeconds > 3_600) {
			throw new StudyResearchError("INVALID_STUDY_ADMISSION", "Study wall time must be 1..3600 seconds");
		}
		if (!Number.isSafeInteger(value.maxMemoryMiB) || value.maxMemoryMiB < 16 || value.maxMemoryMiB > 1_048_576) {
			throw new StudyResearchError("INVALID_STUDY_ADMISSION", "Study memory must be 16..1048576 MiB");
		}
		return structuredClone(value);
	}

	private stringList(value: readonly string[], label: string): string[] {
		if (!Array.isArray(value) || value.length > 1_000) {
			throw new StudyResearchError("INVALID_INPUT", `${label} must be a bounded string array`);
		}
		const result = value.map((item, index) => requiredText(item, `${label}[${index}]`, 20_000));
		if (new Set(result).size !== result.length) {
			throw new StudyResearchError("DUPLICATE_VALUE", `${label} contains duplicate values`);
		}
		return result;
	}

	private hashList(value: readonly string[], label: string, allowDuplicates: boolean): string[] {
		if (!Array.isArray(value) || value.length > 1_000) {
			throw new StudyResearchError("INVALID_INPUT", `${label} must be a bounded hash array`);
		}
		const hashes = value.map((hash, index) => requiredHash(hash, `${label}[${index}]`));
		if (!allowDuplicates && new Set(hashes).size !== hashes.length) {
			throw new StudyResearchError("DUPLICATE_VALUE", `${label} contains duplicate values`);
		}
		return hashes;
	}
}
