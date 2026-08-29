import {
	HARNESS_CONTRACT_VERSION,
	parseHarnessJsonlEntry,
	parseResourceSnapshotRef,
	parseRuntimeJournalRecord,
	parseSessionBinding,
	parseWorkflowRun,
	type HarnessJsonlEntry,
	type ResourceSnapshotRef,
	type RuntimeJournalRecord,
	type SessionBinding,
	type WorkflowRun,
	type WorkflowStatus,
} from "../../harness-contracts/src/index.ts";

export const RUNTIME_JOURNAL_CUSTOM_TYPE = "learning-harness:runtime-journal/v1" as const;

export interface RuntimeBranchEntry {
	type: string;
	id: string;
	customType?: string;
	data?: unknown;
}

export interface RuntimeSessionStore {
	getSessionId(): string;
	getBranch(): RuntimeBranchEntry[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface RuntimeSessionState {
	journalSequence: number;
	binding: SessionBinding | null;
	snapshots: ReadonlyMap<string, ResourceSnapshotRef>;
	workflows: ReadonlyMap<string, WorkflowRun>;
}

interface ParsedJournalRecord {
	nativeEntryId: string;
	record: RuntimeJournalRecord;
}

export class RuntimeSessionHostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeSessionHostError";
	}
}

const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
	pending: ["running", "blocked", "failed", "cancelled"],
	running: ["blocked", "succeeded", "failed", "cancelled"],
	blocked: ["running", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
};

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function assertInitialWorkflow(run: WorkflowRun): void {
	if (run.revision !== 1 || run.sequence !== 0 || run.status !== "pending") {
		throw new RuntimeSessionHostError("initial workflow must be pending at revision 1 and sequence 0");
	}
}

function assertWorkflowTransition(previous: WorkflowRun, next: WorkflowRun): void {
	if (previous.runId !== next.runId) throw new RuntimeSessionHostError("workflow run id cannot change");
	if (previous.sessionBindingId !== next.sessionBindingId) {
		throw new RuntimeSessionHostError("workflow session binding cannot change");
	}
	if (previous.kind !== next.kind) throw new RuntimeSessionHostError("workflow kind cannot change");
	if (previous.startedAt !== next.startedAt) throw new RuntimeSessionHostError("workflow startedAt cannot change");
	if (next.revision !== previous.revision + 1) throw new RuntimeSessionHostError("workflow revision must advance by one");
	if (next.sequence !== previous.sequence + 1) throw new RuntimeSessionHostError("workflow sequence must advance by one");
	if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
		throw new RuntimeSessionHostError("workflow updatedAt cannot move backwards");
	}
	if (!WORKFLOW_TRANSITIONS[previous.status].includes(next.status)) {
		throw new RuntimeSessionHostError(`invalid workflow transition ${previous.status} -> ${next.status}`);
	}
}

function assertBindingUpdate(previous: SessionBinding, next: SessionBinding): void {
	if (previous.bindingId !== next.bindingId) throw new RuntimeSessionHostError("session binding id cannot change");
	if (previous.sessionId !== next.sessionId) throw new RuntimeSessionHostError("bound Pi session cannot change");
	if (previous.courseVersionId !== next.courseVersionId) {
		throw new RuntimeSessionHostError("course version cannot be rebound inside an existing session");
	}
	if (previous.role !== next.role) throw new RuntimeSessionHostError("session role cannot change");
	if (previous.createdAt !== next.createdAt) throw new RuntimeSessionHostError("session binding createdAt cannot change");
	if (next.revision !== previous.revision + 1) throw new RuntimeSessionHostError("session binding revision must advance by one");
}

export class RuntimeSessionHost {
	private readonly sessionStore: RuntimeSessionStore;

	constructor(sessionStore: RuntimeSessionStore) {
		this.sessionStore = sessionStore;
	}

	get sessionId(): string {
		return this.sessionStore.getSessionId();
	}

	recover(): RuntimeSessionState {
		const records = this.readJournal();
		const snapshots = new Map<string, ResourceSnapshotRef>();
		const workflows = new Map<string, WorkflowRun>();
		const idempotencyKeys = new Set<string>();
		let binding: SessionBinding | null = null;
		let expectedSequence = 1;

		for (const { record } of records) {
			if (record.sequence !== expectedSequence) {
				throw new RuntimeSessionHostError(
					`runtime journal sequence mismatch: expected ${expectedSequence}, got ${record.sequence}`,
				);
			}
			expectedSequence++;

			if (idempotencyKeys.has(record.idempotencyKey)) {
				throw new RuntimeSessionHostError(`duplicate persisted idempotency key ${record.idempotencyKey}`);
			}
			idempotencyKeys.add(record.idempotencyKey);

			if (record.entry.type === "learning-harness:resource-snapshot") {
				const snapshot = record.entry.data;
				const previous = snapshots.get(snapshot.resourceSnapshotId);
				if (previous && !sameJson(previous, snapshot)) {
					throw new RuntimeSessionHostError(`resource snapshot ${snapshot.resourceSnapshotId} was redefined`);
				}
				snapshots.set(snapshot.resourceSnapshotId, snapshot);
				continue;
			}

			if (record.entry.type === "learning-harness:session-binding") {
				const next = record.entry.data;
				this.assertBindingReferences(next, snapshots);
				if (binding) assertBindingUpdate(binding, next);
				else if (next.revision !== 1) throw new RuntimeSessionHostError("initial session binding revision must be 1");
				binding = next;
				continue;
			}

			const next = record.entry.data;
			if (!binding || next.sessionBindingId !== binding.bindingId) {
				throw new RuntimeSessionHostError(`workflow ${next.runId} is not owned by the active session binding`);
			}
			const previous = workflows.get(next.runId);
			if (previous) assertWorkflowTransition(previous, next);
			else assertInitialWorkflow(next);
			workflows.set(next.runId, next);
		}

		return {
			journalSequence: records.length,
			binding,
			snapshots,
			workflows,
		};
	}

	recordResourceSnapshot(value: unknown, idempotencyKey: string): string {
		const snapshot = parseResourceSnapshotRef(value);
		const entry: HarnessJsonlEntry = {
			version: HARNESS_CONTRACT_VERSION,
			type: "learning-harness:resource-snapshot",
			data: snapshot,
		};
		return this.appendOnce(entry, idempotencyKey, (state) => {
			const previous = state.snapshots.get(snapshot.resourceSnapshotId);
			if (previous && !sameJson(previous, snapshot)) {
				throw new RuntimeSessionHostError(`resource snapshot ${snapshot.resourceSnapshotId} already exists with other data`);
			}
		});
	}

	recordSessionBinding(value: unknown, idempotencyKey: string): string {
		const binding = parseSessionBinding(value);
		const entry: HarnessJsonlEntry = {
			version: HARNESS_CONTRACT_VERSION,
			type: "learning-harness:session-binding",
			data: binding,
		};
		return this.appendOnce(entry, idempotencyKey, (state) => {
			this.assertBindingReferences(binding, state.snapshots);
			if (state.binding) assertBindingUpdate(state.binding, binding);
			else if (binding.revision !== 1) throw new RuntimeSessionHostError("initial session binding revision must be 1");
		});
	}

	recordWorkflowRun(value: unknown, idempotencyKey: string): string {
		const workflow = parseWorkflowRun(value);
		const entry: HarnessJsonlEntry = {
			version: HARNESS_CONTRACT_VERSION,
			type: "learning-harness:workflow-run",
			data: workflow,
		};
		return this.appendOnce(entry, idempotencyKey, (state) => {
			if (!state.binding || workflow.sessionBindingId !== state.binding.bindingId) {
				throw new RuntimeSessionHostError(`workflow ${workflow.runId} is not owned by the active session binding`);
			}
			const previous = state.workflows.get(workflow.runId);
			if (previous) assertWorkflowTransition(previous, workflow);
			else assertInitialWorkflow(workflow);
		});
	}

	private assertBindingReferences(
		binding: SessionBinding,
		snapshots: ReadonlyMap<string, ResourceSnapshotRef>,
	): void {
		if (binding.sessionId !== this.sessionId) {
			throw new RuntimeSessionHostError(
				`session binding targets ${binding.sessionId}, but active Pi session is ${this.sessionId}`,
			);
		}
		const snapshot = snapshots.get(binding.resourceSnapshotId);
		if (!snapshot) throw new RuntimeSessionHostError(`resource snapshot ${binding.resourceSnapshotId} is not recorded`);
		if (snapshot.courseVersionId !== binding.courseVersionId) {
			throw new RuntimeSessionHostError("resource snapshot course does not match session binding course");
		}
	}

	private appendOnce(
		entry: HarnessJsonlEntry,
		idempotencyKey: string,
		validateNewEntry: (state: RuntimeSessionState) => void,
	): string {
		const normalizedEntry = parseHarnessJsonlEntry(entry);
		const records = this.readJournal();
		const prior = records.find(({ record }) => record.idempotencyKey === idempotencyKey);
		if (prior) {
			if (!sameJson(prior.record.entry, normalizedEntry)) {
				throw new RuntimeSessionHostError(`idempotency key ${idempotencyKey} was reused with different data`);
			}
			return prior.nativeEntryId;
		}

		const state = this.recover();
		validateNewEntry(state);
		const record = parseRuntimeJournalRecord({
			version: HARNESS_CONTRACT_VERSION,
			sequence: state.journalSequence + 1,
			idempotencyKey,
			entry: normalizedEntry,
		});
		return this.sessionStore.appendCustomEntry(RUNTIME_JOURNAL_CUSTOM_TYPE, record);
	}

	private readJournal(): ParsedJournalRecord[] {
		const records: ParsedJournalRecord[] = [];
		for (const entry of this.sessionStore.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== RUNTIME_JOURNAL_CUSTOM_TYPE) continue;
			try {
				records.push({ nativeEntryId: entry.id, record: parseRuntimeJournalRecord(entry.data) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new RuntimeSessionHostError(`invalid runtime journal entry ${entry.id}: ${message}`);
			}
		}
		return records;
	}
}
