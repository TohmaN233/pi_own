import {
	type AttemptEvaluation,
	type ExerciseAttempt,
	type ExerciseInstance,
	type ExercisePrivate,
	type ExercisePublic,
	type ResourceSnapshot,
	type SessionBinding,
	type SolutionCapability,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";

export class AssessmentHostError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AssessmentHostError";
		this.code = code;
	}
}

export interface SolutionVault {
	put(solution: ExercisePrivate): void;
	get(exerciseId: string): ExercisePrivate | undefined;
}

export interface StatefulSolutionVault extends SolutionVault {
	exportState(): ExercisePrivate[];
	restoreState(values: ExercisePrivate[]): void;
}

export interface AssessmentPublicState {
	version: 1;
	publicExercises: ExercisePublic[];
	instances: ExerciseInstance[];
	attempts: ExerciseAttempt[];
	evaluations: AttemptEvaluation[];
	capabilities: Array<{ value: SolutionCapability; remainingUses: number }>;
	idempotency: Array<{ key: string; fingerprint: string; value: unknown }>;
}

export interface AssessmentPrivateState {
	version: 1;
	solutions: ExercisePrivate[];
}

export class InMemorySolutionVault implements SolutionVault {
	private readonly values = new Map<string, ExercisePrivate>();

	put(solution: ExercisePrivate): void {
		const existing = this.values.get(solution.exerciseId);
		if (existing && stableStringify(existing) !== stableStringify(solution)) {
			throw new AssessmentHostError("PRIVATE_ASSET_REDEFINED", `Private asset for ${solution.exerciseId} already exists`);
		}
		this.values.set(solution.exerciseId, Object.freeze({ ...solution, acceptedAnswers: [...solution.acceptedAnswers] }));
	}

	get(exerciseId: string): ExercisePrivate | undefined {
		return this.values.get(exerciseId);
	}

	exportState(): ExercisePrivate[] {
		return [...this.values.values()].sort((left, right) => left.exerciseId.localeCompare(right.exerciseId));
	}

	restoreState(values: ExercisePrivate[]): void {
		if (this.values.size > 0) throw new AssessmentHostError("STATE_NOT_EMPTY", "Solution vault restore requires an empty vault");
		for (const value of values) this.put(value);
	}
}

interface CapabilityState {
	value: SolutionCapability;
	remainingUses: number;
}

interface Idempotent<T> {
	fingerprint: string;
	value: T;
}

function normalizeAnswer(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("und").replace(/[\s\p{P}\p{S}]+/gu, "").trim();
}

function assertBound(binding: SessionBinding, snapshot: ResourceSnapshot | null, courseVersionId: string): void {
	if (binding.courseVersionId !== courseVersionId) throw new AssessmentHostError("COURSE_BINDING_MISMATCH", "Exercise belongs to another course version");
	if (snapshot) {
		if (snapshot.courseVersionId !== courseVersionId || snapshot.resourceSnapshotId !== binding.resourceSnapshotId) {
			throw new AssessmentHostError("SNAPSHOT_BINDING_MISMATCH", "Active resource snapshot does not match the exercise session");
		}
	}
}

function meaningfulAttempt(answer: string): boolean {
	const normalized = answer.normalize("NFKC").trim();
	if (normalized.length < 3) return false;
	if (/^(?:不知道|不会|答案呢|给我答案|tell me|idk|don't know|do not know|answer)$/iu.test(normalized)) return false;
	return (normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

function assertPublicPrivate(publicExercise: ExercisePublic, privateExercise: ExercisePrivate): void {
	if (!publicExercise.exerciseId || publicExercise.exerciseId !== privateExercise.exerciseId) {
		throw new AssessmentHostError("EXERCISE_ID_MISMATCH", "Public and private exercise IDs must match");
	}
	if (!publicExercise.courseVersionId || !publicExercise.prompt.trim()) throw new AssessmentHostError("INVALID_EXERCISE", "Exercise prompt and course version are required");
	if (!Number.isSafeInteger(publicExercise.revision) || publicExercise.revision < 1) throw new AssessmentHostError("INVALID_EXERCISE", "Exercise revision must be positive");
	if (!privateExercise.solution.trim() || privateExercise.acceptedAnswers.length === 0) throw new AssessmentHostError("INVALID_PRIVATE_ASSET", "Solution and accepted answers are required");
	const expectedHash = contentHash({
		exerciseId: privateExercise.exerciseId,
		solution: privateExercise.solution,
		acceptedAnswers: privateExercise.acceptedAnswers,
		rubric: privateExercise.rubric,
	});
	if (privateExercise.contentHash !== expectedHash) throw new AssessmentHostError("PRIVATE_HASH_MISMATCH", "Private exercise content hash is invalid");
	const secretFragments = new Set([
		normalizeAnswer(privateExercise.solution),
		...privateExercise.acceptedAnswers.map(normalizeAnswer),
	].filter((item) => item.length >= 4));
	for (const [index, hint] of publicExercise.hints.entries()) {
		const normalizedHint = normalizeAnswer(hint);
		for (const secret of secretFragments) {
			if (normalizedHint.includes(secret)) throw new AssessmentHostError("SOLUTION_LEAK", `Hint ${index + 1} contains protected answer material`);
		}
	}
}

export class AssessmentHost {
	private readonly vault: SolutionVault;
	private readonly publicExercises = new Map<string, ExercisePublic>();
	private readonly instances = new Map<string, ExerciseInstance>();
	private readonly attempts = new Map<string, ExerciseAttempt>();
	private readonly evaluations = new Map<string, AttemptEvaluation>();
	private readonly capabilities = new Map<string, CapabilityState>();
	private readonly idempotency = new Map<string, Idempotent<unknown>>();

	constructor(vault: SolutionVault) {
		this.vault = vault;
	}

	registerExercise(publicExercise: ExercisePublic, privateExercise: ExercisePrivate): void {
		assertPublicPrivate(publicExercise, privateExercise);
		const existing = this.publicExercises.get(publicExercise.exerciseId);
		if (existing && stableStringify(existing) !== stableStringify(publicExercise)) {
			throw new AssessmentHostError("EXERCISE_REDEFINED", `Exercise ${publicExercise.exerciseId} already exists`);
		}
		this.publicExercises.set(publicExercise.exerciseId, Object.freeze({
			...publicExercise,
			conceptIds: [...publicExercise.conceptIds],
			hints: [...publicExercise.hints],
		}));
		this.vault.put(privateExercise);
	}

	issueExercise(
		exerciseId: string,
		binding: SessionBinding,
		snapshot: ResourceSnapshot,
		idempotencyKey: string,
		issuedAt = new Date().toISOString(),
	): ExerciseInstance {
		const exercise = this.getPublicExercise(exerciseId);
		assertBound(binding, snapshot, exercise.courseVersionId);
		if (snapshot.role !== "student" && snapshot.role !== "teacher") throw new AssessmentHostError("ROLE_DENIED", "Current role cannot issue exercises");
		if (!Number.isFinite(Date.parse(issuedAt))) throw new AssessmentHostError("INVALID_TIMESTAMP", "issuedAt must be ISO-8601");
		const identity = { exerciseId, courseVersionId: exercise.courseVersionId, sessionBindingId: binding.bindingId, issuedAt };
		const instance: ExerciseInstance = Object.freeze({
			instanceId: deterministicId("exercise-instance", identity, 32),
			exerciseId,
			courseVersionId: exercise.courseVersionId,
			sessionBindingId: binding.bindingId,
			issuedAt,
		});
		return this.commitIdempotent(idempotencyKey, { action: "issue", instance }, () => {
			this.instances.set(instance.instanceId, instance);
			return instance;
		});
	}

	requestHint(instanceId: string, level: number, binding: SessionBinding): string {
		const instance = this.getInstance(instanceId);
		if (instance.sessionBindingId !== binding.bindingId || instance.courseVersionId !== binding.courseVersionId) {
			throw new AssessmentHostError("INSTANCE_BINDING_MISMATCH", "Exercise instance belongs to another session");
		}
		const exercise = this.getPublicExercise(instance.exerciseId);
		if (!Number.isSafeInteger(level) || level < 1 || level > exercise.hints.length) {
			throw new AssessmentHostError("HINT_NOT_AVAILABLE", "Requested hint level is not available");
		}
		return exercise.hints[level - 1] as string;
	}

	submitAttempt(
		instanceId: string,
		answer: string,
		binding: SessionBinding,
		idempotencyKey: string,
		submittedAt = new Date().toISOString(),
	): ExerciseAttempt {
		const instance = this.getInstance(instanceId);
		if (instance.sessionBindingId !== binding.bindingId || instance.courseVersionId !== binding.courseVersionId) {
			throw new AssessmentHostError("INSTANCE_BINDING_MISMATCH", "Exercise instance belongs to another session");
		}
		if (!Number.isFinite(Date.parse(submittedAt))) throw new AssessmentHostError("INVALID_TIMESTAMP", "submittedAt must be ISO-8601");
		const normalized = answer.trim();
		const identity = { instanceId, bindingId: binding.bindingId, answerHash: `sha256:${sha256Hex(normalized)}`, submittedAt };
		const attempt: ExerciseAttempt = Object.freeze({
			attemptId: deterministicId("attempt", identity, 32),
			instanceId,
			exerciseId: instance.exerciseId,
			courseVersionId: instance.courseVersionId,
			sessionBindingId: binding.bindingId,
			answer: normalized,
			meaningful: meaningfulAttempt(normalized),
			submittedAt,
			revision: 1,
		});
		return this.commitIdempotent(idempotencyKey, { action: "attempt", attempt }, () => {
			this.attempts.set(attempt.attemptId, attempt);
			return attempt;
		});
	}

	evaluateAttempt(attemptId: string, createdAt = new Date().toISOString()): AttemptEvaluation {
		const attempt = this.getAttempt(attemptId);
		const secret = this.vault.get(attempt.exerciseId);
		if (!secret) throw new AssessmentHostError("PRIVATE_ASSET_UNAVAILABLE", "Private evaluation asset is unavailable");
		const answer = normalizeAnswer(attempt.answer);
		const correct = attempt.meaningful && secret.acceptedAnswers.some((candidate) => normalizeAnswer(candidate) === answer);
		const identity = { attemptId, correct, privateHash: secret.contentHash };
		const evaluation: AttemptEvaluation = Object.freeze({
			evaluationId: deterministicId("attempt-evaluation", identity, 32),
			attemptId,
			correct,
			feedback: attempt.meaningful
				? correct
					? "The attempt satisfies the accepted-answer check."
					: "The attempt is meaningful but does not yet satisfy the accepted-answer check. Review the hint ladder and revise your reasoning."
				: "Submit a concrete reasoning attempt before evaluation.",
			createdAt,
		});
		this.evaluations.set(evaluation.evaluationId, evaluation);
		return evaluation;
	}

	requestSolutionUnlock(
		attemptId: string,
		binding: SessionBinding,
		idempotencyKey: string,
		issuedAt = new Date().toISOString(),
		lifetimeMs = 5 * 60 * 1000,
	): SolutionCapability {
		const attempt = this.getAttempt(attemptId);
		if (attempt.sessionBindingId !== binding.bindingId || attempt.courseVersionId !== binding.courseVersionId) {
			throw new AssessmentHostError("ATTEMPT_BINDING_MISMATCH", "Attempt belongs to another session or course");
		}
		const exercise = this.getPublicExercise(attempt.exerciseId);
		if (exercise.unlockPolicy === "teacher-only" && binding.role !== "teacher") throw new AssessmentHostError("SOLUTION_LOCKED", "This solution is teacher-only");
		if (exercise.unlockPolicy === "after-meaningful-attempt" && !attempt.meaningful) throw new AssessmentHostError("MEANINGFUL_ATTEMPT_REQUIRED", "A meaningful attempt is required before solution access");
		if (exercise.unlockPolicy === "after-correct-attempt") {
			const evaluation = [...this.evaluations.values()].find((item) => item.attemptId === attemptId) ?? this.evaluateAttempt(attemptId, issuedAt);
			if (!evaluation.correct) throw new AssessmentHostError("CORRECT_ATTEMPT_REQUIRED", "A correct attempt is required before solution access");
		}
		if (!Number.isFinite(Date.parse(issuedAt)) || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 24 * 60 * 60 * 1000) {
			throw new AssessmentHostError("INVALID_CAPABILITY_LIFETIME", "Capability lifetime is invalid");
		}
		const expiresAt = new Date(Date.parse(issuedAt) + lifetimeMs).toISOString();
		const identity = { exerciseId: exercise.exerciseId, attemptId, courseVersionId: attempt.courseVersionId, sessionBindingId: binding.bindingId, issuedAt, expiresAt };
		const capability: SolutionCapability = Object.freeze({
			capabilityId: deterministicId("solution-capability", identity, 40),
			exerciseId: exercise.exerciseId,
			attemptId,
			courseVersionId: attempt.courseVersionId,
			sessionBindingId: binding.bindingId,
			issuedAt,
			expiresAt,
			remainingUses: 1,
			contentHash: contentHash(identity),
		});
		return this.commitIdempotent(idempotencyKey, { action: "unlock", capability }, () => {
			this.capabilities.set(capability.capabilityId, { value: capability, remainingUses: 1 });
			return capability;
		});
	}

	readSolution(capabilityId: string, binding: SessionBinding, at = new Date().toISOString()): string {
		const state = this.capabilities.get(capabilityId);
		if (!state) throw new AssessmentHostError("CAPABILITY_INVALID", "Solution capability is invalid");
		const capability = state.value;
		if (capability.sessionBindingId !== binding.bindingId || capability.courseVersionId !== binding.courseVersionId) {
			throw new AssessmentHostError("CAPABILITY_SCOPE_MISMATCH", "Solution capability belongs to another session or course");
		}
		if (Date.parse(at) > Date.parse(capability.expiresAt)) throw new AssessmentHostError("CAPABILITY_EXPIRED", "Solution capability expired");
		if (state.remainingUses < 1) throw new AssessmentHostError("CAPABILITY_CONSUMED", "Solution capability was already consumed");
		const attempt = this.getAttempt(capability.attemptId);
		if (attempt.exerciseId !== capability.exerciseId) throw new AssessmentHostError("CAPABILITY_CORRUPT", "Capability exercise identity is inconsistent");
		const secret = this.vault.get(capability.exerciseId);
		if (!secret) throw new AssessmentHostError("PRIVATE_ASSET_UNAVAILABLE", "Private solution asset is unavailable");
		state.remainingUses -= 1;
		return secret.solution;
	}

	listPublicExercises(courseVersionId: string): ExercisePublic[] {
		return [...this.publicExercises.values()].filter((item) => item.courseVersionId === courseVersionId);
	}

	getPublicExercise(exerciseId: string): ExercisePublic {
		const exercise = this.publicExercises.get(exerciseId);
		if (!exercise) throw new AssessmentHostError("UNKNOWN_EXERCISE", `Unknown exercise ${exerciseId}`);
		return exercise;
	}

	getAttemptById(attemptId: string): ExerciseAttempt {
		return this.getAttempt(attemptId);
	}

	getCapabilityRemainingUses(capabilityId: string): number {
		const state = this.capabilities.get(capabilityId);
		if (!state) throw new AssessmentHostError("CAPABILITY_INVALID", "Solution capability is invalid");
		return state.remainingUses;
	}

	exportPublicState(): AssessmentPublicState {
		return {
			version: 1,
			publicExercises: [...this.publicExercises.values()],
			instances: [...this.instances.values()],
			attempts: [...this.attempts.values()],
			evaluations: [...this.evaluations.values()],
			capabilities: [...this.capabilities.values()].map((state) => ({ value: state.value, remainingUses: state.remainingUses })),
			idempotency: [...this.idempotency.entries()].map(([key, item]) => ({ key, fingerprint: item.fingerprint, value: item.value })),
		};
	}

	exportPrivateState(): AssessmentPrivateState {
		const vault = this.vault as Partial<StatefulSolutionVault>;
		if (typeof vault.exportState !== "function") throw new AssessmentHostError("VAULT_NOT_EXPORTABLE", "Solution vault does not support state export");
		return { version: 1, solutions: vault.exportState() };
	}

	restorePrivateState(state: AssessmentPrivateState): void {
		if (!state || state.version !== 1 || !Array.isArray(state.solutions)) throw new AssessmentHostError("INVALID_STATE", "Invalid private assessment state");
		const vault = this.vault as Partial<StatefulSolutionVault>;
		if (typeof vault.restoreState !== "function") throw new AssessmentHostError("VAULT_NOT_RESTORABLE", "Solution vault does not support state restore");
		vault.restoreState(state.solutions);
	}

	restorePublicState(state: AssessmentPublicState): void {
		if (!state || state.version !== 1 || !Array.isArray(state.publicExercises) || !Array.isArray(state.instances) || !Array.isArray(state.attempts) || !Array.isArray(state.evaluations) || !Array.isArray(state.capabilities) || !Array.isArray(state.idempotency)) {
			throw new AssessmentHostError("INVALID_STATE", "Invalid public assessment state");
		}
		if (this.publicExercises.size || this.instances.size || this.attempts.size || this.evaluations.size || this.capabilities.size || this.idempotency.size) {
			throw new AssessmentHostError("STATE_NOT_EMPTY", "AssessmentHost restore requires an empty host");
		}
		for (const exercise of state.publicExercises) {
			const secret = this.vault.get(exercise.exerciseId);
			if (!secret) throw new AssessmentHostError("PRIVATE_ASSET_UNAVAILABLE", `Missing private asset for ${exercise.exerciseId}`);
			assertPublicPrivate(exercise, secret);
			this.publicExercises.set(exercise.exerciseId, Object.freeze({ ...exercise, conceptIds: [...exercise.conceptIds], hints: [...exercise.hints] }));
		}
		for (const instance of state.instances) {
			const exercise = this.publicExercises.get(instance.exerciseId);
			if (!exercise || exercise.courseVersionId !== instance.courseVersionId) throw new AssessmentHostError("CORRUPT_INSTANCE", `Invalid instance ${instance.instanceId}`);
			this.instances.set(instance.instanceId, Object.freeze({ ...instance }));
		}
		for (const attempt of state.attempts) {
			const instance = this.instances.get(attempt.instanceId);
			if (!instance || instance.exerciseId !== attempt.exerciseId || instance.courseVersionId !== attempt.courseVersionId || instance.sessionBindingId !== attempt.sessionBindingId) {
				throw new AssessmentHostError("CORRUPT_ATTEMPT", `Invalid attempt ${attempt.attemptId}`);
			}
			if (attempt.meaningful !== meaningfulAttempt(attempt.answer)) throw new AssessmentHostError("CORRUPT_ATTEMPT", `Attempt ${attempt.attemptId} has an invalid meaningful flag`);
			this.attempts.set(attempt.attemptId, Object.freeze({ ...attempt }));
		}
		for (const evaluation of state.evaluations) {
			if (!this.attempts.has(evaluation.attemptId)) throw new AssessmentHostError("CORRUPT_EVALUATION", `Invalid evaluation ${evaluation.evaluationId}`);
			this.evaluations.set(evaluation.evaluationId, Object.freeze({ ...evaluation }));
		}
		for (const capabilityState of state.capabilities) {
			const capability = capabilityState.value;
			const attempt = this.attempts.get(capability.attemptId);
			if (!attempt || attempt.exerciseId !== capability.exerciseId || attempt.courseVersionId !== capability.courseVersionId || attempt.sessionBindingId !== capability.sessionBindingId) {
				throw new AssessmentHostError("CORRUPT_CAPABILITY", `Invalid capability ${capability.capabilityId}`);
			}
			if (!Number.isSafeInteger(capabilityState.remainingUses) || capabilityState.remainingUses < 0 || capabilityState.remainingUses > 1) {
				throw new AssessmentHostError("CORRUPT_CAPABILITY", `Invalid use count for ${capability.capabilityId}`);
			}
			this.capabilities.set(capability.capabilityId, { value: Object.freeze({ ...capability }), remainingUses: capabilityState.remainingUses });
		}
		for (const item of state.idempotency) {
			if (!item.key || this.idempotency.has(item.key)) throw new AssessmentHostError("CORRUPT_IDEMPOTENCY", "Invalid idempotency state");
			this.idempotency.set(item.key, { fingerprint: item.fingerprint, value: item.value });
		}
	}

	private getInstance(instanceId: string): ExerciseInstance {
		const instance = this.instances.get(instanceId);
		if (!instance) throw new AssessmentHostError("UNKNOWN_INSTANCE", `Unknown exercise instance ${instanceId}`);
		return instance;
	}

	private getAttempt(attemptId: string): ExerciseAttempt {
		const attempt = this.attempts.get(attemptId);
		if (!attempt) throw new AssessmentHostError("UNKNOWN_ATTEMPT", `Unknown attempt ${attemptId}`);
		return attempt;
	}

	private commitIdempotent<T>(key: string, request: unknown, action: () => T): T {
		if (!key) throw new AssessmentHostError("IDEMPOTENCY_REQUIRED", "idempotencyKey is required");
		const fingerprint = stableStringify(request);
		const existing = this.idempotency.get(key);
		if (existing) {
			if (existing.fingerprint !== fingerprint) throw new AssessmentHostError("IDEMPOTENCY_REUSE", `Idempotency key ${key} was reused`);
			return existing.value as T;
		}
		const value = action();
		this.idempotency.set(key, { fingerprint, value });
		return value;
	}
}

export function createExercisePrivate(
	exerciseId: string,
	solution: string,
	acceptedAnswers: string[],
	rubric: string,
): ExercisePrivate {
	const payload = { exerciseId, solution, acceptedAnswers, rubric };
	return { ...payload, contentHash: contentHash(payload) };
}
