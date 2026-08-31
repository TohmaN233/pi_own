import type { HARNESS_CONTRACT_VERSION, HarnessRole, JsonValue } from "./contracts.ts";

export const PROFILE_MODES = ["general", "student-learn", "practice", "visual-lab", "teacher-prep"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const EXTERNAL_KNOWLEDGE_POLICIES = ["deny", "explain-and-label", "allow"] as const;
export type ExternalKnowledgePolicy = (typeof EXTERNAL_KNOWLEDGE_POLICIES)[number];

export const RESOURCE_KINDS = ["tool", "extension", "skill", "prompt", "theme"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface ResourceDescriptor {
	kind: ResourceKind;
	id: string;
	version: string;
	contentHash: string;
	required: boolean;
	enabled: boolean;
}

export interface ProfileDefinition {
	version: typeof HARNESS_CONTRACT_VERSION;
	profileId: string;
	revision: number;
	role: HarnessRole;
	mode: ProfileMode;
	provider: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
	externalKnowledgePolicy: ExternalKnowledgePolicy;
	courseRequired: boolean;
	tools: string[];
	resources: ResourceDescriptor[];
	instructions: string[];
}

export interface ProfilePatch {
	profileId?: string;
	role?: HarnessRole;
	mode?: ProfileMode;
	provider?: string | null;
	model?: string | null;
	thinkingLevel?: ThinkingLevel;
	externalKnowledgePolicy?: ExternalKnowledgePolicy;
	courseRequired?: boolean;
	tools?: string[];
	resources?: ResourceDescriptor[];
	instructions?: string[];
}

export interface ProfileLayer {
	layerId: string;
	priority: number;
	patch: ProfilePatch;
}

export interface ResourceSnapshot {
	version: typeof HARNESS_CONTRACT_VERSION;
	resourceSnapshotId: string;
	profileId: string;
	profileRevision: number;
	role: HarnessRole;
	mode: ProfileMode;
	courseVersionId: string | null;
	provider: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
	externalKnowledgePolicy: ExternalKnowledgePolicy;
	tools: string[];
	resources: ResourceDescriptor[];
	instructions: string[];
	createdAt: string;
	contentHash: string;
}

export const SNAPSHOT_SWITCH_KINDS = ["none", "hot", "warm", "hard"] as const;
export type SnapshotSwitchKind = (typeof SNAPSHOT_SWITCH_KINDS)[number];

export interface SnapshotDiff {
	kind: SnapshotSwitchKind;
	changedFields: string[];
	addedResources: string[];
	removedResources: string[];
}

export const MATERIAL_KINDS = ["markdown", "text", "code", "notebook", "pdf"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export interface CourseMaterialInput {
	name: string;
	kind: MaterialKind;
	mediaType: string;
	content: string | Uint8Array;
	metadata?: Record<string, JsonValue>;
}

export interface CourseMaterial {
	materialId: string;
	name: string;
	kind: MaterialKind;
	mediaType: string;
	contentHash: string;
	normalizedText: string;
	metadata: Record<string, JsonValue>;
}

export interface SourceSpan {
	spanId: string;
	courseVersionId: string;
	materialId: string;
	materialHash: string;
	ordinal: number;
	startLine: number;
	endLine: number;
	headingPath: string[];
	text: string;
	textHash: string;
	instructionLike: boolean;
}

export interface CourseVersion {
	version: typeof HARNESS_CONTRACT_VERSION;
	courseId: string;
	courseVersionId: string;
	revision: number;
	parentCourseVersionId: string | null;
	contentHash: string;
	createdAt: string;
	materials: CourseMaterial[];
	spans: SourceSpan[];
}

export const SCOPE_LABELS = ["direct", "synthesis", "derived", "computed", "external", "insufficient"] as const;
export type ScopeLabel = (typeof SCOPE_LABELS)[number];

export interface GroundingSpan {
	spanId: string;
	materialId: string;
	startLine: number;
	endLine: number;
	text: string;
	textHash: string;
	score: number;
	matchedTerms: string[];
}

export interface GroundingPacket {
	version: typeof HARNESS_CONTRACT_VERSION;
	packetId: string;
	sessionBindingId: string;
	resourceSnapshotId: string;
	courseVersionId: string;
	query: string;
	queryHash: string;
	createdAt: string;
	spans: GroundingSpan[];
	contentHash: string;
}

export interface AnswerClaim {
	claimId: string;
	text: string;
	scope: ScopeLabel;
	citationSpanIds: string[];
	reason: string | null;
}

export interface AnswerDraft {
	version: typeof HARNESS_CONTRACT_VERSION;
	draftId: string;
	packetId: string;
	courseVersionId: string;
	claims: AnswerClaim[];
	createdAt: string;
	revision: number;
}

export interface PublicationReceipt {
	receiptId: string;
	draftId: string;
	draftRevision: number;
	packetId: string;
	courseVersionId: string;
	publishedAt: string;
	contentHash: string;
}

export const LEARNING_EVENT_KINDS = [
	"introduced",
	"explained",
	"practiced",
	"answered-correct",
	"answered-incorrect",
	"reviewed",
	"reflection",
	"visualized",
	"answer-published",
] as const;
export type LearningEventKind = (typeof LEARNING_EVENT_KINDS)[number];

export interface LearningEvent {
	version: typeof HARNESS_CONTRACT_VERSION;
	eventId: string;
	timelineId: string;
	courseVersionId: string;
	sessionBindingId: string;
	conceptId: string;
	kind: LearningEventKind;
	sequence: number;
	createdAt: string;
	idempotencyKey: string;
	payload: JsonValue;
}

export interface ConceptMastery {
	conceptId: string;
	score: number;
	exposures: number;
	correct: number;
	incorrect: number;
	lastEventAt: string;
}

export interface MasteryProjection {
	timelineId: string;
	courseVersionId: string;
	revision: number;
	concepts: Record<string, ConceptMastery>;
	contentHash: string;
}

export interface ExercisePublic {
	exerciseId: string;
	courseVersionId: string;
	conceptIds: string[];
	prompt: string;
	hints: string[];
	unlockPolicy: "after-meaningful-attempt" | "after-correct-attempt" | "teacher-only";
	revision: number;
}

export interface ExercisePrivate {
	exerciseId: string;
	solution: string;
	acceptedAnswers: string[];
	rubric: string;
	contentHash: string;
}

export interface ExerciseInstance {
	instanceId: string;
	exerciseId: string;
	courseVersionId: string;
	sessionBindingId: string;
	issuedAt: string;
}

export interface ExerciseAttempt {
	attemptId: string;
	instanceId: string;
	exerciseId: string;
	courseVersionId: string;
	sessionBindingId: string;
	answer: string;
	meaningful: boolean;
	submittedAt: string;
	revision: number;
}

export interface AttemptEvaluation {
	evaluationId: string;
	attemptId: string;
	correct: boolean;
	feedback: string;
	createdAt: string;
}

export interface SolutionCapability {
	capabilityId: string;
	exerciseId: string;
	attemptId: string;
	courseVersionId: string;
	sessionBindingId: string;
	issuedAt: string;
	expiresAt: string;
	remainingUses: number;
	contentHash: string;
}

export const VISUALIZATION_KINDS = [
	"function-plot",
	"matrix-transform",
	"algorithm-trace",
	"graph-trace",
	"state-machine",
] as const;
export type VisualizationKind = (typeof VISUALIZATION_KINDS)[number];

export interface VisualizationSpec {
	version: typeof HARNESS_CONTRACT_VERSION;
	specId: string;
	courseVersionId: string;
	kind: VisualizationKind;
	title: string;
	seed: number;
	revision: number;
	payload: JsonValue;
}

export interface VisualArtifact {
	artifactId: string;
	specId: string;
	specRevision: number;
	courseVersionId: string;
	kind: VisualizationKind;
	data: JsonValue;
	trace: JsonValue;
	html: string;
	dataHash: string;
	traceHash: string;
	contentHash: string;
	createdAt: string;
	revision: number;
}

export interface TeacherCourseDraft {
	draftId: string;
	courseId: string;
	title: string;
	materials: CourseMaterialInput[];
	exercises: Array<{ public: ExercisePublic; private: ExercisePrivate }>;
	revision: number;
}

export interface StudentBundleManifest {
	bundleId: string;
	courseVersionId: string;
	profileIds: string[];
	publicExercises: ExercisePublic[];
	files: Array<{ path: string; contentHash: string }>;
	contentHash: string;
}

export interface EvaluationCase {
	caseId: string;
	courseVersionId: string;
	question: string;
	allowedScopes: ScopeLabel[];
	goldSpanIds: string[];
	forbiddenClaims: string[];
	requiresVisual: boolean;
}

export interface EvaluationRunManifest {
	runId: string;
	repoCommit: string;
	piWebBaseline: string;
	piVersion: string;
	courseVersionId: string;
	profileSnapshotId: string;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	seed: number;
	inputCaseId: string;
	toolEventLogSha256: string;
	stateDiffSha256: string;
	artifactManifestSha256: string;
	validatorResultIds: string[];
	createdAt: string;
}
