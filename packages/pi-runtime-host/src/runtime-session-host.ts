import {
	HARNESS_CONTRACT_VERSION,
	type HarnessJsonlEntry,
	parseHarnessJsonlEntry,
	parseResourceSnapshotRef,
	parseRuntimeJournalRecord,
	parseSessionBinding,
	parseWorkflowRun,
	type ResourceSnapshotRef,
	type RuntimeJournalRecord,
	type SessionBinding,
	type WorkflowRun,
	type WorkflowStatus,
} from "../../harness-contracts/src/index.ts";

export const RUNTIME_JOURNAL_CUSTOM_TYPE = "learning-harness:runtime-journal/v1";

export class RuntimeSessionHostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeSessionHostError";
	}
}

export interface RuntimeSessionState {
	journalSequence: number;
	binding: SessionBinding | null;
	snapshots: ResourceSnapshotRef[];
	workflows: WorkflowRun[];
}

interface ParsedJournalRecord {
	nativeEntryId: string;
	record: RuntimeJournalRecord;
}

interface RecoveredJournal {
	state: RuntimeSessionState;
	bindingChain: SessionBinding[];
}

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>(["succeeded", "failed", "cancelled"]);

const ALLOWED_WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, ReadonlySet<WorkflowStatus>>> = {
	pending: new Set(["running", "blocked", "failed", "cancelled"]),
	running: new Set(["blocked", "succeeded", "failed", "cancelled"]),
	blocked: new Set(["running", "failed", "cancelled"]),
	succeeded: new Set(),
	failed: new Set(),
	cancelled: new Set(),
};

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sameBindingScope(left: SessionBinding, right: SessionBinding): boolean {
	return (
		left.courseVersionId === right.courseVersionId &&
		left.resourceSnapshotId === right.resourceSnapshotId &&
		left.role === right.role
	);
}

function journalCorruption(nativeEntryId: string, message: string): never {
	throw new RuntimeSessionHostError(`Harness journal corruption at Pi entry ${nativeEntryId}: ${message}`);
}

function assertWorkflowTransition(previous: WorkflowRun | undefined, next: WorkflowRun): void {
	if (!previous) {
		if (next.revision !== 1 || next.sequence !== 0 || next.status !== "pending") {
			throw new RuntimeSessionHostError("New workflow must start at revision=1, sequence=0, status=pending");
		}
		return;
	}
	if (previous.sessionBindingId !== next.sessionBindingId || previous.kind !== next.kind) {
		throw new RuntimeSessionHostError(`Workflow identity changed for ${next.runId}`);
	}
	if (TERMINAL_WORKFLOW_STATUSES.has(previous.status)) {
		throw new RuntimeSessionHostError(`Terminal workflow ${next.runId} cannot transition from ${previous.status}`);
	}
	if (next.revision !== previous.revision + 1 || next.sequence !== previous.sequence + 1) {
		throw new RuntimeSessionHostError(`Workflow ${next.runId} revision/sequence must advance exactly once`);
	}
	if (!ALLOWED_WORKFLOW_TRANSITIONS[previous.status].has(next.status)) {
		throw new RuntimeSessionHostError(`Invalid workflow transition ${previous.status} -> ${next.status}`);
	}
}

export interface PiSessionCustomEntry {
	type: "custom";
	id: string;
	customType: string;
	data?: unknown;
}

export interface PiSessionStore {
	getSessionId(): string;
	getBranch(): Array<{ type: string; id: string; customType?: string; data?: unknown }>;
	appendCustomEntry(customType: string, data?: unknown): string;
}

export class RuntimeSessionHost {
	private readonly sessionManager: PiSessionStore;

	constructor(sessionManager: PiSessionStore) {
		this.sessionManager = sessionManager;
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	recover(): RuntimeSessionState {
		return this.recoverJournal().state;
	}

	/** Returns the validated binding ancestry, ending with the active binding when present. */
	inspectBindingLineage(): SessionBinding[] {
		return this.recoverJournal().bindingChain;
	}

	private recoverJournal(): RecoveredJournal {
		const records = this.readJournal();
		let expectedSequence = 1;
		let lastBinding: SessionBinding | null = null;
		let activeBinding: SessionBinding | null = null;
		let sawCurrentBinding = false;
		const bindingChain: SessionBinding[] = [];
		const bindingSessionIds = new Set<string>();
		const snapshots = new Map<string, ResourceSnapshotRef>();
		const workflows = new Map<string, WorkflowRun>();
		const idempotencyKeys = new Set<string>();

		for (const { nativeEntryId, record } of records) {
			if (record.sequence !== expectedSequence) {
				journalCorruption(nativeEntryId, `expected journal sequence ${expectedSequence}, got ${record.sequence}`);
			}
			expectedSequence++;
			if (idempotencyKeys.has(record.idempotencyKey)) {
				journalCorruption(nativeEntryId, `duplicate idempotency key ${record.idempotencyKey}`);
			}
			idempotencyKeys.add(record.idempotencyKey);

			if (record.entry.type === "learning-harness:resource-snapshot") {
				const snapshot = record.entry.data;
				if (lastBinding && snapshot.courseVersionId !== lastBinding.courseVersionId) {
					journalCorruption(nativeEntryId, "resource snapshot targets another course after the session was bound");
				}
				const previous = snapshots.get(snapshot.resourceSnapshotId);
				if (previous && !sameJson(previous, snapshot)) {
					journalCorruption(nativeEntryId, `resource snapshot ${snapshot.resourceSnapshotId} was redefined`);
				}
				snapshots.set(snapshot.resourceSnapshotId, snapshot);
				continue;
			}

			if (record.entry.type === "learning-harness:session-binding") {
				const next = record.entry.data;
				const snapshot = snapshots.get(next.resourceSnapshotId);
				if (!snapshot) {
					journalCorruption(nativeEntryId, `binding references unknown snapshot ${next.resourceSnapshotId}`);
				}
				if (snapshot.courseVersionId !== next.courseVersionId) {
					journalCorruption(nativeEntryId, "binding and resource snapshot courseVersionId differ");
				}
				if (lastBinding && lastBinding.sessionId !== next.sessionId) {
					if (sawCurrentBinding || bindingSessionIds.has(next.sessionId)) {
						journalCorruption(nativeEntryId, "forked session has an invalid binding ancestry");
					}
					if (!sameBindingScope(lastBinding, next)) {
						journalCorruption(nativeEntryId, "forked session changed its inherited course, snapshot, or role");
					}
					if (next.revision !== 1)
						journalCorruption(nativeEntryId, "forked session binding must start at revision 1");
				} else if (lastBinding) {
					if (lastBinding.bindingId !== next.bindingId)
						journalCorruption(nativeEntryId, "bindingId changed for an existing session");
					if (lastBinding.courseVersionId !== next.courseVersionId)
						journalCorruption(nativeEntryId, "courseVersionId changed for an existing session");
					if (lastBinding.role !== next.role)
						journalCorruption(nativeEntryId, "role changed for an existing session");
					if (lastBinding.createdAt !== next.createdAt)
						journalCorruption(nativeEntryId, "createdAt changed for an existing session");
					if (next.revision !== lastBinding.revision + 1)
						journalCorruption(nativeEntryId, "binding revision must advance exactly once");
				} else if (next.revision !== 1) {
					journalCorruption(nativeEntryId, "initial binding revision must be 1");
				}
				bindingSessionIds.add(next.sessionId);
				bindingChain.push(next);
				lastBinding = next;
				if (next.sessionId === this.sessionId) {
					sawCurrentBinding = true;
					activeBinding = next;
				}
				continue;
			}

			const next = record.entry.data;
			const previous = workflows.get(next.runId);
			try {
				assertWorkflowTransition(previous, next);
			} catch (error) {
				journalCorruption(nativeEntryId, error instanceof Error ? error.message : String(error));
			}
			workflows.set(next.runId, next);
		}

		return {
			state: {
				journalSequence: records.length,
				binding: activeBinding,
				snapshots: [...snapshots.values()],
				workflows: [...workflows.values()],
			},
			bindingChain,
		};
	}

	recordResourceSnapshot(value: unknown, idempotencyKey: string): string {
		const snapshot = parseResourceSnapshotRef(value);
		const entry: HarnessJsonlEntry = {
			version: HARNESS_CONTRACT_VERSION,
			type: "learning-harness:resource-snapshot",
			data: snapshot,
		};
		return this.appendOnce(entry, idempotencyKey, (state, inheritedBinding) => {
			const scopeBinding = state.binding ?? inheritedBinding;
			if (scopeBinding && snapshot.courseVersionId !== scopeBinding.courseVersionId) {
				throw new RuntimeSessionHostError(
					"Bound Pi session cannot record a resource snapshot for another course version",
				);
			}
			const existing = state.snapshots.find((item) => item.resourceSnapshotId === snapshot.resourceSnapshotId);
			if (existing && !sameJson(existing, snapshot)) {
				throw new RuntimeSessionHostError(
					`Resource snapshot ${snapshot.resourceSnapshotId} already exists with different data`,
				);
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
		return this.appendOnce(entry, idempotencyKey, (state, inheritedBinding) => {
			if (binding.sessionId !== this.sessionId) {
				throw new RuntimeSessionHostError(
					`Binding sessionId ${binding.sessionId} does not match ${this.sessionId}`,
				);
			}
			const snapshot = state.snapshots.find((item) => item.resourceSnapshotId === binding.resourceSnapshotId);
			if (!snapshot) throw new RuntimeSessionHostError(`Unknown resource snapshot ${binding.resourceSnapshotId}`);
			if (snapshot.courseVersionId !== binding.courseVersionId) {
				throw new RuntimeSessionHostError("Binding and resource snapshot courseVersionId must match");
			}
			if (!state.binding) {
				if (inheritedBinding && !sameBindingScope(inheritedBinding, binding)) {
					throw new RuntimeSessionHostError(
						"Forked Pi session must inherit its course, resource snapshot, and role",
					);
				}
				if (binding.revision !== 1) throw new RuntimeSessionHostError("Initial binding revision must be 1");
				return;
			}
			if (state.binding.bindingId !== binding.bindingId) {
				throw new RuntimeSessionHostError("Existing Pi session cannot replace its bindingId");
			}
			if (state.binding.courseVersionId !== binding.courseVersionId) {
				throw new RuntimeSessionHostError("Existing Pi session cannot be rebound to another course version");
			}
			if (state.binding.role !== binding.role) {
				throw new RuntimeSessionHostError("Existing Pi session role cannot change");
			}
			if (state.binding.createdAt !== binding.createdAt) {
				throw new RuntimeSessionHostError("Existing Pi session binding createdAt cannot change");
			}
			if (binding.revision !== state.binding.revision + 1) {
				throw new RuntimeSessionHostError("Binding revision must advance exactly once");
			}
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
			if (!state.binding || state.binding.bindingId !== workflow.sessionBindingId) {
				throw new RuntimeSessionHostError(`Workflow ${workflow.runId} does not target the active session binding`);
			}
			assertWorkflowTransition(
				state.workflows.find((item) => item.runId === workflow.runId),
				workflow,
			);
		});
	}

	private appendOnce(
		entry: HarnessJsonlEntry,
		idempotencyKey: string,
		validateNewEntry: (state: RuntimeSessionState, inheritedBinding: SessionBinding | null) => void,
	): string {
		const normalizedEntry = parseHarnessJsonlEntry(entry);
		const records = this.readJournal();
		const existing = records.find((item) => item.record.idempotencyKey === idempotencyKey);
		if (existing) {
			if (!sameJson(existing.record.entry, normalizedEntry)) {
				throw new RuntimeSessionHostError(`Idempotency key ${idempotencyKey} was reused with different data`);
			}
			return existing.nativeEntryId;
		}

		const recovered = this.recoverJournal();
		const state = recovered.state;
		validateNewEntry(state, recovered.bindingChain.at(-1) ?? null);
		const record: RuntimeJournalRecord = {
			version: HARNESS_CONTRACT_VERSION,
			sequence: state.journalSequence + 1,
			idempotencyKey,
			entry: normalizedEntry,
		};
		parseRuntimeJournalRecord(record);
		return this.sessionManager.appendCustomEntry(RUNTIME_JOURNAL_CUSTOM_TYPE, record);
	}

	private readJournal(): ParsedJournalRecord[] {
		const records: ParsedJournalRecord[] = [];
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== RUNTIME_JOURNAL_CUSTOM_TYPE) continue;
			try {
				records.push({ nativeEntryId: entry.id, record: parseRuntimeJournalRecord(entry.data) });
			} catch (error) {
				journalCorruption(entry.id, error instanceof Error ? error.message : String(error));
			}
		}
		return records;
	}
}
