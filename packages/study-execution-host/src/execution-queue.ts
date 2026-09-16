import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import {
	type FrozenResearchTaskAuthorization,
	type ReserveStudyTaskInput,
	type RunManifest,
	requiredRevision,
	requiredText,
	type Scope,
	StudyResearchError,
	type StudyResearchHost,
	type StudyTask,
	type StudyTaskAdmission,
	validateManifest,
} from "../../study-research-host/src/index.ts";

export type ExecutionQueueStatus =
	| "queued"
	| "admitted"
	| "prepared"
	| "launching"
	| "running"
	| "reconciling"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "limit-reached"
	| "needs-input";

export interface ExecutionResourceRequest {
	cpuMilliCores: number;
	memoryMiB: number;
	wallTimeMs: number;
	diskBytes: number;
}

export interface ExecutionScopeQuota {
	maxRuns: number;
	maxCumulativeWallTimeMs: number;
	maxCumulativeDiskBytes: number;
	expiresAt: string | null;
}

export interface ExecutionQueuePolicyInput {
	maxConcurrentRuns: number;
	maxCpuMilliCores: number;
	maxMemoryMiB: number;
	leaseDurationMs: number;
}

export interface ExecutionQueuePolicy extends ExecutionQueuePolicyInput {
	revision: number;
	configuredAt: string;
}

/**
 * A trusted execution adapter owns the concrete payload. The queue stores the complete
 * `privateHandle` only for a claimed coordinator, and exposes only `publicSummary`.
 * `kind` prevents a future Pi task adapter from being confused with a native runner.
 */
export interface PreparedExecutionHandle {
	kind: string;
	version: number;
	privateHandle: Record<string, unknown>;
	publicSummary: Record<string, unknown>;
}

/** Safe for API/UI output. Adapter secrets belong solely in the private handle. */
export interface PreparedExecutionHandleSummary {
	kind: string;
	version: number;
	publicSummary: Record<string, unknown>;
}

export interface ExecutionQueueJob {
	queueJobId: string;
	/** Globally monotonic enqueue order; it makes claim selection deterministic across projects. */
	enqueueOrder: number;
	projectId: string;
	sessionId: string;
	taskId: string;
	dispatchKey: string;
	dispatchFingerprint: string;
	mode: "study" | "research";
	manifest: RunManifest;
	resources: ExecutionResourceRequest;
	quota: ExecutionScopeQuota;
	status: ExecutionQueueStatus;
	hostTaskRevision: number;
	claimOwner: string | null;
	claimRevision: number;
	leaseExpiresAt: string | null;
	cancellationRequestedAt: string | null;
	preparedHandle: PreparedExecutionHandleSummary | null;
	actualUsage: ExecutionUsage | null;
	admissionFailure: QueueAdmissionFailure | null;
	createdAt: string;
	updatedAt: string;
}

/** Durable, redacted explanation for a queued job that can never be admitted as configured. */
export interface QueueAdmissionFailure {
	code: string;
	message: string;
	coordinatorId: string;
	occurredAt: string;
}

export interface ExecutionUsage {
	wallTimeMs: number;
	diskBytes: number;
}

export interface QueueClaim {
	job: ExecutionQueueJob;
	leaseExpiresAt: string;
}

export interface PreparedLaunchLease {
	job: ExecutionQueueJob;
	handle: PreparedExecutionHandle;
}

export interface StudyExecutionRequest {
	/** Learning task kind; omitted only for the original execution-only callers. */
	kind?: ReserveStudyTaskInput["kind"];
	target?: ReserveStudyTaskInput["target"];
	dispatchKey: string;
	manifest: RunManifest;
	admission: StudyTaskAdmission;
	producerContextId: string;
	resources: ExecutionResourceRequest;
	quota: ExecutionScopeQuota;
}

export interface ResearchExecutionRequest {
	planId: string;
	grantId: string;
	expectedPlanRevision: number;
	dispatchKey: string;
	manifest: RunManifest;
	producerContextId: string;
	resources: ExecutionResourceRequest;
	quota: ExecutionScopeQuota;
}

export interface TerminalReceipt {
	jobId: string;
	claimOwner: string;
	expectedClaimRevision: number;
	status: Extract<ExecutionQueueStatus, "succeeded" | "failed" | "cancelled" | "limit-reached">;
	usage: ExecutionUsage;
}

interface InternalExecutionQueueJob extends ExecutionQueueJob {
	/** Trusted producer provenance stays in durable queue storage and is never returned in queue DTOs. */
	producerContextId: string;
}

interface PayloadRow {
	payload: string;
	payloadHash: string;
}

interface PreparedRow {
	privateHandle: string;
	payloadHash: string;
}

interface ResourceReservation {
	jobId: string;
	scopeKey: string;
	resources: ExecutionResourceRequest;
	releasedAt: string | null;
}

interface ScopeUsage {
	scopeKey: string;
	quota: ExecutionScopeQuota;
	runs: number;
	reservedWallTimeMs: number;
	consumedWallTimeMs: number;
	reservedDiskBytes: number;
	consumedDiskBytes: number;
}

interface JobRecord {
	job: InternalExecutionQueueJob;
	research: {
		planId: string;
		grantId: string;
		expectedPlanRevision: number;
	} | null;
}

export interface StudyExecutionQueueOptions {
	clock?: () => Date;
	/** Trusted shared-database fence, called inside the admission transaction. Existing jobs still reconcile/cancel. */
	canClaimNewExecution?: () => boolean;
}

/**
 * Durable scheduler state only. Execution preparation, launch, reconciliation, and cancellation
 * are deliberately separate coordinator calls; this class never imports or starts a runner.
 */
export class StudyExecutionQueue {
	private readonly database: DatabaseSync;
	private readonly host: StudyResearchHost;
	private readonly clock: () => Date;
	private readonly canClaimNewExecution: (() => boolean) | undefined;

	constructor(database: DatabaseSync, host: StudyResearchHost, options: StudyExecutionQueueOptions = {}) {
		this.database = database;
		this.host = host;
		this.clock = options.clock ?? (() => new Date());
		this.canClaimNewExecution = options.canClaimNewExecution;
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_execution_policy (
				policy_key TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_job (
				queue_job_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				task_id TEXT NOT NULL UNIQUE,
				dispatch_key TEXT NOT NULL,
				status TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL,
				UNIQUE(project_id, dispatch_key)
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_prepared (
				queue_job_id TEXT PRIMARY KEY,
				private_handle TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_resource (
				queue_job_id TEXT PRIMARY KEY,
				scope_key TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_scope_usage (
				scope_key TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_counter (
				counter_key TEXT PRIMARY KEY,
				value INTEGER NOT NULL
			);
		`);
	}

	/** Called only by the trusted composition root after safe defaults were actually detected. */
	configureTrustedPolicy(input: ExecutionQueuePolicyInput, expectedRevision: number): ExecutionQueuePolicy {
		const policy = this.validatePolicy(input);
		return this.transaction(() => {
			const current = this.readPolicyOrNull();
			const currentRevision = current?.revision ?? 0;
			if (currentRevision !== expectedRevision) {
				throw new StudyResearchError("QUEUE_POLICY_CONFLICT", "queue policy changed before saving");
			}
			const saved: ExecutionQueuePolicy = {
				...policy,
				revision: currentRevision + 1,
				configuredAt: this.timestamp(),
			};
			this.savePayload("pi_study_execution_policy", "policy_key", "global", saved);
			return this.copy(saved);
		});
	}

	getPolicy(): ExecutionQueuePolicy | null {
		const policy = this.readPolicyOrNull();
		return policy ? this.copy(policy) : null;
	}

	enqueueStudy(scope: Scope, request: StudyExecutionRequest): { job: ExecutionQueueJob; replay: boolean } {
		const valid = this.validateStudyRequest(request);
		return this.transaction(() => {
			const fingerprint = contentHash({ mode: "study", ...valid });
			const existing = this.readJobByDispatch(scope.projectId, valid.dispatchKey);
			if (existing) return this.replayOrReject(existing, scope, fingerprint);
			const reservation = this.host.reserveStudyTask(scope, {
				dispatchKey: valid.dispatchKey,
				kind: valid.kind ?? "execution",
				target: valid.target,
				manifest: valid.manifest,
				admission: valid.admission,
				producerContextId: valid.producerContextId,
			});
			this.assertExecutionProducer(reservation.task.producerContextId, valid.producerContextId);
			this.assertStudyResourcesWithinFrozenAdmission(reservation.task, valid.resources);
			const job = this.makeJob(
				reservation.task,
				scope,
				fingerprint,
				valid.resources,
				valid.quota,
				reservation.task.authorization.phase,
			);
			const record: JobRecord = { job, research: null };
			this.materializeScopeQuota(record);
			this.saveJob(record);
			return { job: this.publicJob(job), replay: reservation.replay };
		});
	}

	enqueueResearch(scope: Scope, request: ResearchExecutionRequest): { job: ExecutionQueueJob; replay: boolean } {
		const valid = this.validateResearchRequest(request);
		return this.transaction(() => {
			this.assertUnambiguousResearchDependencies(scope, valid.planId, valid.expectedPlanRevision, valid.grantId);
			const fingerprint = contentHash({ mode: "research", ...valid });
			const existing = this.readJobByDispatch(scope.projectId, valid.dispatchKey);
			if (existing) return this.replayOrReject(existing, scope, fingerprint);
			const reservation = this.host.reserveTask(scope, {
				planId: valid.planId,
				grantId: valid.grantId,
				expectedPlanRevision: valid.expectedPlanRevision,
				dispatchKey: valid.dispatchKey,
				kind: "execution",
				manifest: valid.manifest,
				producerContextId: valid.producerContextId,
			});
			this.assertExecutionProducer(reservation.task.producerContextId, valid.producerContextId);
			const job = this.makeJob(reservation.task, scope, fingerprint, valid.resources, valid.quota, "research");
			const record: JobRecord = {
				job,
				research: {
					planId: valid.planId,
					grantId: valid.grantId,
					expectedPlanRevision: valid.expectedPlanRevision,
				},
			};
			this.materializeScopeQuota(record);
			this.saveJob(record);
			return { job: this.publicJob(job), replay: reservation.replay };
		});
	}

	/** Claim and admission are one BEGIN IMMEDIATE transaction, including Host queued -> admitted and resource reservation. */
	claimNext(coordinatorId: string): QueueClaim | null {
		requiredText(coordinatorId, "coordinatorId", 256);
		return this.transaction(() => {
			const policy = this.readPolicy();
			for (const record of this.claimCandidates()) {
				if (record.job.status === "queued") {
					if (this.canClaimNewExecution && !this.canClaimNewExecution()) continue;
					try {
						this.inSavepoint(() => this.admitQueuedRecord(policy, record));
					} catch (error) {
						if (this.isPermanentAdmissionError(error)) {
							this.markNeedsInput(record, coordinatorId, error);
							continue;
						}
						if (error instanceof StudyResearchError && error.code === "QUEUE_RESOURCE_UNAVAILABLE") continue;
						throw error;
					}
				}
				this.assignClaim(record.job, coordinatorId, policy.leaseDurationMs);
				this.saveJob(record);
				return { job: this.publicJob(record.job), leaseExpiresAt: record.job.leaseExpiresAt ?? "" };
			}
			return null;
		});
	}

	private admitQueuedRecord(policy: ExecutionQueuePolicy, record: JobRecord): void {
		if (record.research) this.revalidateQueuedResearch(record);
		const task = this.readHostTask(record.job);
		if (task.status !== "queued" || task.revision !== record.job.hostTaskRevision) {
			throw new StudyResearchError("QUEUE_HOST_TASK_CONFLICT", "Host task changed before queue admission");
		}
		this.reserveResources(policy, record);
		const admitted = this.host.transitionTaskFromFrozenAuthorization({
			taskId: task.taskId,
			expectedTaskRevision: task.revision,
			nextStatus: "admitted",
			detail: "admitted by durable execution queue",
		});
		record.job.status = "admitted";
		record.job.hostTaskRevision = admitted.revision;
	}

	heartbeat(jobId: string, coordinatorId: string, expectedClaimRevision: number): ExecutionQueueJob {
		return this.transaction(() => {
			const policy = this.readPolicy();
			const record = this.readJob(jobId);
			if (this.isTerminal(record.job.status))
				throw new StudyResearchError("QUEUE_STATE_CONFLICT", "terminal jobs cannot renew coordinator leases");
			this.assertClaim(record.job, coordinatorId, expectedClaimRevision);
			this.assignClaim(record.job, coordinatorId, policy.leaseDurationMs);
			this.saveJob(record);
			return this.publicJob(record.job);
		});
	}

	/** Persist the adapter's pure preparation identity before any filesystem work can occur. */
	persistPreparationIntent(
		jobId: string,
		coordinatorId: string,
		expectedClaimRevision: number,
		handle: PreparedExecutionHandle,
	): PreparedLaunchLease {
		const valid = this.validatePreparedHandle(handle);
		return this.transaction(() => {
			const record = this.readJob(jobId);
			this.assertClaim(record.job, coordinatorId, expectedClaimRevision);
			if (record.job.status !== "admitted" || record.job.cancellationRequestedAt !== null)
				throw new StudyResearchError("QUEUE_STATE_CONFLICT", "Only an active admission may start preparation");
			if (record.job.preparedHandle !== null)
				throw new StudyResearchError("QUEUE_STATE_CONFLICT", "Preparation identity is already durable");
			this.savePrivateHandle(jobId, valid);
			record.job.preparedHandle = this.handleSummary(valid);
			this.saveJob(record);
			return { job: this.publicJob(record.job), handle: valid };
		});
	}

	readPreparationIntent(
		jobId: string,
		coordinatorId: string,
		expectedClaimRevision: number,
	): PreparedExecutionHandle | null {
		const record = this.readJob(jobId);
		this.assertClaim(record.job, coordinatorId, expectedClaimRevision);
		if (record.job.status !== "admitted")
			throw new StudyResearchError("QUEUE_STATE_CONFLICT", "Only an admission can read its preparation identity");
		return record.job.preparedHandle === null ? null : this.readPrivateHandle(jobId);
	}

	/** An unstarted task may fail. Charge measured preparation/cleanup before releasing its reservation. */
	recordPrelaunchFailure(input: {
		jobId: string;
		claimOwner: string;
		expectedClaimRevision: number;
		usage: ExecutionUsage;
		message: string;
	}): ExecutionQueueJob {
		const usage = this.validateUsage(input.usage);
		requiredText(input.message, "prelaunch failure", 20000);
		return this.transaction(() => {
			const record = this.readJob(input.jobId);
			this.assertClaim(record.job, input.claimOwner, input.expectedClaimRevision);
			if (record.job.status !== "admitted" && record.job.status !== "prepared")
				throw new StudyResearchError(
					"QUEUE_STATE_CONFLICT",
					"Prelaunch failure cannot settle a possibly running process",
				);
			const task = this.readHostTask(record.job);
			if (task.status !== "admitted" || task.revision !== record.job.hostTaskRevision)
				throw new StudyResearchError("QUEUE_HOST_TASK_CONFLICT", "Task changed before prelaunch failure");
			const status = record.job.cancellationRequestedAt === null ? "failed" : "cancelled";
			const settlement = this.releaseReservation(record.job, usage, status);
			const terminal = this.host.transitionTaskFromFrozenAuthorization({
				taskId: task.taskId,
				expectedTaskRevision: task.revision,
				nextStatus: status,
				detail: `prelaunch ${status}: ${input.message}; usage=${stableStringify(usage)}; exceeded=${settlement.exceeded.join(",") || "none"}`,
			});
			record.job.status = status;
			record.job.hostTaskRevision = terminal.revision;
			record.job.actualUsage = usage;
			record.job.claimOwner = null;
			record.job.leaseExpiresAt = null;
			record.job.updatedAt = this.timestamp();
			this.saveJob(record);
			return this.publicJob(record.job);
		});
	}

	/** Persisted before launch; it never starts a native process. */
	persistPreparedHandle(
		jobId: string,
		coordinatorId: string,
		expectedClaimRevision: number,
		handle: PreparedExecutionHandle,
	): ExecutionQueueJob {
		const valid = this.validatePreparedHandle(handle);
		return this.transaction(() => {
			const record = this.readJob(jobId);
			this.assertClaim(record.job, coordinatorId, expectedClaimRevision);
			if (record.job.status !== "admitted") {
				throw new StudyResearchError(
					"QUEUE_STATE_CONFLICT",
					"only an admitted job can persist a prepared execution handle",
				);
			}
			// Even a cancellation arriving during prepare must retain the final cleanup handle.
			this.savePrivateHandle(jobId, valid);
			record.job.status = "prepared";
			record.job.preparedHandle = this.handleSummary(valid);
			record.job.updatedAt = this.timestamp();
			this.saveJob(record);
			return this.publicJob(record.job);
		});
	}

	/** Returns the private handle only to the trusted detached coordinator after durable launch state is committed. */
	beginPreparedLaunch(jobId: string, coordinatorId: string, expectedClaimRevision: number): PreparedLaunchLease {
		return this.transaction(() => {
			const record = this.readJob(jobId);
			this.assertClaim(record.job, coordinatorId, expectedClaimRevision);
			if (record.job.status !== "prepared") {
				throw new StudyResearchError("QUEUE_STATE_CONFLICT", "only a prepared job may begin execution launch");
			}
			if (record.job.cancellationRequestedAt !== null) {
				throw new StudyResearchError("QUEUE_CANCELLED", "cancelled admission cannot launch");
			}
			const task = this.readHostTask(record.job);
			if (task.status !== "admitted" || task.revision !== record.job.hostTaskRevision) {
				throw new StudyResearchError("QUEUE_HOST_TASK_CONFLICT", "Host task changed before native launch");
			}
			const launching = this.host.transitionTaskFromFrozenAuthorization({
				taskId: task.taskId,
				expectedTaskRevision: task.revision,
				nextStatus: "launching",
				detail: "prepared execution handle durably committed before launch",
			});
			record.job.status = "launching";
			record.job.hostTaskRevision = launching.revision;
			record.job.updatedAt = this.timestamp();
			this.saveJob(record);
			return { job: this.publicJob(record.job), handle: this.readPrivateHandle(jobId) };
		});
	}

	/**
	 * A prepared cancellation never discards the private adapter handle: the claimed coordinator needs
	 * it to clean up preparation artifacts and report measured cleanup usage without launching a process.
	 */
	acquirePreparedCancellation(
		jobId: string,
		coordinatorId: string,
		expectedClaimRevision: number,
	): PreparedLaunchLease {
		return this.transaction(() => {
			const record = this.readJob(jobId);
			this.assertClaim(record.job, coordinatorId, expectedClaimRevision);
			if (record.job.status !== "prepared" || record.job.cancellationRequestedAt === null) {
				throw new StudyResearchError(
					"QUEUE_STATE_CONFLICT",
					"only a cancellation-requested prepared job can expose its cleanup handle",
				);
			}
			return { job: this.publicJob(record.job), handle: this.readPrivateHandle(jobId) };
		});
	}

	confirmRunning(
		jobId: string,
		coordinatorId: string,
		expectedClaimRevision: number,
		executionEvidence: string,
	): ExecutionQueueJob {
		requiredText(executionEvidence, "executionEvidence", 20_000);
		return this.transaction(() => {
			const record = this.readJob(jobId);
			this.assertClaim(record.job, coordinatorId, expectedClaimRevision);
			if (record.job.status !== "launching" && record.job.status !== "reconciling") {
				throw new StudyResearchError(
					"QUEUE_STATE_CONFLICT",
					"only launching or reconciling jobs can confirm running",
				);
			}
			if (record.job.cancellationRequestedAt !== null) {
				throw new StudyResearchError("QUEUE_CANCELLED", "a cancellation request prevents a running confirmation");
			}
			const task = this.readHostTask(record.job);
			if (task.revision !== record.job.hostTaskRevision)
				throw new StudyResearchError("QUEUE_HOST_TASK_CONFLICT", "Host task changed before running receipt");
			const running = this.host.transitionTaskFromFrozenAuthorization({
				taskId: task.taskId,
				expectedTaskRevision: task.revision,
				nextStatus: "running",
				detail: `execution runner confirmed running: ${executionEvidence.trim()}`,
			});
			record.job.status = "running";
			record.job.hostTaskRevision = running.revision;
			record.job.updatedAt = this.timestamp();
			this.saveJob(record);
			return this.publicJob(record.job);
		});
	}

	requestCancellation(jobId: string): ExecutionQueueJob {
		return this.transaction(() => {
			const record = this.readJob(jobId);
			if (this.isTerminal(record.job.status)) return this.publicJob(record.job);
			if (record.job.cancellationRequestedAt !== null) return this.publicJob(record.job);
			record.job.cancellationRequestedAt = this.timestamp();
			if (
				record.job.status === "queued" ||
				(record.job.status === "admitted" && record.job.preparedHandle === null) ||
				record.job.status === "needs-input"
			) {
				const task = this.readHostTask(record.job);
				if (task.revision !== record.job.hostTaskRevision)
					throw new StudyResearchError("QUEUE_HOST_TASK_CONFLICT", "Host task changed before cancellation");
				const cancelled = this.host.transitionTaskFromFrozenAuthorization({
					taskId: task.taskId,
					expectedTaskRevision: task.revision,
					nextStatus: "cancelled",
					detail: "cancellation requested before native launch",
				});
				record.job.status = "cancelled";
				record.job.hostTaskRevision = cancelled.revision;
				record.job.claimOwner = null;
				record.job.leaseExpiresAt = null;
				if (task.status === "admitted")
					this.releaseReservation(record.job, { wallTimeMs: 0, diskBytes: 0 }, "cancelled");
			}
			record.job.updatedAt = this.timestamp();
			this.saveJob(record);
			return this.publicJob(record.job);
		});
	}

	recordTerminalReceipt(input: TerminalReceipt): ExecutionQueueJob {
		const usage = this.validateUsage(input.usage);
		return this.transaction(() => {
			const record = this.readJob(input.jobId);
			this.assertClaim(record.job, input.claimOwner, input.expectedClaimRevision);
			const wasPreparedCancellation =
				record.job.status === "prepared" && record.job.cancellationRequestedAt !== null;
			if (!["launching", "running", "reconciling"].includes(record.job.status) && !wasPreparedCancellation) {
				throw new StudyResearchError(
					"QUEUE_STATE_CONFLICT",
					"terminal receipts require running, an unambiguous launch failure/cancellation, or prepared cancellation cleanup",
				);
			}
			const requestedStatus = record.job.cancellationRequestedAt === null ? input.status : "cancelled";
			const task = this.readHostTask(record.job);
			const settlement = this.releaseReservation(record.job, usage, requestedStatus);
			// Cleanup consumes resources even when execution never started. Preserve the true
			// failure/cancellation outcome while charging and recording every overrun.
			const terminal =
				task.status !== "running" && (requestedStatus === "failed" || requestedStatus === "cancelled")
					? requestedStatus
					: settlement.status;
			if (task.revision !== record.job.hostTaskRevision)
				throw new StudyResearchError("QUEUE_HOST_TASK_CONFLICT", "Host task changed before terminal receipt");
			if (wasPreparedCancellation) {
				if (terminal !== "cancelled" || task.status !== "admitted") {
					throw new StudyResearchError(
						"QUEUE_STATE_CONFLICT",
						"prepared cancellation cleanup may only record a cancelled terminal receipt",
					);
				}
			} else if (task.status !== "running" && terminal !== "failed" && terminal !== "cancelled") {
				throw new StudyResearchError(
					"QUEUE_RUNNING_EVIDENCE_REQUIRED",
					"successful and limit-reached receipts require a prior positive running confirmation",
				);
			}
			const completed = this.host.transitionTaskFromFrozenAuthorization({
				taskId: task.taskId,
				expectedTaskRevision: task.revision,
				nextStatus: terminal,
				detail: `execution runner terminal receipt: ${terminal}; usage=${stableStringify(usage)}; exceeded=${settlement.exceeded.join(",") || "none"}`,
			});
			record.job.status = terminal;
			record.job.hostTaskRevision = completed.revision;
			record.job.actualUsage = usage;
			record.job.claimOwner = null;
			record.job.leaseExpiresAt = null;
			record.job.updatedAt = this.timestamp();
			this.saveJob(record);
			return this.publicJob(record.job);
		});
	}

	/** Expired launching/running jobs become explicit reconciliation work; this never returns them to queued. */
	reconcileExpired(): ExecutionQueueJob[] {
		return this.transaction(() => {
			const now = this.clock().getTime();
			const reconciled: ExecutionQueueJob[] = [];
			for (const record of this.listRecords()) {
				if (!["launching", "running"].includes(record.job.status) || !this.isLeaseExpired(record.job, now))
					continue;
				const task = this.readHostTask(record.job);
				if (task.revision !== record.job.hostTaskRevision)
					throw new StudyResearchError("QUEUE_HOST_TASK_CONFLICT", "Host task changed before reconciliation");
				const next = this.host.transitionTaskFromFrozenAuthorization({
					taskId: task.taskId,
					expectedTaskRevision: task.revision,
					nextStatus: "reconciling",
					detail: "launch lease expired; execution receipt must be reconciled before another action",
				});
				record.job.status = "reconciling";
				record.job.hostTaskRevision = next.revision;
				record.job.claimOwner = null;
				record.job.leaseExpiresAt = null;
				record.job.updatedAt = this.timestamp();
				this.saveJob(record);
				reconciled.push(this.publicJob(record.job));
			}
			return reconciled;
		});
	}

	/** Obtains a fresh lease and the private handle solely for receipt reconciliation; it cannot launch the handle. */
	acquireReconciliation(jobId: string, coordinatorId: string): PreparedLaunchLease {
		requiredText(coordinatorId, "coordinatorId", 256);
		return this.transaction(() => {
			const policy = this.readPolicy();
			const record = this.readJob(jobId);
			if (record.job.status !== "reconciling")
				throw new StudyResearchError("QUEUE_STATE_CONFLICT", "job is not awaiting reconciliation");
			if (record.job.claimOwner !== null && !this.isLeaseExpired(record.job, this.clock().getTime())) {
				throw new StudyResearchError("QUEUE_CLAIM_CONFLICT", "another coordinator owns reconciliation");
			}
			this.assignClaim(record.job, coordinatorId, policy.leaseDurationMs);
			this.saveJob(record);
			return { job: this.publicJob(record.job), handle: this.readPrivateHandle(jobId) };
		});
	}

	getJob(jobId: string): ExecutionQueueJob {
		return this.publicJob(this.readJob(jobId).job);
	}

	/** Backend-only output reader capability. Never serialize this private handle into an API response. */
	getTerminalHandleForTrustedRead(scope: Scope, jobId: string): PreparedExecutionHandle | null {
		this.host.projectRevision(scope);
		const record = this.readJob(jobId);
		if (record.job.projectId !== scope.projectId)
			throw new StudyResearchError("QUEUE_SCOPE_CONFLICT", "Execution belongs to another project");
		this.readHostTask(record.job);
		if (!this.isTerminal(record.job.status))
			throw new StudyResearchError("QUEUE_STATE_CONFLICT", "Execution output is not yet settled");
		return record.job.preparedHandle === null ? null : this.readPrivateHandle(jobId);
	}

	listJobs(projectId: string): ExecutionQueueJob[] {
		requiredText(projectId, "projectId", 128);
		return this.listRecords()
			.filter((record) => record.job.projectId === projectId)
			.map((record) => this.publicJob(record.job));
	}

	private makeJob(
		task: {
			taskId: string;
			projectId: string;
			dispatchKey: string;
			manifest: RunManifest;
			revision: number;
			producerContextId: string | null;
		},
		scope: Scope,
		dispatchFingerprint: string,
		resources: ExecutionResourceRequest,
		quota: ExecutionScopeQuota,
		mode: "study" | "research",
	): InternalExecutionQueueJob {
		return {
			queueJobId: this.newId("queue-job"),
			enqueueOrder: this.nextEnqueueOrder(),
			projectId: task.projectId,
			sessionId: scope.sessionId,
			taskId: task.taskId,
			dispatchKey: task.dispatchKey,
			dispatchFingerprint,
			mode,
			manifest: this.copy(task.manifest),
			resources: this.copy(resources),
			quota: this.copy(quota),
			status: "queued",
			hostTaskRevision: task.revision,
			producerContextId: task.producerContextId ?? "",
			claimOwner: null,
			claimRevision: 0,
			leaseExpiresAt: null,
			cancellationRequestedAt: null,
			preparedHandle: null,
			actualUsage: null,
			admissionFailure: null,
			createdAt: this.timestamp(),
			updatedAt: this.timestamp(),
		};
	}

	private replayOrReject(
		record: JobRecord,
		scope: Scope,
		fingerprint: string,
	): { job: ExecutionQueueJob; replay: boolean } {
		if (record.job.sessionId !== scope.sessionId) {
			throw new StudyResearchError(
				"QUEUE_IDEMPOTENCY_CONFLICT",
				"dispatch key belongs to a different session scope",
			);
		}
		if (record.job.dispatchFingerprint !== fingerprint)
			throw new StudyResearchError(
				"QUEUE_IDEMPOTENCY_CONFLICT",
				"dispatch key was reused with changed queue payload",
			);
		return { job: this.publicJob(record.job), replay: true };
	}

	private assertExecutionProducer(actual: string | null, expected: string): void {
		if (actual === null || actual !== expected)
			throw new StudyResearchError(
				"QUEUE_TRUSTED_PRODUCER_REQUIRED",
				"Host did not freeze the trusted execution producer context",
			);
	}

	private assertStudyResourcesWithinFrozenAdmission(task: StudyTask, resources: ExecutionResourceRequest): void {
		if (task.authorization.kind !== "learning") {
			throw new StudyResearchError(
				"QUEUE_STUDY_LIMIT",
				"learning queue request did not produce frozen learning authorization",
			);
		}
		if (
			resources.wallTimeMs > task.authorization.admission.maxWallSeconds * 1_000 ||
			resources.memoryMiB > task.authorization.admission.maxMemoryMiB
		) {
			throw new StudyResearchError(
				"QUEUE_STUDY_LIMIT",
				"execution resources exceed the frozen Study task admission",
			);
		}
	}

	private assertUnambiguousResearchDependencies(
		scope: Scope,
		planId: string,
		expectedPlanRevision: number,
		grantId: string,
	): void {
		const plan = this.host.getResearchPlan(scope, planId);
		if (plan.revision !== expectedPlanRevision)
			throw new StudyResearchError(
				"QUEUE_RESEARCH_AUTHORIZATION_INVALID",
				"research plan revision changed before queueing",
			);
		const grant = this.host.listScopeGrants(scope).find((candidate) => candidate.grantId === grantId);
		if (!grant || grant.revokedAt !== null || Date.parse(grant.expiresAt) <= this.clock().getTime()) {
			throw new StudyResearchError(
				"QUEUE_RESEARCH_AUTHORIZATION_INVALID",
				"research grant is missing, revoked, or expired",
			);
		}
		if (
			grant.planId !== plan.planId ||
			grant.planRevision !== plan.revision ||
			grant.semanticDigest !== plan.semanticDigest
		) {
			throw new StudyResearchError(
				"QUEUE_RESEARCH_AUTHORIZATION_INVALID",
				"research grant does not match the requested plan",
			);
		}
		const bindings = plan.sourceReferences
			? [...plan.sourceReferences].sort(
					(left, right) =>
						left.sourceId.localeCompare(right.sourceId) || left.contentHash.localeCompare(right.contentHash),
				)
			: this.currentPlanBindings(scope, plan.sourceVersionHashes);
		if (stableStringify(bindings) !== stableStringify(grant.referencedSources)) {
			throw new StudyResearchError(
				"QUEUE_RESEARCH_AUTHORIZATION_INVALID",
				"research grant source bindings are stale",
			);
		}
		const current = this.host.listSources(scope).filter((source) => source.current);
		if (
			bindings.some(
				(binding) =>
					!current.some(
						(source) => source.sourceId === binding.sourceId && source.contentHash === binding.contentHash,
					),
			)
		)
			throw new StudyResearchError(
				"QUEUE_RESEARCH_AUTHORIZATION_INVALID",
				"research plan source bindings are stale",
			);
	}

	private revalidateQueuedResearch(record: JobRecord): void {
		if (!record.research) return;
		try {
			const task = this.readHostTask(record.job);
			if (task.authorization.kind !== "research-grant") {
				throw new StudyResearchError(
					"QUEUE_RESEARCH_AUTHORIZATION_INVALID",
					"queued research job has no frozen research authorization",
				);
			}
			this.assertFrozenResearchAuthorizationCurrent(task.authorization);
			const binding = this.host.currentPhase(record.job.projectId, record.job.sessionId);
			if (!binding)
				throw new StudyResearchError("QUEUE_RESEARCH_AUTHORIZATION_INVALID", "research session is no longer bound");
			this.assertUnambiguousResearchDependencies(
				{
					projectId: record.job.projectId,
					sessionId: record.job.sessionId,
					expectedPhaseRevision: binding.revision,
				},
				record.research.planId,
				record.research.expectedPlanRevision,
				record.research.grantId,
			);
		} catch (error) {
			if (error instanceof StudyResearchError && error.code === "QUEUE_RESEARCH_AUTHORIZATION_INVALID") throw error;
			if (error instanceof StudyResearchError) {
				throw new StudyResearchError("QUEUE_RESEARCH_AUTHORIZATION_INVALID", error.message);
			}
			throw error;
		}
	}

	private currentPlanBindings(
		scope: Scope,
		hashes: readonly string[],
	): Array<{ sourceId: string; contentHash: string }> {
		const current = this.host.listSources(scope).filter((source) => source.current);
		const bindings = hashes.map((hash) => {
			const matches = current.filter((source) => source.contentHash === hash);
			if (matches.length !== 1)
				throw new StudyResearchError(
					"QUEUE_AMBIGUOUS_SOURCE_DEPENDENCY",
					"research plan source hash does not identify exactly one current source",
				);
			return { sourceId: matches[0].sourceId, contentHash: matches[0].contentHash };
		});
		bindings.sort(
			(left, right) =>
				left.sourceId.localeCompare(right.sourceId) || left.contentHash.localeCompare(right.contentHash),
		);
		return bindings;
	}

	private materializeScopeQuota(record: JobRecord): void {
		const scopeKey = this.scopeKey(record);
		const existing = this.readScopeUsage(scopeKey);
		if (!existing) {
			this.saveScopeUsage(this.newScopeUsage(scopeKey, record.job.quota));
			return;
		}
		if (stableStringify(existing.quota) !== stableStringify(record.job.quota)) {
			throw new StudyResearchError(
				"QUEUE_SCOPE_QUOTA_CONFLICT",
				"scope quota conflicts with the quota already materialized for this execution scope",
			);
		}
	}

	private reserveResources(policy: ExecutionQueuePolicy, record: JobRecord): void {
		const { job } = record;
		const active = this.activeReservations();
		if (
			active.concurrent + 1 > policy.maxConcurrentRuns ||
			active.cpu + job.resources.cpuMilliCores > policy.maxCpuMilliCores ||
			active.memory + job.resources.memoryMiB > policy.maxMemoryMiB
		) {
			throw new StudyResearchError("QUEUE_RESOURCE_UNAVAILABLE", "global execution capacity is unavailable");
		}
		const scopeKey = this.scopeKey(record);
		const usage = this.readScopeUsage(scopeKey);
		if (!usage) {
			throw new StudyResearchError(
				"QUEUE_CORRUPT_STATE",
				"execution scope quota was not materialized before admission",
			);
		}
		if (stableStringify(usage.quota) !== stableStringify(job.quota))
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", "materialized execution scope quota changed");
		if (usage.quota.expiresAt !== null && Date.parse(usage.quota.expiresAt) <= this.clock().getTime())
			throw new StudyResearchError("QUEUE_SCOPE_EXPIRED", "scope quota expired before admission");
		if (
			usage.runs + 1 > usage.quota.maxRuns ||
			usage.consumedWallTimeMs + usage.reservedWallTimeMs + job.resources.wallTimeMs >
				usage.quota.maxCumulativeWallTimeMs ||
			usage.consumedDiskBytes + usage.reservedDiskBytes + job.resources.diskBytes >
				usage.quota.maxCumulativeDiskBytes
		) {
			throw new StudyResearchError("QUEUE_SCOPE_LIMIT", "scope cumulative quota blocks admission");
		}
		usage.runs += 1;
		usage.reservedWallTimeMs += job.resources.wallTimeMs;
		usage.reservedDiskBytes += job.resources.diskBytes;
		this.saveScopeUsage(usage);
		this.saveReservation({ jobId: job.queueJobId, scopeKey, resources: job.resources, releasedAt: null });
	}

	private releaseReservation(
		job: InternalExecutionQueueJob,
		usage: ExecutionUsage,
		requestedStatus: TerminalReceipt["status"],
	): { status: TerminalReceipt["status"]; exceeded: string[] } {
		const reservation = this.readReservation(job.queueJobId);
		if (!reservation || reservation.releasedAt !== null) {
			throw new StudyResearchError(
				"QUEUE_CORRUPT_STATE",
				"admitted execution job has a missing or already released resource reservation",
			);
		}
		const aggregate = this.readScopeUsage(reservation.scopeKey);
		if (!aggregate) throw new StudyResearchError("QUEUE_CORRUPT_STATE", "reservation has no scope usage record");
		aggregate.reservedWallTimeMs -= reservation.resources.wallTimeMs;
		aggregate.reservedDiskBytes -= reservation.resources.diskBytes;
		if (aggregate.reservedWallTimeMs < 0 || aggregate.reservedDiskBytes < 0)
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", "scope reservation counters became negative");
		aggregate.consumedWallTimeMs += usage.wallTimeMs;
		aggregate.consumedDiskBytes += usage.diskBytes;
		this.saveScopeUsage(aggregate);
		this.saveReservation({ ...reservation, releasedAt: this.timestamp() });
		const exceeded: string[] = [];
		if (usage.wallTimeMs > reservation.resources.wallTimeMs) exceeded.push("run.wallTimeMs");
		if (usage.diskBytes > reservation.resources.diskBytes) exceeded.push("run.diskBytes");
		if (aggregate.consumedWallTimeMs > aggregate.quota.maxCumulativeWallTimeMs) exceeded.push("scope.wallTimeMs");
		if (aggregate.consumedDiskBytes > aggregate.quota.maxCumulativeDiskBytes) exceeded.push("scope.diskBytes");
		return { status: exceeded.length > 0 ? "limit-reached" : requestedStatus, exceeded };
	}

	private activeReservations(): { concurrent: number; cpu: number; memory: number } {
		const rows = this.database
			.prepare("SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_resource")
			.all() as unknown as PayloadRow[];
		return rows
			.map((row) => this.decode<ResourceReservation>(row, "resource reservation"))
			.filter((reservation) => reservation.releasedAt === null)
			.reduce(
				(sum, reservation) => ({
					concurrent: sum.concurrent + 1,
					cpu: sum.cpu + reservation.resources.cpuMilliCores,
					memory: sum.memory + reservation.resources.memoryMiB,
				}),
				{ concurrent: 0, cpu: 0, memory: 0 },
			);
	}

	private claimCandidates(): JobRecord[] {
		const now = this.clock().getTime();
		return this.listRecords().filter(
			(record) =>
				record.job.status === "queued" ||
				((record.job.status === "admitted" || record.job.status === "prepared") &&
					this.isLeaseExpired(record.job, now)),
		);
	}

	private assignClaim(job: InternalExecutionQueueJob, coordinatorId: string, durationMs: number): void {
		job.claimOwner = coordinatorId;
		job.claimRevision += 1;
		job.leaseExpiresAt = new Date(this.clock().getTime() + durationMs).toISOString();
		job.updatedAt = this.timestamp();
	}

	private assertClaim(job: InternalExecutionQueueJob, owner: string, revision: number): void {
		requiredText(owner, "claimOwner", 256);
		requiredRevision(revision, "expectedClaimRevision");
		if (
			job.claimOwner !== owner ||
			job.claimRevision !== revision ||
			this.isLeaseExpired(job, this.clock().getTime())
		) {
			throw new StudyResearchError("QUEUE_CLAIM_CONFLICT", "coordinator claim is stale or no longer owned");
		}
	}

	private isLeaseExpired(job: InternalExecutionQueueJob, now: number): boolean {
		return job.leaseExpiresAt === null || Date.parse(job.leaseExpiresAt) <= now;
	}

	private readHostTask(job: InternalExecutionQueueJob): StudyTask {
		const task = this.host.readTaskForCoordinator(job.taskId);
		if (task.projectId !== job.projectId || task.authorization.sessionId !== job.sessionId)
			throw new StudyResearchError(
				"QUEUE_HOST_TASK_CONFLICT",
				"queue task scope differs from frozen Host authorization",
			);
		return task;
	}

	private assertFrozenResearchAuthorizationCurrent(authorization: FrozenResearchTaskAuthorization): void {
		this.host.assertFrozenResearchAuthorizationCurrent(authorization);
	}

	private scopeKey(record: JobRecord): string {
		const { job } = record;
		if (!record.research) return `study:${job.projectId}:${job.sessionId}`;
		return `research:${job.projectId}:${record.research.grantId}`;
	}

	private isTerminal(status: ExecutionQueueStatus): boolean {
		return ["succeeded", "failed", "cancelled", "limit-reached"].includes(status);
	}

	private validateStudyRequest(request: StudyExecutionRequest): StudyExecutionRequest {
		requiredText(request.dispatchKey, "dispatchKey", 256);
		requiredText(request.producerContextId, "producerContextId", 256);
		const resources = this.validateResources(request.resources);
		return {
			...request,
			kind: request.kind ?? "execution",
			manifest: validateManifest(request.manifest),
			admission: structuredClone(request.admission),
			resources,
			quota: this.validateQuota(request.quota),
		};
	}

	private validateResearchRequest(request: ResearchExecutionRequest): ResearchExecutionRequest {
		requiredText(request.planId, "planId", 128);
		requiredText(request.grantId, "grantId", 128);
		requiredRevision(request.expectedPlanRevision, "expectedPlanRevision");
		requiredText(request.dispatchKey, "dispatchKey", 256);
		requiredText(request.producerContextId, "producerContextId", 256);
		return {
			...request,
			manifest: validateManifest(request.manifest),
			resources: this.validateResources(request.resources),
			quota: this.validateQuota(request.quota),
		};
	}

	private validatePolicy(input: ExecutionQueuePolicyInput): ExecutionQueuePolicyInput {
		for (const [label, value, minimum, maximum] of [
			["maxConcurrentRuns", input.maxConcurrentRuns, 1, 1_000],
			["maxCpuMilliCores", input.maxCpuMilliCores, 1, 10_000_000],
			["maxMemoryMiB", input.maxMemoryMiB, 16, 10_000_000],
			["leaseDurationMs", input.leaseDurationMs, 1_000, 86_400_000],
		] as const) {
			if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
				throw new StudyResearchError("INVALID_QUEUE_POLICY", `${label} is outside its bounded range`);
		}
		return structuredClone(input);
	}

	private validateResources(value: ExecutionResourceRequest): ExecutionResourceRequest {
		for (const [label, number, maximum] of [
			["cpuMilliCores", value.cpuMilliCores, 10_000_000],
			["memoryMiB", value.memoryMiB, 10_000_000],
			["wallTimeMs", value.wallTimeMs, 31_536_000_000],
			["diskBytes", value.diskBytes, Number.MAX_SAFE_INTEGER],
		] as const) {
			if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
				throw new StudyResearchError("INVALID_QUEUE_RESOURCE", `${label} must be a positive bounded integer`);
		}
		return structuredClone(value);
	}

	private validateQuota(value: ExecutionScopeQuota): ExecutionScopeQuota {
		for (const [label, number] of [
			["maxRuns", value.maxRuns],
			["maxCumulativeWallTimeMs", value.maxCumulativeWallTimeMs],
			["maxCumulativeDiskBytes", value.maxCumulativeDiskBytes],
		] as const) {
			if (!Number.isSafeInteger(number) || number < 1)
				throw new StudyResearchError("INVALID_QUEUE_QUOTA", `${label} must be a positive safe integer`);
		}
		if (value.expiresAt !== null && !Number.isFinite(Date.parse(value.expiresAt)))
			throw new StudyResearchError("INVALID_QUEUE_QUOTA", "quota expiry must be an ISO timestamp or null");
		return structuredClone(value);
	}

	private validateUsage(value: ExecutionUsage): ExecutionUsage {
		for (const [label, number] of [
			["wallTimeMs", value.wallTimeMs],
			["diskBytes", value.diskBytes],
		] as const)
			if (!Number.isSafeInteger(number) || number < 0)
				throw new StudyResearchError("INVALID_QUEUE_USAGE", `${label} must be a non-negative safe integer`);
		return structuredClone(value);
	}

	private validatePreparedHandle(value: PreparedExecutionHandle): PreparedExecutionHandle {
		this.assertPlainJsonObject(value, "prepared execution handle");
		requiredText(value.kind, "prepared execution handle kind", 128);
		if (!Number.isSafeInteger(value.version) || value.version < 1 || value.version > 1_000_000) {
			throw new StudyResearchError(
				"INVALID_PREPARED_HANDLE",
				"prepared execution handle version must be a positive bounded integer",
			);
		}
		for (const [label, section] of [
			["privateHandle", value.privateHandle],
			["publicSummary", value.publicSummary],
		] as const) {
			this.assertPlainJsonObject(section, `prepared execution handle ${label}`);
			let serialized: string;
			try {
				serialized = stableStringify(section);
			} catch {
				throw new StudyResearchError(
					"INVALID_PREPARED_HANDLE",
					`prepared execution handle ${label} is not JSON-serializable`,
				);
			}
			const roundTrip = JSON.parse(serialized);
			if (stableStringify(roundTrip) !== serialized) {
				throw new StudyResearchError(
					"INVALID_PREPARED_HANDLE",
					`prepared execution handle ${label} does not preserve its JSON round trip`,
				);
			}
			if (serialized.length > 100_000) {
				throw new StudyResearchError(
					"INVALID_PREPARED_HANDLE",
					`prepared execution handle ${label} exceeds 100000 characters`,
				);
			}
		}
		this.assertPublicSummaryIsRedacted(value.publicSummary);
		return structuredClone(value);
	}

	private assertPlainJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${label} must be a plain JSON object`);
		}
		this.assertPlainJson(value, label, new Set<object>(), 0);
	}

	private assertPlainJson(value: unknown, path: string, ancestors: Set<object>, depth: number): void {
		if (value === null || typeof value === "string" || typeof value === "boolean") return;
		if (typeof value === "number") {
			if (!Number.isFinite(value))
				throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} must contain only finite JSON numbers`);
			return;
		}
		if (Array.isArray(value)) {
			if (ancestors.has(value))
				throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} contains a cyclic value`);
			if (depth >= 32)
				throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} exceeds the maximum JSON depth`);
			ancestors.add(value);
			for (let index = 0; index < value.length; index += 1)
				this.assertPlainJson(value[index], `${path}[${index}]`, ancestors, depth + 1);
			ancestors.delete(value);
			return;
		}
		if (!value || typeof value !== "object") {
			throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} must contain only JSON values`);
		}
		if (Object.getPrototypeOf(value) !== Object.prototype) {
			throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} must contain only plain objects`);
		}
		if (ancestors.has(value))
			throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} contains a cyclic value`);
		if (depth >= 32)
			throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} exceeds the maximum JSON depth`);
		const names = Object.getOwnPropertyNames(value);
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new StudyResearchError("INVALID_PREPARED_HANDLE", `${path} contains symbol properties`);
		}
		ancestors.add(value);
		for (const key of names) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
				throw new StudyResearchError(
					"INVALID_PREPARED_HANDLE",
					`${path}.${key} must be an enumerable data property`,
				);
			}
			this.assertPlainJson(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
		}
		ancestors.delete(value);
	}

	private handleSummary(handle: PreparedExecutionHandle): PreparedExecutionHandleSummary {
		return { kind: handle.kind, version: handle.version, publicSummary: structuredClone(handle.publicSummary) };
	}

	private assertPublicSummaryIsRedacted(summary: Record<string, unknown>): void {
		const pending: unknown[] = [summary];
		const secretKey = /token|secret|password|credential|authorization|cookie|private/i;
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || typeof current !== "object") continue;
			if (Array.isArray(current)) {
				pending.push(...current);
				continue;
			}
			for (const [key, nested] of Object.entries(current)) {
				if (secretKey.test(key)) {
					throw new StudyResearchError(
						"PREPARED_HANDLE_SECRET_EXPOSED",
						"public prepared-handle summary contains a sensitive field",
					);
				}
				pending.push(nested);
			}
		}
	}

	private newScopeUsage(scopeKey: string, quota: ExecutionScopeQuota): ScopeUsage {
		return {
			scopeKey,
			quota: this.copy(quota),
			runs: 0,
			reservedWallTimeMs: 0,
			consumedWallTimeMs: 0,
			reservedDiskBytes: 0,
			consumedDiskBytes: 0,
		};
	}

	private readPolicy(): ExecutionQueuePolicy {
		const policy = this.readPolicyOrNull();
		if (!policy)
			throw new StudyResearchError(
				"QUEUE_POLICY_UNCONFIGURED",
				"trusted queue policy must be configured before admission",
			);
		return policy;
	}

	private readPolicyOrNull(): ExecutionQueuePolicy | null {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_policy WHERE policy_key = ?",
			)
			.get("global") as PayloadRow | undefined;
		return row ? this.decode<ExecutionQueuePolicy>(row, "execution queue policy") : null;
	}

	private readJob(jobId: string): JobRecord {
		requiredText(jobId, "queueJobId", 128);
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_job WHERE queue_job_id = ?",
			)
			.get(jobId) as PayloadRow | undefined;
		return this.decode<JobRecord>(row, "execution queue job");
	}

	private readJobByDispatch(projectId: string, dispatchKey: string): JobRecord | null {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_job WHERE project_id = ? AND dispatch_key = ?",
			)
			.get(projectId, dispatchKey) as PayloadRow | undefined;
		return row ? this.decode<JobRecord>(row, "execution queue job") : null;
	}

	private listRecords(): JobRecord[] {
		const rows = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_job ORDER BY queue_job_id",
			)
			.all() as unknown as PayloadRow[];
		return rows
			.map((row) => this.decode<JobRecord>(row, "execution queue job"))
			.sort((left, right) => this.queueOrder(left.job) - this.queueOrder(right.job));
	}

	private queueOrder(job: InternalExecutionQueueJob): number {
		if (!Number.isSafeInteger(job.enqueueOrder) || job.enqueueOrder < 1) {
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", "execution queue job has an invalid enqueue order");
		}
		return job.enqueueOrder;
	}

	private nextEnqueueOrder(): number {
		const row = this.database
			.prepare("SELECT value FROM pi_study_execution_counter WHERE counter_key = ?")
			.get("enqueue-order") as { value: number } | undefined;
		const current = row?.value ?? 0;
		if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", "execution queue enqueue counter is invalid");
		}
		const next = current + 1;
		this.database
			.prepare(
				"INSERT INTO pi_study_execution_counter (counter_key, value) VALUES (?, ?) ON CONFLICT(counter_key) DO UPDATE SET value = excluded.value",
			)
			.run("enqueue-order", next);
		return next;
	}

	private publicJob(job: InternalExecutionQueueJob): ExecutionQueueJob {
		const { producerContextId: _producerContextId, ...safe } = job;
		return this.copy(safe);
	}

	private isPermanentAdmissionError(error: unknown): error is StudyResearchError {
		return (
			error instanceof StudyResearchError &&
			[
				"QUEUE_RESEARCH_AUTHORIZATION_INVALID",
				"QUEUE_AMBIGUOUS_SOURCE_DEPENDENCY",
				"QUEUE_SCOPE_EXPIRED",
				"QUEUE_SCOPE_LIMIT",
				"QUEUE_HOST_TASK_CONFLICT",
			].includes(error.code)
		);
	}

	private markNeedsInput(record: JobRecord, coordinatorId: string, error: StudyResearchError): void {
		record.job.status = "needs-input";
		record.job.admissionFailure = {
			code: error.code,
			message: error.message.slice(0, 20_000),
			coordinatorId,
			occurredAt: this.timestamp(),
		};
		record.job.claimOwner = null;
		record.job.leaseExpiresAt = null;
		record.job.updatedAt = this.timestamp();
		this.saveJob(record);
	}

	private saveJob(record: JobRecord): void {
		this.savePayload(
			"pi_study_execution_job",
			"queue_job_id",
			record.job.queueJobId,
			record,
			record.job.projectId,
			record.job.taskId,
			record.job.dispatchKey,
			record.job.status,
		);
	}

	private readReservation(jobId: string): ResourceReservation | null {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_resource WHERE queue_job_id = ?",
			)
			.get(jobId) as PayloadRow | undefined;
		return row ? this.decode<ResourceReservation>(row, "resource reservation") : null;
	}

	private saveReservation(reservation: ResourceReservation): void {
		const payload = stableStringify(reservation);
		this.database
			.prepare(
				"INSERT INTO pi_study_execution_resource (queue_job_id, scope_key, payload, payload_hash) VALUES (?, ?, ?, ?) ON CONFLICT(queue_job_id) DO UPDATE SET scope_key = excluded.scope_key, payload = excluded.payload, payload_hash = excluded.payload_hash",
			)
			.run(reservation.jobId, reservation.scopeKey, payload, contentHash(reservation));
	}

	private readScopeUsage(scopeKey: string): ScopeUsage | null {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_scope_usage WHERE scope_key = ?",
			)
			.get(scopeKey) as PayloadRow | undefined;
		return row ? this.decode<ScopeUsage>(row, "scope usage") : null;
	}

	private saveScopeUsage(usage: ScopeUsage): void {
		this.savePayload("pi_study_execution_scope_usage", "scope_key", usage.scopeKey, usage);
	}

	private savePrivateHandle(jobId: string, handle: PreparedExecutionHandle): void {
		const payload = stableStringify(handle);
		this.database
			.prepare(
				"INSERT INTO pi_study_execution_prepared (queue_job_id, private_handle, payload_hash) VALUES (?, ?, ?) ON CONFLICT(queue_job_id) DO UPDATE SET private_handle = excluded.private_handle, payload_hash = excluded.payload_hash",
			)
			.run(jobId, payload, contentHash(handle));
	}

	private readPrivateHandle(jobId: string): PreparedExecutionHandle {
		const row = this.database
			.prepare(
				"SELECT private_handle AS privateHandle, payload_hash AS payloadHash FROM pi_study_execution_prepared WHERE queue_job_id = ?",
			)
			.get(jobId) as PreparedRow | undefined;
		if (!row || typeof row.privateHandle !== "string" || typeof row.payloadHash !== "string")
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", "prepared execution handle is missing");
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.privateHandle);
		} catch {
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", "prepared execution handle contains invalid JSON");
		}
		if (contentHash(parsed) !== row.payloadHash)
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", "prepared execution handle failed integrity verification");
		return this.validatePreparedHandle(parsed as PreparedExecutionHandle);
	}

	private savePayload(
		table: string,
		idColumn: string,
		id: string,
		value: object,
		projectId?: string,
		taskId?: string,
		dispatchKey?: string,
		status?: string,
	): void {
		const payload = stableStringify(value);
		const hash = contentHash(value);
		if (table === "pi_study_execution_job") {
			if (!projectId || !taskId || !dispatchKey || !status)
				throw new StudyResearchError("QUEUE_CORRUPT_STATE", "job persistence requires indexed fields");
			this.database
				.prepare(
					"INSERT INTO pi_study_execution_job (queue_job_id, project_id, task_id, dispatch_key, status, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(queue_job_id) DO UPDATE SET project_id = excluded.project_id, task_id = excluded.task_id, dispatch_key = excluded.dispatch_key, status = excluded.status, payload = excluded.payload, payload_hash = excluded.payload_hash",
				)
				.run(id, projectId, taskId, dispatchKey, status, payload, hash);
			return;
		}
		this.database
			.prepare(
				`INSERT INTO ${table} (${idColumn}, payload, payload_hash) VALUES (?, ?, ?) ON CONFLICT(${idColumn}) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash`,
			)
			.run(id, payload, hash);
	}

	private decode<T>(row: PayloadRow | undefined, label: string): T {
		if (!row || typeof row.payload !== "string" || typeof row.payloadHash !== "string")
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", `${label} is missing or malformed`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.payload);
		} catch {
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", `${label} has invalid JSON`);
		}
		if (contentHash(parsed) !== row.payloadHash)
			throw new StudyResearchError("QUEUE_CORRUPT_STATE", `${label} failed integrity verification`);
		return parsed as T;
	}

	private inSavepoint<T>(work: () => T): T {
		this.database.exec("SAVEPOINT queue_claim_candidate");
		try {
			const result = work();
			this.database.exec("RELEASE SAVEPOINT queue_claim_candidate");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK TO SAVEPOINT queue_claim_candidate");
			this.database.exec("RELEASE SAVEPOINT queue_claim_candidate");
			throw error;
		}
	}

	private transaction<T>(work: () => T): T {
		const nested = this.database.isTransaction;
		this.database.exec(nested ? "SAVEPOINT study_queue_composition" : "BEGIN IMMEDIATE");
		try {
			const result = work();
			this.database.exec(nested ? "RELEASE study_queue_composition" : "COMMIT");
			return result;
		} catch (error) {
			this.database.exec(nested ? "ROLLBACK TO study_queue_composition" : "ROLLBACK");
			if (nested) this.database.exec("RELEASE study_queue_composition");
			throw error;
		}
	}

	private timestamp(): string {
		const date = this.clock();
		if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
			throw new StudyResearchError("INVALID_CLOCK", "queue clock returned an invalid date");
		return date.toISOString();
	}

	private newId(prefix: string): string {
		return `${prefix}_${randomUUID()}`;
	}
	private copy<T>(value: T): T {
		return structuredClone(value);
	}
}
