import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	AssessmentHost,
	type AssessmentPrivateState,
	type AssessmentPublicState,
	InMemorySolutionVault,
} from "../../assessment-host/src/index.ts";
import { CourseBuilderHost } from "../../course-builder-host/src/index.ts";
import { CourseHost, type CourseHostState, type PublishCourseVersionOptions } from "../../course-host/src/index.ts";
import {
	type AnswerDraft,
	type AttemptEvaluation,
	type CourseMaterialInput,
	type CourseVersion,
	type ExerciseAttempt,
	type ExerciseInstance,
	type ExercisePrivate,
	type ExercisePublic,
	HARNESS_CONTRACT_VERSION,
	type JsonValue,
	type LearningEvent,
	type LearningEventKind,
	type MasteryProjection,
	type ModePackDefinition,
	type PublicationReceipt,
	parseCourseMaterialInput,
	parseResourceSnapshot,
	parseSessionBinding,
	type ResourceSnapshot,
	type SessionBinding,
	type SolutionCapability,
	type SourceSpan,
	type ValidatorResult,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import { KnowledgeHost, type KnowledgeHostState } from "../../knowledge-host/src/index.ts";
import { LearningHost, type LearningHostState } from "../../learning-host/src/index.ts";
import { type PiSessionStore, RuntimeSessionHost } from "../../pi-runtime-host/src/index.ts";
import {
	compileModePackDraft,
	createBuiltinModePacks,
	createDefaultResourceCatalog,
	hasSessionSettings,
	inspectModePackAvailability,
	resolveModePackSnapshot,
	reviseModePackSettings,
} from "../../profile-resource-host/src/index.ts";
import {
	type StudyCellRunSnapshot,
	type StudyCodeCell,
	StudyCodeCells,
} from "../../study-execution-host/src/code-cells.ts";
import {
	type DetachedCoordinatorLaunchOptions,
	ensureDetachedStudyExecutionCoordinator,
	StudyExecutionCoordinator,
	type StudyExecutionCoordinatorOptions,
} from "../../study-execution-host/src/coordinator.ts";
import {
	type EnvironmentPackageExecutionResult,
	type EnvironmentPackagePlan,
	type EnvironmentPackageProcessIdentity,
	inspectEnvironmentPackageProcess,
	inspectEnvironmentPackages,
	terminateEnvironmentPackageProcessTree,
	validateFinalInventory,
} from "../../study-execution-host/src/environment-package-changes.ts";
import type {
	FrozenExecutionEnvironment,
	FrozenExecutionInput,
} from "../../study-execution-host/src/execution-payloads.ts";
import { executionSha256 } from "../../study-execution-host/src/execution-payloads.ts";
import {
	type ExecutionResourceRequest,
	type ExecutionScopeQuota,
	StudyExecutionQueue,
} from "../../study-execution-host/src/execution-queue.ts";
import {
	buildVisualValidationProgram,
	type FrozenVisualExecutionCase,
	readVisualValidationObservations,
} from "../../study-execution-host/src/visual-validation-execution.ts";
import {
	ManuscriptPatchHost,
	type ResearchAnalysisDraft,
	type ResearchPlan,
	type ResearchPlanInput,
	type Scope,
	StudyAgentQueue,
	StudyAssignmentHost,
	StudyResearchHost,
} from "../../study-research-host/src/index.ts";
import { StudyTeachingHost } from "../../study-research-host/src/study-teaching-host.ts";
import {
	compareVisualObservations,
	type VisualValidationSpecification,
	validateVisualSpecification,
} from "../../study-research-host/src/visual-validation.ts";
import { ProjectWorkspaceHost } from "./project-workspaces.ts";

const STORE_VERSION = 1;
const STATE_KEYS = ["course-host", "knowledge-host", "learning-host", "assessment-host", "sessions"] as const;
const LEGACY_STATE_KEYS = ["course-host", "knowledge-host", "learning-host", "sessions"] as const;

export class LearningHarnessError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "LearningHarnessError";
		this.code = code;
	}
}

export interface LearningHarnessOptions {
	databasePath: string;
}

export interface ResearchExecutionInputBinding {
	sourceId: string;
	sourceHash: string;
}

/**
 * Browser-approved execution envelope. The corresponding Host grant remains the
 * authorization primitive; this record narrows it to actual native cell inputs
 * and resource use without ever exposing the user-event capability that minted it.
 */
export interface ResearchExecutionScope {
	scopeId: string;
	projectId: string;
	sessionId: string;
	grantId: string;
	planId: string;
	planRevision: number;
	semanticDigest: string;
	planSnapshot: ResearchPlan;
	allowedLanguages: Array<"python" | "r">;
	allowedInputs: ResearchExecutionInputBinding[];
	maxResources: ExecutionResourceRequest;
	quota: ExecutionScopeQuota;
	changeBoundary: string;
	expiresAt: string;
	revokedAt: string | null;
	createdAt: string;
	contentHash: string;
}

/** Immutable metadata linking a native cell snapshot to Research semantics. */
export interface ResearchCellExecutionRecord {
	recordId: string;
	projectId: string;
	sessionId: string;
	queueJobId: string;
	taskId: string;
	mode: "grant" | "smoke-learning";
	planId: string;
	planRevision: number;
	semanticDigest: string;
	planSnapshot: ResearchPlan;
	grantId: string | null;
	scopeId: string | null;
	cellId: string;
	cellRevision: number;
	cellContentHash: string;
	manifest: { codeHash: string; parameterHash: string; inputHashes: Record<string, string>; environmentHash: string };
	changeNote: string;
	createdAt: string;
	contentHash: string;
}

/** A Research plan can cite a selected learning run without relabelling that old run. */
export interface ResearchLearningPromotion {
	promotionId: string;
	projectId: string;
	sessionId: string;
	sourceTaskId: string;
	sourceCellId: string;
	sourceCellRevision: number;
	sourceCellContentHash: string;
	planId: string;
	planRevision: number;
	semanticDigest: string;
	planSnapshot: ResearchPlan;
	createdAt: string;
	contentHash: string;
}

/** A repair records why a new immutable code revision supersedes a failed attempt. */
export interface ResearchCellRepair {
	repairId: string;
	projectId: string;
	sessionId: string;
	failedTaskId: string;
	failedCellRevision: number;
	failedCellContentHash: string;
	semanticDigest: string;
	repairCellId: string;
	repairCellRevision: number;
	repairCellContentHash: string;
	planId: string;
	planRevision: number;
	changeReason: string;
	createdAt: string;
	contentHash: string;
}

interface ResearchPayloadRow {
	payload: string;
	payloadHash: string;
}

export type EnvironmentPackageOperationStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "unknown"
	| "reconciled";

/** Immutable, runtime-resolved package plan scoped to the browser session that inspected it. */
export interface EnvironmentPackagePlanRecord {
	planId: string;
	projectId: string;
	sessionId: string;
	revision: number;
	plan: EnvironmentPackagePlan;
	createdAt: string;
	contentHash: string;
}

/** Durable package mutation request. Unknown is terminal: its environment may have changed before worker loss. */
export interface EnvironmentPackageOperationRecord {
	operationId: string;
	projectId: string;
	sessionId: string;
	planId: string;
	planRevision: number;
	planHash: string;
	requestId: string;
	consentedAt: string | null;
	status: EnvironmentPackageOperationStatus;
	workerId: string | null;
	leaseExpiresAt: string | null;
	/** The last trusted package-manager root; retained as evidence after it exits. */
	installer: EnvironmentPackageProcessIdentity | null;
	installerExitedAt: string | null;
	/** Reconciliation is deliberately distinct from worker success. */
	reconciledAt: string | null;
	attempts: number;
	diagnostic: string | null;
	result: EnvironmentPackageExecutionResult | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	contentHash: string;
}

interface EnvironmentPackagePayloadRow {
	payload: string;
	payloadHash: string;
}

type ResearchCellAdmission =
	| {
			mode: "grant";
			scopeId: string;
			planId: string;
			grantId: string;
			expectedPlanRevision: number;
			changeNote: string;
	  }
	| { mode: "smoke-learning"; planId: string; expectedPlanRevision: number; changeNote: string };

export interface VisualValidationTargetReference {
	visualizationId: string;
	visualizationRevision: number;
	visualizationHash: string;
	codeHash: string;
	inputHash: string;
	environmentHash: string;
}

export interface VisualValidationSpecificationRecord {
	specificationId: string;
	projectId: string;
	sessionId: string;
	revision: number;
	target: VisualValidationTargetReference;
	specification: VisualValidationSpecification;
	specificationHash: string;
	/** The separately authored oracle must name current source versions before it can run. */
	sourceReferences: Array<{ sourceId: string; sourceHash: string; locator: string }>;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface VisualValidationCanonicalResult {
	status: "passed" | "failed" | "inconclusive";
	report: ReturnType<typeof compareVisualObservations>;
	executionStatus: string;
	observationError: string | null;
	reconciledAt: string;
}

/** A run freezes the specification, target revision, subject source, case inputs and Node descriptor. */
export interface VisualValidationExecutionRecord {
	runId: string;
	projectId: string;
	sessionId: string;
	queueJobId: string;
	taskId: string;
	dispatchKey: string;
	intentHash: string;
	specificationId: string;
	specificationRevision: number;
	target: VisualValidationTargetReference;
	specification: VisualValidationSpecification;
	specificationHash: string;
	sourceReferences: Array<{ sourceId: string; sourceHash: string; locator: string }>;
	inputLineage: Array<{ caseId: string; inputHash: string }>;
	/** This keyed receipt correlation value never comes from the browser or the user visualization. */
	outputKey: string;
	manifest: { codeHash: string; parameterHash: string; inputHashes: Record<string, string>; environmentHash: string };
	canonical: VisualValidationCanonicalResult | null;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface VisualValidationExecutionView extends VisualValidationExecutionRecord {
	queueStatus: string;
	currentStatus: "pending" | "passed" | "failed" | "inconclusive" | "stale";
	staleReasons: string[];
}

interface VisualValidationPayloadRow {
	payload: string;
	payloadHash: string;
}

export interface HarnessSession {
	sessionId: string;
	binding: SessionBinding;
	snapshot: ResourceSnapshot;
	/** Every immutable snapshot prepared for this Pi session, including inactive history. */
	snapshotHistory: ResourceSnapshot[];
	pendingProfileTransition: PreparedProfileTransition | null;
	profileTransitionHistory: CommittedProfileTransition[];
}

export interface PreparedProfileTransition {
	idempotencyKey: string;
	expectedSnapshotId: string;
	targetProfileId: string;
	previousSnapshotId: string;
	snapshot: ResourceSnapshot;
	preparedAt: string;
}

export interface CommittedProfileTransition {
	idempotencyKey: string;
	targetProfileId: string;
	previousSnapshotId: string;
	snapshotId: string;
	bindingRevision: number;
	committedAt: string;
}

export interface ProfileAvailability {
	profileId: string;
	title: string;
	description: string;
	category: string;
	source: "builtin" | "custom";
	runtimeMode: string;
	selectable: boolean;
	disabledReason: string | null;
	missingRequiredResources: string[];
	missingOptionalResources: string[];
	identityMismatches: string[];
}

export interface PrepareProfileTransitionOptions {
	sessionId: string;
	targetProfileId: string;
	expectedSnapshotId: string;
	idempotencyKey: string;
	createdAt?: string;
	modePackDraft?: unknown;
	settingsPatch?: unknown;
}

export interface OpenStudentSessionOptions {
	sessionStore: PiSessionStore;
	courseVersionId: string;
	createdAt?: string;
}

export interface InheritStudentSessionOptions {
	parentSessionStore: PiSessionStore;
	childSessionStore: PiSessionStore;
	createdAt?: string;
}

export interface RecordLearningEventOptions {
	conceptId: string;
	kind: LearningEventKind;
	payload: JsonValue;
	idempotencyKey: string;
	createdAt?: string;
}

export interface PublishedGroundedAnswer {
	draft: AnswerDraft;
	receipt: PublicationReceipt;
	event: LearningEvent;
}

export interface SubmittedPracticeAttempt {
	attempt: ExerciseAttempt;
	evaluation: AttemptEvaluation;
	capability: SolutionCapability | null;
	event: LearningEvent;
}

export interface StoredCourseSource {
	sourceHash: string;
	bytes: Uint8Array;
}

interface SourceWrite {
	courseVersionId: string;
	materialId: string;
	sourceHash: string;
	bytes: Uint8Array;
}

interface StateRow {
	key: string;
	value: string;
}

interface SourceHashRow {
	sourceHash: string;
}

interface SourceBytesRow {
	bytes: Uint8Array;
}

interface PrivateSolutionRow {
	exerciseId: string;
	contentHash: string;
	payloadJson: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireTimestamp(value: string): void {
	if (!Number.isFinite(Date.parse(value)))
		throw new LearningHarnessError("INVALID_TIMESTAMP", "Expected an ISO-8601 timestamp");
}

function sourceBytes(input: CourseMaterialInput): Uint8Array {
	return typeof input.content === "string" ? new TextEncoder().encode(input.content) : new Uint8Array(input.content);
}

function requireModePack(pack: ModePackDefinition | undefined, modePackId: string): ModePackDefinition {
	if (!pack) throw new LearningHarnessError("MODE_PACK_NOT_FOUND", `Unknown Mode Pack ${modePackId}`);
	return pack;
}

function modePackTitle(snapshot: ResourceSnapshot): string {
	const marker = snapshot.instructions.find((instruction) => instruction.startsWith("Mode Pack: "));
	const match = marker ? /^Mode Pack: (.+) \(([^)]+)\)$/u.exec(marker) : null;
	return match?.[2] === snapshot.profileId ? (match[1] as string) : snapshot.profileId;
}

function isInstalledLearnerRuntime(mode: ResourceSnapshot["mode"]): boolean {
	return mode === "student-learn" || mode === "practice";
}

function sessionFromUnknown(value: unknown, courseHost: CourseHost): HarnessSession {
	if (!isRecord(value)) throw new LearningHarnessError("CORRUPT_STATE", "Persisted session must be an object");
	if (typeof value.sessionId !== "string" || !("binding" in value) || !("snapshot" in value)) {
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted session is missing a required field");
	}
	const binding = parseSessionBinding(value.binding);
	const snapshot = parseResourceSnapshot(value.snapshot);
	if (binding.sessionId !== value.sessionId)
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted sessionId and binding differ");
	if (
		!binding.courseVersionId ||
		snapshot.courseVersionId !== binding.courseVersionId ||
		snapshot.resourceSnapshotId !== binding.resourceSnapshotId
	) {
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted session binding and snapshot differ");
	}
	if (snapshot.role !== binding.role)
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted session role and snapshot differ");
	courseHost.assertBoundAccess(binding, snapshot, binding.courseVersionId);
	const snapshotHistory = Array.isArray(value.snapshotHistory)
		? value.snapshotHistory.map((item) => parseResourceSnapshot(item))
		: [snapshot];
	if (!snapshotHistory.some((item) => stableStringify(item) === stableStringify(snapshot))) {
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted session is missing its active snapshot from history");
	}
	const pendingProfileTransition =
		value.pendingProfileTransition === null || value.pendingProfileTransition === undefined
			? null
			: parsePreparedProfileTransition(value.pendingProfileTransition);
	const profileTransitionHistory = Array.isArray(value.profileTransitionHistory)
		? value.profileTransitionHistory.map(parseCommittedProfileTransition)
		: [];
	return {
		sessionId: binding.sessionId,
		binding,
		snapshot,
		snapshotHistory,
		pendingProfileTransition,
		profileTransitionHistory,
	};
}

function parsePreparedProfileTransition(value: unknown): PreparedProfileTransition {
	if (!isRecord(value))
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted profile transition must be an object");
	if (
		typeof value.idempotencyKey !== "string" ||
		typeof value.expectedSnapshotId !== "string" ||
		typeof value.targetProfileId !== "string" ||
		!value.targetProfileId.trim() ||
		typeof value.previousSnapshotId !== "string" ||
		typeof value.preparedAt !== "string"
	)
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted profile transition has invalid fields");
	requireTimestamp(value.preparedAt);
	return {
		idempotencyKey: value.idempotencyKey,
		expectedSnapshotId: value.expectedSnapshotId,
		targetProfileId: value.targetProfileId,
		previousSnapshotId: value.previousSnapshotId,
		snapshot: parseResourceSnapshot(value.snapshot),
		preparedAt: value.preparedAt,
	};
}

function parseCommittedProfileTransition(value: unknown): CommittedProfileTransition {
	if (!isRecord(value))
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted profile transition history must be an object");
	if (
		typeof value.idempotencyKey !== "string" ||
		typeof value.targetProfileId !== "string" ||
		!value.targetProfileId.trim() ||
		typeof value.previousSnapshotId !== "string" ||
		typeof value.snapshotId !== "string" ||
		typeof value.bindingRevision !== "number" ||
		typeof value.committedAt !== "string"
	)
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted profile transition history has invalid fields");
	requireTimestamp(value.committedAt);
	if (!Number.isInteger(value.bindingRevision) || value.bindingRevision < 2)
		throw new LearningHarnessError("CORRUPT_STATE", "Persisted profile transition binding revision is invalid");
	return {
		idempotencyKey: value.idempotencyKey,
		targetProfileId: value.targetProfileId,
		previousSnapshotId: value.previousSnapshotId,
		snapshotId: value.snapshotId,
		bindingRevision: value.bindingRevision,
		committedAt: value.committedAt,
	};
}

/**
 * Durable composition root for the existing Host implementations.
 *
 * Pi remains the transcript authority: this store persists deterministic Harness
 * state, source-byte references, and current session bindings only. Runtime journal
 * entries are written through the supplied PiSessionStore.
 */
export class LearningHarness {
	readonly courseBuilder: CourseBuilderHost;
	readonly projectWorkspaces: ProjectWorkspaceHost;
	readonly studyResearch: StudyResearchHost;
	readonly studyAssignments: StudyAssignmentHost;
	readonly studyManuscripts: ManuscriptPatchHost;
	readonly studyTeaching: StudyTeachingHost;
	readonly studyAgentQueue: StudyAgentQueue;
	readonly studyExecution: StudyExecutionQueue;
	readonly studyCells: StudyCodeCells;
	readonly courseHost = new CourseHost();
	readonly knowledgeHost = new KnowledgeHost(this.courseHost);
	readonly learningHost = new LearningHost();
	private readonly assessmentHost = new AssessmentHost(new InMemorySolutionVault());

	private readonly database: DatabaseSync;
	private readonly databasePath: string;
	private readonly sessions = new Map<string, HarnessSession>();
	private persistenceFailure: Error | null = null;

	constructor(options: LearningHarnessOptions) {
		if (!options.databasePath) throw new LearningHarnessError("DATABASE_PATH_REQUIRED", "databasePath is required");
		this.databasePath = options.databasePath;
		this.database = new DatabaseSync(options.databasePath);
		try {
			// Independent foreground and durable workers share this WAL database. Bound lock waits; persistent contention still throws.
			this.database.exec("PRAGMA busy_timeout = 5000");
			this.database.exec("PRAGMA foreign_keys = ON");
			this.database.exec("PRAGMA journal_mode = WAL");
			this.database.exec("PRAGMA synchronous = FULL");
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS learning_harness_state (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS learning_harness_source_blob (
					source_hash TEXT PRIMARY KEY,
					bytes BLOB NOT NULL
				);
				CREATE TABLE IF NOT EXISTS learning_harness_material_source (
					course_version_id TEXT NOT NULL,
					material_id TEXT NOT NULL,
					source_hash TEXT NOT NULL REFERENCES learning_harness_source_blob(source_hash),
					PRIMARY KEY (course_version_id, material_id)
				);
				CREATE TABLE IF NOT EXISTS learning_harness_private_solution (
					exercise_id TEXT PRIMARY KEY,
					content_hash TEXT NOT NULL,
					payload_json TEXT NOT NULL
				);
			`);
			this.restore();
			this.courseBuilder = new CourseBuilderHost(this.database);
			this.projectWorkspaces = new ProjectWorkspaceHost(this.database);
			this.studyResearch = new StudyResearchHost(this.database);
			this.studyAssignments = new StudyAssignmentHost(this.database, this.studyResearch);
			this.studyManuscripts = new ManuscriptPatchHost(this.database, this.studyResearch, {
				storageRoot: join(dirname(options.databasePath), "manuscript-patches"),
			});
			this.studyTeaching = new StudyTeachingHost(this.database, this.studyResearch, this.courseBuilder);
			this.studyAgentQueue = new StudyAgentQueue(this.database, this.studyResearch);
			this.studyExecution = new StudyExecutionQueue(this.database, this.studyResearch, {
				canClaimNewExecution: () =>
					!this.database.prepare("SELECT operation_id FROM pi_study_environment_package_lock LIMIT 1").get(),
			});
			this.studyCells = new StudyCodeCells(this.database, this.studyResearch);
			this.ensureResearchExecutionTables();
			this.ensureEnvironmentPackageTables();
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	close(): void {
		this.database.close();
	}

	/** Trusted backend composition only; the coordinator shares this Harness connection. */
	ensureStudyExecutionCoordinator(options: Omit<DetachedCoordinatorLaunchOptions, "databasePath">) {
		this.assertHealthy();
		return ensureDetachedStudyExecutionCoordinator(this.database, { ...options, databasePath: this.databasePath });
	}

	/** Create a coordinator without exposing the shared database to app routes. */
	createStudyExecutionCoordinator(
		options: Omit<StudyExecutionCoordinatorOptions, "database" | "queue">,
	): StudyExecutionCoordinator {
		this.assertHealthy();
		return new StudyExecutionCoordinator({ ...options, database: this.database, queue: this.studyExecution });
	}

	/** Persist the complete resolver output before any installation can be requested. */
	saveEnvironmentPackagePlan(scope: Scope, plan: EnvironmentPackagePlan): EnvironmentPackagePlanRecord {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		this.studyResearch.projectRevision(scope);
		this.validateEnvironmentPackagePlan(plan);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.assertEnvironmentPackagePlanUnlocked(plan);
			const existing = this.readEnvironmentPackagePlanByProject(scope.projectId, plan.planId);
			if (existing)
				throw new LearningHarnessError("PACKAGE_PLAN_CONFLICT", "Package plan identifier already exists");
			const value = {
				planId: plan.planId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				revision: 1,
				plan: structuredClone(plan),
				createdAt: new Date().toISOString(),
			};
			const record: EnvironmentPackagePlanRecord = { ...value, contentHash: contentHash(value) };
			this.saveEnvironmentPackagePlanRecord(record);
			this.database.exec("COMMIT");
			return structuredClone(record);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	listEnvironmentPackagePlans(scope: Scope): EnvironmentPackagePlanRecord[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureEnvironmentPackageTables();
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_plan WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC, plan_id",
			)
			.all(scope.projectId, scope.sessionId) as unknown as EnvironmentPackagePayloadRow[];
		return rows.map((row) => {
			const record = this.decodeEnvironmentPackagePayload<EnvironmentPackagePlanRecord>(row, "package plan");
			if (record.sessionId !== scope.sessionId)
				throw new LearningHarnessError(
					"PACKAGE_PLAN_SESSION_CONFLICT",
					"Package plan belongs to another conversation",
				);
			return structuredClone(this.validateEnvironmentPackagePlanRecord(record));
		});
	}

	listEnvironmentPackageOperations(scope: Scope): EnvironmentPackageOperationRecord[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureEnvironmentPackageTables();
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_operation WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC, operation_id",
			)
			.all(scope.projectId, scope.sessionId) as unknown as EnvironmentPackagePayloadRow[];
		return rows.map((row) => {
			const record = this.decodeEnvironmentPackagePayload<EnvironmentPackageOperationRecord>(
				row,
				"package operation",
			);
			if (record.sessionId !== scope.sessionId)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_SESSION_CONFLICT",
					"Package operation belongs to another conversation",
				);
			return structuredClone(this.validateEnvironmentPackageOperationRecord(record));
		});
	}

	/** Worker-facing state: waiting locks are finite; unknown locks require a user-visible reconciliation decision. */
	environmentPackageDrainState(projectId: string): {
		queued: number;
		runnable: number;
		waiting: number;
		needsInput: number;
		activeExecutionJobs: number;
		blockingOperationIds: string[];
	} {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		const project = this.requiredEnvironmentPackageText(projectId, "package project ID", 128);
		// State reads are the durable watchdog: a sole crashed worker has no later
		// claimant to discover its expired lease.  The unknown lock remains intact.
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.fenceExpiredEnvironmentPackageOperations(project, new Date().toISOString());
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_operation WHERE project_id = ? AND status = 'queued' ORDER BY created_at, operation_id",
			)
			.all(project) as unknown as EnvironmentPackagePayloadRow[];
		const activeExecutionJobs = this.activeEnvironmentExecutionJobCount();
		let runnable = 0,
			waiting = 0,
			needsInput = 0;
		const blockingOperationIds = new Set<string>();
		for (const row of rows) {
			const operation = this.validateEnvironmentPackageOperationRecord(
				this.decodeEnvironmentPackagePayload<EnvironmentPackageOperationRecord>(row, "package operation"),
			);
			const plan = this.readEnvironmentPackagePlanByProject(project, operation.planId);
			if (!plan || plan.revision !== operation.planRevision || plan.plan.contentHash !== operation.planHash)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_PLAN_INVALID",
					"Queued package operation no longer has its immutable plan",
				);
			const lock = this.database
				.prepare(
					"SELECT operation_id AS operationId FROM pi_study_environment_package_lock WHERE environment_key = ?",
				)
				.get(this.environmentPackageKey(plan.plan)) as { operationId: string } | undefined;
			if (!lock) {
				if (activeExecutionJobs > 0) waiting++;
				else runnable++;
				continue;
			}
			blockingOperationIds.add(lock.operationId);
			const status = this.database
				.prepare("SELECT status FROM pi_study_environment_package_operation WHERE operation_id = ?")
				.get(lock.operationId) as { status: string } | undefined;
			if (status?.status === "unknown") needsInput++;
			else waiting++;
		}
		return {
			queued: rows.length,
			runnable,
			waiting,
			needsInput,
			activeExecutionJobs,
			blockingOperationIds: [...blockingOperationIds].sort(),
		};
	}

	/** Browser code may queue one immutable plan. It cannot queue a different plan under the same request id. */
	queueEnvironmentPackageOperation(
		scope: Scope,
		input: { planId: string; expectedPlanRevision: number; requestId: string; acceptExistingChanges: boolean },
	): EnvironmentPackageOperationRecord {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const plan = this.readEnvironmentPackagePlan(scope, input.planId);
			if (plan.revision !== input.expectedPlanRevision)
				throw new LearningHarnessError(
					"PACKAGE_PLAN_CONFLICT",
					"Package plan changed before installation was requested",
				);
			const requestId = this.requiredEnvironmentPackageText(input.requestId, "package request ID", 256);
			const replay = this.readEnvironmentPackageOperationByRequest(scope.projectId, requestId);
			if (replay) {
				if (
					replay.sessionId !== scope.sessionId ||
					replay.planId !== plan.planId ||
					replay.planRevision !== plan.revision ||
					replay.planHash !== plan.plan.contentHash
				)
					throw new LearningHarnessError(
						"PACKAGE_REQUEST_CONFLICT",
						"Package request ID was already used for another immutable request",
					);
				this.database.exec("COMMIT");
				return structuredClone(replay);
			}
			if (plan.plan.requiresExistingChangeConsent && input.acceptExistingChanges !== true)
				throw new LearningHarnessError(
					"PACKAGE_CONSENT_REQUIRED",
					"This plan changes existing packages and requires exact browser approval",
				);
			const now = new Date().toISOString();
			const value = {
				operationId: `environment-package-operation-${randomUUID()}`,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				planId: plan.planId,
				planRevision: plan.revision,
				planHash: plan.plan.contentHash,
				requestId,
				consentedAt: plan.plan.requiresExistingChangeConsent ? now : null,
				status: "queued" as const,
				workerId: null,
				leaseExpiresAt: null,
				installer: null,
				installerExitedAt: null,
				reconciledAt: null,
				attempts: 0,
				diagnostic: null,
				result: null,
				createdAt: now,
				updatedAt: now,
				startedAt: null,
				completedAt: null,
			};
			const operation: EnvironmentPackageOperationRecord = { ...value, contentHash: contentHash(value) };
			this.saveEnvironmentPackageOperationRecord(operation);
			this.database.exec("COMMIT");
			return structuredClone(operation);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Worker-only durable claim. This intentionally does not use a Pi phase or a
	 * session runtime: it must continue after the request and browser have gone away.
	 */
	claimEnvironmentPackageOperation(
		projectId: string,
		workerId: string,
	): { operation: EnvironmentPackageOperationRecord; plan: EnvironmentPackagePlanRecord } | null {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		const project = this.requiredEnvironmentPackageText(projectId, "package project ID", 128);
		const worker = this.requiredEnvironmentPackageText(workerId, "package worker ID", 256);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const now = new Date().toISOString();
			this.fenceExpiredEnvironmentPackageOperations(project, now);
			const rows = this.database
				.prepare(
					"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_operation WHERE project_id = ? AND status = 'queued' ORDER BY created_at, operation_id",
				)
				.all(project) as unknown as EnvironmentPackagePayloadRow[];
			if (rows.length === 0) {
				this.database.exec("COMMIT");
				return null;
			}
			if (this.activeEnvironmentExecutionJobCount() > 0) {
				this.database.exec("COMMIT");
				return null;
			}
			for (const row of rows) {
				const queued = this.validateEnvironmentPackageOperationRecord(
					this.decodeEnvironmentPackagePayload<EnvironmentPackageOperationRecord>(row, "package operation"),
				);
				const plan = this.readEnvironmentPackagePlanByProject(project, queued.planId);
				if (!plan || plan.revision !== queued.planRevision || plan.plan.contentHash !== queued.planHash)
					throw new LearningHarnessError(
						"PACKAGE_OPERATION_PLAN_INVALID",
						"Queued package operation no longer has its immutable plan",
					);
				const environmentKey = this.environmentPackageKey(plan.plan);
				const locked = this.database
					.prepare("SELECT operation_id FROM pi_study_environment_package_lock WHERE environment_key = ?")
					.get(environmentKey) as { operation_id: string } | undefined;
				if (locked) continue;
				this.database
					.prepare("INSERT INTO pi_study_environment_package_lock(environment_key, operation_id) VALUES (?, ?)")
					.run(environmentKey, queued.operationId);
				const claimed = this.withEnvironmentPackageContentHash({
					...queued,
					status: "running" as const,
					workerId: worker,
					leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
					installer: null,
					installerExitedAt: null,
					reconciledAt: null,
					attempts: queued.attempts + 1,
					updatedAt: now,
					startedAt: now,
				});
				this.saveEnvironmentPackageOperationRecord(claimed);
				this.database.exec("COMMIT");
				return { operation: structuredClone(claimed), plan: structuredClone(plan) };
			}
			this.database.exec("COMMIT");
			return null;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	finishEnvironmentPackageOperation(input: {
		projectId: string;
		operationId: string;
		workerId: string;
		result: EnvironmentPackageExecutionResult;
	}): EnvironmentPackageOperationRecord {
		return this.completeEnvironmentPackageOperation({ ...input, status: "succeeded", diagnostic: null });
	}

	/** A live package-manager command renews this lease; expiry means its final environment state is unknown. */
	renewEnvironmentPackageOperationLease(input: { projectId: string; operationId: string; workerId: string }): void {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		const projectId = this.requiredEnvironmentPackageText(input.projectId, "package project ID", 128);
		const workerId = this.requiredEnvironmentPackageText(input.workerId, "package worker ID", 256);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.readEnvironmentPackageOperationByProject(projectId, input.operationId);
			if (current.status !== "running" || current.workerId !== workerId)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_CLAIM_CONFLICT",
					"Package operation is no longer claimed by this worker",
				);
			const now = new Date().toISOString();
			this.saveEnvironmentPackageOperationRecord(
				this.withEnvironmentPackageContentHash({
					...current,
					leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
					updatedAt: now,
				}),
			);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** Worker-only: persist the exact package-manager root before it can change a library. */
	recordEnvironmentPackageInstallerStarted(input: {
		projectId: string;
		operationId: string;
		workerId: string;
		installer: EnvironmentPackageProcessIdentity;
	}): void {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		const projectId = this.requiredEnvironmentPackageText(input.projectId, "package project ID", 128);
		const workerId = this.requiredEnvironmentPackageText(input.workerId, "package worker ID", 256);
		this.validateEnvironmentPackageProcessIdentity(input.installer);
		if (
			!input.installer.supervisorExecutablePath ||
			!isAbsolute(input.installer.supervisorExecutablePath) ||
			!input.installer.processCreationIdentity ||
			!/^[0-9]{17,20}$/u.test(input.installer.processCreationIdentity)
		)
			throw new LearningHarnessError(
				"PACKAGE_SUPERVISOR_IDENTITY_REQUIRED",
				"A package installer can be recorded only after an absolute durable supervisor identity is available",
			);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.readEnvironmentPackageOperationByProject(projectId, input.operationId);
			if (current.status !== "running" || current.workerId !== workerId)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_CLAIM_CONFLICT",
					"Package operation is no longer claimed by this worker",
				);
			this.saveEnvironmentPackageOperationRecord(
				this.withEnvironmentPackageContentHash({
					...current,
					installer: structuredClone(input.installer),
					installerExitedAt: null,
					updatedAt: new Date().toISOString(),
				}),
			);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** Worker-only: retain termination evidence; an unexpected worker death leaves this timestamp null. */
	recordEnvironmentPackageInstallerExited(input: {
		projectId: string;
		operationId: string;
		workerId: string;
		installer: EnvironmentPackageProcessIdentity;
	}): void {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		const projectId = this.requiredEnvironmentPackageText(input.projectId, "package project ID", 128);
		const workerId = this.requiredEnvironmentPackageText(input.workerId, "package worker ID", 256);
		this.validateEnvironmentPackageProcessIdentity(input.installer);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.readEnvironmentPackageOperationByProject(projectId, input.operationId);
			if (current.status !== "running" || current.workerId !== workerId)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_CLAIM_CONFLICT",
					"Package operation is no longer claimed by this worker",
				);
			if (
				current.installer === null ||
				current.installer.pid !== input.installer.pid ||
				current.installer.startedAt !== input.installer.startedAt
			)
				throw new LearningHarnessError(
					"PACKAGE_PROCESS_IDENTITY_CONFLICT",
					"Package installer exit does not match the persisted process identity",
				);
			this.saveEnvironmentPackageOperationRecord(
				this.withEnvironmentPackageContentHash({
					...current,
					installerExitedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
			);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Browser-authorized recovery for an unknown operation. It never retries the
	 * plan: it proves the old process is absent, re-reads the fixed runtime, and
	 * only releases the global lock for the original or exactly approved inventory.
	 */
	async reconcileEnvironmentPackageOperation(
		scope: Scope,
		operationId: string,
	): Promise<EnvironmentPackageOperationRecord> {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		this.studyResearch.projectRevision(scope);
		let operation: EnvironmentPackageOperationRecord;
		let plan: EnvironmentPackagePlanRecord;
		this.database.exec("BEGIN IMMEDIATE");
		try {
			operation = this.readEnvironmentPackageOperationByProject(scope.projectId, operationId);
			if (operation.sessionId !== scope.sessionId)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_SESSION_CONFLICT",
					"Package operation belongs to another conversation",
				);
			if (operation.status !== "unknown")
				throw new LearningHarnessError(
					"PACKAGE_RECOVERY_INVALID",
					"Only an unknown package operation can be reconciled",
				);
			plan = this.readEnvironmentPackagePlanByProject(
				scope.projectId,
				operation.planId,
			) as EnvironmentPackagePlanRecord;
			if (plan.revision !== operation.planRevision || plan.plan.contentHash !== operation.planHash)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_PLAN_INVALID",
					"Unknown package operation no longer has its immutable plan",
				);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
		// Older records can still be displayed, but no unknown operation may use the
		// legacy PID/CIM observation path to release its lock. A recovery decision
		// needs the supervisor binary and its exact Windows creation identity even
		// when an old worker claimed it observed an exit.
		if (
			operation.installer === null ||
			!operation.installer.supervisorExecutablePath ||
			!isAbsolute(operation.installer.supervisorExecutablePath) ||
			!operation.installer.processCreationIdentity ||
			!/^[0-9]{17,20}$/u.test(operation.installer.processCreationIdentity)
		)
			throw new LearningHarnessError(
				"PACKAGE_RECOVERY_SUPERVISOR_UNPROVEN",
				"Recovery will not inspect or unlock an unknown package operation without an absolute durable supervisor identity",
			);
		if (operation.installerExitedAt === null) {
			const observed = inspectEnvironmentPackageProcess(operation.installer);
			if (observed === "stale")
				throw new LearningHarnessError(
					"PACKAGE_PROCESS_IDENTITY_STALE",
					"The recorded installer PID was reused; recovery will not terminate or unlock it",
				);
			if (observed === "running") {
				const afterTermination = await terminateEnvironmentPackageProcessTree(operation.installer);
				if (afterTermination !== "exited")
					throw new LearningHarnessError(
						"PACKAGE_PROCESS_TERMINATION_FAILED",
						"The recorded package installer could not be proven stopped",
					);
			}
		}
		const inventory = await inspectEnvironmentPackages({
			language: plan.plan.language,
			executablePath: plan.plan.executablePath,
			environmentDirectory: plan.plan.environmentDirectory,
		});
		let outcome: "approved-final" | "not-applied";
		try {
			validateFinalInventory(plan.plan, inventory);
			outcome = "approved-final";
		} catch (error) {
			const matchesInitial =
				contentHash(inventory.map(({ name, version, location }) => ({ name, version, location }))) ===
				plan.plan.inventoryHash;
			if (!matchesInitial)
				throw new LearningHarnessError(
					"PACKAGE_RECOVERY_INVENTORY_UNPROVEN",
					`Package inventory is neither the immutable initial state nor the approved final state: ${error instanceof Error ? error.message : String(error)}`,
				);
			outcome = "not-applied";
		}
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.readEnvironmentPackageOperationByProject(scope.projectId, operationId);
			if (current.status !== "unknown" || current.contentHash !== operation.contentHash)
				throw new LearningHarnessError(
					"PACKAGE_RECOVERY_CONFLICT",
					"Package operation changed while recovery was proving its state",
				);
			const reconciledAt = new Date().toISOString();
			const next = this.withEnvironmentPackageContentHash({
				...current,
				status: "reconciled" as const,
				leaseExpiresAt: null,
				reconciledAt,
				diagnostic:
					outcome === "approved-final"
						? "Reconciled after worker loss: the current inventory exactly matches the approved final package plan."
						: "Reconciled after worker loss: the current inventory exactly matches the immutable pre-install inventory; the plan was not retried.",
				updatedAt: reconciledAt,
				completedAt: reconciledAt,
			});
			this.saveEnvironmentPackageOperationRecord(next);
			this.database
				.prepare("DELETE FROM pi_study_environment_package_lock WHERE operation_id = ?")
				.run(next.operationId);
			this.database.exec("COMMIT");
			return structuredClone(next);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	failEnvironmentPackageOperation(input: {
		projectId: string;
		operationId: string;
		workerId: string;
		status: "failed" | "unknown";
		diagnostic: string;
	}): EnvironmentPackageOperationRecord {
		return this.completeEnvironmentPackageOperation({ ...input, result: null });
	}

	/** Saves an independently authored numerical specification against one exact visualization revision. */
	saveVisualValidationSpecification(
		scope: Scope,
		input: {
			specificationId?: string;
			expectedSpecificationRevision?: number;
			target: Pick<
				VisualValidationTargetReference,
				"visualizationId" | "visualizationRevision" | "visualizationHash"
			>;
			specification: VisualValidationSpecification;
		},
	): VisualValidationSpecificationRecord {
		this.assertHealthy();
		this.ensureVisualValidationTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const existing = input.specificationId
				? this.readVisualValidationSpecification(scope, input.specificationId)
				: null;
			if (existing && existing.sessionId !== scope.sessionId)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_SESSION_CONFLICT",
					"Validation specification belongs to another conversation",
				);
			if (existing && existing.revision !== input.expectedSpecificationRevision)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_SPEC_CONFLICT",
					"Validation specification changed before saving",
				);
			if (!existing && input.expectedSpecificationRevision !== undefined)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_SPEC_CONFLICT",
					"New validation specifications have no prior revision",
				);
			const target = this.resolveVisualValidationTarget(scope, input.target);
			const specification = structuredClone(input.specification);
			if (specification.targetHash !== target.visualizationHash)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_TARGET_CONFLICT",
					"Validation specification does not name the observed visualization version",
				);
			const specificationHash = validateVisualSpecification(specification);
			this.assertCompleteVisualCategories(specification);
			const sourceReferences = this.validateVisualValidationSources(scope, specification);
			const now = new Date().toISOString();
			const value = {
				specificationId: existing?.specificationId ?? `visual-validation-specification-${randomUUID()}`,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				revision: (existing?.revision ?? 0) + 1,
				target,
				specification,
				specificationHash,
				sourceReferences,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			const record: VisualValidationSpecificationRecord = { ...value, contentHash: contentHash(value) };
			this.saveVisualValidationPayload(
				"pi_study_visual_validation_specification",
				"specification_id",
				record.specificationId,
				record,
				scope.projectId,
			);
			this.database.exec("COMMIT");
			return structuredClone(record);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	listVisualValidationSpecifications(scope: Scope, visualizationId?: string): VisualValidationSpecificationRecord[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureVisualValidationTables();
		const rows = this.database
			.prepare(
				visualizationId
					? "SELECT payload, payload_hash AS payloadHash FROM pi_study_visual_validation_specification WHERE project_id = ? AND visualization_id = ? ORDER BY updated_at DESC, specification_id"
					: "SELECT payload, payload_hash AS payloadHash FROM pi_study_visual_validation_specification WHERE project_id = ? ORDER BY updated_at DESC, specification_id",
			)
			.all(
				...(visualizationId
					? [scope.projectId, this.requiredVisualValidationText(visualizationId, "visualization ID", 128)]
					: [scope.projectId]),
			) as unknown as VisualValidationPayloadRow[];
		return rows.map((row) =>
			structuredClone(
				this.validateStoredVisualValidationSpecification(
					this.decodeVisualValidationPayload<VisualValidationSpecificationRecord>(
						row,
						"visual validation specification",
					),
				),
			),
		);
	}

	/** Atomically reserves a frozen validation task, its keyed Node receipt and its immutable specification snapshot. */
	admitVisualValidationExecution(
		scope: Scope,
		input: {
			specificationId: string;
			expectedSpecificationRevision: number;
			dispatchKey: string;
			intentHash: string;
			resources: ExecutionResourceRequest;
			quota: ExecutionScopeQuota;
			environment: FrozenExecutionEnvironment;
			coordinatorOptions: Omit<StudyExecutionCoordinatorOptions, "database" | "queue">;
		},
	): { job: ReturnType<StudyExecutionQueue["getJob"]>; replay: boolean; run: VisualValidationExecutionRecord } {
		const coordinator = this.createStudyExecutionCoordinator(input.coordinatorOptions);
		this.ensureVisualValidationTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			if (!/^sha256:[a-f0-9]{64}$/u.test(input.intentHash))
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_REQUEST_INVALID",
					"Visual validation intent hash is invalid",
				);
			const replay = this.replayVisualValidationExecution(scope, input.dispatchKey, input.intentHash);
			if (replay) {
				this.database.exec("COMMIT");
				return replay;
			}
			const specificationRecord = this.readVisualValidationSpecification(scope, input.specificationId);
			if (specificationRecord.revision !== input.expectedSpecificationRevision)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_SPEC_CONFLICT",
					"Validation specification changed before execution",
				);
			this.validateStoredVisualValidationSpecification(specificationRecord);
			this.assertVisualValidationRecordCurrent(
				scope,
				specificationRecord.target,
				specificationRecord.sourceReferences,
			);
			this.validateResearchResources(input.resources, "visual validation execution");
			this.validateVisualValidationQuota(input.quota);
			if (input.environment.adapterKind !== "native-windows-node-v1")
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_ENVIRONMENT_INVALID",
					"Visual validation requires the registered isolated Node adapter",
				);
			const cases: FrozenVisualExecutionCase[] = specificationRecord.specification.cases.map((entry) => ({
				caseId: entry.id,
				inputHash: contentHash(entry.inputs),
				inputs: structuredClone(entry.inputs),
			}));
			const outputKey = randomUUID().replaceAll("-", "");
			const program = buildVisualValidationProgram({
				targetCode: this.studyResearch.getVisualizationDraft(scope, specificationRecord.target.visualizationId)
					.code,
				cases,
				outputKey,
				caseTimeoutMs: Math.min(30_000, Math.max(100, Math.floor(input.resources.wallTimeMs / cases.length))),
			});
			const parameterText = stableStringify({
				protocol: "pi-study-visual-validation-v1",
				specificationHash: specificationRecord.specificationHash,
				target: specificationRecord.target,
				inputLineage: cases.map(({ caseId, inputHash }) => ({ caseId, inputHash })),
			});
			const manifest = {
				codeHash: executionSha256(program),
				parameterHash: executionSha256(parameterText),
				inputHashes: {},
				environmentHash: input.environment.descriptorHash,
			};
			const producerContext = this.studyResearch.registerTrustedRunnerContext(
				scope,
				`native-visual-validation:${scope.sessionId}:${sha256Hex(input.dispatchKey)}`,
			);
			const reservation = this.studyExecution.enqueueStudy(scope, {
				dispatchKey: input.dispatchKey,
				kind: "validation",
				target: {
					targetKind: "visualization",
					targetId: specificationRecord.target.visualizationId,
					targetRevision: specificationRecord.target.visualizationRevision,
					targetHash: specificationRecord.target.visualizationHash,
				},
				manifest,
				producerContextId: producerContext.contextId,
				admission: {
					purpose: `Numerical scene validation: ${specificationRecord.specification.scope}`,
					language: "none",
					maxWallSeconds: Math.ceil(input.resources.wallTimeMs / 1000),
					maxMemoryMiB: input.resources.memoryMiB,
				},
				resources: input.resources,
				quota: input.quota,
			});
			const now = new Date().toISOString();
			const runValue = {
				runId: `visual-validation-run-${randomUUID()}`,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				queueJobId: reservation.job.queueJobId,
				taskId: reservation.job.taskId,
				dispatchKey: input.dispatchKey,
				intentHash: input.intentHash,
				specificationId: specificationRecord.specificationId,
				specificationRevision: specificationRecord.revision,
				target: specificationRecord.target,
				specification: specificationRecord.specification,
				specificationHash: specificationRecord.specificationHash,
				sourceReferences: specificationRecord.sourceReferences,
				inputLineage: cases.map(({ caseId, inputHash }) => ({ caseId, inputHash })),
				outputKey,
				manifest,
				canonical: null,
				createdAt: now,
				updatedAt: now,
			};
			const run: VisualValidationExecutionRecord = { ...runValue, contentHash: contentHash(runValue) };
			this.saveVisualValidationPayload("pi_study_visual_validation_run", "run_id", run.runId, run, scope.projectId);
			coordinator.persistPayload(reservation.job.queueJobId, {
				version: 1,
				taskId: reservation.job.taskId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				manifest,
				language: "node",
				program: { fileName: "visual-validation.mjs", content: program, sha256: manifest.codeHash },
				parameters: { canonicalJson: parameterText, sha256: manifest.parameterHash },
				inputs: [],
				environment: input.environment,
				outputLimitBytes: Math.min(input.resources.diskBytes, 64 * 1024),
			});
			this.database
				.prepare(
					"INSERT INTO pi_study_visual_validation_request(project_id, session_id, dispatch_key, intent_hash, queue_job_id) VALUES (?, ?, ?, ?, ?)",
				)
				.run(scope.projectId, scope.sessionId, input.dispatchKey, input.intentHash, reservation.job.queueJobId);
			this.database.exec("COMMIT");
			return { job: reservation.job, replay: reservation.replay, run: structuredClone(run) };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	replayVisualValidationExecution(
		scope: Scope,
		dispatchKey: string,
		intentHash: string,
	): { job: ReturnType<StudyExecutionQueue["getJob"]>; replay: true; run: VisualValidationExecutionRecord } | null {
		this.studyResearch.projectRevision(scope);
		this.ensureVisualValidationTables();
		const row = this.database
			.prepare(
				"SELECT session_id AS sessionId, intent_hash AS intentHash, queue_job_id AS queueJobId FROM pi_study_visual_validation_request WHERE project_id = ? AND dispatch_key = ?",
			)
			.get(scope.projectId, this.requiredVisualValidationText(dispatchKey, "validation dispatch key", 256)) as
			| { sessionId: string; intentHash: string; queueJobId: string }
			| undefined;
		if (!row) return null;
		if (row.sessionId !== scope.sessionId || row.intentHash !== intentHash)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_REQUEST_CONFLICT",
				"Visual validation request changed or belongs to another conversation",
			);
		const job = this.studyExecution.getJob(row.queueJobId);
		const run = this.readVisualValidationRunByQueue(scope, row.queueJobId);
		if (
			job.projectId !== scope.projectId ||
			job.sessionId !== scope.sessionId ||
			job.taskId !== run.taskId ||
			job.dispatchKey !== dispatchKey
		)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_REQUEST_CORRUPT",
				"Visual validation request does not match its frozen queue job",
			);
		return { job, replay: true, run };
	}

	listVisualValidationExecutions(
		scope: Scope,
		input: {
			visualizationId?: string;
			coordinatorOptions: Omit<StudyExecutionCoordinatorOptions, "database" | "queue">;
		},
	): VisualValidationExecutionView[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureVisualValidationTables();
		const rows = this.database
			.prepare(
				input.visualizationId
					? "SELECT payload, payload_hash AS payloadHash FROM pi_study_visual_validation_run WHERE project_id = ? AND visualization_id = ? ORDER BY created_at DESC, run_id"
					: "SELECT payload, payload_hash AS payloadHash FROM pi_study_visual_validation_run WHERE project_id = ? ORDER BY created_at DESC, run_id",
			)
			.all(
				...(input.visualizationId
					? [scope.projectId, this.requiredVisualValidationText(input.visualizationId, "visualization ID", 128)]
					: [scope.projectId]),
			) as unknown as VisualValidationPayloadRow[];
		return rows.map((row) =>
			this.reconcileVisualValidationExecution(
				scope,
				this.decodeVisualValidationPayload<VisualValidationExecutionRecord>(row, "visual validation run").runId,
				input.coordinatorOptions,
			),
		);
	}

	/** Reconciliation makes a terminal native receipt canonical only if its frozen target and sources remain exact. */
	reconcileVisualValidationExecution(
		scope: Scope,
		runId: string,
		coordinatorOptions: Omit<StudyExecutionCoordinatorOptions, "database" | "queue">,
	): VisualValidationExecutionView {
		const coordinator = this.createStudyExecutionCoordinator(coordinatorOptions);
		this.ensureVisualValidationTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			let run = this.readVisualValidationRun(scope, runId);
			this.validateStoredVisualValidationRun(run);
			const job = this.studyExecution.getJob(run.queueJobId);
			if (job.projectId !== scope.projectId || job.sessionId !== scope.sessionId || job.taskId !== run.taskId)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_RUN_CORRUPT",
					"Visual validation run does not match its queue job",
				);
			const staleReasons = this.visualValidationStaleReasons(scope, run.target, run.sourceReferences);
			if (staleReasons.length === 0 && run.canonical === null && this.visualValidationTerminal(job.status)) {
				let report = compareVisualObservations(run.specification, []);
				let observationError: string | null =
					`Isolated execution ended with ${job.status} before a trusted scene receipt was available`;
				if (job.status === "succeeded") {
					try {
						const receipt = coordinator.getPublicResult(run.queueJobId);
						const observations = readVisualValidationObservations(receipt?.logs.stdout ?? null, {
							outputKey: run.outputKey,
							cases: run.inputLineage,
						});
						report = compareVisualObservations(run.specification, observations);
						observationError = null;
					} catch (error) {
						observationError = `Trusted receipt rejected: ${this.visualValidationError(error)}`;
					}
				}
				const canonical: VisualValidationCanonicalResult = {
					status: report.status as VisualValidationCanonicalResult["status"],
					report,
					executionStatus: job.status,
					observationError,
					reconciledAt: new Date().toISOString(),
				};
				if (job.status === "succeeded") {
					this.studyResearch.recordValidationFromFrozenTask({
						taskId: run.taskId,
						expectedTaskRevision: job.hostTaskRevision,
						targetKind: "visualization",
						targetId: run.target.visualizationId,
						targetRevision: run.target.visualizationRevision,
						targetHash: run.target.visualizationHash,
						status: canonical.status,
						findings: [
							`Numerical scope: ${run.specification.scope}`,
							`Frozen specification ${run.specificationHash}; detailed comparison ${contentHash(report)}; run ${run.runId}`,
							...report.comparisons.map((comparison) => `${comparison.caseId}: ${comparison.status}`),
							...(observationError ? [observationError] : []),
							"This checks numerical scene outputs only. Actual browser controls, academic review and formal-use approval remain separate.",
						],
					});
				}
				run = this.withVisualValidationContentHash({ ...run, canonical, updatedAt: canonical.reconciledAt });
				this.saveVisualValidationPayload(
					"pi_study_visual_validation_run",
					"run_id",
					run.runId,
					run,
					scope.projectId,
				);
			}
			this.database.exec("COMMIT");
			return {
				...structuredClone(run),
				queueStatus: job.status,
				currentStatus: staleReasons.length > 0 ? "stale" : (run.canonical?.status ?? "pending"),
				staleReasons,
			};
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * The UI creates this scope immediately after an explicit confirmation. It is
	 * deliberately narrower than the Host grant: one grant maps to one resource
	 * envelope, so the shared queue's grant-scoped cumulative counters cannot be
	 * silently widened by a later request.
	 */
	grantResearchExecutionScope(
		scope: Scope,
		input: {
			planId: string;
			expectedPlanRevision: number;
			userEventId: string;
			expiresAt: string;
			allowedLanguages: readonly ("python" | "r")[];
			allowedInputs: readonly ResearchExecutionInputBinding[];
			maxResources: ExecutionResourceRequest;
			quota: ExecutionScopeQuota;
			changeBoundary: string;
		},
	): ResearchExecutionScope {
		this.assertHealthy();
		this.ensureResearchExecutionTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const plan = this.studyResearch.getResearchPlan(scope, input.planId);
			if (plan.revision !== input.expectedPlanRevision)
				throw new LearningHarnessError("RESEARCH_PLAN_CONFLICT", "Research plan changed before scope approval");
			const allowedLanguages = this.validateResearchLanguages(input.allowedLanguages);
			const allowedInputs = this.validateResearchInputs(scope, plan, input.allowedInputs);
			const maxResources = this.validateResearchResources(input.maxResources, "research scope resource limit");
			const quota = this.validateResearchQuota(input.quota);
			const changeBoundary = this.requiredResearchText(input.changeBoundary, "research change boundary", 6_000);
			const grant = this.studyResearch.grantScopeFromTrustedUserEvent(
				scope,
				plan.planId,
				plan.revision,
				this.requiredResearchText(input.userEventId, "trusted user event", 256),
				input.expiresAt,
			);
			if (quota.expiresAt !== grant.expiresAt)
				throw new LearningHarnessError(
					"RESEARCH_SCOPE_EXPIRY_MISMATCH",
					"Research quota expiry must exactly match the approved scope expiry",
				);
			const value = {
				scopeId: `research-execution-scope-${randomUUID()}`,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				grantId: grant.grantId,
				planId: plan.planId,
				planRevision: plan.revision,
				semanticDigest: plan.semanticDigest,
				planSnapshot: structuredClone(plan),
				allowedLanguages,
				allowedInputs,
				maxResources,
				quota,
				changeBoundary,
				expiresAt: grant.expiresAt,
				revokedAt: null,
				createdAt: new Date().toISOString(),
			};
			const record: ResearchExecutionScope = { ...value, contentHash: contentHash(value) };
			this.saveResearchPayload(
				"pi_study_research_execution_scope",
				"scope_id",
				record.scopeId,
				record,
				scope.projectId,
			);
			this.database.exec("COMMIT");
			return structuredClone(record);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	listResearchExecutionScopes(scope: Scope): ResearchExecutionScope[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureResearchExecutionTables();
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_research_execution_scope WHERE project_id = ? ORDER BY created_at, scope_id",
			)
			.all(scope.projectId) as unknown as ResearchPayloadRow[];
		return rows.map((row) =>
			structuredClone(this.decodeResearchPayload<ResearchExecutionScope>(row, "research execution scope")),
		);
	}

	revokeResearchExecutionScope(scope: Scope, scopeId: string): ResearchExecutionScope {
		this.assertHealthy();
		this.ensureResearchExecutionTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.readResearchExecutionScope(scope, scopeId);
			if (current.sessionId !== scope.sessionId)
				throw new LearningHarnessError(
					"RESEARCH_SCOPE_SESSION_CONFLICT",
					"Research scope belongs to another conversation",
				);
			const grant = this.studyResearch.revokeScopeGrant(scope, current.grantId);
			const revoked =
				current.revokedAt === null
					? this.withResearchContentHash({ ...current, revokedAt: grant.revokedAt ?? new Date().toISOString() })
					: current;
			if (revoked !== current)
				this.saveResearchPayload(
					"pi_study_research_execution_scope",
					"scope_id",
					revoked.scopeId,
					revoked,
					scope.projectId,
				);
			this.database.exec("COMMIT");
			return structuredClone(revoked);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	listResearchCellExecutions(scope: Scope): ResearchCellExecutionRecord[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureResearchExecutionTables();
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_research_execution_run WHERE project_id = ? ORDER BY created_at, record_id",
			)
			.all(scope.projectId) as unknown as ResearchPayloadRow[];
		return rows.map((row) =>
			structuredClone(this.decodeResearchPayload<ResearchCellExecutionRecord>(row, "research execution run")),
		);
	}

	/**
	 * The only Harness write path for an analysis of a terminal Research run.
	 * It joins the immutable cell/run ledger, terminal Host task, queue receipt, and
	 * public coordinator observation before delegating the durable draft to StudyResearchHost.
	 * A queue completion alone is insufficient: all identities must still agree.
	 */
	saveResearchAnalysisFromTerminalRun(
		scope: Scope,
		input: {
			taskId: string;
			expectedTaskRevision: number;
			expectedProjectRevision: number;
			draft: ResearchAnalysisDraft;
			coordinatorOptions: Omit<StudyExecutionCoordinatorOptions, "database" | "queue">;
		},
	) {
		this.assertHealthy();
		this.ensureResearchExecutionTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const record = this.listResearchCellExecutions(scope).find((entry) => entry.taskId === input.taskId);
			if (!record || record.sessionId !== scope.sessionId) {
				throw new LearningHarnessError(
					"RESEARCH_RESULT_RUN_NOT_FOUND",
					"Analysis requires a Research run frozen for this project and session",
				);
			}
			const task = this.studyResearch.readTaskForCoordinator(input.taskId);
			if (
				task.projectId !== scope.projectId ||
				task.authorization.sessionId !== scope.sessionId ||
				task.revision !== input.expectedTaskRevision
			) {
				throw new LearningHarnessError(
					"RESEARCH_RESULT_TASK_CONFLICT",
					"Terminal task changed before analysis save",
				);
			}
			const terminalStatuses: readonly string[] = ["succeeded", "failed", "cancelled", "limit-reached"];
			if (!terminalStatuses.includes(task.status)) {
				throw new LearningHarnessError(
					"RESEARCH_RESULT_NOT_TERMINAL",
					"Analysis can only be saved after the Research execution reaches a terminal status",
				);
			}
			const terminalStatus = task.status as "succeeded" | "failed" | "cancelled" | "limit-reached";
			const snapshot = this.studyCells.readRun(scope, task.taskId);
			if (
				snapshot.cell.cellId !== record.cellId ||
				snapshot.cell.revision !== record.cellRevision ||
				snapshot.cell.contentHash !== record.cellContentHash ||
				stableStringify(snapshot.manifest) !== stableStringify(record.manifest)
			) {
				throw new LearningHarnessError(
					"RESEARCH_RESULT_SNAPSHOT_CONFLICT",
					"Research execution record no longer matches its immutable code-cell run snapshot",
				);
			}
			const queueJob = this.studyExecution.getJob(record.queueJobId);
			if (
				queueJob.projectId !== scope.projectId ||
				queueJob.sessionId !== scope.sessionId ||
				queueJob.taskId !== task.taskId ||
				queueJob.status !== terminalStatus ||
				stableStringify(queueJob.manifest) !== stableStringify(record.manifest)
			) {
				throw new LearningHarnessError(
					"RESEARCH_RESULT_QUEUE_CONFLICT",
					"Research execution queue receipt differs from the immutable terminal task",
				);
			}
			const coordinatorResult = this.createStudyExecutionCoordinator(input.coordinatorOptions).getPublicResult(
				record.queueJobId,
			);
			const stdout = this.boundResearchResultText(coordinatorResult?.logs.stdout ?? null);
			const stderr = this.boundResearchResultText(coordinatorResult?.logs.stderr ?? null);
			const error = this.boundResearchResultText(coordinatorResult?.logs.error ?? null);
			const result = this.studyResearch.createResearchAnalysisDraft(scope, {
				expectedProjectRevision: input.expectedProjectRevision,
				origin: {
					kind: "terminal-run",
					taskId: task.taskId,
					taskRevision: task.revision,
					terminalStatus,
					planSnapshot: record.planSnapshot,
					cell: {
						cellId: snapshot.cell.cellId,
						revision: snapshot.cell.revision,
						contentHash: snapshot.cell.contentHash,
						language: snapshot.cell.language,
						code: snapshot.cell.code,
						parameters: snapshot.cell.parameters,
						inputs: snapshot.cell.inputs,
					},
					manifest: record.manifest,
					output: {
						outputHash: contentHash({
							taskStatus: terminalStatus,
							queueJobId: queueJob.queueJobId,
							queueStatus: queueJob.status,
							coordinatorResult,
						}),
						status: terminalStatus,
						usage: coordinatorResult?.usage ?? queueJob.actualUsage,
						stdout: stdout.value,
						stderr: stderr.value,
						error: error.value,
						truncated: stdout.truncated || stderr.truncated || error.truncated,
						observedAt: coordinatorResult?.observedAt ?? null,
					},
				},
				draft: input.draft,
			});
			this.database.exec("COMMIT");
			return structuredClone(result);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	listResearchLearningPromotions(scope: Scope): ResearchLearningPromotion[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureResearchExecutionTables();
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_research_learning_promotion WHERE project_id = ? ORDER BY created_at, promotion_id",
			)
			.all(scope.projectId) as unknown as ResearchPayloadRow[];
		return rows.map((row) =>
			structuredClone(this.decodeResearchPayload<ResearchLearningPromotion>(row, "research learning promotion")),
		);
	}

	listResearchCellRepairs(scope: Scope): ResearchCellRepair[] {
		this.assertHealthy();
		this.studyResearch.projectRevision(scope);
		this.ensureResearchExecutionTables();
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_research_cell_repair WHERE project_id = ? ORDER BY created_at, repair_id",
			)
			.all(scope.projectId) as unknown as ResearchPayloadRow[];
		return rows.map((row) =>
			structuredClone(this.decodeResearchPayload<ResearchCellRepair>(row, "research cell repair")),
		);
	}

	/** Preserve the source learning run and add a separate Research plan with explicit provenance. */
	promoteLearningCellRunToResearchPlan(
		scope: Scope,
		input: { sourceTaskId: string; plan: ResearchPlanInput; expectedProjectRevision: number },
	): { plan: ResearchPlan; promotion: ResearchLearningPromotion } {
		this.assertHealthy();
		this.ensureResearchExecutionTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const sourceTask = this.studyResearch.listTasks(scope).find((task) => task.taskId === input.sourceTaskId);
			if (
				!sourceTask ||
				sourceTask.projectId !== scope.projectId ||
				sourceTask.authorization.sessionId !== scope.sessionId
			)
				throw new LearningHarnessError(
					"RESEARCH_PROMOTION_SOURCE_MISSING",
					"Selected learning run was not found in this conversation",
				);
			if (sourceTask.authorization.kind !== "learning")
				throw new LearningHarnessError(
					"RESEARCH_PROMOTION_SOURCE_INVALID",
					"Only a learning run can be promoted into a separate Research plan",
				);
			const snapshot = this.studyCells.readRun(scope, sourceTask.taskId);
			this.assertPromotionSources(scope, snapshot, input.plan);
			const plan = this.studyResearch.createResearchPlan(scope, {
				plan: input.plan,
				expectedProjectRevision: input.expectedProjectRevision,
			});
			const value = {
				promotionId: `research-learning-promotion-${randomUUID()}`,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				sourceTaskId: sourceTask.taskId,
				sourceCellId: snapshot.cell.cellId,
				sourceCellRevision: snapshot.cell.revision,
				sourceCellContentHash: snapshot.cell.contentHash,
				planId: plan.planId,
				planRevision: plan.revision,
				semanticDigest: plan.semanticDigest,
				planSnapshot: structuredClone(plan),
				createdAt: new Date().toISOString(),
			};
			const promotion: ResearchLearningPromotion = { ...value, contentHash: contentHash(value) };
			this.saveResearchPayload(
				"pi_study_research_learning_promotion",
				"promotion_id",
				promotion.promotionId,
				promotion,
				scope.projectId,
			);
			this.database.exec("COMMIT");
			return { plan: structuredClone(plan), promotion: structuredClone(promotion) };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** A repair is only a provenance record; it never mutates the failed snapshot or claims code equivalence. */
	recordResearchCellRepair(
		scope: Scope,
		input: {
			failedTaskId: string;
			repairCellId: string;
			repairCellRevision: number;
			planId: string;
			expectedPlanRevision: number;
			changeReason: string;
		},
	): ResearchCellRepair {
		this.assertHealthy();
		this.ensureResearchExecutionTables();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.studyResearch.projectRevision(scope);
			if (this.studyResearch.currentPhase(scope.projectId, scope.sessionId)?.phase !== "research")
				throw new LearningHarnessError("RESEARCH_PHASE_REQUIRED", "Recording a repair requires Research phase");
			const original = this.listResearchCellExecutions(scope).find(
				(record) => record.taskId === input.failedTaskId && record.sessionId === scope.sessionId,
			);
			if (!original)
				throw new LearningHarnessError(
					"RESEARCH_REPAIR_SOURCE_INVALID",
					"Repair source must be a recorded Research execution",
				);
			const failed = this.studyResearch.listTasks(scope).find((task) => task.taskId === input.failedTaskId);
			if (
				!failed ||
				failed.authorization.sessionId !== scope.sessionId ||
				!["failed", "limit-reached", "cancelled"].includes(failed.status)
			)
				throw new LearningHarnessError(
					"RESEARCH_REPAIR_SOURCE_INVALID",
					"Select a terminal failed, cancelled, or limited run to record a repair",
				);
			const previous = this.studyCells.readRun(scope, failed.taskId).cell;
			const cell = this.studyCells.get(scope, input.repairCellId, input.repairCellRevision);
			if (
				original.cellContentHash !== previous.contentHash ||
				cell.cellId !== original.cellId ||
				cell.revision <= original.cellRevision ||
				cell.codeHash === previous.codeHash
			)
				throw new LearningHarnessError(
					"RESEARCH_REPAIR_CELL_INVALID",
					"Repair requires changed code in a newer revision of the original cell",
				);
			const plan = this.studyResearch.getResearchPlan(scope, input.planId);
			if (plan.planId !== original.planId || plan.semanticDigest !== original.semanticDigest)
				throw new LearningHarnessError(
					"RESEARCH_REPAIR_PLAN_INVALID",
					"Scientific plan changes are a new experiment, not an implementation repair",
				);
			if (plan.revision !== input.expectedPlanRevision)
				throw new LearningHarnessError(
					"RESEARCH_PLAN_CONFLICT",
					"Research plan changed before recording the repair",
				);
			const value = {
				repairId: `research-cell-repair-${randomUUID()}`,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				failedTaskId: failed.taskId,
				failedCellRevision: previous.revision,
				failedCellContentHash: previous.contentHash,
				semanticDigest: original.semanticDigest,
				repairCellId: cell.cellId,
				repairCellRevision: cell.revision,
				repairCellContentHash: cell.contentHash,
				planId: plan.planId,
				planRevision: plan.revision,
				changeReason: this.requiredResearchText(input.changeReason, "repair change reason", 6_000),
				createdAt: new Date().toISOString(),
			};
			const repair: ResearchCellRepair = { ...value, contentHash: contentHash(value) };
			this.saveResearchPayload(
				"pi_study_research_cell_repair",
				"repair_id",
				repair.repairId,
				repair,
				scope.projectId,
			);
			this.database.exec("COMMIT");
			return structuredClone(repair);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	/** User request replay compares the complete submitted intent before looking up a frozen run. */
	replayStudyCellExecution(scope: Scope, dispatchKey: string, intentHash: string) {
		this.studyResearch.projectRevision(scope);
		this.ensureStudyCellRequestTable();
		const row = this.database
			.prepare(
				"SELECT session_id, intent_hash, queue_job_id FROM pi_study_cell_request WHERE project_id = ? AND dispatch_key = ?",
			)
			.get(scope.projectId, dispatchKey) as
			| { session_id: string; intent_hash: string; queue_job_id: string }
			| undefined;
		if (!row) return null;
		if (row.session_id !== scope.sessionId || row.intent_hash !== intentHash)
			throw new LearningHarnessError(
				"CELL_REQUEST_CONFLICT",
				"Execution request changed or belongs to another conversation",
			);
		const job = this.studyExecution.getJob(row.queue_job_id);
		if (job.projectId !== scope.projectId || job.sessionId !== scope.sessionId || job.dispatchKey !== dispatchKey)
			throw new LearningHarnessError(
				"CELL_REQUEST_CORRUPT",
				"Execution request identity does not match its queue job",
			);
		return job;
	}

	private ensureStudyCellRequestTable(): void {
		this.database.exec(`CREATE TABLE IF NOT EXISTS pi_study_cell_request (
			project_id TEXT NOT NULL, session_id TEXT NOT NULL, dispatch_key TEXT NOT NULL,
			intent_hash TEXT NOT NULL, queue_job_id TEXT NOT NULL UNIQUE,
			PRIMARY KEY(project_id, dispatch_key))`);
	}

	/** Queue identity, immutable cell and actual payload become visible to background workers together. */
	admitStudyCellExecution(
		scope: Scope,
		input: {
			cellId: string;
			expectedCellRevision: number;
			dispatchKey: string;
			intentHash?: string;
			resources: ExecutionResourceRequest;
			quota: ExecutionScopeQuota;
			environment: FrozenExecutionEnvironment;
			inputs: readonly FrozenExecutionInput[];
			coordinatorOptions: Omit<StudyExecutionCoordinatorOptions, "database" | "queue">;
			research?: ResearchCellAdmission;
		},
	) {
		const coordinator = this.createStudyExecutionCoordinator(input.coordinatorOptions);
		this.ensureStudyCellRequestTable();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			if (input.intentHash !== undefined) {
				if (!/^sha256:[a-f0-9]{64}$/u.test(input.intentHash))
					throw new LearningHarnessError("CELL_REQUEST_INVALID", "Execution intent hash is invalid");
				const replay = this.replayStudyCellExecution(scope, input.dispatchKey, input.intentHash);
				if (replay) {
					const snapshot = this.studyCells.readRun(scope, replay.taskId);
					this.database.exec("COMMIT");
					return { job: replay, replay: true, snapshot };
				}
			}
			const cell = this.studyCells.get(scope, input.cellId, input.expectedCellRevision);
			const manifest = this.studyCells.manifest(cell, input.environment.descriptorHash);
			const researchScope =
				input.research?.mode === "grant"
					? this.assertResearchExecutionScope(scope, input.research, cell, input.inputs, input.resources)
					: null;
			if (input.research?.mode === "smoke-learning")
				this.assertSmokeLearningExecution(scope, input.research, cell, input.inputs);
			const existing = this.studyExecution
				.listJobs(scope.projectId)
				.find((job) => job.dispatchKey === input.dispatchKey);
			if (existing && existing.sessionId !== scope.sessionId)
				throw new LearningHarnessError(
					"EXECUTION_SESSION_CONFLICT",
					"dispatch key belongs to another conversation",
				);
			const producerContextId = existing
				? this.studyResearch.readTaskForCoordinator(existing.taskId).producerContextId
				: this.studyResearch.registerTrustedRunnerContext(
						scope,
						`native-cell:${scope.sessionId}:${sha256Hex(input.dispatchKey)}`,
					).contextId;
			if (!producerContextId)
				throw new LearningHarnessError("EXECUTION_PRODUCER_MISSING", "execution has no trusted producer");
			const request = {
				dispatchKey: input.dispatchKey,
				manifest,
				producerContextId,
				resources: input.resources,
				quota: researchScope?.quota ?? input.quota,
			};
			const reservation =
				input.research?.mode === "grant"
					? this.studyExecution.enqueueResearch(scope, {
							...request,
							planId: input.research.planId,
							grantId: input.research.grantId,
							expectedPlanRevision: input.research.expectedPlanRevision,
						})
					: this.studyExecution.enqueueStudy(scope, {
							...request,
							kind: "execution",
							admission: {
								purpose: cell.purpose,
								language: cell.language,
								maxWallSeconds: Math.ceil(input.resources.wallTimeMs / 1000),
								maxMemoryMiB: input.resources.memoryMiB,
							},
						});
			const snapshot = this.studyCells.bindRunFromTrustedAdmission(scope, {
				cellId: cell.cellId,
				expectedCellRevision: cell.revision,
				taskId: reservation.job.taskId,
			});
			if (input.research)
				this.recordResearchCellExecution(scope, {
					job: reservation.job,
					snapshot,
					manifest,
					research: input.research,
					plan: researchScope ? researchScope.planSnapshot : this.currentSmokePlan(scope, input.research),
				});
			coordinator.persistPayload(reservation.job.queueJobId, {
				version: 1,
				taskId: reservation.job.taskId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				manifest,
				language: cell.language === "r" ? "rscript" : "python",
				program: {
					fileName: cell.language === "r" ? "program.R" : "program.py",
					content: cell.code,
					sha256: cell.codeHash,
				},
				parameters: { canonicalJson: stableStringify(cell.parameters), sha256: cell.parameterHash },
				inputs: input.inputs,
				environment: input.environment,
				outputLimitBytes: input.resources.diskBytes,
			});
			if (input.intentHash !== undefined)
				this.database
					.prepare(
						"INSERT INTO pi_study_cell_request(project_id, session_id, dispatch_key, intent_hash, queue_job_id) VALUES (?, ?, ?, ?, ?)",
					)
					.run(scope.projectId, scope.sessionId, input.dispatchKey, input.intentHash, reservation.job.queueJobId);
			this.database.exec("COMMIT");
			return { ...reservation, snapshot };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	async publishCourseVersion(
		courseId: string,
		materialValues: readonly unknown[],
		options: PublishCourseVersionOptions = {},
	): Promise<CourseVersion> {
		this.assertHealthy();
		const inputs = materialValues.map((value) => parseCourseMaterialInput(value));
		const sourcesByName = new Map<string, StoredCourseSource>();
		for (const input of inputs) {
			if (sourcesByName.has(input.name))
				throw new LearningHarnessError("DUPLICATE_MATERIAL", `Duplicate material ${input.name}`);
			const bytes = sourceBytes(input);
			sourcesByName.set(input.name, { sourceHash: `sha256:${sha256Hex(bytes)}`, bytes });
		}
		const courseVersion = await this.courseHost.publishVersion(courseId, inputs, options);
		this.knowledgeHost.registerCourseVersion(courseVersion.courseVersionId);
		const sourceWrites = courseVersion.materials.map((material) => {
			const source = sourcesByName.get(material.name);
			if (!source)
				throw new LearningHarnessError("SOURCE_MAPPING_MISSING", `Missing source bytes for ${material.name}`);
			return { courseVersionId: courseVersion.courseVersionId, materialId: material.materialId, ...source };
		});
		this.persist(sourceWrites);
		return courseVersion;
	}

	openStudentSession(options: OpenStudentSessionOptions): HarnessSession {
		this.assertHealthy();
		const runtime = new RuntimeSessionHost(options.sessionStore);
		const sessionId = runtime.sessionId;
		const existing = this.sessions.get(sessionId);
		if (existing) {
			if (existing.binding.courseVersionId !== options.courseVersionId) {
				throw new LearningHarnessError(
					"COURSE_REBIND_FORBIDDEN",
					`Session ${sessionId} is already bound to another course version`,
				);
			}
			this.reconcileRuntimeReferences(runtime, existing);
			return this.copySession(existing);
		}

		this.courseHost.getVersion(options.courseVersionId);
		const createdAt = options.createdAt ?? new Date().toISOString();
		requireTimestamp(createdAt);
		const catalog = createDefaultResourceCatalog();
		const snapshot = resolveModePackSnapshot({
			pack: requireModePack(createBuiltinModePacks(catalog)["student-learn"], "student-learn"),
			courseVersionId: options.courseVersionId,
			catalog,
			createdAt,
		});
		const binding = parseSessionBinding({
			version: HARNESS_CONTRACT_VERSION,
			bindingId: deterministicId("session-binding", {
				sessionId,
				courseVersionId: options.courseVersionId,
				resourceSnapshotId: snapshot.resourceSnapshotId,
			}),
			sessionId,
			courseVersionId: options.courseVersionId,
			resourceSnapshotId: snapshot.resourceSnapshotId,
			role: "student",
			createdAt,
			revision: 1,
		});
		const session: HarnessSession = {
			sessionId,
			binding,
			snapshot,
			snapshotHistory: [snapshot],
			pendingProfileTransition: null,
			profileTransitionHistory: [],
		};
		this.recordRuntimeReferences(runtime, session);
		this.sessions.set(sessionId, session);
		this.persist();
		return this.copySession(session);
	}

	inheritStudentSession(options: InheritStudentSessionOptions): HarnessSession | null {
		return this.inheritStudentSessionInternal(options, false);
	}

	/**
	 * Accepts a child with no copied journal only after Pi Web has verified that
	 * its JSONL header directly names the supplied persisted parent session.
	 */
	inheritVerifiedDirectEmptyStudentSession(options: InheritStudentSessionOptions): HarnessSession | null {
		return this.inheritStudentSessionInternal(options, true);
	}

	private inheritStudentSessionInternal(
		options: InheritStudentSessionOptions,
		allowVerifiedDirectEmptyChild: boolean,
	): HarnessSession | null {
		this.assertHealthy();
		const parentRuntime = new RuntimeSessionHost(options.parentSessionStore);
		const parent = this.sessions.get(parentRuntime.sessionId);
		if (!parent) {
			if (parentRuntime.recover().binding) {
				throw new LearningHarnessError(
					"PERSISTED_SESSION_MISSING",
					`Pi session ${parentRuntime.sessionId} is Harness-bound but has no durable Harness state`,
				);
			}
			return null;
		}
		this.reconcileRuntimeReferences(parentRuntime, parent);

		const childRuntime = new RuntimeSessionHost(options.childSessionStore);
		if (childRuntime.sessionId === parentRuntime.sessionId) {
			throw new LearningHarnessError("CHILD_SESSION_REQUIRED", "Fork inheritance requires a new Pi session ID");
		}
		const existing = this.sessions.get(childRuntime.sessionId);
		if (existing) {
			if (
				existing.binding.courseVersionId !== parent.binding.courseVersionId ||
				existing.snapshot.resourceSnapshotId !== parent.snapshot.resourceSnapshotId
			) {
				throw new LearningHarnessError(
					"FORK_INHERITANCE_MISMATCH",
					`Forked session ${childRuntime.sessionId} has different durable Harness state`,
				);
			}
			this.reconcileRuntimeReferences(childRuntime, existing);
			return this.copySession(existing);
		}

		const parentLineage = parentRuntime.inspectBindingLineage();
		const childLineage = childRuntime.inspectBindingLineage();
		const childRecovery = childRuntime.recover();
		const inheritedBinding = childLineage.at(-1);
		if (childRecovery.binding) {
			throw new LearningHarnessError(
				"PERSISTED_SESSION_MISSING",
				`Forked Pi session ${childRuntime.sessionId} is Harness-bound but has no durable Harness state`,
			);
		}
		if (!inheritedBinding && !allowVerifiedDirectEmptyChild) {
			throw new LearningHarnessError(
				"FORK_INHERITANCE_MISMATCH",
				`Forked Pi session ${childRuntime.sessionId} has no inherited Harness ancestor binding`,
			);
		}
		if (!inheritedBinding && (childRecovery.snapshots.length > 0 || childRecovery.workflows.length > 0)) {
			throw new LearningHarnessError(
				"FORK_INHERITANCE_MISMATCH",
				`Forked Pi session ${childRuntime.sessionId} is not an empty direct child`,
			);
		}
		if (
			inheritedBinding &&
			!parentLineage.some((candidate) => stableStringify(candidate) === stableStringify(inheritedBinding))
		) {
			throw new LearningHarnessError(
				"FORK_INHERITANCE_MISMATCH",
				`Forked Pi session ${childRuntime.sessionId} does not inherit an ancestor binding from its parent branch`,
			);
		}
		if (
			inheritedBinding &&
			(inheritedBinding.courseVersionId !== parent.binding.courseVersionId ||
				inheritedBinding.resourceSnapshotId !== parent.binding.resourceSnapshotId ||
				inheritedBinding.role !== parent.binding.role)
		) {
			throw new LearningHarnessError(
				"FORK_INHERITANCE_MISMATCH",
				`Forked Pi session ${childRuntime.sessionId} changed its inherited course, resource snapshot, or role`,
			);
		}
		const inheritedSnapshot = childRecovery.snapshots.find(
			(item) => item.resourceSnapshotId === parent.snapshot.resourceSnapshotId,
		);
		if (
			inheritedSnapshot &&
			(inheritedSnapshot.courseVersionId !== parent.snapshot.courseVersionId ||
				inheritedSnapshot.contentHash !== parent.snapshot.contentHash)
		) {
			throw new LearningHarnessError(
				"FORK_INHERITANCE_MISMATCH",
				`Forked Pi session ${childRuntime.sessionId} has a different inherited resource snapshot`,
			);
		}

		const createdAt = options.createdAt ?? new Date().toISOString();
		requireTimestamp(createdAt);
		const binding = parseSessionBinding({
			version: HARNESS_CONTRACT_VERSION,
			bindingId: deterministicId("session-binding", {
				sessionId: childRuntime.sessionId,
				courseVersionId: parent.binding.courseVersionId,
				resourceSnapshotId: parent.snapshot.resourceSnapshotId,
			}),
			sessionId: childRuntime.sessionId,
			courseVersionId: parent.binding.courseVersionId,
			resourceSnapshotId: parent.snapshot.resourceSnapshotId,
			role: parent.binding.role,
			createdAt,
			revision: 1,
		});
		const child: HarnessSession = {
			sessionId: childRuntime.sessionId,
			binding,
			snapshot: parent.snapshot,
			snapshotHistory: [parent.snapshot],
			pendingProfileTransition: null,
			profileTransitionHistory: [],
		};
		this.recordRuntimeReferences(childRuntime, child);
		this.sessions.set(child.sessionId, child);
		this.persist();
		return this.copySession(child);
	}

	reconcileRuntimeSession(sessionStore: PiSessionStore): HarnessSession | null {
		this.assertHealthy();
		const runtime = new RuntimeSessionHost(sessionStore);
		const session = this.sessions.get(runtime.sessionId);
		const recovered = runtime.recover();
		if (!session) {
			if (recovered.binding) {
				throw new LearningHarnessError(
					"PERSISTED_SESSION_MISSING",
					`Pi session ${runtime.sessionId} is Harness-bound but has no durable Harness state`,
				);
			}
			return null;
		}
		if (
			recovered.binding &&
			recovered.binding.bindingId === session.binding.bindingId &&
			recovered.binding.revision > session.binding.revision
		) {
			const snapshot = session.snapshotHistory.find(
				(item) => item.resourceSnapshotId === recovered.binding?.resourceSnapshotId,
			);
			const pending = session.pendingProfileTransition;
			if (!snapshot || !pending || pending.snapshot.resourceSnapshotId !== snapshot.resourceSnapshotId) {
				throw new LearningHarnessError("RECOVERY_REQUIRED", "Pi journal advanced to an unknown profile snapshot.");
			}
			session.binding = recovered.binding;
			session.snapshot = snapshot;
			session.pendingProfileTransition = null;
			session.profileTransitionHistory.push({
				idempotencyKey: pending.idempotencyKey,
				targetProfileId: pending.targetProfileId,
				previousSnapshotId: pending.previousSnapshotId,
				snapshotId: snapshot.resourceSnapshotId,
				bindingRevision: recovered.binding.revision,
				committedAt: new Date().toISOString(),
			});
			this.persist();
		} else if (
			session.pendingProfileTransition &&
			recovered.binding &&
			stableStringify(recovered.binding) === stableStringify(session.binding)
		) {
			// Candidate construction failed before the journal commit point (or the
			// process stopped there). The old JSONL binding is authoritative, so a
			// restart must release the pending transition instead of wedging the UI.
			session.pendingProfileTransition = null;
			this.persist();
		}
		this.reconcileRuntimeReferences(runtime, session);
		return this.copySession(session);
	}

	listCourses(): CourseVersion[] {
		this.assertHealthy();
		return this.courseHost
			.listCourseIds()
			.map((courseId) => this.courseHost.getLatest(courseId))
			.filter((courseVersion): courseVersion is CourseVersion => courseVersion !== undefined);
	}

	getCourseVersion(courseVersionId: string): CourseVersion {
		this.assertHealthy();
		return this.courseHost.getVersion(courseVersionId);
	}

	findCurrentSession(sessionId: string): HarnessSession | null {
		this.assertHealthy();
		const session = this.sessions.get(sessionId);
		return session ? this.copySession(session) : null;
	}

	availableProfiles(sessionId: string): ProfileAvailability[] {
		const session = this.requireSession(sessionId);
		const catalog = createDefaultResourceCatalog();
		const builtins = createBuiltinModePacks(catalog);
		const result: ProfileAvailability[] = Object.values(builtins).map((pack) => {
			const availability = inspectModePackAvailability(pack, catalog);
			let disabledReason: string | null = null;
			if (pack.role !== session.binding.role) {
				disabledReason = `Requires a hard transition to the ${pack.role} role.`;
			} else if (pack.courseRequired && !session.binding.courseVersionId) {
				disabledReason = "This Mode Pack requires a bound course.";
			} else if (session.binding.role === "student" && !isInstalledLearnerRuntime(pack.runtimeMode)) {
				disabledReason = `${pack.title} requires a runtime that is not installed in the learner build.`;
			} else if (!availability.selectable) {
				const missing = availability.missingRequiredResources.join(", ");
				const mismatched = availability.identityMismatches.join(", ");
				disabledReason = missing
					? `Required Mode Pack resources are unavailable: ${missing}`
					: `Mode Pack resource identity mismatch: ${mismatched}`;
			}
			return {
				profileId: pack.modePackId,
				title: pack.title,
				description: pack.description,
				category: pack.category,
				source: "builtin" as const,
				runtimeMode: pack.runtimeMode,
				selectable: disabledReason === null,
				disabledReason,
				missingRequiredResources: availability.missingRequiredResources,
				missingOptionalResources: availability.missingOptionalResources,
				identityMismatches: availability.identityMismatches,
			};
		});
		const known = new Set(result.map((item) => item.profileId));
		const historical = [...session.snapshotHistory].sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
		for (const snapshot of historical) {
			if (known.has(snapshot.profileId)) continue;
			known.add(snapshot.profileId);
			let disabledReason: string | null = null;
			if (snapshot.role !== session.binding.role) {
				disabledReason = `Requires a hard transition to the ${snapshot.role} role.`;
			} else if (snapshot.courseVersionId !== session.binding.courseVersionId) {
				disabledReason = "The saved Mode Pack belongs to another course version.";
			} else if (session.binding.role === "student" && !isInstalledLearnerRuntime(snapshot.mode)) {
				disabledReason = "The saved Mode Pack requires a runtime that is not installed in the learner build.";
			}
			result.push({
				profileId: snapshot.profileId,
				title: modePackTitle(snapshot),
				description: "Custom immutable Mode Pack saved in this session's snapshot history.",
				category: "education",
				source: "custom",
				runtimeMode: snapshot.mode,
				selectable: disabledReason === null,
				disabledReason,
				missingRequiredResources: [],
				missingOptionalResources: [],
				identityMismatches: [],
			});
		}
		return result;
	}

	prepareProfileTransition(options: PrepareProfileTransitionOptions): PreparedProfileTransition {
		this.assertHealthy();
		const session = this.requireSession(options.sessionId);
		if (!options.idempotencyKey)
			throw new LearningHarnessError(
				"PROFILE_IDEMPOTENCY_REQUIRED",
				"Profile transition requires an idempotency key",
			);
		const catalog = createDefaultResourceCatalog();
		const builtins = createBuiltinModePacks(catalog);
		let requestedPack: ModePackDefinition | null = null;
		let requestedSnapshot: ResourceSnapshot | null = null;
		if (options.settingsPatch !== undefined) {
			if (options.modePackDraft !== undefined || options.targetProfileId !== session.snapshot.profileId)
				throw new Error("Settings must target the current mode without a replacement draft");
			const previousRequest = session.profileTransitionHistory.find(
				(item) => item.idempotencyKey === options.idempotencyKey,
			);
			const source = previousRequest
				? session.snapshotHistory.find((item) => item.resourceSnapshotId === previousRequest.previousSnapshotId)
				: session.snapshot;
			if (!source) throw new Error("Previous settings snapshot is missing");
			requestedSnapshot = reviseModePackSettings(source, options.settingsPatch, catalog, options.createdAt);
		}
		if (options.modePackDraft !== undefined) {
			requestedPack = compileModePackDraft(options.modePackDraft, catalog);
			if (requestedPack.modePackId !== options.targetProfileId) {
				throw new LearningHarnessError(
					"MODE_PACK_ID_MISMATCH",
					"targetProfileId must match the custom Mode Pack id",
				);
			}
			if (!requestedPack.modePackId.startsWith("custom.")) {
				throw new LearningHarnessError(
					"CUSTOM_MODE_PACK_ID_REQUIRED",
					"Custom Mode Pack ids must start with custom.",
				);
			}
			if (
				requestedPack.role !== session.binding.role ||
				!requestedPack.courseRequired ||
				!isInstalledLearnerRuntime(requestedPack.runtimeMode) ||
				requestedPack.tools.length > 0 ||
				!requestedPack.components.some(
					(component) => component.type === "plugin" && component.id === "learning-harness" && component.required,
				)
			) {
				throw new LearningHarnessError(
					"MODE_PACK_SESSION_INCOMPATIBLE",
					"Custom learner Mode Packs must stay course-bound, use the installed student runtime, include the Harness plugin, and declare no Pi coding tools.",
				);
			}
			const requestedAt = options.createdAt ?? new Date().toISOString();
			requireTimestamp(requestedAt);
			requestedSnapshot = resolveModePackSnapshot({
				pack: requestedPack,
				courseVersionId: session.binding.courseVersionId,
				catalog,
				createdAt: requestedAt,
			});
		}
		const available = requestedPack
			? null
			: this.availableProfiles(options.sessionId).find((item) => item.profileId === options.targetProfileId);
		if (!requestedPack && (!available || !available.selectable)) {
			throw new LearningHarnessError(
				"PROFILE_UNAVAILABLE",
				available?.disabledReason ?? `Unknown Mode Pack ${options.targetProfileId}`,
			);
		}
		const previous = session.profileTransitionHistory.find((item) => item.idempotencyKey === options.idempotencyKey);
		if (previous) {
			if (
				previous.targetProfileId !== options.targetProfileId ||
				previous.previousSnapshotId !== options.expectedSnapshotId
			) {
				throw new LearningHarnessError(
					"PROFILE_IDEMPOTENCY_REUSE",
					"Profile transition idempotency key was reused for another request.",
				);
			}
			const snapshot = session.snapshotHistory.find((item) => item.resourceSnapshotId === previous.snapshotId);
			if (!snapshot)
				throw new LearningHarnessError("CORRUPT_STATE", "Committed profile transition lost its snapshot.");
			if (requestedSnapshot && requestedSnapshot.contentHash !== snapshot.contentHash) {
				throw new LearningHarnessError(
					"PROFILE_IDEMPOTENCY_REUSE",
					"Profile transition idempotency key was reused with different Mode Pack content.",
				);
			}
			return {
				idempotencyKey: previous.idempotencyKey,
				expectedSnapshotId: previous.previousSnapshotId,
				targetProfileId: previous.targetProfileId,
				previousSnapshotId: previous.previousSnapshotId,
				snapshot: structuredClone(snapshot),
				preparedAt: previous.committedAt,
			};
		}
		if (options.expectedSnapshotId !== session.snapshot.resourceSnapshotId) {
			throw new LearningHarnessError(
				"SNAPSHOT_CONFLICT",
				"The active resource snapshot changed before this profile transition.",
			);
		}
		if (session.pendingProfileTransition) {
			const pending = session.pendingProfileTransition;
			if (pending.idempotencyKey === options.idempotencyKey) {
				if (
					pending.targetProfileId !== options.targetProfileId ||
					pending.expectedSnapshotId !== options.expectedSnapshotId
				) {
					throw new LearningHarnessError(
						"PROFILE_IDEMPOTENCY_REUSE",
						"Profile transition idempotency key was reused for another request.",
					);
				}
				if (requestedSnapshot && requestedSnapshot.contentHash !== pending.snapshot.contentHash) {
					throw new LearningHarnessError(
						"PROFILE_IDEMPOTENCY_REUSE",
						"Profile transition idempotency key was reused with different Mode Pack content.",
					);
				}
				return structuredClone(pending);
			}
			throw new LearningHarnessError(
				"PROFILE_TRANSITION_BUSY",
				"A profile transition is already prepared for this session.",
			);
		}
		const preparedAt = requestedSnapshot?.createdAt ?? options.createdAt ?? new Date().toISOString();
		requireTimestamp(preparedAt);
		const targetProfileId = options.targetProfileId;
		let snapshot: ResourceSnapshot;
		if (requestedSnapshot) {
			if (!requestedSnapshot) {
				throw new LearningHarnessError("CORRUPT_STATE", "Custom Mode Pack did not produce a resource snapshot.");
			}
			snapshot = requestedSnapshot;
		} else {
			const builtin = builtins[targetProfileId];
			const savedSettings = [...session.snapshotHistory]
				.reverse()
				.find((item) => item.profileId === targetProfileId && hasSessionSettings(item));
			if (savedSettings) {
				snapshot = savedSettings;
			} else if (builtin) {
				snapshot = resolveModePackSnapshot({
					pack: builtin,
					courseVersionId: session.binding.courseVersionId,
					catalog,
					createdAt: preparedAt,
				});
			} else {
				const historical = [...session.snapshotHistory]
					.reverse()
					.find((item) => item.profileId === targetProfileId);
				if (!historical) {
					throw new LearningHarnessError("MODE_PACK_NOT_FOUND", `Unknown Mode Pack ${targetProfileId}`);
				}
				if (
					historical.role !== session.binding.role ||
					historical.courseVersionId !== session.binding.courseVersionId ||
					!isInstalledLearnerRuntime(historical.mode)
				) {
					throw new LearningHarnessError(
						"MODE_PACK_SESSION_INCOMPATIBLE",
						"Saved Mode Pack cannot be activated in this learner session.",
					);
				}
				snapshot = historical;
			}
		}
		const pending: PreparedProfileTransition = {
			idempotencyKey: options.idempotencyKey,
			expectedSnapshotId: options.expectedSnapshotId,
			targetProfileId,
			previousSnapshotId: session.snapshot.resourceSnapshotId,
			snapshot,
			preparedAt,
		};
		if (!session.snapshotHistory.some((item) => item.resourceSnapshotId === snapshot.resourceSnapshotId)) {
			session.snapshotHistory.push(snapshot);
		}
		session.pendingProfileTransition = pending;
		this.persist();
		return structuredClone(pending);
	}

	commitPreparedProfileTransition(
		sessionStore: PiSessionStore,
		sessionId: string,
		idempotencyKey: string,
	): HarnessSession {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const pending = session.pendingProfileTransition;
		if (!pending || pending.idempotencyKey !== idempotencyKey) {
			const completed = session.profileTransitionHistory.find((item) => item.idempotencyKey === idempotencyKey);
			if (completed) return this.copySession(session);
			throw new LearningHarnessError(
				"PROFILE_TRANSITION_UNKNOWN",
				"No prepared profile transition matches this request.",
			);
		}
		if (session.snapshot.resourceSnapshotId !== pending.previousSnapshotId) {
			throw new LearningHarnessError(
				"SNAPSHOT_CONFLICT",
				"The active snapshot no longer matches the prepared profile transition.",
			);
		}
		const runtime = new RuntimeSessionHost(sessionStore);
		if (runtime.sessionId !== sessionId)
			throw new LearningHarnessError(
				"RUNTIME_BINDING_MISMATCH",
				"Pi runtime session does not match profile transition session.",
			);
		const binding = parseSessionBinding({
			...session.binding,
			resourceSnapshotId: pending.snapshot.resourceSnapshotId,
			revision: session.binding.revision + 1,
		});
		const next: HarnessSession = { ...session, binding, snapshot: pending.snapshot };
		this.recordRuntimeReferences(runtime, next);
		session.binding = binding;
		session.snapshot = pending.snapshot;
		session.pendingProfileTransition = null;
		session.profileTransitionHistory.push({
			idempotencyKey,
			targetProfileId: pending.targetProfileId,
			previousSnapshotId: pending.previousSnapshotId,
			snapshotId: pending.snapshot.resourceSnapshotId,
			bindingRevision: binding.revision,
			committedAt: new Date().toISOString(),
		});
		this.persist();
		return this.copySession(session);
	}

	/**
	 * Cancel a transition only while the authoritative Pi journal still names
	 * the old binding. If the journal has advanced, restart reconciliation must
	 * finish that commit instead of silently rolling it back.
	 */
	abortPreparedProfileTransition(
		sessionId: string,
		idempotencyKey: string,
		expectedOldSnapshotId: string,
	): HarnessSession {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const pending = session.pendingProfileTransition;
		if (!pending) {
			const completed = session.profileTransitionHistory.find((item) => item.idempotencyKey === idempotencyKey);
			if (completed) return this.copySession(session);
			throw new LearningHarnessError(
				"PROFILE_TRANSITION_UNKNOWN",
				"No prepared profile transition matches this request.",
			);
		}
		if (
			pending.idempotencyKey !== idempotencyKey ||
			pending.previousSnapshotId !== expectedOldSnapshotId ||
			session.snapshot.resourceSnapshotId !== expectedOldSnapshotId
		) {
			throw new LearningHarnessError(
				"SNAPSHOT_CONFLICT",
				"The prepared profile transition no longer targets the active old snapshot.",
			);
		}
		session.pendingProfileTransition = null;
		this.persist();
		return this.copySession(session);
	}

	findStudentSessionForCourse(courseVersionId: string): HarnessSession | null {
		this.assertHealthy();
		const session = [...this.sessions.values()]
			.filter((item) => item.binding.courseVersionId === courseVersionId && item.binding.role === "student")
			.sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
		return session ? this.copySession(session) : null;
	}

	getCurrentSession(sessionId: string): HarnessSession {
		this.assertHealthy();
		return this.copySession(this.requireSession(sessionId));
	}

	getCurrentCourse(sessionId: string): CourseVersion {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const courseVersionId = session.binding.courseVersionId;
		if (!courseVersionId)
			throw new LearningHarnessError("COURSE_REQUIRED", `Session ${sessionId} has no current course`);
		return this.courseHost.getVersion(courseVersionId);
	}

	searchCurrentCourse(sessionId: string, query: string, createdAt?: string) {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const packet = this.knowledgeHost.search({
			binding: session.binding,
			snapshot: session.snapshot,
			query,
			createdAt,
		});
		this.persist();
		return packet;
	}

	readCurrentCourseSpan(sessionId: string, spanId: string): SourceSpan {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		return this.knowledgeHost.readSpan({ binding: session.binding, snapshot: session.snapshot }, spanId);
	}

	validateCurrentDraft(sessionId: string, draft: AnswerDraft, checkedAt?: string): ValidatorResult {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		return this.knowledgeHost.validateDraft(
			draft,
			{ binding: session.binding, snapshot: session.snapshot },
			checkedAt,
		);
	}

	registerCurrentExercise(sessionId: string, publicExercise: ExercisePublic, privateExercise: ExercisePrivate): void {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		if (session.binding.courseVersionId !== publicExercise.courseVersionId)
			throw new LearningHarnessError("COURSE_BINDING_MISMATCH", "Exercise belongs to another course version");
		const publicState = this.assessmentHost.exportPublicState();
		const privateState = this.assessmentHost.exportPrivateState();
		try {
			this.assessmentHost.registerExercise(publicExercise, privateExercise);
			this.persist();
		} catch (error) {
			this.rollbackAssessment(publicState, privateState, error);
		}
	}

	/** Local fixture-only authoring entry point. Pi Web has no route for this operation. */
	seedCourseExercise(publicExercise: ExercisePublic, privateExercise: ExercisePrivate): void {
		this.assertHealthy();
		this.courseHost.getVersion(publicExercise.courseVersionId);
		const publicState = this.assessmentHost.exportPublicState();
		const privateState = this.assessmentHost.exportPrivateState();
		try {
			this.assessmentHost.registerExercise(publicExercise, privateExercise);
			this.persist();
		} catch (error) {
			this.rollbackAssessment(publicState, privateState, error);
		}
	}

	listCurrentExercises(sessionId: string): ExercisePublic[] {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const courseVersionId = session.binding.courseVersionId;
		if (!courseVersionId)
			throw new LearningHarnessError("COURSE_REQUIRED", `Session ${sessionId} has no current course`);
		return this.assessmentHost.listPublicExercises(courseVersionId);
	}

	getCurrentExercise(sessionId: string, exerciseId: string): ExercisePublic {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const exercise = this.assessmentHost.getPublicExercise(exerciseId);
		if (exercise.courseVersionId !== session.binding.courseVersionId)
			throw new LearningHarnessError("COURSE_BINDING_MISMATCH", "Exercise belongs to another course version");
		return structuredClone(exercise);
	}

	startCurrentExercise(
		sessionId: string,
		exerciseId: string,
		idempotencyKey: string,
		issuedAt?: string,
	): ExerciseInstance {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const publicState = this.assessmentHost.exportPublicState();
		const privateState = this.assessmentHost.exportPrivateState();
		try {
			const instance = this.assessmentHost.issueExercise(
				exerciseId,
				session.binding,
				session.snapshot,
				idempotencyKey,
				issuedAt,
			);
			this.persist();
			return structuredClone(instance);
		} catch (error) {
			return this.rollbackAssessment(publicState, privateState, error);
		}
	}

	requestCurrentPracticeHint(sessionId: string, instanceId: string, level: number): string {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		return this.assessmentHost.requestHint(instanceId, level, session.binding);
	}

	submitCurrentPracticeAttempt(
		sessionId: string,
		instanceId: string,
		answer: string,
		idempotencyKey: string,
		submittedAt?: string,
	): SubmittedPracticeAttempt {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const publicState = this.assessmentHost.exportPublicState();
		const privateState = this.assessmentHost.exportPrivateState();
		const learningState = this.learningHost.exportState();
		try {
			const attempt = this.assessmentHost.submitAttempt(
				instanceId,
				answer,
				session.binding,
				idempotencyKey,
				submittedAt,
			);
			const evaluation = this.assessmentHost.evaluateAttempt(attempt.attemptId, submittedAt);
			const exercise = this.assessmentHost.getPublicExercise(attempt.exerciseId);
			const eligible =
				(exercise.unlockPolicy === "after-meaningful-attempt" && attempt.meaningful) ||
				(exercise.unlockPolicy === "after-correct-attempt" && evaluation.correct) ||
				(exercise.unlockPolicy === "teacher-only" && session.binding.role === "teacher");
			const capability = eligible
				? this.assessmentHost.requestSolutionUnlock(
						attempt.attemptId,
						session.binding,
						`practice-unlock:${attempt.attemptId}`,
						submittedAt,
					)
				: null;
			const event = this.recordPracticeEvent(session, attempt, evaluation, exercise, submittedAt);
			this.persist();
			return {
				attempt: structuredClone(attempt),
				evaluation: structuredClone(evaluation),
				capability: capability ? structuredClone(capability) : null,
				event: structuredClone(event),
			};
		} catch (error) {
			try {
				this.assessmentHost.replacePublicState(publicState);
				this.assessmentHost.replacePrivateState(privateState);
				this.learningHost.replaceState(learningState);
			} catch (rollbackError) {
				this.persistenceFailure = new Error(
					`Practice attempt rollback failed after ${error instanceof Error ? error.message : String(error)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
				throw this.persistenceFailure;
			}
			throw error;
		}
	}

	requestCurrentPracticeSolutionUnlock(
		sessionId: string,
		attemptId: string,
		idempotencyKey: string,
		issuedAt?: string,
	): SolutionCapability {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const publicState = this.assessmentHost.exportPublicState();
		const privateState = this.assessmentHost.exportPrivateState();
		try {
			const capability = this.assessmentHost.requestSolutionUnlock(
				attemptId,
				session.binding,
				idempotencyKey,
				issuedAt,
			);
			this.persist();
			return structuredClone(capability);
		} catch (error) {
			return this.rollbackAssessment(publicState, privateState, error);
		}
	}

	consumeCurrentPracticeSolution(sessionId: string, attemptId: string, at?: string): string {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const publicState = this.assessmentHost.exportPublicState();
		const privateState = this.assessmentHost.exportPrivateState();
		try {
			const solution = this.assessmentHost.readSolutionForAttempt(attemptId, session.binding, at);
			this.persist();
			return solution;
		} catch (error) {
			return this.rollbackAssessment(publicState, privateState, error);
		}
	}

	/**
	 * The only composition entry point that makes a grounded answer visible as
	 * product state. Knowledge publication and the shared learner Timeline are
	 * written by one SQLite transaction. Pi owns the corresponding JSONL message.
	 */
	publishCurrentGroundedAnswer(sessionId: string, draft: AnswerDraft, publishedAt?: string): PublishedGroundedAnswer {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const checkedAt = publishedAt ?? new Date().toISOString();
		requireTimestamp(checkedAt);
		const validation = this.knowledgeHost.validateDraft(
			draft,
			{ binding: session.binding, snapshot: session.snapshot },
			checkedAt,
		);
		if (validation.status !== "pass") {
			throw new LearningHarnessError(
				"PUBLICATION_REJECTED",
				validation.issues.map((item) => item.message).join("; "),
			);
		}
		const knowledgeState = this.knowledgeHost.exportState();
		const learningState = this.learningHost.exportState();
		try {
			const receipt = this.knowledgeHost.publishDraft(
				draft,
				{ binding: session.binding, snapshot: session.snapshot },
				checkedAt,
			);
			const event = this.recordAnswerPublishedEvent(session, draft, receipt, checkedAt);
			this.persist();
			return { draft: structuredClone(draft), receipt: structuredClone(receipt), event };
		} catch (error) {
			try {
				this.knowledgeHost.replaceState(knowledgeState);
				this.learningHost.replaceState(learningState);
			} catch (rollbackError) {
				this.persistenceFailure = new Error(
					`Grounded publication rollback failed after ${error instanceof Error ? error.message : String(error)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
				);
				throw this.persistenceFailure;
			}
			throw error;
		}
	}

	getCurrentTimeline(sessionId: string): LearningEvent[] {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const courseVersionId = session.binding.courseVersionId;
		if (!courseVersionId)
			throw new LearningHarnessError("COURSE_REQUIRED", `Session ${sessionId} has no current course`);
		return this.learningHost.getEvents(this.timelineId(courseVersionId));
	}

	recordLearningEvent(sessionId: string, options: RecordLearningEventOptions): LearningEvent {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const courseVersionId = session.binding.courseVersionId;
		if (!courseVersionId)
			throw new LearningHarnessError("COURSE_REQUIRED", `Session ${sessionId} has no current course`);
		const timelineId = this.timelineId(courseVersionId);
		const previous = this.learningHost.getEvents(timelineId);
		const existing = previous.find((event) => event.idempotencyKey === options.idempotencyKey);
		const createdAt = options.createdAt ?? new Date().toISOString();
		requireTimestamp(createdAt);
		const event: LearningEvent = {
			version: HARNESS_CONTRACT_VERSION,
			eventId: deterministicId("learning-event", { timelineId, idempotencyKey: options.idempotencyKey }),
			timelineId,
			courseVersionId,
			sessionBindingId: session.binding.bindingId,
			conceptId: options.conceptId,
			kind: options.kind,
			sequence: existing?.sequence ?? previous.length + 1,
			createdAt,
			idempotencyKey: options.idempotencyKey,
			payload: options.payload,
		};
		const recorded = this.learningHost.record(event, session.binding);
		if (!existing) this.persist();
		return recorded;
	}

	getLearningProgress(sessionId: string): MasteryProjection {
		this.assertHealthy();
		const session = this.requireSession(sessionId);
		const courseVersionId = session.binding.courseVersionId;
		if (!courseVersionId)
			throw new LearningHarnessError("COURSE_REQUIRED", `Session ${sessionId} has no current course`);
		const timelineId = this.timelineId(courseVersionId);
		if (this.learningHost.getEvents(timelineId).length === 0) {
			const identity = { timelineId, courseVersionId, revision: 0, concepts: {} };
			return Object.freeze({ ...identity, contentHash: `sha256:${sha256Hex(stableStringify(identity))}` });
		}
		return this.learningHost.rebuildProjection(timelineId);
	}

	private timelineId(courseVersionId: string): string {
		return deterministicId("learning-timeline", { learnerId: "local", courseVersionId });
	}

	private recordPracticeEvent(
		session: HarnessSession,
		attempt: ExerciseAttempt,
		evaluation: AttemptEvaluation,
		exercise: ExercisePublic,
		createdAt?: string,
	): LearningEvent {
		const courseVersionId = session.binding.courseVersionId;
		if (!courseVersionId)
			throw new LearningHarnessError("COURSE_REQUIRED", `Session ${session.sessionId} has no current course`);
		const timelineId = this.timelineId(courseVersionId);
		const idempotencyKey = `practice:${attempt.attemptId}`;
		const previous = this.learningHost.getEvents(timelineId);
		const existing = previous.find((event) => event.idempotencyKey === idempotencyKey);
		const event: LearningEvent = {
			version: HARNESS_CONTRACT_VERSION,
			eventId: deterministicId("learning-event", { timelineId, idempotencyKey }),
			timelineId,
			courseVersionId,
			sessionBindingId: session.binding.bindingId,
			conceptId: exercise.conceptIds[0] ?? exercise.exerciseId,
			kind: evaluation.correct ? "answered-correct" : "answered-incorrect",
			sequence: existing?.sequence ?? previous.length + 1,
			createdAt: existing?.createdAt ?? createdAt ?? evaluation.createdAt,
			idempotencyKey,
			payload: {
				type: "practice-attempt",
				exerciseId: exercise.exerciseId,
				attemptId: attempt.attemptId,
				evaluationId: evaluation.evaluationId,
				meaningful: attempt.meaningful,
				correct: evaluation.correct,
			},
		};
		return this.learningHost.record(event, session.binding);
	}

	private rollbackAssessment<T>(
		publicState: AssessmentPublicState,
		privateState: AssessmentPrivateState,
		error: unknown,
	): T {
		try {
			this.assessmentHost.replacePublicState(publicState);
			this.assessmentHost.replacePrivateState(privateState);
		} catch (rollbackError) {
			this.persistenceFailure = new Error(
				`Assessment rollback failed after ${error instanceof Error ? error.message : String(error)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
			throw this.persistenceFailure;
		}
		throw error;
	}

	private recordAnswerPublishedEvent(
		session: HarnessSession,
		draft: AnswerDraft,
		receipt: PublicationReceipt,
		createdAt: string,
	): LearningEvent {
		const courseVersionId = session.binding.courseVersionId;
		if (!courseVersionId)
			throw new LearningHarnessError("COURSE_REQUIRED", `Session ${session.sessionId} has no current course`);
		const timelineId = this.timelineId(courseVersionId);
		const idempotencyKey = `publication:${receipt.receiptId}`;
		const previous = this.learningHost.getEvents(timelineId);
		const existing = previous.find((event) => event.idempotencyKey === idempotencyKey);
		const event: LearningEvent = {
			version: HARNESS_CONTRACT_VERSION,
			eventId: deterministicId("learning-event", { timelineId, idempotencyKey }),
			timelineId,
			courseVersionId,
			sessionBindingId: session.binding.bindingId,
			conceptId: draft.claims[0]?.claimId ?? draft.draftId,
			kind: "answer-published",
			sequence: existing?.sequence ?? previous.length + 1,
			createdAt: existing?.createdAt ?? createdAt,
			idempotencyKey,
			payload: {
				type: "answer-published",
				receiptId: receipt.receiptId,
				draftId: draft.draftId,
				packetId: receipt.packetId,
				claimIds: draft.claims.map((claim) => claim.claimId),
				citationSpanIds: [...new Set(draft.claims.flatMap((claim) => claim.citationSpanIds))],
			},
		};
		return this.learningHost.record(event, session.binding);
	}

	readCourseSource(courseVersionId: string, materialId: string): StoredCourseSource {
		this.assertHealthy();
		this.courseHost.getVersion(courseVersionId);
		const source = this.database
			.prepare(
				"SELECT source_hash AS sourceHash FROM learning_harness_material_source WHERE course_version_id = ? AND material_id = ?",
			)
			.get(courseVersionId, materialId) as SourceHashRow | undefined;
		if (!source) throw new LearningHarnessError("SOURCE_NOT_FOUND", `No source bytes for material ${materialId}`);
		const blob = this.database
			.prepare("SELECT bytes FROM learning_harness_source_blob WHERE source_hash = ?")
			.get(source.sourceHash) as SourceBytesRow | undefined;
		if (!blob) throw new LearningHarnessError("SOURCE_NOT_FOUND", `Source blob ${source.sourceHash} is missing`);
		const bytes = new Uint8Array(blob.bytes);
		if (`sha256:${sha256Hex(bytes)}` !== source.sourceHash)
			throw new LearningHarnessError(
				"SOURCE_HASH_MISMATCH",
				`Source blob ${source.sourceHash} failed integrity validation`,
			);
		return { sourceHash: source.sourceHash, bytes };
	}

	private recordRuntimeReferences(runtime: RuntimeSessionHost, session: HarnessSession): void {
		runtime.recordResourceSnapshot(
			{
				version: session.snapshot.version,
				resourceSnapshotId: session.snapshot.resourceSnapshotId,
				profileId: session.snapshot.profileId,
				profileRevision: session.snapshot.profileRevision,
				courseVersionId: session.snapshot.courseVersionId,
				contentHash: session.snapshot.contentHash,
				createdAt: session.snapshot.createdAt,
			},
			`resource-snapshot:${session.snapshot.resourceSnapshotId}`,
		);
		// The binding id identifies a stable session scope; each profile activation
		// advances its revision and must therefore receive a distinct journal idem key.
		runtime.recordSessionBinding(
			session.binding,
			`session-binding:${session.binding.bindingId}:revision:${session.binding.revision}`,
		);
		const recovered = runtime.recover();
		if (!recovered.binding || stableStringify(recovered.binding) !== stableStringify(session.binding)) {
			throw new LearningHarnessError(
				"RUNTIME_BINDING_MISMATCH",
				`Pi session ${session.sessionId} does not contain the expected Harness binding`,
			);
		}
	}

	private reconcileRuntimeReferences(runtime: RuntimeSessionHost, session: HarnessSession): void {
		const recovered = runtime.recover();
		if (!recovered.binding) {
			const ancestor = runtime.inspectBindingLineage().at(-1);
			if (!ancestor) {
				throw new LearningHarnessError(
					"RUNTIME_BINDING_MISMATCH",
					`Pi session ${session.sessionId} has no inherited Harness binding to reconcile`,
				);
			}
			const durableAncestor = this.sessions.get(ancestor.sessionId);
			if (!durableAncestor || stableStringify(durableAncestor.binding) !== stableStringify(ancestor)) {
				throw new LearningHarnessError(
					"RUNTIME_BINDING_MISMATCH",
					`Pi session ${session.sessionId} does not end on a known durable Harness ancestor binding`,
				);
			}
			// A Pi navigation can expose only copied ancestor history. Re-append this
			// session's durable references rather than adopting that ancestor binding.
			this.recordRuntimeReferences(runtime, session);
			return;
		}
		this.assertRuntimeReferences(runtime, session);
	}

	private assertRuntimeReferences(runtime: RuntimeSessionHost, session: HarnessSession): void {
		const recovered = runtime.recover();
		if (!recovered.binding || stableStringify(recovered.binding) !== stableStringify(session.binding)) {
			throw new LearningHarnessError(
				"RUNTIME_BINDING_MISMATCH",
				`Pi session ${session.sessionId} does not contain the expected Harness binding`,
			);
		}
		const snapshot = recovered.snapshots.find(
			(item) => item.resourceSnapshotId === session.snapshot.resourceSnapshotId,
		);
		if (
			!snapshot ||
			snapshot.courseVersionId !== session.snapshot.courseVersionId ||
			snapshot.contentHash !== session.snapshot.contentHash
		) {
			throw new LearningHarnessError(
				"RUNTIME_SNAPSHOT_MISMATCH",
				`Pi session ${session.sessionId} does not contain the expected Harness resource snapshot`,
			);
		}
	}

	private requireSession(sessionId: string): HarnessSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new LearningHarnessError("UNKNOWN_SESSION", `Unknown Harness session ${sessionId}`);
		return session;
	}

	private ensureEnvironmentPackageTables(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_environment_package_lock (
				environment_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE
			);
			CREATE TABLE IF NOT EXISTS pi_study_environment_package_plan (
				plan_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
				created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_environment_package_plan_project ON pi_study_environment_package_plan(project_id, created_at, plan_id);
			CREATE TABLE IF NOT EXISTS pi_study_environment_package_operation (
				operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
				plan_id TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL,
				lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
				UNIQUE(project_id, request_id)
			);
			CREATE INDEX IF NOT EXISTS pi_study_environment_package_operation_claim ON pi_study_environment_package_operation(project_id, status, created_at, operation_id);
			CREATE INDEX IF NOT EXISTS pi_study_environment_package_operation_lease ON pi_study_environment_package_operation(project_id, status, lease_expires_at);
		`);
	}

	private saveEnvironmentPackagePlanRecord(record: EnvironmentPackagePlanRecord): void {
		const payload = stableStringify(record);
		this.database
			.prepare(`INSERT INTO pi_study_environment_package_plan(plan_id, project_id, session_id, created_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(plan_id) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`)
			.run(record.planId, record.projectId, record.sessionId, record.createdAt, payload, contentHash(record));
	}

	private saveEnvironmentPackageOperationRecord(record: EnvironmentPackageOperationRecord): void {
		const payload = stableStringify(record);
		this.database
			.prepare(`INSERT INTO pi_study_environment_package_operation(operation_id, project_id, session_id, plan_id, request_id, status, lease_expires_at, created_at, updated_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(operation_id) DO UPDATE SET status = excluded.status, lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at, payload = excluded.payload, payload_hash = excluded.payload_hash`)
			.run(
				record.operationId,
				record.projectId,
				record.sessionId,
				record.planId,
				record.requestId,
				record.status,
				record.leaseExpiresAt,
				record.createdAt,
				record.updatedAt,
				payload,
				contentHash(record),
			);
	}

	private decodeEnvironmentPackagePayload<T extends { contentHash: string }>(
		row: EnvironmentPackagePayloadRow,
		label: string,
	): T {
		let parsed: T;
		try {
			parsed = JSON.parse(row.payload) as T;
		} catch {
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", `${label} is not valid JSON`);
		}
		if (!parsed || typeof parsed !== "object" || typeof parsed.contentHash !== "string")
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", `${label} has an invalid shape`);
		const { contentHash: identity, ...body } = parsed;
		if (contentHash(parsed) !== row.payloadHash || contentHash(body) !== identity)
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", `${label} integrity check failed`);
		return parsed;
	}

	private withEnvironmentPackageContentHash<T extends { contentHash: string }>(value: T): T {
		const { contentHash: _identity, ...body } = value;
		return { ...body, contentHash: contentHash(body) } as T;
	}

	private readEnvironmentPackagePlan(scope: Scope, planId: string): EnvironmentPackagePlanRecord {
		this.studyResearch.projectRevision(scope);
		const record = this.readEnvironmentPackagePlanByProject(scope.projectId, planId);
		if (!record)
			throw new LearningHarnessError("PACKAGE_PLAN_NOT_FOUND", "Package plan was not found in this project");
		if (record.sessionId !== scope.sessionId)
			throw new LearningHarnessError(
				"PACKAGE_PLAN_SESSION_CONFLICT",
				"Package plan belongs to another conversation",
			);
		return record;
	}

	private readEnvironmentPackagePlanByProject(projectId: string, planId: string): EnvironmentPackagePlanRecord | null {
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_plan WHERE project_id = ? AND plan_id = ?",
			)
			.get(projectId, this.requiredEnvironmentPackageText(planId, "package plan ID", 128)) as
			| EnvironmentPackagePayloadRow
			| undefined;
		return row
			? this.validateEnvironmentPackagePlanRecord(
					this.decodeEnvironmentPackagePayload<EnvironmentPackagePlanRecord>(row, "package plan"),
				)
			: null;
	}

	private readEnvironmentPackageOperationByRequest(
		projectId: string,
		requestId: string,
	): EnvironmentPackageOperationRecord | null {
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_operation WHERE project_id = ? AND request_id = ?",
			)
			.get(projectId, requestId) as EnvironmentPackagePayloadRow | undefined;
		return row
			? this.validateEnvironmentPackageOperationRecord(
					this.decodeEnvironmentPackagePayload<EnvironmentPackageOperationRecord>(row, "package operation"),
				)
			: null;
	}

	private readEnvironmentPackageOperationByProject(
		projectId: string,
		operationId: string,
	): EnvironmentPackageOperationRecord {
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_operation WHERE project_id = ? AND operation_id = ?",
			)
			.get(projectId, this.requiredEnvironmentPackageText(operationId, "package operation ID", 128)) as
			| EnvironmentPackagePayloadRow
			| undefined;
		if (!row)
			throw new LearningHarnessError(
				"PACKAGE_OPERATION_NOT_FOUND",
				"Package operation was not found in this project",
			);
		return this.validateEnvironmentPackageOperationRecord(
			this.decodeEnvironmentPackagePayload<EnvironmentPackageOperationRecord>(row, "package operation"),
		);
	}

	private readExpiredEnvironmentPackageOperations(
		projectId: string,
		now: string,
	): EnvironmentPackageOperationRecord[] {
		const rows = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_environment_package_operation WHERE project_id = ? AND status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
			)
			.all(projectId, now) as unknown as EnvironmentPackagePayloadRow[];
		return rows.map((row) =>
			this.validateEnvironmentPackageOperationRecord(
				this.decodeEnvironmentPackagePayload<EnvironmentPackageOperationRecord>(row, "package operation"),
			),
		);
	}

	/** Changes only durable state: expiry never implies an installer was harmless or unlocks its environment. */
	private fenceExpiredEnvironmentPackageOperations(projectId: string, now: string): void {
		for (const expired of this.readExpiredEnvironmentPackageOperations(projectId, now)) {
			const unknown = this.withEnvironmentPackageContentHash({
				...expired,
				status: "unknown" as const,
				leaseExpiresAt: null,
				diagnostic: "Worker lease expired before final inventory validation; do not retry this operation.",
				updatedAt: now,
				completedAt: now,
			});
			this.saveEnvironmentPackageOperationRecord(unknown);
		}
	}

	/** Package installation waits for every admitted/preparing/running native execution, globally and transactionally. */
	private activeEnvironmentExecutionJobCount(): number {
		const row = this.database
			.prepare(
				"SELECT COUNT(*) AS count FROM pi_study_execution_job WHERE status NOT IN ('queued', 'succeeded', 'failed', 'cancelled', 'limit-reached', 'needs-input')",
			)
			.get() as { count: number };
		return row.count;
	}

	private completeEnvironmentPackageOperation(input: {
		projectId: string;
		operationId: string;
		workerId: string;
		status: "succeeded" | "failed" | "unknown";
		diagnostic: string | null;
		result: EnvironmentPackageExecutionResult | null;
	}): EnvironmentPackageOperationRecord {
		this.assertHealthy();
		this.ensureEnvironmentPackageTables();
		const projectId = this.requiredEnvironmentPackageText(input.projectId, "package project ID", 128);
		const workerId = this.requiredEnvironmentPackageText(input.workerId, "package worker ID", 256);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.readEnvironmentPackageOperationByProject(projectId, input.operationId);
			if (current.status !== "running" || current.workerId !== workerId)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_CLAIM_CONFLICT",
					"Package operation is no longer claimed by this worker",
				);
			if (input.status === "succeeded") this.validateEnvironmentPackageExecutionResult(input.result);
			else if (input.result !== null)
				throw new LearningHarnessError(
					"PACKAGE_OPERATION_RESULT_INVALID",
					"Failed package operation may not have a final result",
				);
			const now = new Date().toISOString();
			const next = this.withEnvironmentPackageContentHash({
				...current,
				status: input.status,
				leaseExpiresAt: null,
				diagnostic: input.diagnostic === null ? null : this.environmentPackageDiagnostic(input.diagnostic),
				result: input.result === null ? null : structuredClone(input.result),
				updatedAt: now,
				completedAt: now,
			});
			this.saveEnvironmentPackageOperationRecord(next);
			// Unknown remains fenced: an orphaned installer may still be alive after its worker disappeared.
			if (input.status === "succeeded" || input.status === "failed")
				this.database
					.prepare("DELETE FROM pi_study_environment_package_lock WHERE operation_id = ?")
					.run(next.operationId);
			this.database.exec("COMMIT");
			return structuredClone(next);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private validateEnvironmentPackagePlanRecord(record: EnvironmentPackagePlanRecord): EnvironmentPackagePlanRecord {
		this.requiredEnvironmentPackageText(record.planId, "package plan ID", 128);
		this.requiredEnvironmentPackageText(record.projectId, "package project ID", 128);
		this.requiredEnvironmentPackageText(record.sessionId, "package session ID", 128);
		if (!Number.isSafeInteger(record.revision) || record.revision < 1)
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", "Package plan revision is invalid");
		this.validateEnvironmentPackagePlan(record.plan);
		if (record.planId !== record.plan.planId)
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", "Package plan identity differs from its payload");
		this.requireEnvironmentPackageTimestamp(record.createdAt, "package plan creation time");
		return record;
	}

	private validateEnvironmentPackageOperationRecord(
		record: EnvironmentPackageOperationRecord,
	): EnvironmentPackageOperationRecord {
		for (const [value, label, maximum] of [
			[record.operationId, "package operation ID", 128],
			[record.projectId, "package project ID", 128],
			[record.sessionId, "package session ID", 128],
			[record.planId, "package plan ID", 128],
			[record.requestId, "package request ID", 256],
		] as const)
			this.requiredEnvironmentPackageText(value, label, maximum);
		if (!/^sha256:[a-f0-9]{64}$/u.test(record.planHash))
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", "Package operation plan hash is invalid");
		if (
			!Number.isSafeInteger(record.planRevision) ||
			record.planRevision < 1 ||
			!Number.isSafeInteger(record.attempts) ||
			record.attempts < 0
		)
			throw new LearningHarnessError(
				"PACKAGE_RECORD_CORRUPT",
				"Package operation revision or attempt count is invalid",
			);
		if (!["queued", "running", "succeeded", "failed", "unknown", "reconciled"].includes(record.status))
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", "Package operation status is invalid");
		if (record.status === "running" && (!record.workerId || !record.leaseExpiresAt))
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", "Running package operation has no worker lease");
		if (record.status !== "running" && record.leaseExpiresAt !== null)
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", "Terminal package operation retained a worker lease");
		if (record.workerId !== null) this.requiredEnvironmentPackageText(record.workerId, "package worker ID", 256);
		if (record.leaseExpiresAt !== null)
			this.requireEnvironmentPackageTimestamp(record.leaseExpiresAt, "package worker lease");
		if (record.installer !== null) this.validateEnvironmentPackageProcessIdentity(record.installer);
		if (record.installerExitedAt !== null) {
			if (record.installer === null)
				throw new LearningHarnessError(
					"PACKAGE_RECORD_CORRUPT",
					"Package operation retained an exit time without an installer",
				);
			this.requireEnvironmentPackageTimestamp(record.installerExitedAt, "package installer exit time");
		}
		if (record.reconciledAt !== null)
			this.requireEnvironmentPackageTimestamp(record.reconciledAt, "package reconciliation time");
		if (record.status === "reconciled" && record.reconciledAt === null)
			throw new LearningHarnessError(
				"PACKAGE_RECORD_CORRUPT",
				"Reconciled package operation has no reconciliation time",
			);
		if (record.status !== "reconciled" && record.reconciledAt !== null)
			throw new LearningHarnessError(
				"PACKAGE_RECORD_CORRUPT",
				"Unreconciled package operation has a reconciliation time",
			);
		if (record.consentedAt !== null)
			this.requireEnvironmentPackageTimestamp(record.consentedAt, "package consent time");
		if (record.startedAt !== null) this.requireEnvironmentPackageTimestamp(record.startedAt, "package start time");
		if (record.completedAt !== null)
			this.requireEnvironmentPackageTimestamp(record.completedAt, "package completion time");
		this.requireEnvironmentPackageTimestamp(record.createdAt, "package creation time");
		this.requireEnvironmentPackageTimestamp(record.updatedAt, "package update time");
		if (record.status === "succeeded") this.validateEnvironmentPackageExecutionResult(record.result);
		if (record.status !== "succeeded" && record.result !== null)
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", "Non-success package operation has a final result");
		return record;
	}

	private validateEnvironmentPackagePlan(plan: EnvironmentPackagePlan): void {
		if (!plan || typeof plan !== "object" || !/^sha256:[a-f0-9]{64}$/u.test(plan.contentHash))
			throw new LearningHarnessError("PACKAGE_PLAN_INVALID", "Package plan is invalid");
		const { contentHash: identity, ...body } = plan;
		if (
			contentHash(body) !== identity ||
			!["python", "r"].includes(plan.language) ||
			!Array.isArray(plan.packages) ||
			plan.packages.length === 0
		)
			throw new LearningHarnessError("PACKAGE_PLAN_INVALID", "Package plan integrity check failed");
		this.requiredEnvironmentPackageText(plan.planId, "package plan ID", 128);
		if (!/^sha256:[a-f0-9]{64}$/u.test(plan.inventoryHash))
			throw new LearningHarnessError("PACKAGE_PLAN_INVALID", "Package plan inventory hash is invalid");
	}

	private assertEnvironmentPackagePlanUnlocked(plan: EnvironmentPackagePlan): void {
		const locked = this.database
			.prepare("SELECT operation_id FROM pi_study_environment_package_lock WHERE environment_key = ?")
			.get(this.environmentPackageKey(plan)) as { operation_id: string } | undefined;
		if (locked)
			throw new LearningHarnessError(
				"PACKAGE_ENVIRONMENT_BUSY",
				"Package environment is locked by a running or unreconciled operation",
			);
	}

	private environmentPackageKey(plan: EnvironmentPackagePlan): string {
		return contentHash({
			language: plan.language,
			executablePath: plan.executablePath,
			environmentDirectory: plan.environmentDirectory,
		});
	}

	private validateEnvironmentPackageExecutionResult(
		result: EnvironmentPackageExecutionResult | null,
	): asserts result is EnvironmentPackageExecutionResult {
		if (
			!result ||
			!Array.isArray(result.finalInventory) ||
			!Array.isArray(result.installed) ||
			!/^sha256:[a-f0-9]{64}$/u.test(result.finalInventoryHash)
		)
			throw new LearningHarnessError(
				"PACKAGE_OPERATION_RESULT_INVALID",
				"Package operation final validation result is invalid",
			);
		this.requireEnvironmentPackageTimestamp(result.validatedAt, "package final validation time");
	}

	private requiredEnvironmentPackageText(value: unknown, label: string, maximum: number): string {
		if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0"))
			throw new LearningHarnessError("PACKAGE_INPUT_INVALID", `Invalid ${label}`);
		return value.trim();
	}

	private validateEnvironmentPackageProcessIdentity(value: EnvironmentPackageProcessIdentity): void {
		if (!Number.isSafeInteger(value.pid) || value.pid < 1)
			throw new LearningHarnessError("PACKAGE_PROCESS_IDENTITY_INVALID", "Package installer PID is invalid");
		this.requireEnvironmentPackageTimestamp(value.startedAt, "package installer start time");
		if (value.supervisorExecutablePath !== undefined && !isAbsolute(value.supervisorExecutablePath))
			throw new LearningHarnessError(
				"PACKAGE_PROCESS_IDENTITY_INVALID",
				"Package supervisor executable path must be absolute when present",
			);
		if (value.processCreationIdentity !== undefined && !/^[0-9]{17,20}$/u.test(value.processCreationIdentity))
			throw new LearningHarnessError(
				"PACKAGE_PROCESS_IDENTITY_INVALID",
				"Package supervisor creation identity must be a Windows FILETIME value when present",
			);
	}

	private requireEnvironmentPackageTimestamp(value: unknown, label: string): void {
		if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
			throw new LearningHarnessError("PACKAGE_RECORD_CORRUPT", `Invalid ${label}`);
	}

	private environmentPackageDiagnostic(value: string): string {
		return (
			value
				.replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/gu, "[local path]")
				.trim()
				.slice(0, 2_000) || "Package operation failed without a diagnostic"
		);
	}

	private ensureVisualValidationTables(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_visual_validation_specification (
				specification_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
				visualization_id TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_visual_validation_specification_target ON pi_study_visual_validation_specification(project_id, visualization_id, updated_at, specification_id);
			CREATE TABLE IF NOT EXISTS pi_study_visual_validation_run (
				run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
				queue_job_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL UNIQUE, visualization_id TEXT NOT NULL,
				created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_visual_validation_run_target ON pi_study_visual_validation_run(project_id, visualization_id, created_at, run_id);
			CREATE TABLE IF NOT EXISTS pi_study_visual_validation_request (
				project_id TEXT NOT NULL, session_id TEXT NOT NULL, dispatch_key TEXT NOT NULL,
				intent_hash TEXT NOT NULL, queue_job_id TEXT NOT NULL UNIQUE, PRIMARY KEY(project_id, dispatch_key)
			);
		`);
	}

	private saveVisualValidationPayload(
		table: "pi_study_visual_validation_specification" | "pi_study_visual_validation_run",
		idColumn: "specification_id" | "run_id",
		id: string,
		value: VisualValidationSpecificationRecord | VisualValidationExecutionRecord,
		projectId: string,
	): void {
		if (value.projectId !== projectId)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_PROJECT_MISMATCH",
				"Visual validation record project does not match its storage scope",
			);
		const payload = stableStringify(value);
		const payloadHash = contentHash(value);
		if (table === "pi_study_visual_validation_specification") {
			const specification = value as VisualValidationSpecificationRecord;
			this.database
				.prepare(`INSERT INTO ${table}(${idColumn}, project_id, session_id, visualization_id, updated_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(${idColumn}) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash, updated_at = excluded.updated_at`)
				.run(
					id,
					projectId,
					specification.sessionId,
					specification.target.visualizationId,
					specification.updatedAt,
					payload,
					payloadHash,
				);
			return;
		}
		const run = value as VisualValidationExecutionRecord;
		this.database
			.prepare(`INSERT INTO ${table}(${idColumn}, project_id, session_id, queue_job_id, task_id, visualization_id, created_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(${idColumn}) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`)
			.run(
				id,
				projectId,
				run.sessionId,
				run.queueJobId,
				run.taskId,
				run.target.visualizationId,
				run.createdAt,
				payload,
				payloadHash,
			);
	}

	private decodeVisualValidationPayload<T extends { contentHash: string }>(
		row: VisualValidationPayloadRow,
		label: string,
	): T {
		let parsed: T;
		try {
			parsed = JSON.parse(row.payload) as T;
		} catch {
			throw new LearningHarnessError("VISUAL_VALIDATION_RECORD_CORRUPT", `${label} is not valid JSON`);
		}
		if (!parsed || typeof parsed !== "object" || typeof parsed.contentHash !== "string")
			throw new LearningHarnessError("VISUAL_VALIDATION_RECORD_CORRUPT", `${label} has an invalid shape`);
		const { contentHash: identity, ...body } = parsed;
		if (contentHash(parsed) !== row.payloadHash || contentHash(body) !== identity)
			throw new LearningHarnessError("VISUAL_VALIDATION_RECORD_CORRUPT", `${label} integrity check failed`);
		return parsed;
	}

	private withVisualValidationContentHash<T extends { contentHash: string }>(value: T): T {
		const { contentHash: _identity, ...body } = value;
		return { ...body, contentHash: contentHash(body) } as T;
	}

	private readVisualValidationSpecification(
		scope: Scope,
		specificationId: string,
	): VisualValidationSpecificationRecord {
		this.studyResearch.projectRevision(scope);
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_visual_validation_specification WHERE project_id = ? AND specification_id = ?",
			)
			.get(
				scope.projectId,
				this.requiredVisualValidationText(specificationId, "validation specification ID", 128),
			) as VisualValidationPayloadRow | undefined;
		if (!row)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_SPEC_NOT_FOUND",
				"Visual validation specification was not found in this project",
			);
		const record = this.validateStoredVisualValidationSpecification(
			this.decodeVisualValidationPayload<VisualValidationSpecificationRecord>(
				row,
				"visual validation specification",
			),
		);
		if (record.sessionId !== scope.sessionId)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_SESSION_CONFLICT",
				"Visual validation specification belongs to another conversation",
			);
		return record;
	}

	private readVisualValidationRun(scope: Scope, runId: string): VisualValidationExecutionRecord {
		this.studyResearch.projectRevision(scope);
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_visual_validation_run WHERE project_id = ? AND run_id = ?",
			)
			.get(scope.projectId, this.requiredVisualValidationText(runId, "visual validation run ID", 128)) as
			| VisualValidationPayloadRow
			| undefined;
		if (!row)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RUN_NOT_FOUND",
				"Visual validation run was not found in this project",
			);
		const record = this.validateStoredVisualValidationRun(
			this.decodeVisualValidationPayload<VisualValidationExecutionRecord>(row, "visual validation run"),
		);
		if (record.sessionId !== scope.sessionId)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_SESSION_CONFLICT",
				"Visual validation run belongs to another conversation",
			);
		return record;
	}

	private readVisualValidationRunByQueue(scope: Scope, queueJobId: string): VisualValidationExecutionRecord {
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_visual_validation_run WHERE project_id = ? AND queue_job_id = ?",
			)
			.get(scope.projectId, queueJobId) as VisualValidationPayloadRow | undefined;
		if (!row)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RUN_CORRUPT",
				"Visual validation request has no frozen run record",
			);
		const record = this.validateStoredVisualValidationRun(
			this.decodeVisualValidationPayload<VisualValidationExecutionRecord>(row, "visual validation run"),
		);
		if (record.sessionId !== scope.sessionId)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_SESSION_CONFLICT",
				"Visual validation run belongs to another conversation",
			);
		return record;
	}

	private validateStoredVisualValidationSpecification(
		record: VisualValidationSpecificationRecord,
	): VisualValidationSpecificationRecord {
		this.requiredVisualValidationText(record.specificationId, "validation specification ID", 128);
		this.requiredVisualValidationText(record.projectId, "validation project ID", 128);
		this.requiredVisualValidationText(record.sessionId, "validation session ID", 128);
		if (!Number.isSafeInteger(record.revision) || record.revision < 1)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RECORD_CORRUPT",
				"Visual validation specification revision is invalid",
			);
		this.validateVisualValidationTargetReference(record.target);
		if (validateVisualSpecification(record.specification) !== record.specificationHash)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RECORD_CORRUPT",
				"Visual validation specification hash is invalid",
			);
		if (record.specification.targetHash !== record.target.visualizationHash)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RECORD_CORRUPT",
				"Visual validation specification target does not match its frozen target",
			);
		this.assertCompleteVisualCategories(record.specification);
		if (stableStringify(record.sourceReferences) !== stableStringify(record.specification.oracle.sourceReferences))
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RECORD_CORRUPT",
				"Visual validation source references differ from its oracle",
			);
		this.validateVisualValidationSourceShape(record.sourceReferences);
		return record;
	}

	private validateStoredVisualValidationRun(record: VisualValidationExecutionRecord): VisualValidationExecutionRecord {
		this.requiredVisualValidationText(record.runId, "visual validation run ID", 128);
		this.requiredVisualValidationText(record.queueJobId, "visual validation queue job ID", 128);
		this.requiredVisualValidationText(record.taskId, "visual validation task ID", 128);
		this.requiredVisualValidationText(record.dispatchKey, "visual validation dispatch key", 256);
		if (!/^sha256:[a-f0-9]{64}$/u.test(record.intentHash))
			throw new LearningHarnessError("VISUAL_VALIDATION_RECORD_CORRUPT", "Visual validation intent hash is invalid");
		this.validateStoredVisualValidationSpecification({
			specificationId: record.specificationId,
			projectId: record.projectId,
			sessionId: record.sessionId,
			revision: record.specificationRevision,
			target: record.target,
			specification: record.specification,
			specificationHash: record.specificationHash,
			sourceReferences: record.sourceReferences,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			contentHash: "unchecked",
		});
		if (!/^[A-Za-z0-9_-]{24,128}$/u.test(record.outputKey))
			throw new LearningHarnessError("VISUAL_VALIDATION_RECORD_CORRUPT", "Visual validation output key is invalid");
		const expectedLineage = record.specification.cases.map((entry) => ({
			caseId: entry.id,
			inputHash: contentHash(entry.inputs),
		}));
		if (stableStringify(record.inputLineage) !== stableStringify(expectedLineage))
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RECORD_CORRUPT",
				"Visual validation input lineage is invalid",
			);
		for (const hash of [record.manifest.codeHash, record.manifest.parameterHash, record.manifest.environmentHash])
			if (!/^sha256:[a-f0-9]{64}$/u.test(hash))
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_RECORD_CORRUPT",
					"Visual validation manifest hash is invalid",
				);
		if (Object.keys(record.manifest.inputHashes).length !== 0)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RECORD_CORRUPT",
				"Visual validation payload must not have ambient source inputs",
			);
		return record;
	}

	private resolveVisualValidationTarget(
		scope: Scope,
		input: Pick<VisualValidationTargetReference, "visualizationId" | "visualizationRevision" | "visualizationHash">,
	): VisualValidationTargetReference {
		const visualization = this.studyResearch.getVisualizationDraft(
			scope,
			this.requiredVisualValidationText(input.visualizationId, "visualization ID", 128),
		);
		if (
			visualization.revision !== input.visualizationRevision ||
			visualization.contentHash !== input.visualizationHash
		)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_TARGET_CONFLICT",
				"Visualization changed before validation was saved",
			);
		return {
			visualizationId: visualization.visualizationId,
			visualizationRevision: visualization.revision,
			visualizationHash: visualization.contentHash,
			codeHash: visualization.codeHash,
			inputHash: visualization.inputHash,
			environmentHash: visualization.environmentHash,
		};
	}

	private validateVisualValidationTargetReference(value: VisualValidationTargetReference): void {
		this.requiredVisualValidationText(value.visualizationId, "visualization ID", 128);
		if (!Number.isSafeInteger(value.visualizationRevision) || value.visualizationRevision < 1)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_RECORD_CORRUPT",
				"Visual validation target revision is invalid",
			);
		for (const hash of [value.visualizationHash, value.codeHash, value.inputHash, value.environmentHash])
			if (!/^sha256:[a-f0-9]{64}$/u.test(hash))
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_RECORD_CORRUPT",
					"Visual validation target hash is invalid",
				);
	}

	private assertCompleteVisualCategories(specification: VisualValidationSpecification): void {
		const categories = new Set(specification.cases.map((entry) => entry.category));
		for (const category of ["ordinary", "boundary", "degenerate", "interaction"] as const)
			if (!categories.has(category))
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_INCOMPLETE",
					`Visual validation must include an ${category} case before execution`,
				);
	}

	private validateVisualValidationSourceShape(
		value: readonly { sourceId: string; sourceHash: string; locator: string }[],
	): void {
		if (!Array.isArray(value) || value.length < 1 || value.length > 100)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_SOURCE_REQUIRED",
				"Visual validation requires 1–100 independently sourced oracle references",
			);
		const identities = new Set<string>();
		for (const reference of value) {
			const sourceId = this.requiredVisualValidationText(reference?.sourceId, "oracle source ID", 128);
			const sourceHash = this.requiredVisualValidationText(reference?.sourceHash, "oracle source hash", 80);
			this.requiredVisualValidationText(reference?.locator, "oracle source locator", 4000);
			if (
				!/^sha256:[a-f0-9]{64}$/u.test(sourceHash) ||
				identities.has(`${sourceId}\0${sourceHash}\0${reference.locator}`)
			)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_SOURCE_INVALID",
					"Visual validation oracle sources are invalid or duplicated",
				);
			identities.add(`${sourceId}\0${sourceHash}\0${reference.locator}`);
		}
	}

	private validateVisualValidationSources(
		scope: Scope,
		specification: VisualValidationSpecification,
	): Array<{ sourceId: string; sourceHash: string; locator: string }> {
		const references = structuredClone(specification.oracle.sourceReferences);
		this.validateVisualValidationSourceShape(references);
		const current = this.studyResearch.listSources(scope).filter((source) => source.current);
		for (const reference of references)
			if (
				!current.some(
					(source) => source.sourceId === reference.sourceId && source.contentHash === reference.sourceHash,
				)
			)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_SOURCE_STALE",
					"Visual validation oracle source is no longer current",
				);
		return references;
	}

	private assertVisualValidationRecordCurrent(
		scope: Scope,
		target: VisualValidationTargetReference,
		references: readonly { sourceId: string; sourceHash: string; locator: string }[],
	): void {
		this.resolveVisualValidationTarget(scope, target);
		this.assertVisualValidationSourceReferencesCurrent(scope, references);
	}

	private visualValidationStaleReasons(
		scope: Scope,
		target: VisualValidationTargetReference,
		references: readonly { sourceId: string; sourceHash: string; locator: string }[],
	): string[] {
		const reasons: string[] = [];
		try {
			this.resolveVisualValidationTarget(scope, target);
		} catch {
			reasons.push("Visualization target revision is no longer current");
		}
		try {
			this.assertVisualValidationSourceReferencesCurrent(scope, references);
		} catch {
			reasons.push("An oracle source version is no longer current");
		}
		return reasons;
	}

	private assertVisualValidationSourceReferencesCurrent(
		scope: Scope,
		references: readonly { sourceId: string; sourceHash: string; locator: string }[],
	): void {
		this.validateVisualValidationSourceShape(references);
		const current = this.studyResearch.listSources(scope).filter((source) => source.current);
		for (const reference of references)
			if (
				!current.some(
					(source) => source.sourceId === reference.sourceId && source.contentHash === reference.sourceHash,
				)
			)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_SOURCE_STALE",
					"Visual validation oracle source is no longer current",
				);
	}

	private validateVisualValidationQuota(value: ExecutionScopeQuota): void {
		for (const [name, amount] of [
			["maxRuns", value.maxRuns],
			["maxCumulativeWallTimeMs", value.maxCumulativeWallTimeMs],
			["maxCumulativeDiskBytes", value.maxCumulativeDiskBytes],
		] as const)
			if (!Number.isSafeInteger(amount) || amount < 1)
				throw new LearningHarnessError(
					"VISUAL_VALIDATION_QUOTA_INVALID",
					`${name} must be a positive safe integer`,
				);
		if (value.expiresAt !== null)
			throw new LearningHarnessError(
				"VISUAL_VALIDATION_QUOTA_INVALID",
				"Visual validation uses a non-expiring bounded learning quota",
			);
	}

	private visualValidationTerminal(status: string): boolean {
		return ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(status);
	}

	private visualValidationError(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return message.replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/gu, "[local path]").slice(0, 2000);
	}

	private requiredVisualValidationText(value: unknown, label: string, max: number): string {
		if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
			throw new LearningHarnessError("VISUAL_VALIDATION_INPUT_INVALID", `Invalid ${label}`);
		return value.trim();
	}

	private ensureResearchExecutionTables(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_research_execution_scope (
				scope_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, grant_id TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_research_execution_scope_project ON pi_study_research_execution_scope(project_id, created_at, scope_id);
			CREATE TABLE IF NOT EXISTS pi_study_research_execution_run (
				record_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, queue_job_id TEXT NOT NULL UNIQUE,
				task_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_research_execution_run_project ON pi_study_research_execution_run(project_id, created_at, record_id);
			CREATE TABLE IF NOT EXISTS pi_study_research_learning_promotion (
				promotion_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_task_id TEXT NOT NULL,
				created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_research_learning_promotion_project ON pi_study_research_learning_promotion(project_id, created_at, promotion_id);
			CREATE TABLE IF NOT EXISTS pi_study_research_cell_repair (
				repair_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, failed_task_id TEXT NOT NULL,
				created_at TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_research_cell_repair_project ON pi_study_research_cell_repair(project_id, created_at, repair_id);
		`);
	}

	private saveResearchPayload(
		table:
			| "pi_study_research_execution_scope"
			| "pi_study_research_execution_run"
			| "pi_study_research_learning_promotion"
			| "pi_study_research_cell_repair",
		idColumn: "scope_id" | "record_id" | "promotion_id" | "repair_id",
		id: string,
		value: { projectId: string; createdAt: string; contentHash: string },
		projectId: string,
	): void {
		if (value.projectId !== projectId)
			throw new LearningHarnessError(
				"RESEARCH_RECORD_PROJECT_MISMATCH",
				"Research record project does not match its storage scope",
			);
		const payload = stableStringify(value);
		const payloadHash = contentHash(value);
		if (table === "pi_study_research_execution_scope") {
			const scope = value as ResearchExecutionScope;
			this.database
				.prepare(`INSERT INTO ${table}(${idColumn}, project_id, grant_id, created_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(${idColumn}) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`)
				.run(id, projectId, scope.grantId, value.createdAt, payload, payloadHash);
			return;
		}
		if (table === "pi_study_research_execution_run") {
			const run = value as ResearchCellExecutionRecord;
			this.database
				.prepare(`INSERT INTO ${table}(${idColumn}, project_id, queue_job_id, task_id, created_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(${idColumn}) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`)
				.run(id, projectId, run.queueJobId, run.taskId, value.createdAt, payload, payloadHash);
			return;
		}
		if (table === "pi_study_research_learning_promotion") {
			const promotion = value as ResearchLearningPromotion;
			this.database
				.prepare(`INSERT INTO ${table}(${idColumn}, project_id, source_task_id, created_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(${idColumn}) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`)
				.run(id, projectId, promotion.sourceTaskId, value.createdAt, payload, payloadHash);
			return;
		}
		const repair = value as ResearchCellRepair;
		this.database
			.prepare(`INSERT INTO ${table}(${idColumn}, project_id, failed_task_id, created_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(${idColumn}) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`)
			.run(id, projectId, repair.failedTaskId, value.createdAt, payload, payloadHash);
	}

	private decodeResearchPayload<T extends { contentHash: string }>(row: ResearchPayloadRow, label: string): T {
		let parsed: T;
		try {
			parsed = JSON.parse(row.payload) as T;
		} catch {
			throw new LearningHarnessError("RESEARCH_RECORD_CORRUPT", `${label} is not valid JSON`);
		}
		if (!parsed || typeof parsed !== "object" || typeof parsed.contentHash !== "string")
			throw new LearningHarnessError("RESEARCH_RECORD_CORRUPT", `${label} has an invalid shape`);
		const { contentHash: identity, ...body } = parsed;
		if (contentHash(parsed) !== row.payloadHash || contentHash(body) !== identity)
			throw new LearningHarnessError("RESEARCH_RECORD_CORRUPT", `${label} integrity check failed`);
		return parsed;
	}

	private withResearchContentHash<T extends { contentHash: string }>(value: T): T {
		const { contentHash: _identity, ...body } = value;
		return { ...body, contentHash: contentHash(body) } as T;
	}

	private readResearchExecutionScope(scope: Scope, scopeId: string): ResearchExecutionScope {
		this.studyResearch.projectRevision(scope);
		const row = this.database
			.prepare(
				"SELECT payload, payload_hash AS payloadHash FROM pi_study_research_execution_scope WHERE project_id = ? AND scope_id = ?",
			)
			.get(scope.projectId, this.requiredResearchText(scopeId, "research scope ID", 128)) as
			| ResearchPayloadRow
			| undefined;
		if (!row)
			throw new LearningHarnessError(
				"RESEARCH_SCOPE_NOT_FOUND",
				"Research execution scope was not found in this project",
			);
		return this.decodeResearchPayload<ResearchExecutionScope>(row, "research execution scope");
	}

	private requiredResearchText(value: unknown, label: string, max: number): string {
		if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
			throw new LearningHarnessError("RESEARCH_INPUT_INVALID", `Invalid ${label}`);
		return value.trim();
	}

	private boundResearchResultText(value: string | null): { value: string | null; truncated: boolean } {
		if (value === null) return { value: null, truncated: false };
		if (typeof value !== "string" || value.includes("\0")) {
			throw new LearningHarnessError("RESEARCH_RESULT_OUTPUT_INVALID", "Coordinator result output is malformed");
		}
		const maximum = 200_000;
		return value.length <= maximum
			? { value, truncated: false }
			: { value: value.slice(0, maximum), truncated: true };
	}

	private validateResearchResources(value: ExecutionResourceRequest, label: string): ExecutionResourceRequest {
		for (const [name, number, maximum] of [
			["cpuMilliCores", value.cpuMilliCores, 10_000_000],
			["memoryMiB", value.memoryMiB, 10_000_000],
			["wallTimeMs", value.wallTimeMs, 31_536_000_000],
			["diskBytes", value.diskBytes, Number.MAX_SAFE_INTEGER],
		] as const) {
			if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
				throw new LearningHarnessError(
					"RESEARCH_RESOURCE_INVALID",
					`${label} ${name} must be a positive bounded integer`,
				);
		}
		return structuredClone(value);
	}

	private validateResearchQuota(value: ExecutionScopeQuota): ExecutionScopeQuota {
		for (const [name, number] of [
			["maxRuns", value.maxRuns],
			["maxCumulativeWallTimeMs", value.maxCumulativeWallTimeMs],
			["maxCumulativeDiskBytes", value.maxCumulativeDiskBytes],
		] as const) {
			if (!Number.isSafeInteger(number) || number < 1)
				throw new LearningHarnessError("RESEARCH_QUOTA_INVALID", `${name} must be a positive safe integer`);
		}
		if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))
			throw new LearningHarnessError("RESEARCH_QUOTA_INVALID", "Research quota must have an ISO expiry timestamp");
		return structuredClone(value);
	}

	private validateResearchLanguages(value: readonly ("python" | "r")[]): Array<"python" | "r"> {
		if (!Array.isArray(value) || value.length === 0 || value.length > 2)
			throw new LearningHarnessError(
				"RESEARCH_LANGUAGE_INVALID",
				"Choose one or both supported Research cell languages",
			);
		const languages = [...new Set(value)];
		if (languages.some((language) => language !== "python" && language !== "r"))
			throw new LearningHarnessError(
				"RESEARCH_LANGUAGE_INVALID",
				"Research scope contains an unsupported cell language",
			);
		return languages.sort();
	}

	private currentPlanSourceBindings(
		scope: Scope,
		plan: {
			sourceReferences?: readonly { sourceId: string; contentHash: string }[];
			sourceVersionHashes: readonly string[];
		},
	): ResearchExecutionInputBinding[] {
		const current = this.studyResearch.listSources(scope).filter((source) => source.current);
		const bindings = plan.sourceReferences
			? plan.sourceReferences.map((reference) => ({
					sourceId: reference.sourceId,
					sourceHash: reference.contentHash,
				}))
			: plan.sourceVersionHashes.map((sourceHash) => {
					const matches = current.filter((source) => source.contentHash === sourceHash);
					if (matches.length !== 1)
						throw new LearningHarnessError(
							"RESEARCH_SOURCE_AMBIGUOUS",
							"Research plan source hash does not identify exactly one current source",
						);
					return { sourceId: matches[0].sourceId, sourceHash: matches[0].contentHash };
				});
		const identities = new Set<string>();
		for (const binding of bindings) {
			if (
				!/^sha256:[a-f0-9]{64}$/u.test(binding.sourceHash) ||
				!binding.sourceId ||
				identities.has(`${binding.sourceId}\0${binding.sourceHash}`)
			)
				throw new LearningHarnessError(
					"RESEARCH_SOURCE_INVALID",
					"Research plan source bindings are invalid or duplicated",
				);
			identities.add(`${binding.sourceId}\0${binding.sourceHash}`);
			if (
				!current.some((source) => source.sourceId === binding.sourceId && source.contentHash === binding.sourceHash)
			)
				throw new LearningHarnessError(
					"RESEARCH_SOURCE_STALE",
					"Research plan source version is no longer current",
				);
		}
		return bindings.sort(
			(left, right) =>
				left.sourceId.localeCompare(right.sourceId) || left.sourceHash.localeCompare(right.sourceHash),
		);
	}

	private validateResearchInputs(
		scope: Scope,
		plan: ResearchPlan,
		value: readonly ResearchExecutionInputBinding[],
	): ResearchExecutionInputBinding[] {
		if (!Array.isArray(value) || value.length > 64)
			throw new LearningHarnessError(
				"RESEARCH_INPUT_INVALID",
				"Research scope may allow at most 64 registered source inputs",
			);
		const planBindings = this.currentPlanSourceBindings(scope, plan);
		const identities = new Set<string>();
		const result = value.map((binding) => {
			const sourceId = this.requiredResearchText(binding?.sourceId, "research input source ID", 128);
			const sourceHash = this.requiredResearchText(binding?.sourceHash, "research input source hash", 80);
			if (!/^sha256:[a-f0-9]{64}$/u.test(sourceHash))
				throw new LearningHarnessError("RESEARCH_INPUT_INVALID", "Research input source hash is invalid");
			const identity = `${sourceId}\0${sourceHash}`;
			if (identities.has(identity))
				throw new LearningHarnessError("RESEARCH_INPUT_INVALID", "Research scope repeats an input source version");
			identities.add(identity);
			if (!planBindings.some((candidate) => candidate.sourceId === sourceId && candidate.sourceHash === sourceHash))
				throw new LearningHarnessError(
					"RESEARCH_INPUT_OUTSIDE_PLAN",
					"Research input is outside the approved plan source bindings",
				);
			return { sourceId, sourceHash };
		});
		return result.sort(
			(left, right) =>
				left.sourceId.localeCompare(right.sourceId) || left.sourceHash.localeCompare(right.sourceHash),
		);
	}

	private assertCellInputsWithinResearchScope(
		cell: StudyCodeCell,
		frozen: readonly FrozenExecutionInput[],
		allowedInputs: readonly ResearchExecutionInputBinding[],
	): void {
		if (frozen.length !== cell.inputs.length)
			throw new LearningHarnessError(
				"RESEARCH_INPUT_SNAPSHOT_MISMATCH",
				"Frozen inputs do not match the selected code cell bindings",
			);
		const inputByName = new Map(frozen.map((input) => [input.name, input]));
		if (inputByName.size !== frozen.length)
			throw new LearningHarnessError("RESEARCH_INPUT_SNAPSHOT_MISMATCH", "Frozen inputs contain duplicate names");
		for (const binding of cell.inputs) {
			const input = inputByName.get(binding.name);
			if (!input || input.sha256 !== binding.sourceHash)
				throw new LearningHarnessError(
					"RESEARCH_INPUT_SNAPSHOT_MISMATCH",
					"Frozen input hash does not match the immutable cell binding",
				);
			if (
				!allowedInputs.some(
					(allowed) => allowed.sourceId === binding.sourceId && allowed.sourceHash === binding.sourceHash,
				)
			)
				throw new LearningHarnessError(
					"RESEARCH_INPUT_NOT_ALLOWED",
					"Code cell input is outside the approved Research scope",
				);
		}
	}

	private assertResearchExecutionScope(
		scope: Scope,
		request: Extract<ResearchCellAdmission, { mode: "grant" }>,
		cell: StudyCodeCell,
		frozen: readonly FrozenExecutionInput[],
		resources: ExecutionResourceRequest,
	): ResearchExecutionScope {
		const executionScope = this.readResearchExecutionScope(scope, request.scopeId);
		if (
			!executionScope.planSnapshot ||
			executionScope.planSnapshot.planId !== executionScope.planId ||
			executionScope.planSnapshot.revision !== executionScope.planRevision ||
			executionScope.planSnapshot.semanticDigest !== executionScope.semanticDigest
		)
			throw new LearningHarnessError(
				"RESEARCH_SCOPE_SNAPSHOT_MISSING",
				"Scope lacks its exact scientific plan snapshot; approve the current plan again",
			);
		if (
			executionScope.sessionId !== scope.sessionId ||
			executionScope.grantId !== request.grantId ||
			executionScope.planId !== request.planId ||
			executionScope.planRevision !== request.expectedPlanRevision
		)
			throw new LearningHarnessError(
				"RESEARCH_SCOPE_MISMATCH",
				"Research scope does not match the requested plan and grant",
			);
		if (executionScope.revokedAt !== null || Date.parse(executionScope.expiresAt) <= Date.now())
			throw new LearningHarnessError("RESEARCH_SCOPE_INACTIVE", "Research execution scope is revoked or expired");
		if (!executionScope.allowedLanguages.includes(cell.language))
			throw new LearningHarnessError(
				"RESEARCH_LANGUAGE_NOT_ALLOWED",
				"Code cell language is outside the approved Research scope",
			);
		this.validateResearchResources(resources, "research execution");
		for (const key of ["cpuMilliCores", "memoryMiB", "wallTimeMs", "diskBytes"] as const)
			if (resources[key] > executionScope.maxResources[key])
				throw new LearningHarnessError("RESEARCH_RESOURCE_EXCEEDED", `${key} exceeds the approved Research scope`);
		this.assertCellInputsWithinResearchScope(cell, frozen, executionScope.allowedInputs);
		this.requiredResearchText(request.changeNote, "research run change note", 6_000);
		const plan = this.studyResearch.getResearchPlan(scope, executionScope.planId);
		if (plan.revision !== executionScope.planRevision || plan.semanticDigest !== executionScope.semanticDigest)
			throw new LearningHarnessError("RESEARCH_SCOPE_STALE", "Research plan changed after scope approval");
		const grant = this.studyResearch
			.listScopeGrants(scope)
			.find((candidate) => candidate.grantId === executionScope.grantId);
		if (!grant || grant.revokedAt !== null || Date.parse(grant.expiresAt) <= Date.now())
			throw new LearningHarnessError("RESEARCH_SCOPE_INACTIVE", "Research grant is missing, revoked, or expired");
		return executionScope;
	}

	private assertSmokeLearningExecution(
		scope: Scope,
		request: Extract<ResearchCellAdmission, { mode: "smoke-learning" }>,
		cell: StudyCodeCell,
		frozen: readonly FrozenExecutionInput[],
	): void {
		if (this.studyResearch.getPhase(scope).phase !== "research")
			throw new LearningHarnessError(
				"RESEARCH_PHASE_REQUIRED",
				"Smoke execution requires the explicit Research phase",
			);
		const plan = this.currentSmokePlan(scope, request);
		this.assertCellInputsWithinResearchScope(cell, frozen, this.currentPlanSourceBindings(scope, plan));
		this.requiredResearchText(request.changeNote, "smoke run change note", 6_000);
	}

	private currentSmokePlan(
		scope: Scope,
		request: { planId: string; expectedPlanRevision: number },
	): Pick<ResearchPlan, "planId" | "revision" | "semanticDigest"> & ResearchPlan {
		const plan = this.studyResearch.getResearchPlan(scope, request.planId);
		if (plan.kind !== "smoke" || plan.revision !== request.expectedPlanRevision)
			throw new LearningHarnessError(
				"RESEARCH_SMOKE_PLAN_INVALID",
				"Smoke execution requires the current smoke plan revision",
			);
		this.currentPlanSourceBindings(scope, plan);
		return plan;
	}

	private recordResearchCellExecution(
		scope: Scope,
		input: {
			job: { queueJobId: string; taskId: string };
			snapshot: StudyCellRunSnapshot;
			manifest: ResearchCellExecutionRecord["manifest"];
			research: ResearchCellAdmission;
			plan: ResearchPlan;
		},
	): ResearchCellExecutionRecord {
		const value = {
			recordId: `research-cell-execution-${randomUUID()}`,
			projectId: scope.projectId,
			sessionId: scope.sessionId,
			queueJobId: input.job.queueJobId,
			taskId: input.job.taskId,
			mode: input.research.mode,
			planId: input.plan.planId,
			planRevision: input.plan.revision,
			semanticDigest: input.plan.semanticDigest,
			planSnapshot: structuredClone(input.plan),
			grantId: input.research.mode === "grant" ? input.research.grantId : null,
			scopeId: input.research.mode === "grant" ? input.research.scopeId : null,
			cellId: input.snapshot.cell.cellId,
			cellRevision: input.snapshot.cell.revision,
			cellContentHash: input.snapshot.cell.contentHash,
			manifest: structuredClone(input.manifest),
			changeNote: this.requiredResearchText(input.research.changeNote, "research run change note", 6_000),
			createdAt: new Date().toISOString(),
		};
		const record: ResearchCellExecutionRecord = { ...value, contentHash: contentHash(value) };
		this.saveResearchPayload(
			"pi_study_research_execution_run",
			"record_id",
			record.recordId,
			record,
			scope.projectId,
		);
		return record;
	}

	private assertPromotionSources(scope: Scope, snapshot: StudyCellRunSnapshot, plan: ResearchPlanInput): void {
		const bindings = this.currentPlanSourceBindings(scope, plan);
		for (const input of snapshot.cell.inputs)
			if (
				!bindings.some((binding) => binding.sourceId === input.sourceId && binding.sourceHash === input.sourceHash)
			)
				throw new LearningHarnessError(
					"RESEARCH_PROMOTION_SOURCE_INVALID",
					"Promoted learning run input must remain an explicit source of the new Research plan",
				);
	}

	private assertHealthy(): void {
		if (this.persistenceFailure) {
			throw new LearningHarnessError(
				"PERSISTENCE_FAILURE",
				`Learning Harness is unavailable after a persistence failure: ${this.persistenceFailure.message}`,
			);
		}
	}

	private copySession(session: HarnessSession): HarnessSession {
		return structuredClone(session);
	}

	private persist(sourceWrites: readonly SourceWrite[] = []): void {
		const states: Readonly<Record<(typeof STATE_KEYS)[number], string>> = {
			"course-host": stableStringify(this.courseHost.exportState()),
			"knowledge-host": stableStringify(this.knowledgeHost.exportState()),
			"learning-host": stableStringify(this.learningHost.exportState()),
			"assessment-host": stableStringify(this.assessmentHost.exportPublicState()),
			sessions: stableStringify({
				version: STORE_VERSION,
				sessions: [...this.sessions.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
			}),
		};
		let transactionStarted = false;
		try {
			this.database.exec("BEGIN IMMEDIATE");
			transactionStarted = true;
			const putPrivateSolution = this.database.prepare(
				"INSERT INTO learning_harness_private_solution (exercise_id, content_hash, payload_json) VALUES (?, ?, ?) ON CONFLICT(exercise_id) DO NOTHING",
			);
			const getPrivateSolution = this.database.prepare(
				"SELECT content_hash AS contentHash, payload_json AS payloadJson FROM learning_harness_private_solution WHERE exercise_id = ?",
			);
			for (const solution of this.assessmentHost.exportPrivateState().solutions) {
				const payloadJson = stableStringify(solution);
				putPrivateSolution.run(solution.exerciseId, solution.contentHash, payloadJson);
				const persisted = getPrivateSolution.get(solution.exerciseId) as
					| { contentHash: string; payloadJson: string }
					| undefined;
				if (!persisted || persisted.contentHash !== solution.contentHash || persisted.payloadJson !== payloadJson) {
					throw new LearningHarnessError(
						"PRIVATE_SOLUTION_CONFLICT",
						`Private solution ${solution.exerciseId} does not match the immutable vault record`,
					);
				}
			}
			const putBlob = this.database.prepare(
				"INSERT INTO learning_harness_source_blob (source_hash, bytes) VALUES (?, ?) ON CONFLICT(source_hash) DO NOTHING",
			);
			const putSource = this.database.prepare(
				"INSERT INTO learning_harness_material_source (course_version_id, material_id, source_hash) VALUES (?, ?, ?) ON CONFLICT(course_version_id, material_id) DO NOTHING",
			);
			const sourceHash = this.database.prepare(
				"SELECT source_hash AS sourceHash FROM learning_harness_material_source WHERE course_version_id = ? AND material_id = ?",
			);
			const sourceBytesByHash = this.database.prepare(
				"SELECT bytes FROM learning_harness_source_blob WHERE source_hash = ?",
			);
			for (const source of sourceWrites) {
				putBlob.run(source.sourceHash, source.bytes);
				putSource.run(source.courseVersionId, source.materialId, source.sourceHash);
				const persisted = sourceHash.get(source.courseVersionId, source.materialId) as SourceHashRow | undefined;
				if (!persisted || persisted.sourceHash !== source.sourceHash) {
					throw new LearningHarnessError(
						"SOURCE_BYTES_CONFLICT",
						`Course material ${source.materialId} already has different source bytes`,
					);
				}
				const blob = sourceBytesByHash.get(source.sourceHash) as SourceBytesRow | undefined;
				if (!blob || `sha256:${sha256Hex(blob.bytes)}` !== source.sourceHash) {
					throw new LearningHarnessError(
						"SOURCE_HASH_MISMATCH",
						`Source blob ${source.sourceHash} failed integrity validation`,
					);
				}
			}
			const putState = this.database.prepare(
				"INSERT INTO learning_harness_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			);
			for (const key of STATE_KEYS) putState.run(key, states[key]);
			this.database.exec("COMMIT");
			transactionStarted = false;
		} catch (error) {
			if (transactionStarted) {
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					this.persistenceFailure = new Error(
						`Persistence failed (${error instanceof Error ? error.message : String(error)}) and rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
					);
					throw this.persistenceFailure;
				}
			}
			this.persistenceFailure = error instanceof Error ? error : new Error(String(error));
			throw error;
		}
	}

	private restore(): void {
		const rows = this.database
			.prepare("SELECT key, value FROM learning_harness_state")
			.all() as unknown as StateRow[];
		if (rows.length === 0) return;
		const values = new Map(rows.map((row) => [row.key, row.value]));
		const legacyState =
			rows.length === LEGACY_STATE_KEYS.length &&
			LEGACY_STATE_KEYS.every((key) => values.has(key)) &&
			!values.has("assessment-host");
		if (!legacyState) {
			if (rows.length !== STATE_KEYS.length)
				throw new LearningHarnessError("CORRUPT_STATE", "Persistent Harness state is incomplete");
			for (const key of STATE_KEYS)
				if (!values.has(key))
					throw new LearningHarnessError("CORRUPT_STATE", `Persistent Harness state is missing ${key}`);
		}
		this.courseHost.restoreState(JSON.parse(values.get("course-host") as string) as CourseHostState);
		this.assertSourceStoreIntegrity();
		this.knowledgeHost.restoreState(JSON.parse(values.get("knowledge-host") as string) as KnowledgeHostState);
		for (const courseVersion of this.courseHost.listAllVersions())
			this.knowledgeHost.registerCourseVersion(courseVersion.courseVersionId);
		this.learningHost.restoreState(JSON.parse(values.get("learning-host") as string) as LearningHostState);
		const privateRows = this.database
			.prepare(
				"SELECT exercise_id AS exerciseId, content_hash AS contentHash, payload_json AS payloadJson FROM learning_harness_private_solution ORDER BY exercise_id",
			)
			.all() as unknown as PrivateSolutionRow[];
		const privateSolutions = privateRows.map((row) => {
			const parsed = JSON.parse(row.payloadJson) as ExercisePrivate;
			if (parsed.exerciseId !== row.exerciseId || parsed.contentHash !== row.contentHash)
				throw new LearningHarnessError("CORRUPT_STATE", `Private solution ${row.exerciseId} is inconsistent`);
			return parsed;
		});
		this.assessmentHost.restorePrivateState({ version: 1, solutions: privateSolutions });
		this.assessmentHost.restorePublicState(
			legacyState
				? {
						version: 1,
						publicExercises: [],
						instances: [],
						attempts: [],
						evaluations: [],
						capabilities: [],
						idempotency: [],
					}
				: (JSON.parse(values.get("assessment-host") as string) as AssessmentPublicState),
		);
		const persisted = JSON.parse(values.get("sessions") as string) as unknown;
		if (!isRecord(persisted) || persisted.version !== STORE_VERSION || !Array.isArray(persisted.sessions)) {
			throw new LearningHarnessError("CORRUPT_STATE", "Persisted sessions have an unsupported shape");
		}
		for (const value of persisted.sessions) {
			const session = sessionFromUnknown(value, this.courseHost);
			if (this.sessions.has(session.sessionId))
				throw new LearningHarnessError("CORRUPT_STATE", `Duplicate persisted session ${session.sessionId}`);
			this.sessions.set(session.sessionId, session);
		}
		if (legacyState) this.persist();
	}

	private assertSourceStoreIntegrity(): void {
		for (const courseVersion of this.courseHost.listAllVersions()) {
			for (const material of courseVersion.materials)
				this.readCourseSource(courseVersion.courseVersionId, material.materialId);
		}
	}
}
