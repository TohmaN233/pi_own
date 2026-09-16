import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import type { RecordFrozenAgentArtifactsInput, StudyResearchHost } from "./study-research-host.ts";
import type {
	FrozenCheckTarget,
	KnowledgeNodeDraft,
	KnowledgeNoteDraft,
	KnowledgeRelationDraft,
	Scope,
	StudyAgentClaim,
	StudyAgentDispatchLookup,
	StudyAgentEnqueueInput,
	StudyAgentPacketBinding,
	StudyAgentPrivateContext,
	StudyAgentQueueTask,
	StudyAgentReconcileResolution,
	StudyAgentReport,
	StudyAgentReportInput,
	StudyAgentReportTarget,
	StudyAgentSourceEvidence,
	StudyAgentWorkerClaimInput,
	StudyPaperMap,
	StudyTask,
	TaskStatus,
} from "./types.ts";
import { requiredHash, requiredJsonLocator, requiredText, StudyResearchError } from "./validation.ts";

interface QueueRow {
	taskId: string;
	projectId: string;
	sessionId: string;
	dispatchKey: string;
	intentHash: string;
	priority: number;
	evidenceJson: string;
	evidenceHash: string;
	contextJson: string;
	contextHash: string;
	packetHash: string;
	packetBindingHash: string;
	targetJson: string;
	targetHash: string;
	claimOwner: string | null;
	claimToken: string | null;
	leaseExpiresAt: string | null;
	launchStartedAt: string | null;
	cancelRequestedAt: string | null;
	reportJson: string | null;
	reportHash: string | null;
	createdAt: string;
	updatedAt: string;
}

interface QueueRecord {
	row: QueueRow;
	evidence: StudyAgentSourceEvidence[];
	context: StudyAgentPrivateContext;
	target: StudyAgentReportTarget | null;
	report: StudyAgentReport | null;
}

interface TaskIdRow {
	taskId: string;
}

interface PacketBindingMigrationRow {
	taskId: string;
	packetHash: string;
	intentHash: string;
	contextJson: string;
	contextHash: string;
}

const QUEUE_SELECT_COLUMNS = `
	task_id AS taskId,
	project_id AS projectId,
	session_id AS sessionId,
	dispatch_key AS dispatchKey,
	intent_hash AS intentHash,
	priority,
	evidence_json AS evidenceJson,
	evidence_hash AS evidenceHash,
	context_json AS contextJson,
	context_hash AS contextHash,
	packet_hash AS packetHash,
	packet_binding_hash AS packetBindingHash,
	target_json AS targetJson,
	target_hash AS targetHash,
	claim_owner AS claimOwner,
	claim_token AS claimToken,
	lease_expires_at AS leaseExpiresAt,
	launch_started_at AS launchStartedAt,
	cancel_requested_at AS cancelRequestedAt,
	report_json AS reportJson,
	report_hash AS reportHash,
	created_at AS createdAt,
	updated_at AS updatedAt`;

export interface StudyAgentQueueOptions {
	clock?: () => Date;
	leaseDurationMs?: number;
}

/**
 * Durable Agent queue metadata. The Host task remains the canonical state
 * machine; this table only records the immutable packet, evidence, lease and
 * report that the generic Host task contract does not own.
 */
export class StudyAgentQueue {
	private readonly database: DatabaseSync;
	private readonly host: StudyResearchHost;
	private readonly clock: () => Date;
	private readonly leaseDurationMs: number;
	private transactionSequence = 0;

	constructor(database: DatabaseSync, host: StudyResearchHost, options: StudyAgentQueueOptions = {}) {
		this.database = database;
		this.host = host;
		this.clock = options.clock ?? (() => new Date());
		this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
		if (
			!Number.isSafeInteger(this.leaseDurationMs) ||
			this.leaseDurationMs < 1_000 ||
			this.leaseDurationMs > 300_000
		) {
			throw new StudyResearchError("INVALID_AGENT_QUEUE_POLICY", "Agent lease duration must be 1000..300000 ms");
		}
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_agent_queue (
				task_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				dispatch_key TEXT NOT NULL,
				intent_hash TEXT NOT NULL,
				priority INTEGER NOT NULL,
				evidence_json TEXT NOT NULL,
				evidence_hash TEXT NOT NULL,
				context_json TEXT NOT NULL,
				context_hash TEXT NOT NULL,
				packet_hash TEXT NOT NULL,
				packet_binding_hash TEXT NOT NULL,
				target_json TEXT NOT NULL,
				target_hash TEXT NOT NULL,
				claim_owner TEXT,
				claim_token TEXT,
				lease_expires_at TEXT,
				launch_started_at TEXT,
				cancel_requested_at TEXT,
				report_json TEXT,
				report_hash TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(project_id, dispatch_key)
			);
			CREATE INDEX IF NOT EXISTS pi_study_agent_queue_project_priority
				ON pi_study_agent_queue(project_id, priority DESC, created_at, task_id);
			CREATE TABLE IF NOT EXISTS pi_study_agent_queue_diagnostic (
				diagnostic_id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL,
				event TEXT NOT NULL,
				detail TEXT NOT NULL,
				created_at TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
		`);
		this.migratePacketBindingHashes();
	}

	/**
	 * Atomically reserves the canonical Host task, binds its real id into the Pi
	 * packet, then persists the path-free dispatch projection. The callback must
	 * be synchronous and idempotent for the same packet.
	 */
	enqueueLearning(
		input: StudyAgentEnqueueInput,
		bindPacket: (taskId: string) => StudyAgentPacketBinding,
	): { task: StudyAgentQueueTask; replay: boolean } {
		return this.transaction(() => {
			this.assertEnqueueInput(input);
			// Membership is checked even for replay, but the mutable phase revision is
			// intentionally not part of the replay identity.
			this.host.currentPhase(input.scope.projectId, input.scope.sessionId);
			const existing = this.rowByDispatch(input.scope.projectId, input.dispatchKey);
			if (existing) {
				const record = this.decodeRecord(existing);
				if (record.row.sessionId !== input.scope.sessionId || record.row.intentHash !== input.intentHash) {
					throw new StudyResearchError("IDEMPOTENCY_CONFLICT", "Agent dispatch belongs to another request");
				}
				return { task: this.publicTask(record), replay: true };
			}
			const evidence =
				input.kind === "paper-map"
					? []
					: input.kind === "review" && input.target
						? this.host.assertStudyAgentReviewEvidence(input.scope, input.evidence, input.target)
						: this.host.assertStudyAgentEvidence(input.scope, input.evidence);
			if (input.kind === "reading" && (evidence.length < 1 || evidence.length > 8)) {
				throw new StudyResearchError(
					"AGENT_READING_EVIDENCE_REQUIRED",
					"a reading task must bind one to eight source chunks",
				);
			}
			const producer = this.host.registerTrustedRunnerContext(
				input.scope,
				`pi-session:${input.context.agentSessionId}`,
			);
			const reservation = this.host.reserveStudyTask(input.scope, {
				dispatchKey: input.dispatchKey,
				kind: input.kind,
				manifest: input.manifest,
				admission: input.admission,
				producerContextId: producer.contextId,
				target: input.target,
			});
			if (reservation.replay) {
				throw new StudyResearchError(
					"AGENT_QUEUE_BINDING_MISSING",
					"Host task predates its required Agent queue packet binding",
				);
			}
			const binding = bindPacket(reservation.task.taskId);
			requiredHash(binding.packetHash, "Agent packet hash");
			const now = this.timestamp();
			const target = this.publicTarget(reservation.task.target);
			const record: QueueRecord = {
				row: {
					taskId: reservation.task.taskId,
					projectId: reservation.task.projectId,
					sessionId: reservation.task.authorization.sessionId,
					dispatchKey: reservation.task.dispatchKey,
					intentHash: input.intentHash,
					priority: input.priority ?? 0,
					evidenceJson: stableStringify(evidence),
					evidenceHash: contentHash(evidence),
					contextJson: stableStringify(input.context),
					contextHash: contentHash(input.context),
					packetHash: binding.packetHash,
					packetBindingHash: this.packetBindingHash(
						reservation.task.taskId,
						binding.packetHash,
						input.context.agentSessionId,
						input.intentHash,
					),
					targetJson: stableStringify(target),
					targetHash: contentHash(target),
					claimOwner: null,
					claimToken: null,
					leaseExpiresAt: null,
					launchStartedAt: null,
					cancelRequestedAt: null,
					reportJson: null,
					reportHash: null,
					createdAt: now,
					updatedAt: now,
				},
				evidence,
				context: structuredClone(input.context),
				target,
				report: null,
			};
			this.insertRecord(record);
			return { task: this.publicTask(record), replay: false };
		});
	}

	/** Same-project viewers can recover a prior allocation without creating another Pi session. */
	readByDispatch(input: StudyAgentDispatchLookup): StudyAgentQueueTask | null {
		requiredText(input.projectId, "projectId", 128);
		requiredText(input.sessionId, "sessionId", 128);
		requiredText(input.dispatchKey, "dispatchKey", 256);
		this.host.currentPhase(input.projectId, input.sessionId);
		const row = this.rowByDispatch(input.projectId, input.dispatchKey);
		return row ? this.publicTask(this.decodeRecord(row)) : null;
	}

	/** Path-free task list available to every session belonging to a project. */
	listProjectTasks(projectId: string, sessionId: string): StudyAgentQueueTask[] {
		requiredText(projectId, "projectId", 128);
		requiredText(sessionId, "sessionId", 128);
		this.host.currentPhase(projectId, sessionId);
		const rows = this.database
			.prepare(
				`SELECT ${QUEUE_SELECT_COLUMNS} FROM pi_study_agent_queue WHERE project_id = ? ORDER BY priority DESC, created_at, task_id`,
			)
			.all(projectId) as unknown as QueueRow[];
		return rows.map((row) => this.publicTask(this.decodeRecord(row)));
	}

	list(scope: Scope): StudyAgentQueueTask[] {
		return this.listProjectTasks(scope.projectId, scope.sessionId);
	}

	/** Change an unclaimed reading task's drain priority with an explicit CAS. */
	setPriority(scope: Scope, taskId: string, expectedPriority: number, priority: number): StudyAgentQueueTask {
		this.host.currentPhase(scope.projectId, scope.sessionId);
		requiredText(taskId, "taskId", 128);
		this.assertPriority(expectedPriority, "expected Agent priority");
		this.assertPriority(priority, "Agent priority");
		return this.transaction(() => {
			const record = this.recordByTask(taskId);
			if (record.row.projectId !== scope.projectId) {
				throw new StudyResearchError("CROSS_PROJECT", "Agent task belongs to another project");
			}
			const hostTask = this.requireHostTask(record);
			if (
				hostTask.kind !== "reading" ||
				(hostTask.status !== "queued" && hostTask.status !== "admitted") ||
				record.row.claimToken !== null ||
				record.row.launchStartedAt !== null
			) {
				throw new StudyResearchError(
					"AGENT_PRIORITY_CONFLICT",
					"only an unclaimed queued or admitted reading task may change priority",
				);
			}
			if (record.row.priority !== expectedPriority) {
				throw new StudyResearchError("AGENT_PRIORITY_CONFLICT", "Agent task priority changed before this update");
			}
			const updatedAt = this.timestamp();
			const changed = this.database
				.prepare(
					"UPDATE pi_study_agent_queue SET priority = ?, updated_at = ? WHERE task_id = ? AND project_id = ? AND priority = ? AND claim_token IS NULL AND launch_started_at IS NULL",
				)
				.run(priority, updatedAt, taskId, scope.projectId, expectedPriority);
			if (changed.changes !== 1) {
				throw new StudyResearchError("AGENT_PRIORITY_CONFLICT", "Agent priority update lost its queue CAS");
			}
			this.appendDiagnostic(
				taskId,
				"priority-updated",
				`Agent reading priority changed from ${expectedPriority} to ${priority}`,
			);
			return this.publicTask(this.recordByTask(taskId));
		});
	}

	/** Trusted worker drain view. It exposes no JSONL paths or producer handles. */
	listClaimable(projectId?: string): StudyAgentQueueTask[] {
		return this.transaction(() => {
			this.reconcileExpiredInside();
			const rows = (projectId
				? this.database
						.prepare(
							`SELECT ${QUEUE_SELECT_COLUMNS} FROM pi_study_agent_queue WHERE project_id = ? ORDER BY priority DESC, created_at, task_id`,
						)
						.all(projectId)
				: this.database
						.prepare(
							`SELECT ${QUEUE_SELECT_COLUMNS} FROM pi_study_agent_queue ORDER BY priority DESC, created_at, task_id`,
						)
						.all()) as unknown as QueueRow[];
			return rows
				.map((row) => this.decodeRecord(row))
				.filter(
					(record) =>
						this.isClaimable(record) ||
						(record.row.claimToken === null && this.requireHostTask(record).status === "reconciling"),
				)
				.map((record) => this.publicTask(record));
		});
	}

	/** One conservative worker may own one unexpired Agent lease globally. */
	claimNext(workerId: string): StudyAgentClaim | null {
		requiredText(workerId, "workerId", 256);
		return this.transaction(() => {
			this.reconcileExpiredInside();
			if (this.hasGlobalActiveLease()) return null;
			const rows = this.database
				.prepare(
					`SELECT ${QUEUE_SELECT_COLUMNS} FROM pi_study_agent_queue ORDER BY priority DESC, created_at, task_id`,
				)
				.all() as unknown as QueueRow[];
			for (const row of rows) {
				const record = this.decodeRecord(row);
				const status = this.requireHostTask(record).status;
				if (!this.isClaimable(record) && status !== "reconciling") continue;
				return this.claimRecord(record, workerId);
			}
			return null;
		});
	}

	claim(projectId: string, taskId: string, workerId: string): StudyAgentClaim | null {
		requiredText(projectId, "projectId", 128);
		requiredText(taskId, "taskId", 128);
		requiredText(workerId, "workerId", 256);
		return this.transaction(() => {
			this.reconcileExpiredInside();
			const record = this.recordByTask(taskId);
			if (record.row.projectId !== projectId) {
				throw new StudyResearchError("CROSS_PROJECT", "Agent task belongs to another project");
			}
			if (this.hasGlobalActiveLease(taskId)) return null;
			return this.claimRecord(record, workerId);
		});
	}

	heartbeat(input: StudyAgentWorkerClaimInput): StudyAgentClaim {
		return this.transaction(() => {
			const record = this.assertOwnedActiveLease(input);
			const hostTask = this.requireHostTask(record);
			if (hostTask.status === "cancelled") return this.claimFromRecord(record);
			if (!["admitted", "launching", "running", "reconciling"].includes(hostTask.status)) {
				throw new StudyResearchError("AGENT_STATE_CONFLICT", "only active Agent tasks may renew a lease");
			}
			const leaseExpiresAt = this.leaseExpiry();
			const changed = this.database
				.prepare(
					"UPDATE pi_study_agent_queue SET lease_expires_at = ?, updated_at = ? WHERE task_id = ? AND claim_owner = ? AND claim_token = ? AND lease_expires_at >= ?",
				)
				.run(
					leaseExpiresAt,
					this.timestamp(),
					record.row.taskId,
					input.workerId,
					input.claimToken,
					this.timestamp(),
				);
			if (changed.changes !== 1) throw new StudyResearchError("AGENT_CLAIM_CONFLICT", "Agent lease is stale");
			const next = this.recordByTask(record.row.taskId);
			return this.claimFromRecord(next);
		});
	}

	/** Durable launch boundary: call this before asking the Pi runtime to start a turn. */
	markLaunching(input: StudyAgentWorkerClaimInput): StudyAgentQueueTask {
		return this.transitionOwned(input, "admitted", "launching", "Agent packet launch recorded", (record) => {
			if (record.row.launchStartedAt !== null) {
				throw new StudyResearchError("AGENT_STATE_CONFLICT", "Agent packet was already launched");
			}
			const changed = this.database
				.prepare(
					"UPDATE pi_study_agent_queue SET launch_started_at = ?, updated_at = ? WHERE task_id = ? AND claim_owner = ? AND claim_token = ?",
				)
				.run(this.timestamp(), this.timestamp(), record.row.taskId, input.workerId, input.claimToken);
			if (changed.changes !== 1)
				throw new StudyResearchError("AGENT_CLAIM_CONFLICT", "Agent launch ownership was lost");
		});
	}

	markRunning(input: StudyAgentWorkerClaimInput): StudyAgentQueueTask {
		return this.transitionOwned(input, "launching", "running", "Pi reported an active Agent turn");
	}

	fail(input: StudyAgentWorkerClaimInput, detail: string): StudyAgentQueueTask {
		requiredText(detail, "Agent failure detail", 20_000);
		return this.transaction(() => {
			const record = this.assertOwnedActiveLease(input);
			const task = this.requireHostTask(record);
			if (task.status === "cancelled") {
				throw new StudyResearchError("AGENT_CANCELLED", "cancelled Agent work must acknowledge cancellation");
			}
			if (!["admitted", "launching", "running", "reconciling"].includes(task.status)) {
				throw new StudyResearchError("AGENT_STATE_CONFLICT", "Agent task cannot record this failure");
			}
			this.host.transitionTaskFromFrozenAuthorization({
				taskId: task.taskId,
				expectedTaskRevision: task.revision,
				nextStatus: "failed",
				detail,
			});
			this.appendDiagnostic(record.row.taskId, "failed", detail);
			this.clearLease(record.row.taskId, input.workerId, input.claimToken);
			return this.publicTask(this.recordByTask(record.row.taskId));
		});
	}

	acknowledgeCancellation(input: StudyAgentWorkerClaimInput, detail: string): StudyAgentQueueTask {
		requiredText(detail, "Agent cancellation detail", 20_000);
		return this.transaction(() => {
			const record = this.assertOwnedActiveLease(input);
			const task = this.requireHostTask(record);
			if (task.status !== "cancelled" || record.row.cancelRequestedAt === null) {
				throw new StudyResearchError("AGENT_STATE_CONFLICT", "Agent task has no cancellation to acknowledge");
			}
			this.appendDiagnostic(record.row.taskId, "cancellation-acknowledged", detail);
			this.clearLease(record.row.taskId, input.workerId, input.claimToken);
			return this.publicTask(this.recordByTask(record.row.taskId));
		});
	}

	/** Cancellation wins over late provider output and never synthesizes a success report. */
	cancel(scope: Scope, taskId: string): StudyAgentQueueTask {
		this.host.currentPhase(scope.projectId, scope.sessionId);
		requiredText(taskId, "taskId", 128);
		return this.transaction(() => {
			const record = this.recordByTask(taskId);
			if (record.row.projectId !== scope.projectId)
				throw new StudyResearchError("CROSS_PROJECT", "Agent task belongs to another project");
			const hostTask = this.requireHostTask(record);
			if (["succeeded", "failed", "cancelled", "limit-reached"].includes(hostTask.status)) {
				return this.publicTask(record);
			}
			const cancelled = this.host.transitionTaskFromFrozenAuthorization({
				taskId,
				expectedTaskRevision: hostTask.revision,
				nextStatus: "cancelled",
				detail: "Agent cancellation requested",
			});
			this.database
				.prepare(
					"UPDATE pi_study_agent_queue SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE task_id = ?",
				)
				.run(this.timestamp(), this.timestamp(), taskId);
			if (cancelled.status !== "cancelled")
				throw new StudyResearchError("AGENT_STATE_CONFLICT", "Agent task did not cancel");
			return this.publicTask(this.recordByTask(taskId));
		});
	}

	/** Expired post-launch work is deliberately left reconciling; this never starts another model turn. */
	reconcileExpired(): StudyAgentQueueTask[] {
		return this.transaction(() => this.reconcileExpiredInside());
	}

	acquireReconciliation(projectId: string, taskId: string, workerId: string): StudyAgentClaim {
		requiredText(projectId, "projectId", 128);
		requiredText(taskId, "taskId", 128);
		requiredText(workerId, "workerId", 256);
		return this.transaction(() => {
			if (this.hasGlobalActiveLease(taskId)) {
				throw new StudyResearchError("AGENT_CAPACITY_UNAVAILABLE", "the conservative Agent worker slot is busy");
			}
			const record = this.recordByTask(taskId);
			if (record.row.projectId !== projectId)
				throw new StudyResearchError("CROSS_PROJECT", "Agent task belongs to another project");
			if (record.row.claimToken !== null || this.requireHostTask(record).status !== "reconciling") {
				throw new StudyResearchError("AGENT_STATE_CONFLICT", "Agent task is not awaiting reconciliation");
			}
			return this.assignLease(record, workerId);
		});
	}

	markNeedsInput(input: StudyAgentWorkerClaimInput, detail: string): StudyAgentQueueTask {
		const normalizedDetail = requiredText(detail, "Agent needs-input detail", 20_000);
		return this.transaction(() => {
			const record = this.assertOwnedActiveLease(input);
			let task = this.requireHostTask(record);
			if (record.row.cancelRequestedAt !== null || task.status === "cancelled") {
				throw new StudyResearchError("AGENT_CANCELLED", "cancelled Agent work must acknowledge cancellation");
			}
			if (task.status === "launching" || task.status === "running") {
				task = this.host.transitionTaskFromFrozenAuthorization({
					taskId: task.taskId,
					expectedTaskRevision: task.revision,
					nextStatus: "reconciling",
					detail: "Agent provider state is unknown after launch; reconciliation is required",
				});
				this.appendDiagnostic(record.row.taskId, "provider-state-unknown", normalizedDetail);
			} else if (task.status !== "reconciling") {
				throw new StudyResearchError(
					"AGENT_STATE_CONFLICT",
					"only a launching, running, or reconciling Agent task may require input",
				);
			}
			this.host.transitionTaskFromFrozenAuthorization({
				taskId: task.taskId,
				expectedTaskRevision: task.revision,
				nextStatus: "needs-input",
				detail: normalizedDetail,
			});
			this.appendDiagnostic(record.row.taskId, "reconciled:needs-input", normalizedDetail);
			this.clearLease(record.row.taskId, input.workerId, input.claimToken);
			return this.publicTask(this.recordByTask(record.row.taskId));
		});
	}

	reconcile(input: StudyAgentWorkerClaimInput, resolution: StudyAgentReconcileResolution): StudyAgentQueueTask {
		requiredText(resolution.detail, "reconciliation detail", 20_000);
		return this.transaction(() => {
			const record = this.assertOwnedActiveLease(input);
			const task = this.requireHostTask(record);
			if (task.status !== "reconciling") {
				throw new StudyResearchError("AGENT_STATE_CONFLICT", "Agent task is not awaiting reconciliation");
			}
			this.host.transitionTaskFromFrozenAuthorization({
				taskId: task.taskId,
				expectedTaskRevision: task.revision,
				nextStatus: resolution.status,
				detail: resolution.detail,
			});
			this.appendDiagnostic(record.row.taskId, `reconciled:${resolution.status}`, resolution.detail);
			this.clearLease(record.row.taskId, input.workerId, input.claimToken);
			return this.publicTask(this.recordByTask(record.row.taskId));
		});
	}

	/** Trusted worker access only. Browser-facing reads use readByDispatch/listProjectTasks. */
	readContext(input: StudyAgentWorkerClaimInput): StudyAgentPrivateContext {
		const record = this.assertOwnedActiveLease(input);
		return this.freeze(structuredClone(record.context));
	}

	/** Trusted synthesis recovery only: reopen a completed reader, never another model turn. */
	readCompletedReadingContextForTrustedSynthesis(scope: Scope, taskId: string): StudyAgentPrivateContext {
		this.host.currentPhase(scope.projectId, scope.sessionId);
		const record = this.recordByTask(taskId);
		const task = this.requireHostTask(record);
		if (
			record.row.projectId !== scope.projectId ||
			record.row.sessionId !== scope.sessionId ||
			task.kind !== "reading" ||
			task.status !== "succeeded"
		) {
			throw new StudyResearchError(
				"AGENT_CONTEXT_SCOPE",
				"Synthesis recovery requires this session's completed reading task",
			);
		}
		return this.freeze(structuredClone(record.context));
	}

	complete(input: StudyAgentWorkerClaimInput & { report: StudyAgentReportInput }): StudyAgentQueueTask {
		return this.transaction(() => {
			const record = this.assertOwnedActiveLease(input);
			const hostTask = this.requireHostTask(record);
			if (record.row.cancelRequestedAt !== null || hostTask.status === "cancelled") {
				throw new StudyResearchError("AGENT_CANCELLED", "cancelled Agent work cannot save a success report");
			}
			if (hostTask.status !== "running" && hostTask.status !== "reconciling") {
				throw new StudyResearchError(
					"AGENT_STATE_CONFLICT",
					"only a running or reconciling Agent task may save a report",
				);
			}
			if (record.report !== null) {
				throw new StudyResearchError("AGENT_REPORT_CONFLICT", "Agent task already has a report");
			}
			if (hostTask.kind === "review" && record.target === null) {
				throw new StudyResearchError("CHECK_TARGET_REQUIRED", "review task was not reserved with a frozen target");
			}
			const report = this.normalizeReport(input.report, record);
			const artifacts = this.artifactsFor(report, record, hostTask);
			const persisted = this.database
				.prepare(
					"UPDATE pi_study_agent_queue SET report_json = ?, report_hash = ?, updated_at = ? WHERE task_id = ? AND report_json IS NULL",
				)
				.run(stableStringify(report), report.reportHash, this.timestamp(), record.row.taskId);
			if (persisted.changes !== 1) {
				throw new StudyResearchError("AGENT_REPORT_CONFLICT", "Agent task report changed before it could be saved");
			}
			this.host.recordFrozenAgentArtifacts(artifacts);
			const succeeded = this.host.transitionTaskFromFrozenAuthorization({
				taskId: record.row.taskId,
				expectedTaskRevision: hostTask.revision,
				nextStatus: "succeeded",
				detail: `Agent report saved with ${report.outcome} academic outcome`,
			});
			if (hostTask.kind === "review") {
				const target = record.target;
				if (target === null) {
					throw new StudyResearchError("CHECK_TARGET_REQUIRED", "review task lost its frozen target");
				}
				this.host.recordIndependentReviewFromFrozenTask({
					taskId: succeeded.taskId,
					expectedTaskRevision: succeeded.revision,
					targetKind: target.targetKind,
					targetId: target.targetId,
					targetRevision: target.targetRevision,
					targetHash: target.targetHash,
					status: this.canonicalReviewStatus(report),
					findings: this.canonicalReviewFindings(report),
				});
			}
			this.clearLease(record.row.taskId, input.workerId, input.claimToken);
			return this.publicTask(this.recordByTask(record.row.taskId));
		});
	}

	private transitionOwned(
		input: StudyAgentWorkerClaimInput,
		expectedStatus: TaskStatus,
		nextStatus: TaskStatus,
		detail: string,
		beforeTransition?: (record: QueueRecord) => void,
	): StudyAgentQueueTask {
		return this.transaction(() => {
			const record = this.assertOwnedActiveLease(input);
			const hostTask = this.requireHostTask(record);
			if (hostTask.status !== expectedStatus) {
				throw new StudyResearchError(
					"AGENT_STATE_CONFLICT",
					`Agent task is ${hostTask.status}, expected ${expectedStatus}`,
				);
			}
			beforeTransition?.(record);
			this.host.transitionTaskFromFrozenAuthorization({
				taskId: record.row.taskId,
				expectedTaskRevision: hostTask.revision,
				nextStatus,
				detail,
			});
			return this.publicTask(this.recordByTask(record.row.taskId));
		});
	}

	private claimRecord(record: QueueRecord, workerId: string): StudyAgentClaim {
		const hostTask = this.requireHostTask(record);
		if (!this.isClaimable(record) && hostTask.status !== "reconciling") {
			throw new StudyResearchError("AGENT_STATE_CONFLICT", "Agent task is not claimable");
		}
		if (hostTask.status === "queued") {
			this.host.transitionTaskFromFrozenAuthorization({
				taskId: record.row.taskId,
				expectedTaskRevision: hostTask.revision,
				nextStatus: "admitted",
				detail: "Agent worker admitted frozen packet",
			});
		}
		return this.assignLease(this.recordByTask(record.row.taskId), workerId);
	}

	private assignLease(record: QueueRecord, workerId: string): StudyAgentClaim {
		const claimToken = `agent-claim_${randomUUID()}`;
		const leaseExpiresAt = this.leaseExpiry();
		const changed = this.database
			.prepare(
				"UPDATE pi_study_agent_queue SET claim_owner = ?, claim_token = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ? AND claim_token IS NULL",
			)
			.run(workerId, claimToken, leaseExpiresAt, this.timestamp(), record.row.taskId);
		if (changed.changes !== 1)
			throw new StudyResearchError("AGENT_CLAIM_CONFLICT", "Agent task was claimed by another worker");
		return this.claimFromRecord(this.recordByTask(record.row.taskId));
	}

	private claimFromRecord(record: QueueRecord): StudyAgentClaim {
		if (!record.row.claimOwner || !record.row.claimToken || !record.row.leaseExpiresAt) {
			throw new StudyResearchError("CORRUPT_STATE", "Agent queue record lost its active lease");
		}
		return this.freeze({
			task: this.publicTask(record),
			workerId: record.row.claimOwner,
			claimToken: record.row.claimToken,
			leaseExpiresAt: record.row.leaseExpiresAt,
		});
	}

	private reconcileExpiredInside(): StudyAgentQueueTask[] {
		const now = this.timestamp();
		const rows = this.database
			.prepare(
				`SELECT ${QUEUE_SELECT_COLUMNS} FROM pi_study_agent_queue WHERE claim_token IS NOT NULL AND lease_expires_at < ? ORDER BY created_at, task_id`,
			)
			.all(now) as unknown as QueueRow[];
		const reconciled: StudyAgentQueueTask[] = [];
		for (const row of rows) {
			const record = this.decodeRecord(row);
			const task = this.requireHostTask(record);
			if (task.status === "admitted" && record.row.launchStartedAt === null) {
				this.clearLease(record.row.taskId, record.row.claimOwner, record.row.claimToken);
				continue;
			}
			if (task.status === "launching" || task.status === "running") {
				this.host.transitionTaskFromFrozenAuthorization({
					taskId: task.taskId,
					expectedTaskRevision: task.revision,
					nextStatus: "reconciling",
					detail: "Agent lease expired after the durable launch boundary; provider state is unknown",
				});
				this.clearLease(record.row.taskId, record.row.claimOwner, record.row.claimToken);
				reconciled.push(this.publicTask(this.recordByTask(record.row.taskId)));
				continue;
			}
			this.clearLease(record.row.taskId, record.row.claimOwner, record.row.claimToken);
		}
		return reconciled;
	}

	private normalizeReport(input: StudyAgentReportInput, record: QueueRecord): StudyAgentReport {
		requiredText(input.summary, "Agent report summary", 200_000);
		if (!["passed", "failed", "inconclusive"].includes(input.outcome)) {
			throw new StudyResearchError("INVALID_AGENT_REPORT", "Agent report outcome is invalid");
		}
		if (!Array.isArray(input.findings) || input.findings.length > 1_000) {
			throw new StudyResearchError("INVALID_AGENT_REPORT", "Agent findings must be bounded");
		}
		if (!Array.isArray(input.notes) || input.notes.length > 256) {
			throw new StudyResearchError("INVALID_AGENT_REPORT", "Agent report notes must be bounded");
		}
		if (!Array.isArray(input.unresolved) || input.unresolved.length > 1_000) {
			throw new StudyResearchError("INVALID_AGENT_REPORT", "Agent unresolved items must be bounded");
		}
		const evidenceIds = new Set(record.evidence.map((evidence) => evidence.id));
		const taskKind = this.requireHostTask(record).kind;
		const resultOnlyReview =
			record.evidence.length === 0 && record.target?.targetKind === "result" && taskKind === "review";
		const paperMapTask = taskKind === "paper-map";
		if (paperMapTask && (input.findings.length !== 0 || input.notes.length !== 0)) {
			throw new StudyResearchError(
				"AGENT_EVIDENCE_CONFLICT",
				"paper-map reports retain sections and unresolved items without direct chunk findings or notes",
			);
		}
		if (resultOnlyReview && input.notes.length !== 0)
			throw new StudyResearchError(
				"AGENT_EVIDENCE_CONFLICT",
				"Result-only reviews retain findings on the frozen result; source notes require located source evidence",
			);
		const requireEvidenceIds = (value: readonly string[], label: string): string[] => {
			if (
				!Array.isArray(value) ||
				(value.length === 0 && !resultOnlyReview && !paperMapTask) ||
				value.length > record.evidence.length
			) {
				throw new StudyResearchError("AGENT_EVIDENCE_CONFLICT", `${label} must cite frozen evidence`);
			}
			const normalized = value.map((id, index) => requiredText(id, `${label}[${index}]`, 128));
			if (new Set(normalized).size !== normalized.length || normalized.some((id) => !evidenceIds.has(id))) {
				throw new StudyResearchError("AGENT_EVIDENCE_CONFLICT", `${label} differs from frozen evidence`);
			}
			return normalized;
		};
		const findings = input.findings.map((finding, index) => {
			if (!["major", "moderate", "minor", "uncertain"].includes(finding.severity)) {
				throw new StudyResearchError("INVALID_AGENT_REPORT", `finding ${index} has an invalid severity`);
			}
			return {
				severity: finding.severity,
				explanation: requiredText(finding.explanation, `finding ${index}.explanation`, 100_000),
				evidenceIds: requireEvidenceIds(finding.evidenceIds, `finding ${index}.evidenceIds`),
			};
		});
		const notes = input.notes.map((note, index) => ({
			title: requiredText(note.title, `note ${index}.title`, 2_000),
			body: requiredText(note.body, `note ${index}.body`, 200_000),
			evidenceIds: requireEvidenceIds(note.evidenceIds, `note ${index}.evidenceIds`),
		}));
		const unresolved = input.unresolved.map((item, index) => requiredText(item, `unresolved ${index}`, 20_000));
		if (new Set(unresolved).size !== unresolved.length) {
			throw new StudyResearchError("DUPLICATE_VALUE", "Agent unresolved items must be unique");
		}
		if (stableStringify(input.target) !== stableStringify(record.target)) {
			throw new StudyResearchError(
				"AGENT_TARGET_CONFLICT",
				"Agent report target differs from its frozen task target",
			);
		}
		const paperMap = paperMapTask ? this.normalizePaperMap(input.paperMap) : undefined;
		if (!paperMapTask && input.paperMap !== undefined) {
			throw new StudyResearchError("INVALID_AGENT_REPORT", "only paper-map tasks may save a paper map");
		}
		const raw = {
			summary: input.summary.trim(),
			outcome: input.outcome,
			findings,
			notes,
			unresolved,
			target: structuredClone(record.target),
			citations: structuredClone(record.evidence),
			createdAt: this.timestamp(),
			...(paperMap ? { paperMap } : {}),
		};
		return { ...raw, reportHash: contentHash(raw) };
	}

	/** Structural and freshness validation occurs in Host inside the completion transaction. */
	private normalizePaperMap(value: StudyPaperMap | undefined): StudyPaperMap {
		if (!value)
			throw new StudyResearchError("INVALID_PAPER_MAP", "paper-map task did not provide its structured map");
		return structuredClone(value);
	}

	private artifactsFor(
		report: StudyAgentReport,
		record: QueueRecord,
		hostTask: StudyTask,
	): RecordFrozenAgentArtifactsInput {
		const sourceById = new Map(record.evidence.map((evidence) => [evidence.id, evidence]));
		const nodes: KnowledgeNodeDraft[] = [];
		const notes: KnowledgeNoteDraft[] = [];
		const relations: KnowledgeRelationDraft[] = [];
		for (const [noteIndex, note] of report.notes.entries()) {
			const evidenceBySource = new Map<string, StudyAgentSourceEvidence>();
			for (const evidenceId of note.evidenceIds) {
				const evidence = sourceById.get(evidenceId);
				if (!evidence) throw new StudyResearchError("CORRUPT_STATE", "report note lost frozen evidence");
				evidenceBySource.set(`${evidence.sourceId}\u0000${evidence.sourceHash}`, evidence);
			}
			const localKeys: string[] = [];
			for (const [sourceIndex, evidence] of Array.from(evidenceBySource.values()).entries()) {
				const localKey = `agent-note-${noteIndex + 1}-source-${sourceIndex + 1}`;
				localKeys.push(localKey);
				nodes.push({
					localKey,
					kind: "claim",
					title: note.title,
					statement: note.body,
					scope: `${hostTask.kind} report ${hostTask.taskId}`,
					sourceId: evidence.sourceId,
					sourceHash: evidence.sourceHash,
					manuallyEdited: false,
				});
				notes.push({
					author: "agent",
					body: note.body,
					sourceId: evidence.sourceId,
					sourceHash: evidence.sourceHash,
					nodeLocalKeys: [localKey],
				});
			}
			for (const localKey of localKeys.slice(1)) {
				relations.push({ fromNodeLocalKey: localKeys[0], toNodeLocalKey: localKey, kind: "refers-to" });
			}
		}
		const evidence = record.evidence;
		return {
			taskId: record.row.taskId,
			evidence,
			checkpoints:
				hostTask.kind === "reading"
					? evidence.map((item) => ({
							sourceId: item.sourceId,
							sourceHash: item.sourceHash,
							locator: item.locator,
							note: report.summary,
						}))
					: [],
			knowledge: { nodes, notes, relations },
			...(report.paperMap ? { paperMap: report.paperMap } : {}),
		};
	}

	private isClaimable(record: QueueRecord): boolean {
		if (record.row.cancelRequestedAt !== null || record.row.claimToken !== null) return false;
		const task = this.requireHostTask(record);
		return task.status === "queued" || (task.status === "admitted" && record.row.launchStartedAt === null);
	}

	private hasGlobalActiveLease(exceptTaskId?: string): boolean {
		const row = this.database
			.prepare(
				"SELECT task_id AS taskId FROM pi_study_agent_queue WHERE claim_token IS NOT NULL AND lease_expires_at >= ? AND (? IS NULL OR task_id <> ?) LIMIT 1",
			)
			.get(this.timestamp(), exceptTaskId ?? null, exceptTaskId ?? null) as TaskIdRow | undefined;
		return row !== undefined;
	}

	private assertOwnedActiveLease(input: StudyAgentWorkerClaimInput): QueueRecord {
		requiredText(input.projectId, "projectId", 128);
		requiredText(input.taskId, "taskId", 128);
		requiredText(input.workerId, "workerId", 256);
		requiredText(input.claimToken, "claimToken", 256);
		const record = this.recordByTask(input.taskId);
		if (record.row.projectId !== input.projectId) {
			throw new StudyResearchError("CROSS_PROJECT", "Agent task belongs to another project");
		}
		if (
			record.row.claimOwner !== input.workerId ||
			record.row.claimToken !== input.claimToken ||
			record.row.leaseExpiresAt === null ||
			record.row.leaseExpiresAt < this.timestamp()
		) {
			throw new StudyResearchError("AGENT_CLAIM_CONFLICT", "Agent lease is stale or no longer owned");
		}
		return record;
	}

	private clearLease(taskId: string, owner: string | null, token: string | null): void {
		if (owner === null || token === null) return;
		const changed = this.database
			.prepare(
				"UPDATE pi_study_agent_queue SET claim_owner = NULL, claim_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE task_id = ? AND claim_owner = ? AND claim_token = ?",
			)
			.run(this.timestamp(), taskId, owner, token);
		if (changed.changes !== 1)
			throw new StudyResearchError("AGENT_CLAIM_CONFLICT", "Agent lease changed before release");
	}

	private appendDiagnostic(taskId: string, event: string, detail: string): void {
		const payload = {
			taskId,
			event,
			detail: requiredText(detail, "Agent diagnostic detail", 20_000),
			createdAt: this.timestamp(),
		};
		this.database
			.prepare(
				"INSERT INTO pi_study_agent_queue_diagnostic(diagnostic_id, task_id, event, detail, created_at, payload_hash) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				`agent-diagnostic_${randomUUID()}`,
				payload.taskId,
				payload.event,
				payload.detail,
				payload.createdAt,
				contentHash(payload),
			);
	}

	private requireHostTask(record: QueueRecord): StudyTask {
		const task = this.host.readTaskForCoordinator(record.row.taskId);
		if (
			task.projectId !== record.row.projectId ||
			task.authorization.sessionId !== record.row.sessionId ||
			task.dispatchKey !== record.row.dispatchKey ||
			task.producerContextId === null
		) {
			throw new StudyResearchError("AGENT_QUEUE_CORRUPT", "Agent queue metadata no longer matches its Host task");
		}
		if (stableStringify(this.publicTarget(task.target)) !== stableStringify(record.target)) {
			throw new StudyResearchError("AGENT_QUEUE_CORRUPT", "Agent queue target differs from its frozen Host target");
		}
		return task;
	}

	private publicTask(record: QueueRecord): StudyAgentQueueTask {
		const task = this.requireHostTask(record);
		return this.freeze({
			taskId: task.taskId,
			projectId: task.projectId,
			sessionId: task.authorization.sessionId,
			dispatchKey: task.dispatchKey,
			intentHash: record.row.intentHash,
			priority: record.row.priority,
			kind: task.kind,
			status: task.status,
			taskRevision: task.revision,
			authorization: structuredClone(task.authorization),
			manifest: structuredClone(task.manifest),
			evidence: structuredClone(record.evidence),
			target: structuredClone(record.target),
			context: { agentSessionId: record.context.agentSessionId, packetHash: record.row.packetHash },
			cancelRequestedAt: record.row.cancelRequestedAt,
			createdAt: record.row.createdAt,
			updatedAt: record.row.updatedAt,
			report: record.report ? structuredClone(record.report) : null,
		});
	}

	private publicTarget(target: FrozenCheckTarget | null): StudyAgentReportTarget | null {
		return target
			? {
					targetKind: target.targetKind,
					targetId: target.targetId,
					targetRevision: target.targetRevision,
					targetHash: target.targetHash,
				}
			: null;
	}

	private assertEnqueueInput(input: StudyAgentEnqueueInput): void {
		requiredText(input.dispatchKey, "dispatchKey", 256);
		requiredHash(input.intentHash, "intentHash");
		if (!["reading", "paper-map", "review", "explanation"].includes(input.kind)) {
			throw new StudyResearchError("INVALID_AGENT_TASK", "Agent queue kind is invalid");
		}
		if (input.priority !== undefined) this.assertPriority(input.priority, "Agent priority");
		requiredText(input.context.agentSessionId, "Agent session id", 256);
		requiredText(input.context.sessionFile, "Agent session file", 8_192);
		if (input.context.sessionFile.includes("\0")) {
			throw new StudyResearchError("INVALID_AGENT_CONTEXT", "Agent session file contains NUL");
		}
		if (input.kind === "paper-map" && input.evidence.length !== 0) {
			throw new StudyResearchError(
				"INVALID_AGENT_TASK",
				"paper-map tasks must retain report links instead of source chunks",
			);
		}
		if ((input.kind === "review") !== (input.target !== undefined)) {
			throw new StudyResearchError("AGENT_TARGET_REQUIRED", "only review Agent tasks may reserve a version target");
		}
		if (input.target) {
			requiredText(input.target.targetId, "Agent target id", 128);
			requiredHash(input.target.targetHash, "Agent target hash");
			if (!Number.isSafeInteger(input.target.targetRevision) || input.target.targetRevision < 1) {
				throw new StudyResearchError("INVALID_AGENT_TARGET", "Agent target revision is invalid");
			}
		}
	}

	private assertPriority(value: number, label: string): number {
		if (!Number.isSafeInteger(value) || value < -100 || value > 100) {
			throw new StudyResearchError("INVALID_AGENT_PRIORITY", `${label} must be an integer from -100 to 100`);
		}
		return value;
	}

	private canonicalReviewStatus(report: StudyAgentReport): "passed" | "failed" | "inconclusive" {
		if (
			report.outcome === "failed" ||
			report.findings.some((finding) => finding.severity === "major" || finding.severity === "moderate")
		) {
			return "failed";
		}
		if (
			report.outcome === "inconclusive" ||
			report.unresolved.length > 0 ||
			report.findings.some((finding) => finding.severity === "uncertain")
		) {
			return "inconclusive";
		}
		return "passed";
	}

	private canonicalReviewFindings(report: StudyAgentReport): string[] {
		return [
			`Summary: ${report.summary}`,
			...(report.citations.length === 0 && report.target?.targetKind === "result"
				? [
						`Evidence: frozen result ${report.target.targetId} r${report.target.targetRevision} ${report.target.targetHash}; no paper-source citations were supplied.`,
					]
				: []),
			...report.findings.map(
				(finding, index) =>
					`Finding ${index + 1} [${finding.severity}] ${finding.explanation} (evidence: ${finding.evidenceIds.join(", ")})`,
			),
			...report.unresolved.map((item, index) => `Unresolved ${index + 1}: ${item}`),
		];
	}

	private insertRecord(record: QueueRecord): void {
		const row = record.row;
		this.database
			.prepare(
				"INSERT INTO pi_study_agent_queue(task_id, project_id, session_id, dispatch_key, intent_hash, priority, evidence_json, evidence_hash, context_json, context_hash, packet_hash, packet_binding_hash, target_json, target_hash, claim_owner, claim_token, lease_expires_at, launch_started_at, cancel_requested_at, report_json, report_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				row.taskId,
				row.projectId,
				row.sessionId,
				row.dispatchKey,
				row.intentHash,
				row.priority,
				row.evidenceJson,
				row.evidenceHash,
				row.contextJson,
				row.contextHash,
				row.packetHash,
				row.packetBindingHash,
				row.targetJson,
				row.targetHash,
				row.claimOwner,
				row.claimToken,
				row.leaseExpiresAt,
				row.launchStartedAt,
				row.cancelRequestedAt,
				row.reportJson,
				row.reportHash,
				row.createdAt,
				row.updatedAt,
			);
	}

	private recordByTask(taskId: string): QueueRecord {
		const row = this.database
			.prepare(`SELECT ${QUEUE_SELECT_COLUMNS} FROM pi_study_agent_queue WHERE task_id = ?`)
			.get(taskId) as QueueRow | undefined;
		if (!row) throw new StudyResearchError("AGENT_TASK_NOT_FOUND", "Agent queue task was not found");
		return this.decodeRecord(row);
	}

	private rowByDispatch(projectId: string, dispatchKey: string): QueueRow | undefined {
		return this.database
			.prepare(`SELECT ${QUEUE_SELECT_COLUMNS} FROM pi_study_agent_queue WHERE project_id = ? AND dispatch_key = ?`)
			.get(projectId, dispatchKey) as QueueRow | undefined;
	}

	private decodeRecord(row: QueueRow): QueueRecord {
		const evidence = this.decodePayload<StudyAgentSourceEvidence[]>(
			row.evidenceJson,
			row.evidenceHash,
			"Agent evidence",
		);
		const context = this.decodePayload<StudyAgentPrivateContext>(row.contextJson, row.contextHash, "Agent context");
		const target = this.decodePayload<StudyAgentReportTarget | null>(row.targetJson, row.targetHash, "Agent target");
		const report =
			row.reportJson === null && row.reportHash === null
				? null
				: row.reportJson !== null && row.reportHash !== null
					? this.decodeReport(row.reportJson, row.reportHash)
					: (() => {
							throw new StudyResearchError("CORRUPT_STATE", "Agent report payload/hash columns disagree");
						})();
		requiredText(row.taskId, "stored Agent task id", 128);
		requiredText(row.projectId, "stored Agent project id", 128);
		requiredText(row.sessionId, "stored Agent session id", 128);
		requiredText(row.dispatchKey, "stored Agent dispatch key", 256);
		requiredHash(row.intentHash, "stored Agent intent hash");
		requiredHash(row.packetHash, "stored Agent packet hash");
		requiredHash(row.packetBindingHash, "stored Agent packet binding hash");
		if (
			row.packetBindingHash !==
			this.packetBindingHash(row.taskId, row.packetHash, context.agentSessionId, row.intentHash)
		) {
			throw new StudyResearchError("CORRUPT_STATE", "stored Agent packet binding failed its integrity check");
		}
		if (!Number.isSafeInteger(row.priority) || row.priority < -100 || row.priority > 100) {
			throw new StudyResearchError("CORRUPT_STATE", "stored Agent priority is invalid");
		}
		this.assertTimestamp(row.createdAt, "stored Agent creation time");
		this.assertTimestamp(row.updatedAt, "stored Agent update time");
		if (
			(row.claimOwner === null) !== (row.claimToken === null) ||
			(row.claimToken === null) !== (row.leaseExpiresAt === null)
		) {
			throw new StudyResearchError("CORRUPT_STATE", "stored Agent lease columns disagree");
		}
		if (row.leaseExpiresAt !== null) this.assertTimestamp(row.leaseExpiresAt, "stored Agent lease expiry");
		if (row.launchStartedAt !== null) this.assertTimestamp(row.launchStartedAt, "stored Agent launch time");
		if (row.cancelRequestedAt !== null) this.assertTimestamp(row.cancelRequestedAt, "stored Agent cancellation time");
		const storedTaskKind = this.host.readTaskForCoordinator(row.taskId).kind;
		this.validateStoredEvidence(
			evidence,
			target?.targetKind === "result" && storedTaskKind === "review",
			storedTaskKind === "paper-map",
		);
		requiredText(context.agentSessionId, "stored Agent session identity", 256);
		requiredText(context.sessionFile, "stored Agent private session file", 8_192);
		if (target !== null) {
			requiredText(target.targetId, "stored Agent target id", 128);
			requiredHash(target.targetHash, "stored Agent target hash");
			if (!Number.isSafeInteger(target.targetRevision) || target.targetRevision < 1) {
				throw new StudyResearchError("CORRUPT_STATE", "stored Agent target revision is invalid");
			}
		}
		return { row, evidence, context, target, report };
	}

	private validateStoredEvidence(
		evidence: StudyAgentSourceEvidence[],
		resultOnlyReview: boolean,
		paperMap: boolean,
	): void {
		if (
			!Array.isArray(evidence) ||
			(evidence.length === 0 && !resultOnlyReview && !paperMap) ||
			(paperMap && evidence.length !== 0) ||
			evidence.length > 64
		) {
			throw new StudyResearchError("CORRUPT_STATE", "stored Agent evidence count is invalid");
		}
		const ids = new Set<string>();
		for (const item of evidence) {
			requiredText(item.id, "stored Agent evidence id", 128);
			requiredText(item.sourceId, "stored Agent evidence source", 128);
			requiredHash(item.sourceHash, "stored Agent evidence hash");
			requiredJsonLocator(item.locator, "stored Agent evidence locator");
			if (ids.has(item.id))
				throw new StudyResearchError("CORRUPT_STATE", "stored Agent evidence ids are duplicated");
			ids.add(item.id);
		}
	}

	private decodePayload<T>(payload: string, hash: string, label: string): T {
		requiredHash(hash, `${label} hash`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw new StudyResearchError("CORRUPT_STATE", `${label} contains invalid JSON`);
		}
		if (contentHash(parsed) !== hash)
			throw new StudyResearchError("CORRUPT_STATE", `${label} failed its payload hash`);
		return parsed as T;
	}

	private decodeReport(payload: string, hash: string): StudyAgentReport {
		requiredHash(hash, "Agent report hash");
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw new StudyResearchError("CORRUPT_STATE", "Agent report contains invalid JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new StudyResearchError("CORRUPT_STATE", "Agent report must be an object");
		}
		const report = parsed as StudyAgentReport;
		if (report.reportHash !== hash || contentHash(this.reportWithoutHash(report)) !== hash) {
			throw new StudyResearchError("CORRUPT_STATE", "stored Agent report failed its integrity check");
		}
		return report;
	}

	private reportWithoutHash(report: StudyAgentReport): Omit<StudyAgentReport, "reportHash"> {
		const { reportHash: _reportHash, ...raw } = report;
		return raw;
	}

	private packetBindingHash(taskId: string, packetHash: string, agentSessionId: string, intentHash: string): string {
		return contentHash({ taskId, packetHash, agentSessionId, intentHash });
	}

	/** Upgrade early development databases before their first read with the stronger packet binding. */
	private migratePacketBindingHashes(): void {
		const columns = this.database.prepare("PRAGMA table_info(pi_study_agent_queue)").all() as { name: string }[];
		if (columns.some((column) => column.name === "packet_binding_hash")) return;
		this.database.exec("ALTER TABLE pi_study_agent_queue ADD COLUMN packet_binding_hash TEXT");
		const rows = this.database
			.prepare(
				"SELECT task_id AS taskId, packet_hash AS packetHash, intent_hash AS intentHash, context_json AS contextJson, context_hash AS contextHash FROM pi_study_agent_queue",
			)
			.all() as unknown as PacketBindingMigrationRow[];
		for (const row of rows) {
			const context = this.decodePayload<StudyAgentPrivateContext>(
				row.contextJson,
				row.contextHash,
				"Agent context",
			);
			this.database
				.prepare("UPDATE pi_study_agent_queue SET packet_binding_hash = ? WHERE task_id = ?")
				.run(
					this.packetBindingHash(row.taskId, row.packetHash, context.agentSessionId, row.intentHash),
					row.taskId,
				);
		}
	}

	private timestamp(): string {
		const value = this.clock();
		if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
			throw new StudyResearchError("INVALID_CLOCK", "Agent queue clock returned an invalid date");
		}
		return value.toISOString();
	}

	private leaseExpiry(): string {
		const now = this.clock();
		if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
			throw new StudyResearchError("INVALID_CLOCK", "Agent queue clock returned an invalid date");
		}
		return new Date(now.getTime() + this.leaseDurationMs).toISOString();
	}

	private assertTimestamp(value: string, label: string): void {
		if (!Number.isFinite(Date.parse(value))) throw new StudyResearchError("CORRUPT_STATE", `${label} is invalid`);
	}

	private transaction<T>(work: () => T): T {
		const savepoint = `pi_study_agent_queue_${++this.transactionSequence}`;
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

	private freeze<T>(value: T): T {
		if (!value || typeof value !== "object") return value;
		for (const child of Object.values(value)) this.freeze(child);
		return Object.freeze(value);
	}
}
