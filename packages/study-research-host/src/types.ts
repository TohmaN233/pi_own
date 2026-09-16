/** Durable domain contracts for the Study & Research product. This package does not execute processes. */
export type StudyPhase = "study" | "research";
export type SourceKind = "pdf" | "tex" | "docx" | "text" | "code" | "asset";
export type CoverageKind = "extracted" | "read" | "checked";
export type SourceRole = "primary" | "tex-include" | "linked-pdf" | "reference" | "supplement" | "code";
export type PlanKind = "theory" | "smoke" | "formal" | "exploration";
export type TaskKind = "reading" | "paper-map" | "execution" | "validation" | "review" | "explanation";
export type TaskStatus =
	| "queued"
	| "admitted"
	| "launching"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "limit-reached"
	| "reconciling"
	| "needs-input";
export type CheckStatus = "passed" | "failed" | "inconclusive";

export interface Scope {
	projectId: string;
	sessionId: string;
	expectedPhaseRevision: number;
}

export interface PhaseBinding {
	projectId: string;
	sessionId: string;
	phase: StudyPhase;
	revision: number;
	changedAt: string;
}

export interface SourceVersion {
	sourceId: string;
	projectId: string;
	/** Trusted UI import adapter path; this is never exposed as an arbitrary Agent file read capability. */
	sourceRoot: string;
	relativePath: string;
	kind: SourceKind;
	sourceRole: SourceRole;
	diagnostics: SourceDiagnostic[];
	contentHash: string;
	parser: string;
	version: number;
	current: boolean;
	createdAt: string;
}

export interface SourceDiagnostic {
	severity: "info" | "warning" | "error";
	code: string;
	message: string;
	path: string | null;
	locator: string | null;
	requiresPdfInspection: boolean;
}

export interface SourceChunk {
	chunkId: string;
	projectId: string;
	sourceId: string;
	sourceHash: string;
	ordinal: number;
	locator: string;
	text: string;
	textHash: string;
	createdAt: string;
}

export interface ReadCheckpoint {
	checkpointId: string;
	projectId: string;
	sessionId: string;
	sourceId: string;
	sourceHash: string;
	kind: CoverageKind;
	locator: string;
	note: string;
	createdAt: string;
}

export interface KnowledgeNote {
	noteId: string;
	projectId: string;
	revision: number;
	author: "user" | "agent";
	/** A direct user edit makes even an agent-created note ineligible for source rebasing. */
	manuallyEdited: boolean;
	body: string;
	sourceId: string | null;
	sourceHash: string | null;
	nodeIds: string[];
	stale: boolean;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface KnowledgeNode {
	nodeId: string;
	projectId: string;
	revision: number;
	kind: "concept" | "claim" | "proof" | "assumption" | "implementation" | "question";
	title: string;
	statement: string;
	scope: string;
	sourceId: string | null;
	sourceHash: string | null;
	manuallyEdited: boolean;
	stale: boolean;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface KnowledgeRelation {
	relationId: string;
	projectId: string;
	revision: number;
	fromNodeId: string;
	toNodeId: string;
	kind: "prerequisite" | "supports" | "contradicts" | "refers-to" | "implements";
	/** Unknown is retained only for legacy rows whose relation provenance was never persisted. */
	author: "user" | "agent" | "unknown";
	manuallyEdited: boolean;
	sourceId: string | null;
	sourceHash: string | null;
	/** Retired source-local relations are history, not active graph edges. */
	stale: boolean;
	/** Legacy unknown relations require explicit human review before any destructive replacement. */
	requiresReview: boolean;
	createdAt: string;
}

export interface KnowledgeNodeDraft {
	localKey: string;
	/**
	 * Only source-update candidates may use this CAS replacement identity. Omission
	 * creates a new node; it never means "pick the next old node".
	 */
	replaceNodeId?: string;
	kind: KnowledgeNode["kind"];
	title: string;
	statement: string;
	scope: string;
	sourceId: string | null;
	sourceHash: string | null;
	manuallyEdited: boolean;
}

export interface KnowledgeNoteDraft {
	/** See KnowledgeNodeDraft.replaceNodeId. */
	replaceNoteId?: string;
	author: KnowledgeNote["author"];
	body: string;
	sourceId: string | null;
	sourceHash: string | null;
	nodeLocalKeys: string[];
}

export interface KnowledgeRelationDraft {
	fromNodeLocalKey: string;
	toNodeLocalKey: string;
	kind: KnowledgeRelation["kind"];
}

export interface KnowledgeRelationInput {
	fromNodeId: string;
	toNodeId: string;
	kind: KnowledgeRelation["kind"];
	expectedProjectRevision: number;
}

export interface KnowledgeChange {
	notes: readonly KnowledgeNoteDraft[];
	nodes: readonly KnowledgeNodeDraft[];
	relations: readonly KnowledgeRelationDraft[];
}

/** Explicit CAS edits are intentionally separate from additive change sets. */
export interface KnowledgeNoteEdit {
	noteId: string;
	expectedNoteRevision: number;
	expectedProjectRevision: number;
	body: string;
	sourceId: string | null;
	sourceHash: string | null;
	nodeIds: string[];
}

export interface KnowledgeNodeEdit {
	nodeId: string;
	expectedNodeRevision: number;
	expectedProjectRevision: number;
	kind: KnowledgeNode["kind"];
	title: string;
	statement: string;
	scope: string;
	sourceId: string | null;
	sourceHash: string | null;
	manuallyEdited: boolean;
}

export interface SourceVersionInput {
	sourceRoot: string;
	relativePath: string;
	kind: SourceKind;
	sourceRole: SourceRole;
	diagnostics: SourceDiagnostic[];
	contentHash: string;
	parser: string;
	chunks: readonly Omit<SourceChunk, "chunkId" | "projectId" | "sourceId" | "sourceHash" | "textHash" | "createdAt">[];
}

export interface SourceUpdateProposal {
	proposalId: string;
	projectId: string;
	sourceId: string;
	previousHash: string;
	candidateHash: string;
	baseProjectRevision: number;
	status: "pending" | "accepted" | "rejected" | "superseded";
	changeSummary: string;
	createdAt: string;
	resolvedAt: string | null;
}

/** The only project knowledge a source-update proposal is allowed to touch. */
export interface SourceUpdateAffectedKnowledge {
	notes: KnowledgeNote[];
	nodes: KnowledgeNode[];
	relations: KnowledgeRelation[];
}

export interface SourceUpdateDetails {
	proposal: SourceUpdateProposal;
	candidate: SourceVersion;
	candidateKnowledge: KnowledgeChange;
	affected: SourceUpdateAffectedKnowledge;
}

export interface TheoryPlan {
	question: string;
	assumptions: string[];
	propositions: string[];
	proofSteps: string[];
	counterexamples: string[];
	openGaps: string[];
}

export interface SmokePlan {
	question: string;
	method: string;
	evaluation: string;
	allowedChanges: string[];
}

export interface FormalPlan {
	question: string;
	hypotheses: string[];
	datasetVersion: string;
	splitProtocol: string;
	primaryMetrics: string[];
	method: string;
	stoppingConditions: string[];
}

export interface ExplorationPlan {
	question: string;
	direction: string;
	allowedChanges: string[];
	stoppingConditions: string[];
}

export type ResearchPlanDetail = TheoryPlan | SmokePlan | FormalPlan | ExplorationPlan;

export interface ResearchPlan {
	planId: string;
	projectId: string;
	revision: number;
	kind: PlanKind;
	detail: ResearchPlanDetail;
	/** Exact source identities used for grants; legacy hash-only plans are revalidated fail-closed. */
	sourceReferences?: SourceReference[];
	sourceVersionHashes: string[];
	semanticDigest: string;
	createdAt: string;
	updatedAt: string;
}

export interface ResearchPlanInput {
	kind: PlanKind;
	detail: ResearchPlanDetail;
	sourceVersionHashes: string[];
	/** Explicit source identities prevent an ambiguous content hash from selecting an arbitrary source. */
	sourceReferences?: readonly SourceReference[];
}

export interface SourceReference {
	sourceId: string;
	contentHash: string;
}

export interface ScopeGrant {
	grantId: string;
	projectId: string;
	sessionId: string;
	planId: string;
	planRevision: number;
	semanticDigest: string;
	/** Retained for stored-record compatibility; admission uses referencedSources instead. */
	scopeEpoch: number;
	referencedSources: Array<{ sourceId: string; contentHash: string }>;
	userEventId: string;
	expiresAt: string;
	revokedAt: string | null;
	createdAt: string;
}

export interface RunManifest {
	codeHash: string;
	parameterHash: string;
	inputHashes: Record<string, string>;
	environmentHash: string;
}

export interface StudyTaskAdmission {
	purpose: string;
	language: "python" | "r" | "none";
	maxWallSeconds: number;
	maxMemoryMiB: number;
}

/**
 * Bounded learning admission is deliberately distinct from a Research scope grant.
 * It may originate in either explicit interactive phase without changing that phase.
 */
export interface FrozenLearningTaskAuthorization {
	kind: "learning";
	projectId: string;
	sessionId: string;
	phase: StudyPhase;
	phaseRevision: number;
	admission: StudyTaskAdmission;
}

/** @deprecated Use FrozenLearningTaskAuthorization; the name remains source-compatible. */
export type FrozenStudyTaskAuthorization = FrozenLearningTaskAuthorization;

export interface FrozenCheckTarget {
	targetKind: VersionCheck["targetKind"];
	targetId: string;
	targetRevision: number;
	targetHash: string;
	executionTaskId: string | null;
	executionProducerContextId: string | null;
	executionProducerIdentity: string | null;
}

export interface FrozenResearchTaskAuthorization {
	kind: "research-grant";
	projectId: string;
	sessionId: string;
	phase: "research";
	phaseRevision: number;
	grantId: string;
	planId: string;
	planRevision: number;
	semanticDigest: string;
}

export type FrozenTaskAuthorization = FrozenLearningTaskAuthorization | FrozenResearchTaskAuthorization;

export interface StudyTask {
	taskId: string;
	projectId: string;
	dispatchKey: string;
	dispatchFingerprint: string;
	kind: TaskKind;
	status: TaskStatus;
	revision: number;
	authorization: FrozenTaskAuthorization;
	manifest: RunManifest;
	/** Host-owned runner context registered before the task was reserved. */
	producerContextId: string | null;
	/** Validation/review callbacks can only write this reservation-time target. */
	target: FrozenCheckTarget | null;
	createdAt: string;
	updatedAt: string;
}

export interface TaskEvent {
	eventId: string;
	projectId: string;
	taskId: string;
	sequence: number;
	status: TaskStatus;
	detail: string;
	createdAt: string;
}

export interface ReservationResult {
	task: StudyTask;
	replay: boolean;
}

export type TerminalResearchTaskStatus = "succeeded" | "failed" | "cancelled" | "limit-reached";

/**
 * The analysis record freezes the actual execution inputs that were available to
 * the result author. It is intentionally a product record rather than a live
 * handle: output bytes and local paths remain with the execution adapter.
 */
export interface TerminalResearchRunOrigin {
	kind: "terminal-run";
	taskId: string;
	taskRevision: number;
	terminalStatus: TerminalResearchTaskStatus;
	planSnapshot: ResearchPlan;
	cell: {
		cellId: string;
		revision: number;
		contentHash: string;
		language: "python" | "r";
		code: string;
		parameters: Record<string, unknown>;
		inputs: Array<{ name: string; sourceId: string; sourceHash: string }>;
	};
	manifest: RunManifest;
	/** Hash of the complete trusted coordinator observation, plus bounded retained excerpts. */
	output: {
		outputHash: string;
		status: TerminalResearchTaskStatus;
		usage: { wallTimeMs: number; diskBytes: number } | null;
		stdout: string | null;
		stderr: string | null;
		error: string | null;
		truncated: boolean;
		observedAt: string | null;
	};
}

/** Theory analysis starts from an exact immutable plan revision and never invents an execution task. */
export interface TheoryResearchResultOrigin {
	kind: "theory-plan";
	planSnapshot: ResearchPlan;
}

/** Retained only for old execution-only callers that do not have a complete frozen run packet. */
export interface LegacyExecutionResultOrigin {
	kind: "legacy-execution";
	taskId: string;
	taskRevision: number;
	manifest: RunManifest;
}

export type ResearchResultOrigin = TerminalResearchRunOrigin | TheoryResearchResultOrigin | LegacyExecutionResultOrigin;

export interface ResearchAnalysisDraft {
	classification: "positive" | "negative" | "inconclusive";
	summary: string;
	limitations: string[];
	/** Important derivations or claims remain reviewable material, never an approval shortcut. */
	claims: string[];
}

export interface ResearchResult {
	resultId: string;
	projectId: string;
	/** Null is a genuine theory origin, not a synthetic execution task. */
	taskId: string | null;
	revision: number;
	origin: ResearchResultOrigin;
	classification: ResearchAnalysisDraft["classification"];
	summary: ResearchAnalysisDraft["summary"];
	limitations: ResearchAnalysisDraft["limitations"];
	claims: ResearchAnalysisDraft["claims"];
	state: "draft" | "confirmed";
	manifest: RunManifest;
	confirmedAt: string | null;
	confirmedUserEventId: string | null;
	publishedAt: string | null;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface VersionCheck {
	checkId: string;
	projectId: string;
	targetKind: "result" | "visualization";
	targetId: string;
	targetRevision: number;
	targetHash: string;
	taskId: string;
	taskAuthorization: FrozenTaskAuthorization;
	manifest: RunManifest;
	producerContextId: string | null;
	status: CheckStatus;
	findings: string[];
	createdAt: string;
}

export interface IndependentReview extends VersionCheck {
	reviewerContextId: string;
}

/** A context minted by the trusted execution adapter, never supplied by an Agent callback. */
export interface TrustedRunnerContext {
	contextId: string;
	projectId: string;
	sessionId: string;
	producerIdentity: string;
	createdAt: string;
}

export interface VisualizationDraft {
	visualizationId: string;
	projectId: string;
	revision: number;
	owner: StudyPhase;
	/** Trusted provenance of the session that created this exact visualization revision. */
	creatorContextId: string;
	creatorIdentity: string;
	purpose: string;
	code: string;
	codeHash: string;
	/** Canonical hash of the bounded render parameters; inputs remain available for deterministic reopen. */
	inputHash: string;
	inputs: Record<string, unknown>;
	inputHashes: Record<string, string>;
	environmentHash: string;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface VisualizationDraftInput {
	/** Minted by the trusted adapter for the originating Pi session, never by an Agent callback. */
	creatorContextId?: string;
	purpose: string;
	code: string;
	inputs: Record<string, unknown>;
	inputHashes: Record<string, string>;
	environmentHash: string;
}

/** A source identity and bounded locator frozen before an Agent receives a packet. */
export interface StudyAgentSourceEvidence {
	id: string;
	sourceId: string;
	sourceHash: string;
	locator: string;
}

/** The validation/review target exposed to product callers; provenance handles stay private. */
export interface StudyAgentReportTarget {
	targetKind: VersionCheck["targetKind"];
	targetId: string;
	targetRevision: number;
	targetHash: string;
}

/** Public packet identity deliberately excludes its local JSONL path. */
export interface StudyAgentPacketContext {
	agentSessionId: string;
	packetHash: string;
}

/** Trusted worker-only allocation. Do not return this object from browser-facing APIs. */
export interface StudyAgentPrivateContext {
	agentSessionId: string;
	sessionFile: string;
}

/** The callback finalizes a task-id-bound Pi packet while the queue savepoint is open. */
export interface StudyAgentPacketBinding {
	packetHash: string;
}

export interface StudyAgentFinding {
	severity: "major" | "moderate" | "minor" | "uncertain";
	explanation: string;
	evidenceIds: readonly string[];
}

export interface StudyAgentNote {
	title: string;
	body: string;
	evidenceIds: readonly string[];
}

/** The five durable sections of a whole-paper learning map. */
export interface StudyPaperMapSections {
	problem: string;
	contributions: string;
	assumptionsNotation: string;
	argumentDependencies: string;
	limitationsUnresolved: string;
}

/** A hash-bound report edge. Recursive paper-map reductions retain every underlying report through these edges. */
export interface StudyPaperMapReportReference {
	taskId: string;
	reportHash: string;
	kind: "reading" | "paper-map";
}

/** Coverage is factual task state, separate from the model's academic uncertainty prose. */
export interface StudyPaperMapCoverage {
	totalReadingTasks: number;
	completedReadingTaskIds: readonly string[];
	unavailableReadingTasks: readonly {
		taskId: string;
		status:
			| Exclude<TaskStatus, "queued" | "admitted" | "launching" | "running" | "reconciling">
			| "missing-report"
			| "oversized-report";
	}[];
}

/**
 * A trusted worker supplies provenance and coverage after the model emits the
 * five sections. `inputReports` is a bounded recursive edge, never an
 * unbounded copy of a paper or all prior reports.
 */
export interface StudyPaperMap {
	version: 1;
	mapGroupHash: string;
	rootInputHash: string;
	level: number;
	final: boolean;
	sourceScope: readonly SourceReference[];
	coverage: StudyPaperMapCoverage;
	inputReports: readonly StudyPaperMapReportReference[];
	sections: StudyPaperMapSections;
}

/** A successful model turn may still report a failed or inconclusive academic result. */
export interface StudyAgentReportInput {
	summary: string;
	outcome: "passed" | "failed" | "inconclusive";
	findings: readonly StudyAgentFinding[];
	notes: readonly StudyAgentNote[];
	unresolved: readonly string[];
	target: StudyAgentReportTarget | null;
	/** Present only for a `paper-map` task and assembled by the trusted worker. */
	paperMap?: StudyPaperMap;
}

export interface StudyAgentReport extends StudyAgentReportInput {
	citations: readonly StudyAgentSourceEvidence[];
	reportHash: string;
	createdAt: string;
}

/** Path-free durable task projection for routes, clients, and cross-session project viewers. */
export interface StudyAgentQueueTask {
	taskId: string;
	projectId: string;
	sessionId: string;
	dispatchKey: string;
	intentHash: string;
	priority: number;
	kind: TaskKind;
	status: TaskStatus;
	taskRevision: number;
	authorization: FrozenTaskAuthorization;
	manifest: RunManifest;
	evidence: readonly StudyAgentSourceEvidence[];
	target: StudyAgentReportTarget | null;
	context: StudyAgentPacketContext;
	cancelRequestedAt: string | null;
	createdAt: string;
	updatedAt: string;
	report: StudyAgentReport | null;
}

export interface StudyAgentClaim {
	task: StudyAgentQueueTask;
	workerId: string;
	claimToken: string;
	leaseExpiresAt: string;
}

export interface StudyAgentEnqueueInput {
	scope: Scope;
	dispatchKey: string;
	intentHash: string;
	priority?: number;
	kind: "reading" | "paper-map" | "review" | "explanation";
	manifest: RunManifest;
	admission: StudyTaskAdmission;
	target?: StudyAgentReportTarget;
	evidence: readonly StudyAgentSourceEvidence[];
	context: StudyAgentPrivateContext;
}

export interface StudyAgentDispatchLookup {
	projectId: string;
	sessionId: string;
	dispatchKey: string;
}

export interface StudyAgentWorkerClaimInput {
	projectId: string;
	taskId: string;
	workerId: string;
	claimToken: string;
}

export interface StudyAgentReconcileResolution {
	status: "cancelled" | "failed" | "needs-input";
	detail: string;
}
