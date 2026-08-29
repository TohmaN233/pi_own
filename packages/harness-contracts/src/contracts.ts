export const HARNESS_CONTRACT_VERSION = 1 as const;

export const HARNESS_ROLES = ["student", "teacher", "general"] as const;
export type HarnessRole = (typeof HARNESS_ROLES)[number];

export const HOST_NAMES = [
	"runtime",
	"profile",
	"course",
	"knowledge",
	"learning",
	"assessment",
	"visual",
	"workflow",
	"teacher",
] as const;
export type HostName = (typeof HOST_NAMES)[number];

export const WORKFLOW_KINDS = [
	"general-chat",
	"grounded-answer",
	"practice",
	"visualization",
	"course-import",
	"teacher-publish",
] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export const WORKFLOW_STATUSES = ["pending", "running", "blocked", "succeeded", "failed", "cancelled"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const VALIDATOR_STATUSES = ["pass", "fail"] as const;
export type ValidatorStatus = (typeof VALIDATOR_STATUSES)[number];

export const VALIDATOR_SEVERITIES = ["error", "warning"] as const;
export type ValidatorSeverity = (typeof VALIDATOR_SEVERITIES)[number];

export const HARNESS_ERROR_CODES = [
	"INVALID_CONTRACT",
	"UNSUPPORTED_VERSION",
	"UNKNOWN_FIELD",
	"REVISION_MISMATCH",
	"COURSE_BINDING_MISMATCH",
	"SNAPSHOT_BINDING_MISMATCH",
	"DUPLICATE_COMMAND",
	"INVALID_TRANSITION",
	"VALIDATION_FAILED",
] as const;
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface SessionBinding {
	version: typeof HARNESS_CONTRACT_VERSION;
	bindingId: string;
	sessionId: string;
	courseVersionId: string | null;
	resourceSnapshotId: string;
	role: HarnessRole;
	createdAt: string;
	revision: number;
}

export interface ResourceSnapshotRef {
	version: typeof HARNESS_CONTRACT_VERSION;
	resourceSnapshotId: string;
	profileId: string;
	profileRevision: number;
	courseVersionId: string | null;
	contentHash: string;
	createdAt: string;
}

export interface WorkflowRun {
	version: typeof HARNESS_CONTRACT_VERSION;
	runId: string;
	sessionBindingId: string;
	kind: WorkflowKind;
	status: WorkflowStatus;
	sequence: number;
	startedAt: string;
	updatedAt: string;
	revision: number;
}

export interface HostCommand<TPayload extends JsonValue = JsonValue> {
	version: typeof HARNESS_CONTRACT_VERSION;
	commandId: string;
	host: HostName;
	kind: string;
	idempotencyKey: string;
	expectedRevision: number | null;
	payload: TPayload;
}

export interface ValidatorIssue {
	code: string;
	severity: ValidatorSeverity;
	message: string;
	path: string | null;
}

export interface ValidatorSubject {
	kind: string;
	id: string;
	revision: number;
}

export interface ValidatorResult {
	version: typeof HARNESS_CONTRACT_VERSION;
	validatorId: string;
	status: ValidatorStatus;
	subject: ValidatorSubject;
	checkedAt: string;
	issues: ValidatorIssue[];
}

export type HarnessJsonlEntry =
	| {
			version: typeof HARNESS_CONTRACT_VERSION;
			type: "learning-harness:session-binding";
			data: SessionBinding;
	  }
	| {
			version: typeof HARNESS_CONTRACT_VERSION;
			type: "learning-harness:resource-snapshot";
			data: ResourceSnapshotRef;
	  }
	| {
			version: typeof HARNESS_CONTRACT_VERSION;
			type: "learning-harness:workflow-run";
			data: WorkflowRun;
	  };

export interface RuntimeJournalRecord {
	version: typeof HARNESS_CONTRACT_VERSION;
	sequence: number;
	idempotencyKey: string;
	entry: HarnessJsonlEntry;
}

export const SESSION_BINDING_SCHEMA = {
	$id: "pi-learning-harness/session-binding/v1",
	type: "object",
	additionalProperties: false,
	required: [
		"version",
		"bindingId",
		"sessionId",
		"courseVersionId",
		"resourceSnapshotId",
		"role",
		"createdAt",
		"revision",
	],
} as const;

export const RESOURCE_SNAPSHOT_REF_SCHEMA = {
	$id: "pi-learning-harness/resource-snapshot-ref/v1",
	type: "object",
	additionalProperties: false,
	required: [
		"version",
		"resourceSnapshotId",
		"profileId",
		"profileRevision",
		"courseVersionId",
		"contentHash",
		"createdAt",
	],
} as const;

export const WORKFLOW_RUN_SCHEMA = {
	$id: "pi-learning-harness/workflow-run/v1",
	type: "object",
	additionalProperties: false,
	required: [
		"version",
		"runId",
		"sessionBindingId",
		"kind",
		"status",
		"sequence",
		"startedAt",
		"updatedAt",
		"revision",
	],
} as const;

export const HOST_COMMAND_SCHEMA = {
	$id: "pi-learning-harness/host-command/v1",
	type: "object",
	additionalProperties: false,
	required: [
		"version",
		"commandId",
		"host",
		"kind",
		"idempotencyKey",
		"expectedRevision",
		"payload",
	],
} as const;

export const VALIDATOR_RESULT_SCHEMA = {
	$id: "pi-learning-harness/validator-result/v1",
	type: "object",
	additionalProperties: false,
	required: ["version", "validatorId", "status", "subject", "checkedAt", "issues"],
} as const;

export const RUNTIME_JOURNAL_RECORD_SCHEMA = {
	$id: "pi-learning-harness/runtime-journal-record/v1",
	type: "object",
	additionalProperties: false,
	required: ["version", "sequence", "idempotencyKey", "entry"],
} as const;
