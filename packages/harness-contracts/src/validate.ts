import {
	HARNESS_CONTRACT_VERSION,
	HARNESS_ROLES,
	HOST_NAMES,
	VALIDATOR_SEVERITIES,
	VALIDATOR_STATUSES,
	WORKFLOW_KINDS,
	WORKFLOW_STATUSES,
	type HarnessJsonlEntry,
	type HostCommand,
	type JsonValue,
	type ResourceSnapshotRef,
	type SessionBinding,
	type ValidatorIssue,
	type ValidatorResult,
	type ValidatorSubject,
	type WorkflowRun,
} from "./contracts.ts";

export class HarnessContractError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "HarnessContractError";
		this.path = path;
	}
}

type RecordValue = Record<string, unknown>;

function fail(path: string, message: string): never {
	throw new HarnessContractError(path, message);
}

function expectRecord(value: unknown, path: string): RecordValue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(path, "expected object");
	}
	return value as RecordValue;
}

function expectExactKeys(record: RecordValue, allowed: readonly string[], path: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedSet.has(key)) fail(`${path}.${key}`, "unknown field");
	}
	for (const key of allowed) {
		if (!(key in record)) fail(`${path}.${key}`, "missing required field");
	}
}

function expectVersion(value: unknown, path: string): typeof HARNESS_CONTRACT_VERSION {
	if (value !== HARNESS_CONTRACT_VERSION) fail(path, `unsupported contract version ${String(value)}`);
	return HARNESS_CONTRACT_VERSION;
}

function expectString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) fail(path, "expected non-empty string");
	return value;
}

function expectNullableString(value: unknown, path: string): string | null {
	if (value === null) return null;
	return expectString(value, path);
}

function expectNonNegativeInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, "expected non-negative safe integer");
	return value as number;
}

function expectPositiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) fail(path, "expected positive safe integer");
	return value as number;
}

function expectIsoTimestamp(value: unknown, path: string): string {
	const text = expectString(value, path);
	const parsed = Date.parse(text);
	if (!Number.isFinite(parsed)) fail(path, "expected ISO-8601 timestamp");
	return text;
}

function expectEnum<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
	if (typeof value !== "string" || !allowed.includes(value)) {
		fail(path, `expected one of ${allowed.join(", ")}`);
	}
	return value as T[number];
}

function expectJsonValue(value: unknown, path: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(path, "JSON number must be finite");
		return value;
	}
	if (Array.isArray(value)) return value.map((item, index) => expectJsonValue(item, `${path}[${index}]`));
	if (typeof value === "object") {
		const result: Record<string, JsonValue> = {};
		for (const [key, child] of Object.entries(value as RecordValue)) {
			result[key] = expectJsonValue(child, `${path}.${key}`);
		}
		return result;
	}
	fail(path, "expected JSON value");
}

function parseValidatorSubject(value: unknown, path: string): ValidatorSubject {
	const record = expectRecord(value, path);
	expectExactKeys(record, ["kind", "id", "revision"], path);
	return {
		kind: expectString(record.kind, `${path}.kind`),
		id: expectString(record.id, `${path}.id`),
		revision: expectPositiveInteger(record.revision, `${path}.revision`),
	};
}

function parseValidatorIssue(value: unknown, path: string): ValidatorIssue {
	const record = expectRecord(value, path);
	expectExactKeys(record, ["code", "severity", "message", "path"], path);
	return {
		code: expectString(record.code, `${path}.code`),
		severity: expectEnum(record.severity, VALIDATOR_SEVERITIES, `${path}.severity`),
		message: expectString(record.message, `${path}.message`),
		path: record.path === null ? null : expectString(record.path, `${path}.path`),
	};
}

export function parseSessionBinding(value: unknown): SessionBinding {
	const path = "sessionBinding";
	const record = expectRecord(value, path);
	expectExactKeys(
		record,
		[
			"version",
			"bindingId",
			"sessionId",
			"courseVersionId",
			"resourceSnapshotId",
			"role",
			"createdAt",
			"revision",
		],
		path,
	);
	return {
		version: expectVersion(record.version, `${path}.version`),
		bindingId: expectString(record.bindingId, `${path}.bindingId`),
		sessionId: expectString(record.sessionId, `${path}.sessionId`),
		courseVersionId: expectNullableString(record.courseVersionId, `${path}.courseVersionId`),
		resourceSnapshotId: expectString(record.resourceSnapshotId, `${path}.resourceSnapshotId`),
		role: expectEnum(record.role, HARNESS_ROLES, `${path}.role`),
		createdAt: expectIsoTimestamp(record.createdAt, `${path}.createdAt`),
		revision: expectPositiveInteger(record.revision, `${path}.revision`),
	};
}

export function parseResourceSnapshotRef(value: unknown): ResourceSnapshotRef {
	const path = "resourceSnapshotRef";
	const record = expectRecord(value, path);
	expectExactKeys(
		record,
		[
			"version",
			"resourceSnapshotId",
			"profileId",
			"profileRevision",
			"courseVersionId",
			"contentHash",
			"createdAt",
		],
		path,
	);
	return {
		version: expectVersion(record.version, `${path}.version`),
		resourceSnapshotId: expectString(record.resourceSnapshotId, `${path}.resourceSnapshotId`),
		profileId: expectString(record.profileId, `${path}.profileId`),
		profileRevision: expectPositiveInteger(record.profileRevision, `${path}.profileRevision`),
		courseVersionId: expectNullableString(record.courseVersionId, `${path}.courseVersionId`),
		contentHash: expectString(record.contentHash, `${path}.contentHash`),
		createdAt: expectIsoTimestamp(record.createdAt, `${path}.createdAt`),
	};
}

export function parseWorkflowRun(value: unknown): WorkflowRun {
	const path = "workflowRun";
	const record = expectRecord(value, path);
	expectExactKeys(
		record,
		[
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
		path,
	);
	return {
		version: expectVersion(record.version, `${path}.version`),
		runId: expectString(record.runId, `${path}.runId`),
		sessionBindingId: expectString(record.sessionBindingId, `${path}.sessionBindingId`),
		kind: expectEnum(record.kind, WORKFLOW_KINDS, `${path}.kind`),
		status: expectEnum(record.status, WORKFLOW_STATUSES, `${path}.status`),
		sequence: expectNonNegativeInteger(record.sequence, `${path}.sequence`),
		startedAt: expectIsoTimestamp(record.startedAt, `${path}.startedAt`),
		updatedAt: expectIsoTimestamp(record.updatedAt, `${path}.updatedAt`),
		revision: expectPositiveInteger(record.revision, `${path}.revision`),
	};
}

export function parseHostCommand(value: unknown): HostCommand {
	const path = "hostCommand";
	const record = expectRecord(value, path);
	expectExactKeys(
		record,
		["version", "commandId", "host", "kind", "idempotencyKey", "expectedRevision", "payload"],
		path,
	);
	return {
		version: expectVersion(record.version, `${path}.version`),
		commandId: expectString(record.commandId, `${path}.commandId`),
		host: expectEnum(record.host, HOST_NAMES, `${path}.host`),
		kind: expectString(record.kind, `${path}.kind`),
		idempotencyKey: expectString(record.idempotencyKey, `${path}.idempotencyKey`),
		expectedRevision:
			record.expectedRevision === null
				? null
				: expectPositiveInteger(record.expectedRevision, `${path}.expectedRevision`),
		payload: expectJsonValue(record.payload, `${path}.payload`),
	};
}

export function parseValidatorResult(value: unknown): ValidatorResult {
	const path = "validatorResult";
	const record = expectRecord(value, path);
	expectExactKeys(record, ["version", "validatorId", "status", "subject", "checkedAt", "issues"], path);
	if (!Array.isArray(record.issues)) fail(`${path}.issues`, "expected array");
	const status = expectEnum(record.status, VALIDATOR_STATUSES, `${path}.status`);
	const issues = record.issues.map((issue, index) => parseValidatorIssue(issue, `${path}.issues[${index}]`));
	if (status === "pass" && issues.some((issue) => issue.severity === "error")) {
		fail(`${path}.issues`, "pass result cannot contain error issues");
	}
	if (status === "fail" && !issues.some((issue) => issue.severity === "error")) {
		fail(`${path}.issues`, "fail result must contain at least one error issue");
	}
	return {
		version: expectVersion(record.version, `${path}.version`),
		validatorId: expectString(record.validatorId, `${path}.validatorId`),
		status,
		subject: parseValidatorSubject(record.subject, `${path}.subject`),
		checkedAt: expectIsoTimestamp(record.checkedAt, `${path}.checkedAt`),
		issues,
	};
}

export function parseHarnessJsonlEntry(value: unknown): HarnessJsonlEntry {
	const path = "harnessJsonlEntry";
	const record = expectRecord(value, path);
	expectExactKeys(record, ["version", "type", "data"], path);
	expectVersion(record.version, `${path}.version`);
	const type = expectString(record.type, `${path}.type`);
	if (type === "learning-harness:session-binding") {
		return { version: HARNESS_CONTRACT_VERSION, type, data: parseSessionBinding(record.data) };
	}
	if (type === "learning-harness:resource-snapshot") {
		return { version: HARNESS_CONTRACT_VERSION, type, data: parseResourceSnapshotRef(record.data) };
	}
	if (type === "learning-harness:workflow-run") {
		return { version: HARNESS_CONTRACT_VERSION, type, data: parseWorkflowRun(record.data) };
	}
	fail(`${path}.type`, `unsupported harness entry type ${type}`);
}
