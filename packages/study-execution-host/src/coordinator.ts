import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { cpus } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import type { Scope } from "../../study-research-host/src/types.ts";
import {
	assertFrozenPayloadIdentity,
	decodeFrozenInput,
	executionSha256,
	type FrozenExecutionPayload,
	type FrozenExecutionPayloadIdentity,
	frozenPayloadHash,
	validateFrozenExecutionPayload,
} from "./execution-payloads.ts";
import type {
	ExecutionQueueJob,
	ExecutionUsage,
	PreparedExecutionHandle,
	PreparedLaunchLease,
	StudyExecutionQueue,
} from "./execution-queue.ts";
import {
	abandonIsolatedWindowsPreparation,
	abandonPreparedIsolatedWindowsRun,
	cancelIsolatedWindowsRun,
	type IsolatedWindowsPreparedRunLocator,
	type IsolatedWindowsRunHandle,
	type IsolatedWindowsRunStatus,
	launchPreparedIsolatedWindowsRun,
	prepareIsolatedWindowsRun,
	reconcileIsolatedWindowsRun,
} from "./windows-runner.ts";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "limit-reached"]);
const ADAPTER_STATUS = new Set(["launching", "running", "succeeded", "failed", "cancelled", "limit-reached"]);

export interface CoordinatorPublicLogs {
	stdout: string | null;
	stderr: string | null;
	error: string | null;
}

export interface CoordinatorAdapterObservation {
	status: "launching" | "running" | "succeeded" | "failed" | "cancelled" | "limit-reached";
	usage: ExecutionUsage;
	/** Required before this coordinator may turn a successful terminal receipt into Host running. */
	processEvidence: string | null;
	logs: CoordinatorPublicLogs;
}

export interface CoordinatorAdapterPreparation {
	job: ExecutionQueueJob;
	payload: FrozenExecutionPayload;
	payloadHash: string;
	artifactDirectory: string;
}

/**
 * Implementations receive queue-private handles only from a current coordinator claim.
 * They must never return those handles through public results or logs.
 */
export interface StudyExecutionAdapter {
	readonly kind: string;
	/** Pure identity allocation; the queue persists this before invoking external preparation. */
	createPreparationIntent?(input: CoordinatorAdapterPreparation): PreparedExecutionHandle;
	prepare(input: CoordinatorAdapterPreparation, intent?: PreparedExecutionHandle): Promise<PreparedExecutionHandle>;
	/** Must prove no execution was launched, clean owned partial snapshots and report retained usage. */
	abandonPreparation?(intent: PreparedExecutionHandle): Promise<CoordinatorAdapterObservation>;
	launch(handle: PreparedExecutionHandle): Promise<CoordinatorAdapterObservation>;
	poll(handle: PreparedExecutionHandle): Promise<CoordinatorAdapterObservation>;
	cancel(handle: PreparedExecutionHandle): Promise<CoordinatorAdapterObservation>;
	abandonPrepared(handle: PreparedExecutionHandle): Promise<CoordinatorAdapterObservation>;
}

export interface StudyExecutionCoordinatorOptions {
	database: DatabaseSync;
	queue: StudyExecutionQueue;
	coordinatorId?: string;
	adapters: readonly StudyExecutionAdapter[];
	artifactDirectory: string;
}

export interface CoordinatorPublicResult {
	queueJobId: string;
	status: ExecutionQueueJob["status"];
	usage: ExecutionUsage;
	logs: CoordinatorPublicLogs;
	observedAt: string;
}

export interface CoordinatorTickResult {
	claimedJobId: string | null;
	reconciledJobIds: string[];
}

export interface StudyWindowsNativeAdapterOptions {
	runRootDirectory: string;
	/** The current Windows runner accepts 1..100 and does not let the coordinator invent a different value. */
	cpuRatePercent: number;
	/** Test-only seam for a staged-payload mutation before the runner snapshots it. */
	afterMaterializeForTesting?: (input: {
		stagingDirectory: string;
		programFileName: string;
		inputFileNames: readonly string[];
	}) => Promise<void>;
	/** Test-only seam for exercising the fail-closed cleanup path after the runner snapshot exists. */
	beforeStagingCleanupForTesting?: (input: { stagingDirectory: string }) => Promise<void>;
}

export interface DetachedCoordinatorLaunchOptions {
	/** The same SQLite path that the service opens through LearningHarness. */
	databasePath: string;
	/** Absolute path to scripts/study-execution-coordinator.mjs (or a trusted deployed equivalent). */
	scriptPath: string;
	runRootDirectory: string;
	artifactDirectory: string;
	/** One database may run several explicitly named coordinators; the default is the sole primary worker. */
	coordinatorId?: string;
	nodeExecutablePath?: string;
	intervalMs?: number;
	workerLeaseMs?: number;
}

export interface DetachedCoordinatorLaunchRequest {
	launchKey: string;
	coordinatorId: string;
	processId: number | null;
	status: "started" | "already-running" | "already-starting" | "reconciling";
	/** A spawn request never claims that the child has booted, acquired its fence, or completed a tick. */
	ready: false;
}

export interface DetachedCoordinatorWorkerIdentity {
	launchKey: string;
	workerToken: string;
	processId: number;
	processCreationIdentity: string;
	leaseDurationMs: number;
}

interface StoredPayloadRow {
	queueJobId: string;
	payload: string;
	payloadHash: string;
}

interface StoredResultRow {
	payload: string;
	payloadHash: string;
}

interface ActiveLease {
	adapter: StudyExecutionAdapter;
	claimRevision: number;
	handle: PreparedExecutionHandle;
}

interface DetachedCoordinatorWorkerRecord {
	version: 1;
	launchKey: string;
	coordinatorId: string;
	workerToken: string;
	processId: number | null;
	processCreationIdentity: string | null;
	status: "starting" | "active" | "stopped";
	databasePath: string;
	scriptPath: string;
	runRootDirectory: string;
	artifactDirectory: string;
	nodeExecutablePath: string;
	intervalMs: number;
	workerLeaseMs: number;
	launchedAt: string;
	lastHeartbeatAt: string | null;
	leaseExpiresAt: string;
	lastError: { code: string; message: string; observedAt: string } | null;
}

export class StudyExecutionCoordinatorError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StudyExecutionCoordinatorError";
		this.code = code;
	}
}

/**
 * Detached, durable queue driver. It has no UI capability and shares the Harness database with
 * Host and queue state. Queue owns private prepared handles; this class persists only frozen
 * payloads and redacted public observations.
 */
export class StudyExecutionCoordinator {
	private readonly database: DatabaseSync;
	private readonly queue: StudyExecutionQueue;
	private readonly coordinatorId: string;
	private readonly adapters: ReadonlyMap<string, StudyExecutionAdapter>;
	private readonly artifactDirectory: string;
	private readonly active = new Map<string, ActiveLease>();
	private running = false;

	constructor(options: StudyExecutionCoordinatorOptions) {
		this.database = options.database;
		this.queue = options.queue;
		this.coordinatorId = options.coordinatorId ?? `detached-coordinator:${randomUUID()}`;
		if (!this.coordinatorId.trim() || this.coordinatorId.length > 256) {
			throw new StudyExecutionCoordinatorError("COORDINATOR_ID_INVALID", "coordinatorId must be bounded text");
		}
		this.artifactDirectory = resolveRequiredDirectory(options.artifactDirectory, "artifactDirectory");
		const adapters = new Map<string, StudyExecutionAdapter>();
		for (const adapter of options.adapters) {
			if (!adapter.kind || adapter.kind.length > 128 || adapters.has(adapter.kind)) {
				throw new StudyExecutionCoordinatorError("ADAPTER_INVALID", "adapter kinds must be unique bounded text");
			}
			adapters.set(adapter.kind, adapter);
		}
		if (adapters.size === 0)
			throw new StudyExecutionCoordinatorError("ADAPTER_REQUIRED", "a coordinator requires an adapter");
		this.adapters = adapters;
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_execution_frozen_payload (
				queue_job_id TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_coordinator_result (
				queue_job_id TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_detached_worker (
				launch_key TEXT PRIMARY KEY,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pi_study_execution_private_diagnostic (
				diagnostic_id TEXT PRIMARY KEY,
				queue_job_id TEXT NOT NULL,
				observed_at TEXT NOT NULL,
				details TEXT NOT NULL
			);
		`);
	}

	/**
	 * Fences a child process which was started by ensureDetachedStudyExecutionCoordinator.
	 * A spawn is deliberately not ready until the child has completed this durable activation.
	 */
	activateDetachedWorker(identity: DetachedCoordinatorWorkerIdentity): void {
		validateDetachedWorkerIdentity(identity);
		this.transaction(() => {
			const record = this.readDetachedWorker(identity.launchKey);
			if (!record || record.workerToken !== identity.workerToken) {
				throw new StudyExecutionCoordinatorError(
					"DETACHED_COORDINATOR_FENCED",
					"detached coordinator start was replaced or was never requested",
				);
			}
			if (record.status === "stopped") {
				throw new StudyExecutionCoordinatorError(
					"DETACHED_COORDINATOR_FENCED",
					"detached coordinator has already stopped",
				);
			}
			if (
				record.processId !== null &&
				(record.processId !== identity.processId ||
					record.processCreationIdentity !== identity.processCreationIdentity)
			) {
				throw new StudyExecutionCoordinatorError(
					"DETACHED_COORDINATOR_FENCED",
					"detached coordinator process identity does not match its launch request",
				);
			}
			this.saveDetachedWorker({
				...record,
				processId: identity.processId,
				processCreationIdentity: identity.processCreationIdentity,
				status: "active",
				lastHeartbeatAt: this.timestamp(),
				leaseExpiresAt: this.detachedLeaseExpiry(identity.leaseDurationMs),
				lastError: null,
			});
		});
	}

	/** Updates the independent service-process fence while a long queue operation is awaiting I/O. */
	heartbeatDetachedWorker(identity: DetachedCoordinatorWorkerIdentity): void {
		validateDetachedWorkerIdentity(identity);
		this.transaction(() => {
			const record = this.readDetachedWorker(identity.launchKey);
			if (
				!record ||
				record.status !== "active" ||
				record.workerToken !== identity.workerToken ||
				record.processId !== identity.processId ||
				record.processCreationIdentity !== identity.processCreationIdentity ||
				Date.parse(record.leaseExpiresAt) <= Date.now()
			) {
				throw new StudyExecutionCoordinatorError(
					"DETACHED_COORDINATOR_FENCED",
					"detached coordinator no longer owns the current process fence",
				);
			}
			this.saveDetachedWorker({
				...record,
				lastHeartbeatAt: this.timestamp(),
				leaseExpiresAt: this.detachedLeaseExpiry(identity.leaseDurationMs),
			});
		});
	}

	/** Persists a retriable worker failure; the watch loop continues unless its process fence was lost. */
	recordDetachedWorkerFailure(identity: DetachedCoordinatorWorkerIdentity, error: unknown): void {
		validateDetachedWorkerIdentity(identity);
		const details = detachedErrorDetails(error);
		this.transaction(() => {
			const record = this.readDetachedWorker(identity.launchKey);
			if (
				!record ||
				record.status !== "active" ||
				record.workerToken !== identity.workerToken ||
				record.processId !== identity.processId ||
				record.processCreationIdentity !== identity.processCreationIdentity
			) {
				throw new StudyExecutionCoordinatorError(
					"DETACHED_COORDINATOR_FENCED",
					"cannot record an error for a coordinator that no longer owns its fence",
				);
			}
			this.saveDetachedWorker({
				...record,
				lastError: { ...details, observedAt: this.timestamp() },
			});
		});
	}

	/** Stores the exact code, parameters, inputs, and environment descriptor before a queue job is claimed. */
	persistPayload(queueJobId: string, value: unknown): FrozenExecutionPayload {
		const payload = validateFrozenExecutionPayload(value);
		const job = this.queue.getJob(queueJobId);
		assertFrozenPayloadIdentity(payload, identityForJob(job));
		const payloadHash = frozenPayloadHash(payload);
		this.transaction(() => {
			const existing = this.readStoredPayloadRow(queueJobId);
			if (existing) {
				if (existing.payloadHash !== payloadHash) {
					throw new StudyExecutionCoordinatorError(
						"PAYLOAD_CONFLICT",
						"queue job already has a different frozen execution payload",
					);
				}
				return;
			}
			this.database
				.prepare(
					"INSERT INTO pi_study_execution_frozen_payload (queue_job_id, payload, payload_hash) VALUES (?, ?, ?)",
				)
				.run(queueJobId, stableStringify(payload), payloadHash);
		});
		return structuredClone(payload);
	}

	getPublicResult(queueJobId: string): CoordinatorPublicResult | null {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_coordinator_result WHERE queue_job_id = ?",
			)
			.get(queueJobId) as StoredResultRow | undefined;
		if (!row) return null;
		return structuredClone(this.decodeStored<CoordinatorPublicResult>(row, "coordinator public result"));
	}

	/** Scoped export reads frozen source bytes; runner handles and cancellation tokens remain private. */
	readFrozenPayloadForTrustedExport(scope: Scope, queueJobId: string): FrozenExecutionPayload {
		this.queue.getTerminalHandleForTrustedRead(scope, queueJobId);
		return structuredClone(this.readPayloadForJob(this.queue.getJob(queueJobId)));
	}

	/** One durable scheduling pass. Calls are serialized so an old claim revision cannot race a heartbeat. */
	async tick(): Promise<CoordinatorTickResult> {
		if (this.running)
			throw new StudyExecutionCoordinatorError("COORDINATOR_BUSY", "coordinator tick is already active");
		this.running = true;
		try {
			const reconciled = this.queue.reconcileExpired();
			const reconciledJobIds = reconciled.map((job) => job.queueJobId);
			for (const queueJobId of this.listPayloadJobIds()) {
				const job = this.queue.getJob(queueJobId);
				if (isTerminal(job.status)) {
					this.active.delete(queueJobId);
					continue;
				}
				if (this.active.has(queueJobId)) await this.pollActive(job);
				else if (
					job.status === "reconciling" &&
					(job.claimOwner === null || Date.parse(job.leaseExpiresAt ?? "") <= Date.now())
				)
					await this.recoverReconciliation(job);
			}
			const claim = this.queue.claimNext(this.coordinatorId);
			if (!claim) return { claimedJobId: null, reconciledJobIds };
			await this.driveClaim(claim.job);
			return { claimedJobId: claim.job.queueJobId, reconciledJobIds };
		} finally {
			this.running = false;
		}
	}

	/** Records cancellation in queue state, then uses the current private handle only when this coordinator owns it. */
	async requestCancellation(queueJobId: string): Promise<ExecutionQueueJob> {
		if (this.running)
			throw new StudyExecutionCoordinatorError("COORDINATOR_BUSY", "cancellation must not race a coordinator tick");
		const job = this.queue.requestCancellation(queueJobId);
		if (isTerminal(job.status)) {
			this.active.delete(queueJobId);
			return job;
		}
		const active = this.active.get(queueJobId);
		if (!active || job.claimOwner !== this.coordinatorId || job.claimRevision !== active.claimRevision) return job;
		if (job.status === "prepared") {
			const lease = this.queue.acquirePreparedCancellation(queueJobId, this.coordinatorId, active.claimRevision);
			active.handle = lease.handle;
			await this.observe(
				queueJobId,
				active,
				await this.withHeartbeat(lease.job, active, () => active.adapter.abandonPrepared(lease.handle)),
			);
			return this.queue.getJob(queueJobId);
		}
		if (job.status === "launching" || job.status === "running") {
			await this.observe(
				queueJobId,
				active,
				await this.withHeartbeat(job, active, () => active.adapter.cancel(active.handle)),
			);
		}
		return this.queue.getJob(queueJobId);
	}

	private async driveClaim(job: ExecutionQueueJob): Promise<void> {
		if (job.status === "admitted") {
			let intent = this.queue.readPreparationIntent(job.queueJobId, this.coordinatorId, job.claimRevision);
			let adapter = intent ? this.adapters.get(intent.kind) : undefined;
			let entry: ActiveLease | null = null;
			let prepared: PreparedExecutionHandle | null = null;
			const startedAt = Date.now();
			try {
				const payload = this.readPayloadForJob(job);
				adapter = this.adapterFor(payload);
				const preparation = {
					job,
					payload,
					payloadHash: frozenPayloadHash(payload),
					artifactDirectory: this.artifactDirectory,
				};
				if (!intent && adapter.createPreparationIntent) {
					intent = adapter.createPreparationIntent(preparation);
					this.queue.persistPreparationIntent(job.queueJobId, this.coordinatorId, job.claimRevision, intent);
				}
				entry = { adapter, claimRevision: job.claimRevision, handle: intent ?? emptyHandle() };
				if (job.cancellationRequestedAt !== null)
					throw new StudyExecutionCoordinatorError(
						"PREPARATION_CANCELLED",
						"Preparation was cancelled before execution",
					);
				const leaseEntry = entry;
				const preparationAdapter = adapter;
				await this.withHeartbeat(job, leaseEntry, async () => {
					prepared = await preparationAdapter.prepare(preparation, intent ?? undefined);
				});
				if (!prepared)
					throw new StudyExecutionCoordinatorError("PREPARATION_HANDLE_MISSING", "Preparation returned no handle");
				const saved = this.queue.persistPreparedHandle(
					job.queueJobId,
					this.coordinatorId,
					entry.claimRevision,
					prepared,
				);
				entry.handle = prepared;
				this.active.set(job.queueJobId, entry);
				if (saved.cancellationRequestedAt !== null) {
					await this.observe(
						job.queueJobId,
						entry,
						await this.withHeartbeat(saved, entry, () => leaseEntry.adapter.abandonPrepared(leaseEntry.handle)),
					);
				} else await this.launchPrepared(saved, entry);
			} catch (error) {
				this.database
					.prepare(
						"INSERT INTO pi_study_execution_private_diagnostic (diagnostic_id, queue_job_id, observed_at, details) VALUES (?, ?, ?, ?)",
					)
					.run(
						randomUUID(),
						job.queueJobId,
						this.timestamp(),
						redactCredentials(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(
							0,
							20000,
						),
					);
				const current = this.queue.getJob(job.queueJobId);
				if (!["admitted", "prepared"].includes(current.status)) throw error;
				const code =
					isRecord(error) && typeof error.code === "string"
						? error.code
						: error instanceof Error && "code" in error
							? String(error.code)
							: "PREPARATION_FAILED";
				const message = error instanceof Error ? error.message : String(error);
				if (
					current.claimOwner !== this.coordinatorId ||
					current.claimRevision !== (entry?.claimRevision ?? job.claimRevision)
				)
					throw error;
				if (code === "PREPARATION_BUSY") {
					this.savePublicResult(job.queueJobId, {
						status: current.status,
						usage: { wallTimeMs: 0, diskBytes: 0 },
						processEvidence: null,
						logs: { stdout: null, stderr: null, error: `${code}: ${message}` },
					});
					return;
				}
				let cleanup: CoordinatorAdapterObservation | null = null;
				if (prepared && adapter) {
					const cleanupAdapter = adapter,
						cleanupHandle = prepared;
					entry ??= { adapter, claimRevision: current.claimRevision, handle: prepared };
					cleanup = await this.withHeartbeat(current, entry, () => cleanupAdapter.abandonPrepared(cleanupHandle));
				} else if (intent) {
					if (!adapter?.abandonPreparation)
						throw new StudyExecutionCoordinatorError(
							"PREPARATION_CLEANUP_REQUIRED",
							`Cannot release reservation until partial preparation is reconciled: ${message}`,
						);
					const cleanupAdapter = adapter,
						cleanupIntent = intent;
					entry ??= { adapter, claimRevision: current.claimRevision, handle: intent };
					cleanup = await this.withHeartbeat(current, entry, () =>
						cleanupAdapter.abandonPreparation!(cleanupIntent),
					);
				}
				if (cleanup && !isTerminal(cleanup.status))
					throw new StudyExecutionCoordinatorError(
						"PREPARATION_CLEANUP_INCOMPLETE",
						"Preparation cleanup did not prove a terminal process state",
					);
				const usage = {
					wallTimeMs: Math.max(Date.now() - startedAt, cleanup?.usage.wallTimeMs ?? 0),
					diskBytes: cleanup?.usage.diskBytes ?? 0,
				};
				this.transaction(() => {
					const settled = this.queue.recordPrelaunchFailure({
						jobId: job.queueJobId,
						claimOwner: this.coordinatorId,
						expectedClaimRevision: entry?.claimRevision ?? job.claimRevision,
						usage,
						message: `${code}: ${message}`,
					});
					this.savePublicResult(job.queueJobId, {
						status: settled.status,
						usage,
						processEvidence: null,
						logs: { stdout: null, stderr: null, error: `${code}: ${message}` },
					});
				});
				this.active.delete(job.queueJobId);
			}
			return;
		}
		if (job.status === "prepared") {
			const payload = this.readPayloadForJob(job);
			const adapter = this.adapterFor(payload);
			const entry: ActiveLease = { adapter, claimRevision: job.claimRevision, handle: emptyHandle() };
			if (job.cancellationRequestedAt !== null) {
				const lease = this.queue.acquirePreparedCancellation(
					job.queueJobId,
					this.coordinatorId,
					entry.claimRevision,
				);
				entry.claimRevision = lease.job.claimRevision;
				entry.handle = lease.handle;
				this.active.set(job.queueJobId, entry);
				await this.observe(
					job.queueJobId,
					entry,
					await this.withHeartbeat(lease.job, entry, () => adapter.abandonPrepared(lease.handle)),
				);
				return;
			}
			const lease = this.queue.beginPreparedLaunch(job.queueJobId, this.coordinatorId, entry.claimRevision);
			entry.claimRevision = lease.job.claimRevision;
			entry.handle = lease.handle;
			this.active.set(job.queueJobId, entry);
			await this.launchLease(lease, entry);
			return;
		}
		throw new StudyExecutionCoordinatorError("COORDINATOR_STATE_INVALID", `cannot drive claimed ${job.status} job`);
	}

	private async launchPrepared(job: ExecutionQueueJob, entry: ActiveLease): Promise<void> {
		const lease = this.queue.beginPreparedLaunch(job.queueJobId, this.coordinatorId, entry.claimRevision);
		entry.claimRevision = lease.job.claimRevision;
		entry.handle = lease.handle;
		await this.launchLease(lease, entry);
	}

	private async launchLease(lease: PreparedLaunchLease, entry: ActiveLease): Promise<void> {
		const observation = await this.withHeartbeat(lease.job, entry, () => entry.adapter.launch(lease.handle));
		await this.observe(lease.job.queueJobId, entry, observation);
	}

	private async pollActive(job: ExecutionQueueJob): Promise<void> {
		const entry = this.active.get(job.queueJobId);
		if (!entry || job.claimOwner !== this.coordinatorId || job.claimRevision !== entry.claimRevision) {
			this.active.delete(job.queueJobId);
			return;
		}
		const observation = await this.withHeartbeat(job, entry, () =>
			job.cancellationRequestedAt === null ? entry.adapter.poll(entry.handle) : entry.adapter.cancel(entry.handle),
		);
		await this.observe(job.queueJobId, entry, observation);
	}

	private async recoverReconciliation(job: ExecutionQueueJob): Promise<void> {
		const payload = this.readPayloadForJob(job);
		const adapter = this.adapterFor(payload);
		const lease = this.queue.acquireReconciliation(job.queueJobId, this.coordinatorId);
		const entry: ActiveLease = { adapter, claimRevision: lease.job.claimRevision, handle: lease.handle };
		this.active.set(job.queueJobId, entry);
		const observation = await this.withHeartbeat(lease.job, entry, () =>
			lease.job.cancellationRequestedAt === null ? adapter.poll(lease.handle) : adapter.cancel(lease.handle),
		);
		await this.observe(job.queueJobId, entry, observation);
	}

	private async observe(
		queueJobId: string,
		entry: ActiveLease,
		observation: CoordinatorAdapterObservation,
	): Promise<void> {
		validateObservation(observation);
		this.transaction(() => {
			const current = this.queue.getJob(queueJobId);
			if (current.claimOwner !== this.coordinatorId || current.claimRevision !== entry.claimRevision) {
				throw new StudyExecutionCoordinatorError(
					"COORDINATOR_CLAIM_STALE",
					"adapter observation belongs to a stale queue claim",
				);
			}
			if (observation.status === "launching") {
				this.savePublicResult(queueJobId, observation);
				return;
			}
			if (observation.status === "running") {
				if (current.cancellationRequestedAt === null) this.confirmRunning(queueJobId, entry, observation);
				this.savePublicResult(queueJobId, observation);
				return;
			}
			if (
				current.cancellationRequestedAt === null &&
				(observation.status === "succeeded" || observation.status === "limit-reached")
			) {
				this.confirmRunning(queueJobId, entry, observation);
			}
			const settled = this.queue.recordTerminalReceipt({
				jobId: queueJobId,
				claimOwner: this.coordinatorId,
				expectedClaimRevision: entry.claimRevision,
				status: observation.status,
				usage: observation.usage,
			});
			this.savePublicResult(queueJobId, {
				...observation,
				status: settled.status as CoordinatorAdapterObservation["status"],
			});
			if (isTerminal(settled.status)) this.active.delete(queueJobId);
		});
	}

	private confirmRunning(queueJobId: string, entry: ActiveLease, observation: CoordinatorAdapterObservation): void {
		if (!observation.processEvidence) {
			throw new StudyExecutionCoordinatorError(
				"POSITIVE_PROCESS_EVIDENCE_REQUIRED",
				"success, limit, and running observations require correlated process evidence",
			);
		}
		const current = this.queue.getJob(queueJobId);
		if (current.status === "running") return;
		this.queue.confirmRunning(queueJobId, this.coordinatorId, entry.claimRevision, observation.processEvidence);
	}

	/** Maintains the exact mutable claim revision while a long prepare/launch/poll call is in flight. */
	private async withHeartbeat<T>(job: ExecutionQueueJob, entry: ActiveLease, work: () => Promise<T>): Promise<T> {
		let complete = false;
		let finishWait!: () => void;
		const finished = new Promise<void>((resolve) => {
			finishWait = resolve;
		});
		const beat = async () => {
			while (!complete) {
				const remaining = Math.max(1_000, Date.parse(job.leaseExpiresAt ?? "") - Date.now());
				const delay = Math.max(250, Math.floor(remaining / 3));
				const continueBeating = await waitForHeartbeatDelay(delay, finished);
				if (!continueBeating || complete) return;
				const renewed = this.queue.heartbeat(job.queueJobId, this.coordinatorId, entry.claimRevision);
				entry.claimRevision = renewed.claimRevision;
				job = renewed;
			}
		};
		// Attach the rejection handler immediately while preparation is still in flight.
		// Its failure is propagated after work stops; it is never an unhandled rejection.
		let heartbeatFailure: unknown;
		const heartbeat = beat().catch((error: unknown) => {
			heartbeatFailure = error;
		});
		let outcome: { ok: true; value: T } | { ok: false; error: unknown };
		try {
			outcome = { ok: true, value: await work() };
		} catch (error) {
			outcome = { ok: false, error };
		} finally {
			complete = true;
			finishWait();
			await heartbeat;
		}
		if (heartbeatFailure !== undefined) {
			if (!outcome.ok)
				throw new AggregateError(
					[outcome.error, heartbeatFailure],
					"Execution work and its queue heartbeat both failed",
				);
			throw heartbeatFailure;
		}
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}

	private readPayloadForJob(job: ExecutionQueueJob): FrozenExecutionPayload {
		const row = this.readStoredPayloadRow(job.queueJobId);
		if (!row) {
			throw new StudyExecutionCoordinatorError(
				"FROZEN_PAYLOAD_MISSING",
				"a claimed queue job has no durable frozen execution payload",
			);
		}
		const payload = this.decodeStored<FrozenExecutionPayload>(row, "frozen execution payload");
		const valid = validateFrozenExecutionPayload(payload);
		assertFrozenPayloadIdentity(valid, identityForJob(job));
		if (frozenPayloadHash(valid) !== row.payloadHash) {
			throw new StudyExecutionCoordinatorError(
				"FROZEN_PAYLOAD_CORRUPT",
				"frozen execution payload hash does not match",
			);
		}
		return valid;
	}

	private adapterFor(payload: FrozenExecutionPayload): StudyExecutionAdapter {
		const adapter = this.adapters.get(payload.environment.adapterKind);
		if (!adapter) {
			throw new StudyExecutionCoordinatorError(
				"EXECUTION_ADAPTER_UNAVAILABLE",
				`no trusted adapter is registered for ${payload.environment.adapterKind}`,
			);
		}
		return adapter;
	}

	private listPayloadJobIds(): string[] {
		return (
			this.database
				.prepare("SELECT queue_job_id AS queueJobId FROM pi_study_execution_frozen_payload ORDER BY queue_job_id")
				.all() as Array<{ queueJobId: string }>
		).map((row) => row.queueJobId);
	}

	private readStoredPayloadRow(queueJobId: string): StoredPayloadRow | null {
		const row = this.database
			.prepare(
				"SELECT queue_job_id AS queueJobId, payload, payload_hash AS payloadHash FROM pi_study_execution_frozen_payload WHERE queue_job_id = ?",
			)
			.get(queueJobId) as StoredPayloadRow | undefined;
		return row ?? null;
	}

	private savePublicResult(
		queueJobId: string,
		observation: Omit<CoordinatorAdapterObservation, "status"> & { status: ExecutionQueueJob["status"] },
	): void {
		const result: CoordinatorPublicResult = {
			queueJobId,
			status: observation.status,
			usage: structuredClone(observation.usage),
			logs: redactLogs(observation.logs),
			observedAt: new Date().toISOString(),
		};
		this.database
			.prepare(
				"INSERT INTO pi_study_execution_coordinator_result (queue_job_id, payload, payload_hash) VALUES (?, ?, ?) ON CONFLICT(queue_job_id) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash",
			)
			.run(queueJobId, stableStringify(result), contentHash(result));
	}

	private decodeStored<T>(row: { payload: string; payloadHash: string }, label: string): T {
		if (typeof row.payload !== "string" || typeof row.payloadHash !== "string") {
			throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", `${label} row is malformed`);
		}
		let value: unknown;
		try {
			value = JSON.parse(row.payload);
		} catch {
			throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", `${label} contains invalid JSON`);
		}
		if (contentHash(value) !== row.payloadHash) {
			throw new StudyExecutionCoordinatorError(
				"COORDINATOR_STORE_CORRUPT",
				`${label} failed integrity verification`,
			);
		}
		return value as T;
	}

	private readDetachedWorker(launchKey: string): DetachedCoordinatorWorkerRecord | null {
		const row = this.database
			.prepare(
				"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_detached_worker WHERE launch_key = ?",
			)
			.get(launchKey) as StoredResultRow | undefined;
		return row ? validateDetachedWorkerRecord(this.decodeStored<unknown>(row, "detached coordinator worker")) : null;
	}

	private saveDetachedWorker(record: DetachedCoordinatorWorkerRecord): void {
		const valid = validateDetachedWorkerRecord(record);
		this.database
			.prepare(
				"INSERT INTO pi_study_execution_detached_worker (launch_key, payload, payload_hash) VALUES (?, ?, ?) ON CONFLICT(launch_key) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash",
			)
			.run(valid.launchKey, stableStringify(valid), contentHash(valid));
	}

	private detachedLeaseExpiry(durationMs: number): string {
		return new Date(Date.now() + durationMs).toISOString();
	}

	private timestamp(): string {
		return new Date().toISOString();
	}

	private transaction<T>(work: () => T): T {
		const nested = this.database.isTransaction;
		this.database.exec(nested ? "SAVEPOINT study_coordinator_composition" : "BEGIN IMMEDIATE");
		try {
			const result = work();
			this.database.exec(nested ? "RELEASE study_coordinator_composition" : "COMMIT");
			return result;
		} catch (error) {
			this.database.exec(nested ? "ROLLBACK TO study_coordinator_composition" : "ROLLBACK");
			if (nested) this.database.exec("RELEASE study_coordinator_composition");
			throw error;
		}
	}
}

/**
 * Starts at most one live worker for the named coordinator in this SQLite database. The returned
 * value is a launch request only: the child must later activate the durable token itself.
 */
export async function ensureDetachedStudyExecutionCoordinator(
	database: DatabaseSync,
	options: DetachedCoordinatorLaunchOptions,
): Promise<DetachedCoordinatorLaunchRequest> {
	ensureDetachedWorkerTable(database);
	const launch = normalizeDetachedCoordinatorLaunch(options);
	const claim = inDetachedTransaction(database, () => {
		const existing = readDetachedWorkerRecord(database, launch.launchKey);
		if (existing && Date.parse(existing.leaseExpiresAt) > Date.now()) {
			assertDetachedLaunchMatches(existing, launch);
			return { action: "wait" as const, existing };
		}
		const workerToken = randomUUID();
		const starting: DetachedCoordinatorWorkerRecord = {
			version: 1,
			launchKey: launch.launchKey,
			coordinatorId: launch.coordinatorId,
			workerToken,
			processId: null,
			processCreationIdentity: null,
			status: "starting",
			databasePath: launch.databasePath,
			scriptPath: launch.scriptPath,
			runRootDirectory: launch.runRootDirectory,
			artifactDirectory: launch.artifactDirectory,
			nodeExecutablePath: launch.nodeExecutablePath,
			intervalMs: launch.intervalMs,
			workerLeaseMs: launch.workerLeaseMs,
			launchedAt: new Date().toISOString(),
			lastHeartbeatAt: null,
			leaseExpiresAt: new Date(Date.now() + launch.workerLeaseMs).toISOString(),
			lastError: null,
		};
		saveDetachedWorkerRecord(database, starting);
		return { action: "spawn" as const, workerToken };
	});
	if (claim.action === "wait") return detachedWorkerWaitRequest(claim.existing);
	const { workerToken } = claim;
	try {
		const child = await spawnDetachedCoordinator(launch, workerToken);
		const childProcessId = child.pid;
		if (typeof childProcessId !== "number" || !Number.isSafeInteger(childProcessId) || childProcessId < 1) {
			throw new StudyExecutionCoordinatorError(
				"DETACHED_COORDINATOR_SPAWN_FAILED",
				"detached coordinator child did not expose a valid process id",
			);
		}
		const processId = childProcessId;
		const processCreationIdentity = currentDetachedCoordinatorProcessIdentity(processId);
		inDetachedTransaction(database, () => {
			const current = readDetachedWorkerRecord(database, launch.launchKey);
			if (!current || current.workerToken !== workerToken) {
				throw new StudyExecutionCoordinatorError(
					"DETACHED_COORDINATOR_FENCED",
					"detached coordinator launch request was replaced before its process was recorded",
				);
			}
			if (
				current.status === "active" &&
				(current.processId !== processId || current.processCreationIdentity !== processCreationIdentity)
			) {
				throw new StudyExecutionCoordinatorError(
					"DETACHED_COORDINATOR_FENCED",
					"child activated with a process identity different from the launched process",
				);
			}
			if (current.status === "starting") {
				saveDetachedWorkerRecord(database, { ...current, processId, processCreationIdentity });
			}
		});
		child.unref();
		return {
			launchKey: launch.launchKey,
			coordinatorId: launch.coordinatorId,
			processId,
			status: "started",
			ready: false,
		};
	} catch (error) {
		inDetachedTransaction(database, () => {
			const current = readDetachedWorkerRecord(database, launch.launchKey);
			if (current?.workerToken === workerToken && current.status === "starting" && current.processId === null) {
				database
					.prepare("DELETE FROM pi_study_execution_detached_worker WHERE launch_key = ?")
					.run(launch.launchKey);
			}
		});
		throw error;
	}
}

/**
 * The only initial native adapter. It proves the exact Node executable bytes, then proves the
 * Windows runner snapshot contains the same digest. Python/R refuse execution until a complete
 * environment-file verifier is supplied; their descriptor hash is never treated as proof alone.
 */
export function createNativeWindowsNodeAdapter(options: StudyWindowsNativeAdapterOptions): StudyExecutionAdapter {
	const runRootDirectory = resolveRequiredDirectory(options.runRootDirectory, "runRootDirectory");
	if (!Number.isSafeInteger(options.cpuRatePercent) || options.cpuRatePercent < 1 || options.cpuRatePercent > 100) {
		throw new StudyExecutionCoordinatorError("NATIVE_ADAPTER_CONFIG_INVALID", "cpuRatePercent must be 1..100");
	}
	return {
		kind: "native-windows-node-v1",
		createPreparationIntent() {
			return {
				kind: "native-windows-node-v1",
				version: 1,
				privateHandle: {
					locator: { runRootDirectory, preparationIdentity: { runId: randomUUID(), cancelToken: randomUUID() } },
				},
				publicSummary: { language: "node", preparationPending: true },
			};
		},
		async abandonPreparation(intent) {
			const result = await abandonIsolatedWindowsPreparation(nodePreparationLocator(intent, runRootDirectory));
			return {
				status: result.status,
				usage: { wallTimeMs: result.wallTimeMs, diskBytes: result.diskBytes },
				processEvidence: null,
				logs: { stdout: null, stderr: null, error: null },
			};
		},
		async prepare(input, intent) {
			if (input.payload.language !== "node") {
				throw new StudyExecutionCoordinatorError(
					"ENVIRONMENT_VERIFIER_UNAVAILABLE",
					"Python and R require a complete verified environment-file manifest before native execution",
				);
			}
			await verifyNodeEnvironment(input.payload);
			const cpuBinding = nativeCpuBinding(input.job.resources.cpuMilliCores, options.cpuRatePercent);
			const preparationIdentity = intent
				? nodePreparationLocator(intent, runRootDirectory).preparationIdentity
				: { runId: randomUUID(), cancelToken: randomUUID() };
			let staging: StagedNodePayload | null = null;
			let runner: IsolatedWindowsRunHandle | null = null;
			let prepared: PreparedExecutionHandle | null = null;
			let preparationFailure: unknown = null;
			let runnerAbandoned = false;
			try {
				const materializedStaging = await materializePayload(input, runRootDirectory, preparationIdentity.runId);
				staging = materializedStaging;
				await options.afterMaterializeForTesting?.({
					stagingDirectory: materializedStaging.directory,
					programFileName: input.payload.program.fileName,
					inputFileNames: input.payload.inputs.map((item, index) => nodeStagingInputFileName(item.name, index)),
				});
				runner = await prepareIsolatedWindowsRun({
					runRootDirectory,
					preparationIdentity,
					language: "node",
					executablePath: input.payload.environment.executablePath,
					programPath: join(materializedStaging.directory, input.payload.program.fileName),
					inputPaths: input.payload.inputs.map((item, index) =>
						join(materializedStaging.directory, nodeStagingInputFileName(item.name, index)),
					),
					limits: {
						memoryBytes: input.job.resources.memoryMiB * 1_024 * 1_024,
						cpuRatePercent: cpuBinding.actualCpuRatePercent,
						wallTimeMs: input.job.resources.wallTimeMs,
						outputLimitBytes: input.payload.outputLimitBytes,
					},
				});
				if (runner.runId !== preparationIdentity.runId || runner.cancelToken !== preparationIdentity.cancelToken) {
					throw new StudyExecutionCoordinatorError(
						"NODE_PREPARATION_IDENTITY_MISMATCH",
						"runner did not preserve the queue-persisted native preparation identity",
					);
				}
				await verifyNodeEnvironment(input.payload);
				await verifyRunnerSnapshotContainsExecutable(runner, input.payload);
				prepared = {
					kind: "native-windows-node-v1",
					version: 1,
					privateHandle: {
						runner,
						payloadHash: input.payloadHash,
						compiledProgramHash: contentHash(input.payload.program.content),
						compiledProgramProtocol: "direct-node-v1",
						cpuBinding,
					},
					publicSummary: {
						runId: runner.runId,
						language: input.payload.language,
						payloadHash: input.payloadHash,
						compiledProgramHash: contentHash(input.payload.program.content),
						cpuBinding,
					},
				};
			} catch (error) {
				preparationFailure = error;
				if (runner) {
					try {
						await abandonPreparedIsolatedWindowsRun(runner);
						runnerAbandoned = true;
					} catch (cleanupError) {
						preparationFailure = preparedNodeRunnerCleanupFailure(error, cleanupError);
					}
				}
			}
			if (staging) {
				let cleanupTriggerFailure: unknown = null;
				try {
					await options.beforeStagingCleanupForTesting?.({ stagingDirectory: staging.directory });
				} catch (error) {
					cleanupTriggerFailure = error;
				}
				let cleanupFailure: unknown = null;
				try {
					await cleanupMaterializedPayload(staging);
				} catch (error) {
					cleanupFailure = error;
				}
				if (cleanupTriggerFailure || cleanupFailure) {
					let runnerAbandonmentFailure: unknown = null;
					if (runner && !runnerAbandoned) {
						try {
							await abandonPreparedIsolatedWindowsRun(runner);
							runnerAbandoned = true;
						} catch (error) {
							runnerAbandonmentFailure = error;
						}
					}
					throw nodeStagingCleanupFailure({
						staging,
						preparationFailure,
						cleanupTriggerFailure,
						cleanupFailure,
						runnerWasAbandoned: runnerAbandoned,
						runnerAbandonmentFailure,
					});
				}
			}
			if (preparationFailure) throw preparationFailure;
			if (!prepared) {
				throw new StudyExecutionCoordinatorError(
					"NODE_PREPARATION_INVALID",
					"native Node preparation completed without a prepared runner handle",
				);
			}
			return prepared;
		},
		async launch(handle) {
			const runner = nativeHandle(handle);
			return observeWindowsStatus(await launchPreparedIsolatedWindowsRun(runner), runner);
		},
		async poll(handle) {
			const runner = nativeHandle(handle);
			return observeWindowsStatus(await reconcileIsolatedWindowsRun(runner), runner);
		},
		async cancel(handle) {
			const runner = nativeHandle(handle);
			return observeWindowsStatus(await cancelIsolatedWindowsRun(runner), runner);
		},
		async abandonPrepared(handle) {
			const runner = nativeHandle(handle);
			return observeWindowsStatus(await abandonPreparedIsolatedWindowsRun(runner), runner);
		},
	};
}

function nodePreparationLocator(
	intent: PreparedExecutionHandle,
	runRootDirectory: string,
): IsolatedWindowsPreparedRunLocator {
	const locator = isRecord(intent.privateHandle) ? intent.privateHandle.locator : null;
	if (
		intent.kind !== "native-windows-node-v1" ||
		intent.version !== 1 ||
		!isRecord(locator) ||
		locator.runRootDirectory !== runRootDirectory ||
		!isRecord(locator.preparationIdentity) ||
		typeof locator.preparationIdentity.runId !== "string" ||
		typeof locator.preparationIdentity.cancelToken !== "string"
	) {
		throw new StudyExecutionCoordinatorError("NATIVE_HANDLE_INVALID", "Node preparation intent is invalid");
	}
	return {
		runRootDirectory,
		preparationIdentity: {
			runId: locator.preparationIdentity.runId,
			cancelToken: locator.preparationIdentity.cancelToken,
		},
	};
}

function identityForJob(job: ExecutionQueueJob): FrozenExecutionPayloadIdentity {
	return { taskId: job.taskId, projectId: job.projectId, sessionId: job.sessionId, manifest: job.manifest };
}

function nativeCpuBinding(
	requestedCpuMilliCores: number,
	configuredMaximumPercent: number,
): {
	requestedCpuMilliCores: number;
	logicalCores: number;
	actualCpuRatePercent: number;
} {
	const logicalCores = cpus().length;
	if (!Number.isSafeInteger(logicalCores) || logicalCores < 1) {
		throw new StudyExecutionCoordinatorError(
			"NATIVE_CPU_CAPACITY_UNAVAILABLE",
			"the native adapter cannot determine the machine's logical CPU capacity",
		);
	}
	const capacityMilliCores = logicalCores * 1_000;
	const requestedPercent = Math.floor((requestedCpuMilliCores * 100) / capacityMilliCores);
	if (requestedPercent < 1) {
		throw new StudyExecutionCoordinatorError(
			"NATIVE_CPU_GRANULARITY_UNSUPPORTED",
			`requested ${requestedCpuMilliCores}m is below the Windows Job 1% granularity for ${logicalCores} logical cores`,
		);
	}
	return {
		requestedCpuMilliCores,
		logicalCores,
		actualCpuRatePercent: Math.min(requestedPercent, configuredMaximumPercent),
	};
}

function emptyHandle(): PreparedExecutionHandle {
	return { kind: "coordinator-placeholder", version: 1, privateHandle: {}, publicSummary: {} };
}

function isTerminal(status: string): boolean {
	return TERMINAL.has(status);
}

function validateObservation(value: CoordinatorAdapterObservation): void {
	if (!ADAPTER_STATUS.has(value.status)) {
		throw new StudyExecutionCoordinatorError("ADAPTER_OBSERVATION_INVALID", "adapter returned an invalid status");
	}
	for (const [name, amount] of Object.entries(value.usage)) {
		if (!Number.isSafeInteger(amount) || amount < 0) {
			throw new StudyExecutionCoordinatorError(
				"ADAPTER_OBSERVATION_INVALID",
				`${name} must be a non-negative integer`,
			);
		}
	}
	if (value.processEvidence !== null && (typeof value.processEvidence !== "string" || !value.processEvidence.trim())) {
		throw new StudyExecutionCoordinatorError(
			"ADAPTER_OBSERVATION_INVALID",
			"process evidence must be meaningful text or null",
		);
	}
}

function redactLogs(logs: CoordinatorPublicLogs): CoordinatorPublicLogs {
	return {
		stdout: redactLog(logs.stdout),
		stderr: redactLog(logs.stderr),
		error: redactLog(logs.error),
	};
}

function redactLog(value: string | null): string | null {
	if (value === null) return null;
	if (typeof value !== "string")
		throw new StudyExecutionCoordinatorError("ADAPTER_OBSERVATION_INVALID", "public logs must be text or null");
	const redacted = redactCredentials(value)
		.replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/gu, "[local path]")
		.replace(/\\\\[^\r\n"'<>]*/gu, "[local path]");
	return redacted.length <= 20_000 ? redacted : `${redacted.slice(0, 20_000)}\n[truncated]`;
}

function redactCredentials(value: string): string {
	return value
		.replace(/("(?:token|secret|password|credential|authorization|cookie)"\s*:\s*")[^"\r\n]*(")/giu, "$1[redacted]$2")
		.replace(/((?:token|secret|password|credential|authorization|cookie)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
		.replace(/(bearer\s+)[^\s,;]+/giu, "$1[redacted]");
}

interface StagedNodePayload {
	directory: string;
	canonicalDirectory: string;
	directoryIdentity: Stats;
	canonicalPayloadRoot: string;
	payloadRootIdentity: Stats;
	files: Map<string, Stats>;
	stagingIdentity: string;
}

async function materializePayload(
	input: CoordinatorAdapterPreparation,
	runRootDirectory: string,
	stagingIdentity: string,
): Promise<StagedNodePayload> {
	const queueJobId = privateNodeStagingPathSegment(input.job.queueJobId, "queue job id");
	const payloadHash = privateNodeStagingPayloadHash(input.payloadHash);
	const runId = privateNodeStagingPathSegment(stagingIdentity, "run id");
	const stagingRoot = join(runRootDirectory, "private-node-payloads");
	const queueRoot = join(stagingRoot, queueJobId);
	const payloadRoot = join(queueRoot, payloadHash);
	const directory = join(payloadRoot, `run-${runId}`);
	await mkdir(runRootDirectory, { recursive: true });
	const canonicalRunRoot = await canonicalNodeStagingDirectory(runRootDirectory, "run root");
	if (!isChild(canonicalRunRoot.path, stagingRoot)) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_REJECTED",
			"private Node staging path escaped its configured root",
		);
	}
	await mkdir(payloadRoot, { recursive: true });
	const canonicalPayloadRoot = await canonicalNodeStagingDirectory(payloadRoot, "payload root");
	if (!isChild(canonicalRunRoot.path, canonicalPayloadRoot.path)) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_REJECTED",
			"private Node payload root escaped its configured run root",
		);
	}
	try {
		await mkdir(directory);
	} catch (error) {
		if (isNodeError(error, "EEXIST")) {
			throw new StudyExecutionCoordinatorError(
				"NODE_STAGING_IDENTITY_BUSY",
				"a private Node staging identity is already materialized and requires fenced recovery",
			);
		}
		throw error;
	}
	let staging: StagedNodePayload | null = null;
	try {
		const canonicalDirectory = await canonicalNodeStagingDirectory(directory, "staging directory");
		if (!isChild(canonicalPayloadRoot.path, canonicalDirectory.path)) {
			throw new StudyExecutionCoordinatorError(
				"NODE_STAGING_REJECTED",
				"private Node staging directory escaped its payload root",
			);
		}
		staging = {
			directory,
			canonicalDirectory: canonicalDirectory.path,
			directoryIdentity: canonicalDirectory.identity,
			canonicalPayloadRoot: canonicalPayloadRoot.path,
			payloadRootIdentity: canonicalPayloadRoot.identity,
			files: new Map<string, Stats>(),
			stagingIdentity: runId,
		};
		await writeStagedNodeFile(staging, input.payload.program.fileName, input.payload.program.content, "utf8");
		for (const [index, item] of input.payload.inputs.entries()) {
			await writeStagedNodeFile(staging, nodeStagingInputFileName(item.name, index), decodeFrozenInput(item));
		}
		return staging;
	} catch (error) {
		if (!staging) throw error;
		try {
			await cleanupMaterializedPayload(staging);
		} catch (cleanupError) {
			throw nodeStagingCleanupFailure({
				staging,
				preparationFailure: error,
				cleanupTriggerFailure: null,
				cleanupFailure: cleanupError,
				runnerWasAbandoned: false,
				runnerAbandonmentFailure: null,
			});
		}
		throw error;
	}
}

function nodeStagingInputFileName(name: string, index: number): string {
	return `input-${index}${extname(name) || ".bin"}`;
}

async function writeStagedNodeFile(
	staging: StagedNodePayload,
	fileName: string,
	contents: string | Uint8Array,
	encoding?: BufferEncoding,
): Promise<void> {
	if (!isDirectNodeStagingFileName(fileName)) {
		throw new StudyExecutionCoordinatorError("NODE_STAGING_REJECTED", "staged Node file name is invalid");
	}
	const path = join(staging.directory, fileName);
	const file = await open(path, "wx");
	try {
		let writeFailure: unknown = null;
		try {
			if (encoding) await file.writeFile(contents as string, encoding);
			else await file.writeFile(contents as Uint8Array);
		} catch (error) {
			writeFailure = error;
		}
		const identity = await file.stat();
		if (!identity.isFile()) {
			throw new StudyExecutionCoordinatorError("NODE_STAGING_REJECTED", "staged Node entry is not a regular file");
		}
		staging.files.set(fileName, identity);
		if (writeFailure) throw writeFailure;
	} finally {
		await file.close();
	}
}

async function cleanupMaterializedPayload(staging: StagedNodePayload): Promise<void> {
	const payloadRoot = await canonicalNodeStagingDirectory(staging.canonicalPayloadRoot, "payload root");
	if (!sameNodeStagingIdentity(staging.payloadRootIdentity, payloadRoot.identity)) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_PATH_CHANGED",
			"private Node payload root changed before cleanup",
		);
	}
	const directory = await canonicalNodeStagingDirectory(staging.directory, "staging directory");
	if (
		directory.path !== staging.canonicalDirectory ||
		!sameNodeStagingIdentity(staging.directoryIdentity, directory.identity) ||
		!isChild(payloadRoot.path, directory.path)
	) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_PATH_CHANGED",
			"private Node staging directory changed before cleanup",
		);
	}
	const entries = await readdir(directory.path, { withFileTypes: true });
	if (entries.some((entry) => !staging.files.has(entry.name))) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_CONTENT_CHANGED",
			"private Node staging directory contains an unexpected entry",
		);
	}
	for (const [fileName, expectedIdentity] of staging.files) {
		const path = join(directory.path, fileName);
		let before: Stats;
		try {
			before = await lstat(path);
		} catch (error) {
			// A runner-prepare failure can remove an owned source before it returns. It is safe to
			// leave that absent entry alone; additions and substitutions still fail closed above/below.
			if (isNodeError(error, "ENOENT")) continue;
			throw error;
		}
		if (!before.isFile() || before.isSymbolicLink() || !sameNodeStagingIdentity(expectedIdentity, before)) {
			throw new StudyExecutionCoordinatorError(
				"NODE_STAGING_CONTENT_CHANGED",
				"private staged Node file changed before cleanup",
			);
		}
		const canonicalPath = await realpath(path);
		if (!isChild(directory.path, canonicalPath) || resolve(canonicalPath) !== resolve(path)) {
			throw new StudyExecutionCoordinatorError(
				"NODE_STAGING_REPARSE_REJECTED",
				"private staged Node file resolves outside staging",
			);
		}
		const after = await lstat(canonicalPath);
		if (!after.isFile() || after.isSymbolicLink() || !sameNodeStagingIdentity(before, after)) {
			throw new StudyExecutionCoordinatorError(
				"NODE_STAGING_PATH_CHANGED",
				"private staged Node file changed during cleanup",
			);
		}
		await unlink(canonicalPath);
	}
	const beforeRemove = await lstat(directory.path);
	if (
		!beforeRemove.isDirectory() ||
		beforeRemove.isSymbolicLink() ||
		!sameNodeStagingIdentity(staging.directoryIdentity, beforeRemove)
	) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_PATH_CHANGED",
			"private Node staging directory changed during cleanup",
		);
	}
	await rmdir(directory.path);
}

function canonicalNodeStagingDirectory(path: string, label: string): Promise<{ path: string; identity: Stats }> {
	return resolveStableNodeStagingDirectory(path, label, "NODE_STAGING_REPARSE_REJECTED", "NODE_STAGING_PATH_CHANGED");
}

async function resolveStableNodeStagingDirectory(
	path: string,
	label: string,
	reparseCode: string,
	changedCode: string,
): Promise<{ path: string; identity: Stats }> {
	const before = await lstat(path);
	if (!before.isDirectory() || before.isSymbolicLink()) {
		throw new StudyExecutionCoordinatorError(reparseCode, `${label} is not a concrete directory`);
	}
	const canonical = await realpath(path);
	const after = await lstat(canonical);
	if (!after.isDirectory() || after.isSymbolicLink() || !sameNodeStagingIdentity(before, after)) {
		throw new StudyExecutionCoordinatorError(changedCode, `${label} changed while it was being resolved`);
	}
	return { path: canonical, identity: after };
}

function privateNodeStagingPathSegment(value: string, label: string): string {
	if (!value || value.length > 255 || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_REJECTED",
			`${label} is not a safe private Node staging path segment`,
		);
	}
	return value;
}

function privateNodeStagingPayloadHash(value: string): string {
	if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
		throw new StudyExecutionCoordinatorError(
			"NODE_STAGING_REJECTED",
			"payload hash is not a SHA-256 private staging path segment",
		);
	}
	return value.slice("sha256:".length);
}

function isDirectNodeStagingFileName(value: string): boolean {
	return !!value && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function sameNodeStagingIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function preparedNodeRunnerCleanupFailure(original: unknown, cleanupError: unknown): StudyExecutionCoordinatorError {
	return new StudyExecutionCoordinatorError(
		"NODE_PREPARE_CLEANUP_FAILED",
		`prepared snapshot verification failed (${nodeErrorText(original)}); runner abandonment also failed (${nodeErrorText(cleanupError)})`,
	);
}

function nodeStagingCleanupFailure(input: {
	staging: StagedNodePayload;
	preparationFailure: unknown;
	cleanupTriggerFailure: unknown;
	cleanupFailure: unknown;
	runnerWasAbandoned: boolean;
	runnerAbandonmentFailure: unknown;
}): StudyExecutionCoordinatorError {
	const failures = [
		input.preparationFailure ? `preparation failed (${nodeErrorText(input.preparationFailure)})` : null,
		input.cleanupTriggerFailure ? `cleanup trigger failed (${nodeErrorText(input.cleanupTriggerFailure)})` : null,
		input.cleanupFailure ? `staging cleanup failed (${nodeErrorText(input.cleanupFailure)})` : null,
		input.runnerWasAbandoned ? "prepared runner was abandoned" : null,
		input.runnerAbandonmentFailure
			? `runner abandonment failed (${nodeErrorText(input.runnerAbandonmentFailure)})`
			: null,
	].filter((value): value is string => value !== null);
	return new StudyExecutionCoordinatorError(
		"NODE_STAGING_CLEANUP_FAILED",
		`private Node staging ${input.staging.stagingIdentity} could not be cleaned after snapshot preparation: ${failures.join("; ")}`,
	);
}

function nodeErrorText(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

async function verifyNodeEnvironment(payload: FrozenExecutionPayload): Promise<void> {
	const executable = payload.environment.files.find(
		(file) => file.absolutePath === payload.environment.executablePath,
	);
	if (!executable)
		throw new StudyExecutionCoordinatorError(
			"ENVIRONMENT_BINDING_INVALID",
			"Node executable is not in its frozen file list",
		);
	for (const file of payload.environment.files) {
		const bytes = await readFile(file.absolutePath);
		if (executionSha256(bytes) !== file.sha256) {
			throw new StudyExecutionCoordinatorError(
				"ENVIRONMENT_BINDING_MISMATCH",
				`environment file changed: ${file.absolutePath}`,
			);
		}
	}
}

async function verifyRunnerSnapshotContainsExecutable(
	handle: IsolatedWindowsRunHandle,
	payload: FrozenExecutionPayload,
): Promise<void> {
	const executable = payload.environment.files.find(
		(file) => file.absolutePath === payload.environment.executablePath,
	);
	if (!executable)
		throw new StudyExecutionCoordinatorError("ENVIRONMENT_BINDING_INVALID", "Node executable is not frozen");
	const config = JSON.parse(await readFile(join(handle.controlDirectory, "config.json"), "utf8")) as unknown;
	if (!isRecord(config) || config.ConfigBindingHash !== handle.configBindingHash || !Array.isArray(config.Files)) {
		throw new StudyExecutionCoordinatorError(
			"RUNNER_SNAPSHOT_BINDING_INVALID",
			"runner configuration does not match its private handle",
		);
	}
	const expectedDigest = executable.sha256.slice("sha256:".length);
	if (
		typeof config.ExecutablePath !== "string" ||
		!config.Files.some(
			(file) => isRecord(file) && file.path === config.ExecutablePath && file.sha256 === expectedDigest,
		)
	) {
		throw new StudyExecutionCoordinatorError(
			"RUNNER_SNAPSHOT_BINDING_INVALID",
			"runner snapshot does not contain the verified Node executable digest",
		);
	}
	const programPath = join(handle.runDirectory, "input", `program${extname(payload.program.fileName)}`);
	if (config.ProgramPath !== programPath)
		throw new StudyExecutionCoordinatorError(
			"RUNNER_SNAPSHOT_BINDING_INVALID",
			"Runner program path differs from the frozen program",
		);
	const expectedFiles = [
		{ path: programPath, sha256: payload.program.sha256 },
		...payload.inputs.map((input, index) => ({
			path: join(handle.runDirectory, "input", `input-${index}${extname(input.name) || ".bin"}`),
			sha256: input.sha256,
		})),
	];
	for (const file of expectedFiles) {
		if (
			!config.Files.some(
				(entry) =>
					isRecord(entry) && entry.path === file.path && entry.sha256 === file.sha256.slice("sha256:".length),
			) ||
			executionSha256(await readFile(file.path)) !== file.sha256
		) {
			throw new StudyExecutionCoordinatorError(
				"RUNNER_SNAPSHOT_BINDING_INVALID",
				"Runner program or input bytes differ from the approved frozen payload",
			);
		}
	}
}

function nativeHandle(handle: PreparedExecutionHandle): IsolatedWindowsRunHandle {
	if (
		handle.kind !== "native-windows-node-v1" ||
		!isRecord(handle.privateHandle) ||
		!isRecord(handle.privateHandle.runner)
	) {
		throw new StudyExecutionCoordinatorError(
			"NATIVE_HANDLE_INVALID",
			"prepared handle is not a native Windows Node handle",
		);
	}
	const runner = handle.privateHandle.runner;
	if (
		runner.version !== 1 ||
		typeof runner.runId !== "string" ||
		typeof runner.runDirectory !== "string" ||
		typeof runner.controlDirectory !== "string" ||
		typeof runner.outputDirectory !== "string" ||
		typeof runner.helperPath !== "string" ||
		typeof runner.cancelToken !== "string" ||
		typeof runner.configBindingHash !== "string"
	) {
		throw new StudyExecutionCoordinatorError("NATIVE_HANDLE_INVALID", "native Windows private handle is malformed");
	}
	return runner as unknown as IsolatedWindowsRunHandle;
}

async function observeWindowsStatus(
	status: IsolatedWindowsRunStatus,
	handle: IsolatedWindowsRunHandle,
): Promise<CoordinatorAdapterObservation> {
	const logs = isTerminal(status.status)
		? {
				stdout: await readOptionalLog(handle.outputDirectory, "stdout.log"),
				stderr: await readOptionalLog(handle.outputDirectory, "stderr.log"),
				error: status.error,
			}
		: { stdout: null, stderr: null, error: status.error };
	return {
		status: status.status,
		usage: { wallTimeMs: status.wallTimeMs, diskBytes: status.outputBytes },
		processEvidence:
			status.processId > 0 && status.processCreationFileTime
				? `windows runner processId=${status.processId}; creation=${status.processCreationFileTime}; config=${status.configBindingHash}`
				: null,
		logs,
	};
}

async function readOptionalLog(outputDirectory: string, name: string): Promise<string | null> {
	try {
		return await readFile(join(outputDirectory, name), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	}
}

function resolveRequiredDirectory(value: string, label: string): string {
	if (!value || !value.trim() || !isAbsolute(value)) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_PATH_INVALID", `${label} must be an absolute path`);
	}
	return resolve(value);
}

function isChild(root: string, candidate: string): boolean {
	const difference = relative(root, candidate);
	return difference !== "" && !difference.startsWith("..") && !isAbsolute(difference);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function waitForHeartbeatDelay(milliseconds: number, finished: Promise<void>): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(true), milliseconds);
		void finished.then(() => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

interface NormalizedDetachedCoordinatorLaunch {
	launchKey: string;
	coordinatorId: string;
	databasePath: string;
	scriptPath: string;
	runRootDirectory: string;
	artifactDirectory: string;
	nodeExecutablePath: string;
	intervalMs: number;
	workerLeaseMs: number;
}

function normalizeDetachedCoordinatorLaunch(
	options: DetachedCoordinatorLaunchOptions,
): NormalizedDetachedCoordinatorLaunch {
	const databasePath = resolveRequiredPath(options.databasePath, "databasePath");
	const scriptPath = resolveRequiredPath(options.scriptPath, "scriptPath");
	const runRootDirectory = resolveRequiredDirectory(options.runRootDirectory, "runRootDirectory");
	const artifactDirectory = resolveRequiredDirectory(options.artifactDirectory, "artifactDirectory");
	const nodeExecutablePath = resolveRequiredPath(options.nodeExecutablePath ?? process.execPath, "nodeExecutablePath");
	const coordinatorId = options.coordinatorId ?? "primary";
	boundedText(coordinatorId, "coordinatorId", 256);
	const intervalMs = options.intervalMs ?? 1_000;
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
		throw new StudyExecutionCoordinatorError(
			"DETACHED_COORDINATOR_CONFIG_INVALID",
			"intervalMs must be an integer from 100 through 60000",
		);
	}
	const workerLeaseMs = options.workerLeaseMs ?? Math.max(30_000, intervalMs * 6);
	if (!Number.isSafeInteger(workerLeaseMs) || workerLeaseMs < intervalMs * 3 || workerLeaseMs > 300_000) {
		throw new StudyExecutionCoordinatorError(
			"DETACHED_COORDINATOR_CONFIG_INVALID",
			"workerLeaseMs must be three intervals through five minutes",
		);
	}
	return {
		launchKey: contentHash({ databasePath, coordinatorId }),
		coordinatorId,
		databasePath,
		scriptPath,
		runRootDirectory,
		artifactDirectory,
		nodeExecutablePath,
		intervalMs,
		workerLeaseMs,
	};
}

async function spawnDetachedCoordinator(
	launch: NormalizedDetachedCoordinatorLaunch,
	workerToken: string,
): Promise<ReturnType<typeof spawn>> {
	await mkdir(launch.artifactDirectory, { recursive: true });
	const log = await open(join(launch.artifactDirectory, "coordinator-startup.log"), "a");
	try {
		const child = spawn(
			launch.nodeExecutablePath,
			[
				launch.scriptPath,
				"--database",
				launch.databasePath,
				"--run-root",
				launch.runRootDirectory,
				"--artifact-dir",
				launch.artifactDirectory,
				"--coordinator-id",
				launch.coordinatorId,
				"--interval-ms",
				String(launch.intervalMs),
				"--worker-lease-ms",
				String(launch.workerLeaseMs),
				"--worker-launch-key",
				launch.launchKey,
				"--worker-token",
				workerToken,
				"--watch",
			],
			{ detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: true },
		);
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		return child;
	} finally {
		await log.close();
	}
}

function ensureDetachedWorkerTable(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS pi_study_execution_detached_worker (
			launch_key TEXT PRIMARY KEY,
			payload TEXT NOT NULL,
			payload_hash TEXT NOT NULL
		);
	`);
}

function readDetachedWorkerRecord(database: DatabaseSync, launchKey: string): DetachedCoordinatorWorkerRecord | null {
	const row = database
		.prepare(
			"SELECT payload AS payload, payload_hash AS payloadHash FROM pi_study_execution_detached_worker WHERE launch_key = ?",
		)
		.get(launchKey) as StoredResultRow | undefined;
	if (!row) return null;
	if (typeof row.payload !== "string" || typeof row.payloadHash !== "string") {
		throw new StudyExecutionCoordinatorError(
			"COORDINATOR_STORE_CORRUPT",
			"detached coordinator worker row is malformed",
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(row.payload);
	} catch {
		throw new StudyExecutionCoordinatorError(
			"COORDINATOR_STORE_CORRUPT",
			"detached coordinator worker contains invalid JSON",
		);
	}
	if (contentHash(value) !== row.payloadHash) {
		throw new StudyExecutionCoordinatorError(
			"COORDINATOR_STORE_CORRUPT",
			"detached coordinator worker failed integrity verification",
		);
	}
	return validateDetachedWorkerRecord(value);
}

function saveDetachedWorkerRecord(database: DatabaseSync, record: DetachedCoordinatorWorkerRecord): void {
	const valid = validateDetachedWorkerRecord(record);
	database
		.prepare(
			"INSERT INTO pi_study_execution_detached_worker (launch_key, payload, payload_hash) VALUES (?, ?, ?) ON CONFLICT(launch_key) DO UPDATE SET payload = excluded.payload, payload_hash = excluded.payload_hash",
		)
		.run(valid.launchKey, stableStringify(valid), contentHash(valid));
}

function inDetachedTransaction<T>(database: DatabaseSync, work: () => T): T {
	const nested = database.isTransaction;
	database.exec(nested ? "SAVEPOINT study_detached_coordinator" : "BEGIN IMMEDIATE");
	try {
		const result = work();
		database.exec(nested ? "RELEASE study_detached_coordinator" : "COMMIT");
		return result;
	} catch (error) {
		database.exec(nested ? "ROLLBACK TO study_detached_coordinator" : "ROLLBACK");
		if (nested) database.exec("RELEASE study_detached_coordinator");
		throw error;
	}
}

function detachedWorkerWaitRequest(record: DetachedCoordinatorWorkerRecord): DetachedCoordinatorLaunchRequest {
	let currentIdentity: string | null = null;
	if (record.processId !== null && record.processCreationIdentity !== null) {
		try {
			currentIdentity = currentDetachedCoordinatorProcessIdentity(record.processId);
		} catch (error) {
			if (
				!(
					error instanceof StudyExecutionCoordinatorError &&
					error.code === "DETACHED_COORDINATOR_PROCESS_UNVERIFIED"
				)
			) {
				throw error;
			}
		}
	}
	const identityMatches =
		record.processId !== null &&
		record.processCreationIdentity !== null &&
		currentIdentity === record.processCreationIdentity;
	return {
		launchKey: record.launchKey,
		coordinatorId: record.coordinatorId,
		processId: record.processId,
		status:
			record.status === "active" && identityMatches
				? "already-running"
				: record.status === "starting" && record.processId === null
					? "already-starting"
					: "reconciling",
		ready: false,
	};
}

/** A PID alone is reusable; the .NET start-time ticks bind it to the durable worker token. */
export function currentDetachedCoordinatorProcessIdentity(processId = process.pid): string {
	if (process.platform !== "win32") {
		throw new StudyExecutionCoordinatorError(
			"DETACHED_COORDINATOR_PLATFORM_UNSUPPORTED",
			"detached coordinator process identity requires Windows",
		);
	}
	if (!Number.isSafeInteger(processId) || processId < 1) {
		throw new StudyExecutionCoordinatorError("DETACHED_COORDINATOR_IDENTITY_INVALID", "processId must be positive");
	}
	const command = `$p = Get-Process -Id ${processId} -ErrorAction Stop; [Console]::Write($p.StartTime.ToUniversalTime().Ticks)`;
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
		encoding: "utf8",
		timeout: 5_000,
		windowsHide: true,
	});
	const identity = result.status === 0 ? result.stdout.trim() : "";
	if (!/^\d{15,20}$/u.test(identity)) {
		throw new StudyExecutionCoordinatorError(
			"DETACHED_COORDINATOR_PROCESS_UNVERIFIED",
			"the detached coordinator PID cannot be bound to a current Windows process creation time",
		);
	}
	return identity;
}

function assertDetachedLaunchMatches(
	record: DetachedCoordinatorWorkerRecord,
	launch: NormalizedDetachedCoordinatorLaunch,
): void {
	if (
		record.databasePath !== launch.databasePath ||
		record.scriptPath !== launch.scriptPath ||
		record.runRootDirectory !== launch.runRootDirectory ||
		record.artifactDirectory !== launch.artifactDirectory ||
		record.nodeExecutablePath !== launch.nodeExecutablePath ||
		record.intervalMs !== launch.intervalMs ||
		record.workerLeaseMs !== launch.workerLeaseMs
	) {
		throw new StudyExecutionCoordinatorError(
			"DETACHED_COORDINATOR_CONFIG_CONFLICT",
			"the named detached coordinator is live with a different service configuration",
		);
	}
}

function validateDetachedWorkerIdentity(identity: DetachedCoordinatorWorkerIdentity): void {
	boundedText(identity.launchKey, "launchKey", 256);
	boundedText(identity.workerToken, "workerToken", 256);
	if (!Number.isSafeInteger(identity.processId) || identity.processId < 1) {
		throw new StudyExecutionCoordinatorError("DETACHED_COORDINATOR_IDENTITY_INVALID", "processId must be positive");
	}
	if (typeof identity.processCreationIdentity !== "string" || !/^\d{15,20}$/u.test(identity.processCreationIdentity)) {
		throw new StudyExecutionCoordinatorError(
			"DETACHED_COORDINATOR_IDENTITY_INVALID",
			"processCreationIdentity must be a Windows creation-time tick value",
		);
	}
	if (
		!Number.isSafeInteger(identity.leaseDurationMs) ||
		identity.leaseDurationMs < 300 ||
		identity.leaseDurationMs > 300_000
	) {
		throw new StudyExecutionCoordinatorError(
			"DETACHED_COORDINATOR_IDENTITY_INVALID",
			"leaseDurationMs must be an integer from 300 through 300000",
		);
	}
}

function validateDetachedWorkerRecord(value: unknown): DetachedCoordinatorWorkerRecord {
	if (!isRecord(value) || value.version !== 1) {
		throw new StudyExecutionCoordinatorError(
			"COORDINATOR_STORE_CORRUPT",
			"detached coordinator worker has an invalid version",
		);
	}
	const record: DetachedCoordinatorWorkerRecord = {
		version: 1,
		launchKey: storedText(value.launchKey, "launchKey", 256),
		coordinatorId: storedText(value.coordinatorId, "coordinatorId", 256),
		workerToken: storedText(value.workerToken, "workerToken", 256),
		processId: storedProcessId(value.processId),
		processCreationIdentity:
			value.processCreationIdentity === null ? null : storedProcessCreationIdentity(value.processCreationIdentity),
		status: storedWorkerStatus(value.status),
		databasePath: storedText(value.databasePath, "databasePath", 32_768),
		scriptPath: storedText(value.scriptPath, "scriptPath", 32_768),
		runRootDirectory: storedText(value.runRootDirectory, "runRootDirectory", 32_768),
		artifactDirectory: storedText(value.artifactDirectory, "artifactDirectory", 32_768),
		nodeExecutablePath: storedText(value.nodeExecutablePath, "nodeExecutablePath", 32_768),
		intervalMs: storedBoundedInteger(value.intervalMs, "intervalMs", 100, 300_000),
		workerLeaseMs: storedBoundedInteger(value.workerLeaseMs, "workerLeaseMs", 300, 300_000),
		launchedAt: storedTimestamp(value.launchedAt, "launchedAt"),
		lastHeartbeatAt:
			value.lastHeartbeatAt === null ? null : storedTimestamp(value.lastHeartbeatAt, "lastHeartbeatAt"),
		leaseExpiresAt: storedTimestamp(value.leaseExpiresAt, "leaseExpiresAt"),
		lastError: storedWorkerError(value.lastError),
	};
	if (
		!isAbsolute(record.databasePath) ||
		!isAbsolute(record.scriptPath) ||
		!isAbsolute(record.runRootDirectory) ||
		!isAbsolute(record.artifactDirectory) ||
		!isAbsolute(record.nodeExecutablePath)
	) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", "detached worker contains a relative path");
	}
	if (record.workerLeaseMs < record.intervalMs * 3) {
		throw new StudyExecutionCoordinatorError(
			"COORDINATOR_STORE_CORRUPT",
			"detached worker lease is shorter than three ticks",
		);
	}
	if ((record.processId === null) !== (record.processCreationIdentity === null)) {
		throw new StudyExecutionCoordinatorError(
			"COORDINATOR_STORE_CORRUPT",
			"detached worker must store both process id and creation identity together",
		);
	}
	return record;
}

function storedText(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", `detached worker ${label} is invalid`);
	}
	return value;
}

function storedProcessId(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", "detached worker process id is invalid");
	}
	return value;
}

function storedProcessCreationIdentity(value: unknown): string {
	if (typeof value !== "string" || !/^\d{15,20}$/u.test(value)) {
		throw new StudyExecutionCoordinatorError(
			"COORDINATOR_STORE_CORRUPT",
			"detached worker process creation identity is invalid",
		);
	}
	return value;
}

function storedWorkerStatus(value: unknown): DetachedCoordinatorWorkerRecord["status"] {
	if (value === "starting" || value === "active" || value === "stopped") return value;
	throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", "detached worker status is invalid");
}

function storedBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", `detached worker ${label} is invalid`);
	}
	return value;
}

function storedTimestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", `detached worker ${label} is invalid`);
	}
	return value;
}

function storedWorkerError(value: unknown): DetachedCoordinatorWorkerRecord["lastError"] {
	if (value === null) return null;
	if (!isRecord(value)) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_STORE_CORRUPT", "detached worker error is invalid");
	}
	return {
		code: storedText(value.code, "error code", 256),
		message: storedText(value.message, "error message", 20_000),
		observedAt: storedTimestamp(value.observedAt, "error timestamp"),
	};
}

function detachedErrorDetails(error: unknown): { code: string; message: string } {
	const code =
		isRecord(error) && typeof error.code === "string" && error.code.trim()
			? error.code.slice(0, 256)
			: "DETACHED_COORDINATOR_TICK_FAILED";
	const message =
		error instanceof Error && error.message ? error.message.slice(0, 20_000) : String(error).slice(0, 20_000);
	return { code, message: message || "detached coordinator tick failed" };
}

function boundedText(value: unknown, label: string, maximum: number): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new StudyExecutionCoordinatorError("DETACHED_COORDINATOR_CONFIG_INVALID", `${label} must be bounded text`);
	}
}

function resolveRequiredPath(value: string, label: string): string {
	if (!value || !value.trim() || !isAbsolute(value)) {
		throw new StudyExecutionCoordinatorError("COORDINATOR_PATH_INVALID", `${label} must be an absolute path`);
	}
	return resolve(value);
}
