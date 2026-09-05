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
import { deterministicId, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import { KnowledgeHost, type KnowledgeHostState } from "../../knowledge-host/src/index.ts";
import { LearningHost, type LearningHostState } from "../../learning-host/src/index.ts";
import { type PiSessionStore, RuntimeSessionHost } from "../../pi-runtime-host/src/index.ts";
import {
	compileModePackDraft,
	createBuiltinModePacks,
	createDefaultResourceCatalog,
	inspectModePackAvailability,
	resolveModePackSnapshot,
} from "../../profile-resource-host/src/index.ts";

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
	readonly courseHost = new CourseHost();
	readonly knowledgeHost = new KnowledgeHost(this.courseHost);
	readonly learningHost = new LearningHost();
	private readonly assessmentHost = new AssessmentHost(new InMemorySolutionVault());

	private readonly database: DatabaseSync;
	private readonly sessions = new Map<string, HarnessSession>();
	private persistenceFailure: Error | null = null;

	constructor(options: LearningHarnessOptions) {
		if (!options.databasePath) throw new LearningHarnessError("DATABASE_PATH_REQUIRED", "databasePath is required");
		this.database = new DatabaseSync(options.databasePath);
		try {
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
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	close(): void {
		this.database.close();
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
		if (requestedPack) {
			if (!requestedSnapshot) {
				throw new LearningHarnessError("CORRUPT_STATE", "Custom Mode Pack did not produce a resource snapshot.");
			}
			snapshot = requestedSnapshot;
		} else {
			const builtin = builtins[targetProfileId];
			if (builtin) {
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
