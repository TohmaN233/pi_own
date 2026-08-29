import {
	EXTERNAL_KNOWLEDGE_POLICIES,
	MATERIAL_KINDS,
	PROFILE_MODES,
	RESOURCE_KINDS,
	SCOPE_LABELS,
	SNAPSHOT_SWITCH_KINDS,
	THINKING_LEVELS,
	VISUALIZATION_KINDS,
	type AnswerClaim,
	type AnswerDraft,
	type CourseMaterialInput,
	type ProfileDefinition,
	type ResourceDescriptor,
	type ResourceSnapshot,
	type VisualizationSpec,
} from "./domain.ts";
import { HARNESS_CONTRACT_VERSION, HARNESS_ROLES, type JsonValue } from "./contracts.ts";
import { HarnessContractError } from "./validate.ts";

type RecordValue = Record<string, unknown>;

function fail(path: string, message: string): never {
	throw new HarnessContractError(path, message);
}

function record(value: unknown, path: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
	return value as RecordValue;
}

function exact(value: RecordValue, keys: readonly string[], path: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
	for (const key of keys) if (!(key in value)) fail(`${path}.${key}`, "missing required field");
}

function stringValue(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) fail(path, "expected non-empty string");
	return value;
}

function textValue(value: unknown, path: string): string {
	if (typeof value !== "string") fail(path, "expected string");
	return value;
}

function nullableString(value: unknown, path: string): string | null {
	return value === null ? null : stringValue(value, path);
}

function nullableText(value: unknown, path: string): string | null {
	return value === null ? null : textValue(value, path);
}

function positive(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) fail(path, "expected positive safe integer");
	return value as number;
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected finite number");
	return value;
}

function booleanValue(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "expected boolean");
	return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
	if (typeof value !== "string" || !values.includes(value)) fail(path, `expected one of ${values.join(", ")}`);
	return value as T[number];
}

function strings(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) fail(path, "expected array");
	return value.map((item, index) => stringValue(item, `${path}[${index}]`));
}

function json(value: unknown, path: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return finiteNumber(value, path);
	if (Array.isArray(value)) return value.map((item, index) => json(item, `${path}[${index}]`));
	if (typeof value === "object") {
		const result: Record<string, JsonValue> = {};
		for (const [key, child] of Object.entries(value as RecordValue)) result[key] = json(child, `${path}.${key}`);
		return result;
	}
	fail(path, "expected JSON value");
}

export function parseResourceDescriptor(value: unknown, path = "resource"): ResourceDescriptor {
	const item = record(value, path);
	exact(item, ["kind", "id", "version", "contentHash", "required", "enabled"], path);
	return {
		kind: enumValue(item.kind, RESOURCE_KINDS, `${path}.kind`),
		id: stringValue(item.id, `${path}.id`),
		version: stringValue(item.version, `${path}.version`),
		contentHash: stringValue(item.contentHash, `${path}.contentHash`),
		required: booleanValue(item.required, `${path}.required`),
		enabled: booleanValue(item.enabled, `${path}.enabled`),
	};
}

export function parseProfileDefinition(value: unknown): ProfileDefinition {
	const path = "profile";
	const item = record(value, path);
	exact(
		item,
		[
			"version",
			"profileId",
			"revision",
			"role",
			"mode",
			"provider",
			"model",
			"thinkingLevel",
			"externalKnowledgePolicy",
			"courseRequired",
			"tools",
			"resources",
			"instructions",
		],
		path,
	);
	if (item.version !== HARNESS_CONTRACT_VERSION) fail(`${path}.version`, "unsupported contract version");
	if (!Array.isArray(item.resources)) fail(`${path}.resources`, "expected array");
	return {
		version: HARNESS_CONTRACT_VERSION,
		profileId: stringValue(item.profileId, `${path}.profileId`),
		revision: positive(item.revision, `${path}.revision`),
		role: enumValue(item.role, HARNESS_ROLES, `${path}.role`),
		mode: enumValue(item.mode, PROFILE_MODES, `${path}.mode`),
		provider: nullableString(item.provider, `${path}.provider`),
		model: nullableString(item.model, `${path}.model`),
		thinkingLevel: enumValue(item.thinkingLevel, THINKING_LEVELS, `${path}.thinkingLevel`),
		externalKnowledgePolicy: enumValue(
			item.externalKnowledgePolicy,
			EXTERNAL_KNOWLEDGE_POLICIES,
			`${path}.externalKnowledgePolicy`,
		),
		courseRequired: booleanValue(item.courseRequired, `${path}.courseRequired`),
		tools: strings(item.tools, `${path}.tools`),
		resources: item.resources.map((resource, index) => parseResourceDescriptor(resource, `${path}.resources[${index}]`)),
		instructions: strings(item.instructions, `${path}.instructions`),
	};
}

export function parseResourceSnapshot(value: unknown): ResourceSnapshot {
	const path = "resourceSnapshot";
	const item = record(value, path);
	exact(
		item,
		[
			"version",
			"resourceSnapshotId",
			"profileId",
			"profileRevision",
			"role",
			"mode",
			"courseVersionId",
			"provider",
			"model",
			"thinkingLevel",
			"externalKnowledgePolicy",
			"tools",
			"resources",
			"instructions",
			"createdAt",
			"contentHash",
		],
		path,
	);
	if (item.version !== HARNESS_CONTRACT_VERSION) fail(`${path}.version`, "unsupported contract version");
	if (!Array.isArray(item.resources)) fail(`${path}.resources`, "expected array");
	const createdAt = stringValue(item.createdAt, `${path}.createdAt`);
	if (!Number.isFinite(Date.parse(createdAt))) fail(`${path}.createdAt`, "expected ISO timestamp");
	return {
		version: HARNESS_CONTRACT_VERSION,
		resourceSnapshotId: stringValue(item.resourceSnapshotId, `${path}.resourceSnapshotId`),
		profileId: stringValue(item.profileId, `${path}.profileId`),
		profileRevision: positive(item.profileRevision, `${path}.profileRevision`),
		role: enumValue(item.role, HARNESS_ROLES, `${path}.role`),
		mode: enumValue(item.mode, PROFILE_MODES, `${path}.mode`),
		courseVersionId: nullableString(item.courseVersionId, `${path}.courseVersionId`),
		provider: nullableString(item.provider, `${path}.provider`),
		model: nullableString(item.model, `${path}.model`),
		thinkingLevel: enumValue(item.thinkingLevel, THINKING_LEVELS, `${path}.thinkingLevel`),
		externalKnowledgePolicy: enumValue(
			item.externalKnowledgePolicy,
			EXTERNAL_KNOWLEDGE_POLICIES,
			`${path}.externalKnowledgePolicy`,
		),
		tools: strings(item.tools, `${path}.tools`),
		resources: item.resources.map((resource, index) => parseResourceDescriptor(resource, `${path}.resources[${index}]`)),
		instructions: strings(item.instructions, `${path}.instructions`),
		createdAt,
		contentHash: stringValue(item.contentHash, `${path}.contentHash`),
	};
}

export function parseCourseMaterialInput(value: unknown): CourseMaterialInput {
	const path = "courseMaterial";
	const item = record(value, path);
	const allowed = new Set(["name", "kind", "mediaType", "content", "metadata"]);
	for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
	for (const key of ["name", "kind", "mediaType", "content"] as const) if (!(key in item)) fail(`${path}.${key}`, "missing required field");
	if (typeof item.content !== "string" && !(item.content instanceof Uint8Array)) fail(`${path}.content`, "expected string or Uint8Array");
	let metadata: Record<string, JsonValue> = {};
	if (item.metadata !== undefined) {
		const parsed = json(item.metadata, `${path}.metadata`);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${path}.metadata`, "expected object");
		metadata = parsed as Record<string, JsonValue>;
	}
	return {
		name: stringValue(item.name, `${path}.name`),
		kind: enumValue(item.kind, MATERIAL_KINDS, `${path}.kind`),
		mediaType: stringValue(item.mediaType, `${path}.mediaType`),
		content: item.content,
		metadata,
	};
}

export function parseAnswerClaim(value: unknown, path = "answerClaim"): AnswerClaim {
	const item = record(value, path);
	exact(item, ["claimId", "text", "scope", "citationSpanIds", "reason"], path);
	return {
		claimId: stringValue(item.claimId, `${path}.claimId`),
		text: stringValue(item.text, `${path}.text`),
		scope: enumValue(item.scope, SCOPE_LABELS, `${path}.scope`),
		citationSpanIds: strings(item.citationSpanIds, `${path}.citationSpanIds`),
		reason: nullableText(item.reason, `${path}.reason`),
	};
}

export function parseAnswerDraft(value: unknown): AnswerDraft {
	const path = "answerDraft";
	const item = record(value, path);
	exact(item, ["version", "draftId", "packetId", "courseVersionId", "claims", "createdAt", "revision"], path);
	if (item.version !== HARNESS_CONTRACT_VERSION) fail(`${path}.version`, "unsupported contract version");
	if (!Array.isArray(item.claims)) fail(`${path}.claims`, "expected array");
	const createdAt = stringValue(item.createdAt, `${path}.createdAt`);
	if (!Number.isFinite(Date.parse(createdAt))) fail(`${path}.createdAt`, "expected ISO timestamp");
	return {
		version: HARNESS_CONTRACT_VERSION,
		draftId: stringValue(item.draftId, `${path}.draftId`),
		packetId: stringValue(item.packetId, `${path}.packetId`),
		courseVersionId: stringValue(item.courseVersionId, `${path}.courseVersionId`),
		claims: item.claims.map((claim, index) => parseAnswerClaim(claim, `${path}.claims[${index}]`)),
		createdAt,
		revision: positive(item.revision, `${path}.revision`),
	};
}

export function parseVisualizationSpec(value: unknown): VisualizationSpec {
	const path = "visualizationSpec";
	const item = record(value, path);
	exact(item, ["version", "specId", "courseVersionId", "kind", "title", "seed", "revision", "payload"], path);
	if (item.version !== HARNESS_CONTRACT_VERSION) fail(`${path}.version`, "unsupported contract version");
	return {
		version: HARNESS_CONTRACT_VERSION,
		specId: stringValue(item.specId, `${path}.specId`),
		courseVersionId: stringValue(item.courseVersionId, `${path}.courseVersionId`),
		kind: enumValue(item.kind, VISUALIZATION_KINDS, `${path}.kind`),
		title: stringValue(item.title, `${path}.title`),
		seed: finiteNumber(item.seed, `${path}.seed`),
		revision: positive(item.revision, `${path}.revision`),
		payload: json(item.payload, `${path}.payload`),
	};
}

export const _domainValidatorConstants = { SCOPE_LABELS, SNAPSHOT_SWITCH_KINDS };
