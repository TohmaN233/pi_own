import { HARNESS_CONTRACT_VERSION, HARNESS_ROLES } from "./contracts.ts";
import { EXTERNAL_KNOWLEDGE_POLICIES, PROFILE_MODES, THINKING_LEVELS } from "./domain.ts";
import {
	MODE_PACK_CATEGORIES,
	MODE_PACK_COMPONENT_TYPES,
	MODE_PACK_RESOURCE_DELIVERIES,
	MODE_PACK_SYSTEM_PROMPT_MODES,
	type ModePackComponentPin,
	type ModePackComponentRef,
	type ModePackDefinition,
	type ModePackDraft,
} from "./mode-pack.ts";
import { HarnessContractError } from "./validate.ts";

type RecordValue = Record<string, unknown>;

const MODE_PACK_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const COMPONENT_ID = /^[a-z][a-z0-9]*(?:[.:/-][a-z0-9]+)*$/u;
const PACKAGE_CONTENT_HASH = /^sha256:[a-f0-9]{64}$/u;

function fail(path: string, message: string): never {
	throw new HarnessContractError(path, message);
}

function record(value: unknown, path: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
	return value as RecordValue;
}

function exactWithOptional(
	value: RecordValue,
	required: readonly string[],
	optional: readonly string[],
	path: string,
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
	for (const key of required) if (!(key in value)) fail(`${path}.${key}`, "missing required field");
}

function stringValue(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) fail(path, "expected non-empty string");
	return value.trim();
}

function packageContentHash(value: unknown, path: string): string {
	const result = stringValue(value, path);
	if (!PACKAGE_CONTENT_HASH.test(result)) fail(path, "expected sha256:<64 lowercase hex characters>");
	return result;
}

function textValue(value: unknown, path: string): string {
	if (typeof value !== "string") fail(path, "expected string");
	return value;
}

function nullableString(value: unknown, path: string): string | null {
	return value === null ? null : stringValue(value, path);
}

function positive(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) fail(path, "expected positive safe integer");
	return value as number;
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

function parseComponentRef(value: unknown, path: string): ModePackComponentRef {
	const item = record(value, path);
	exactWithOptional(item, ["type", "id", "required", "enabled"], ["delivery"], path);
	const id = stringValue(item.id, `${path}.id`);
	if (!COMPONENT_ID.test(id)) fail(`${path}.id`, "expected a stable component identifier");
	const type = enumValue(item.type, MODE_PACK_COMPONENT_TYPES, `${path}.type`);
	const delivery =
		item.delivery === undefined
			? undefined
			: enumValue(item.delivery, MODE_PACK_RESOURCE_DELIVERIES, `${path}.delivery`);
	if (delivery === "native-skill" && type !== "skill")
		fail(`${path}.delivery`, "native-skill requires a skill component");
	if (delivery === "native-prompt-template" && type !== "prompt" && type !== "workflow")
		fail(`${path}.delivery`, "native-prompt-template requires a prompt or workflow component");
	return {
		type,
		id,
		required: booleanValue(item.required, `${path}.required`),
		enabled: booleanValue(item.enabled, `${path}.enabled`),
		...(delivery ? { delivery } : {}),
	};
}

function parseComponentPin(value: unknown, path: string): ModePackComponentPin {
	const item = record(value, path);
	exactWithOptional(item, ["type", "id", "required", "enabled", "version", "contentHash"], ["delivery"], path);
	const base = parseComponentRef(
		{
			type: item.type,
			id: item.id,
			required: item.required,
			enabled: item.enabled,
			...(item.delivery === undefined ? {} : { delivery: item.delivery }),
		},
		path,
	);
	return {
		...base,
		version: stringValue(item.version, `${path}.version`),
		contentHash: stringValue(item.contentHash, `${path}.contentHash`),
	};
}

function parseShared(
	value: unknown,
	path: string,
	definition: boolean,
): Omit<ModePackDraft, "components"> & { components: unknown[]; contentHash?: string } {
	const item = record(value, path);
	const keys = [
		"version",
		"modePackId",
		"revision",
		"title",
		"description",
		"category",
		"role",
		"runtimeMode",
		"provider",
		"model",
		"thinkingLevel",
		"externalKnowledgePolicy",
		"courseRequired",
		"tools",
		"components",
		"systemPrompt",
		"instructions",
		...(definition ? ["contentHash"] : []),
	] as const;
	exactWithOptional(item, keys, ["packageContentHash", "systemPromptMode"], path);
	if (item.version !== HARNESS_CONTRACT_VERSION) fail(`${path}.version`, "unsupported contract version");
	const modePackId = stringValue(item.modePackId, `${path}.modePackId`);
	if (!MODE_PACK_ID.test(modePackId)) fail(`${path}.modePackId`, "expected lowercase dot/hyphen identifier");
	if (!Array.isArray(item.components)) fail(`${path}.components`, "expected array");
	const systemPrompt = textValue(item.systemPrompt, `${path}.systemPrompt`);
	if (!systemPrompt.trim()) fail(`${path}.systemPrompt`, "expected non-empty prompt");
	return {
		version: HARNESS_CONTRACT_VERSION,
		modePackId,
		revision: positive(item.revision, `${path}.revision`),
		title: stringValue(item.title, `${path}.title`),
		description: stringValue(item.description, `${path}.description`),
		category: enumValue(item.category, MODE_PACK_CATEGORIES, `${path}.category`),
		role: enumValue(item.role, HARNESS_ROLES, `${path}.role`),
		runtimeMode: enumValue(item.runtimeMode, PROFILE_MODES, `${path}.runtimeMode`),
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
		components: item.components,
		systemPrompt,
		...(item.systemPromptMode === undefined
			? {}
			: {
					systemPromptMode: enumValue(
						item.systemPromptMode,
						MODE_PACK_SYSTEM_PROMPT_MODES,
						`${path}.systemPromptMode`,
					),
				}),
		instructions: strings(item.instructions, `${path}.instructions`),
		...(item.packageContentHash === undefined
			? {}
			: { packageContentHash: packageContentHash(item.packageContentHash, `${path}.packageContentHash`) }),
		...(definition ? { contentHash: stringValue(item.contentHash, `${path}.contentHash`) } : {}),
	};
}

export function parseModePackDraft(value: unknown): ModePackDraft {
	const parsed = parseShared(value, "modePackDraft", false);
	return {
		...parsed,
		components: parsed.components.map((component, index) =>
			parseComponentRef(component, `modePackDraft.components[${index}]`),
		),
	};
}

export function parseModePackDefinition(value: unknown): ModePackDefinition {
	const parsed = parseShared(value, "modePackDefinition", true);
	return {
		...parsed,
		components: parsed.components.map((component, index) =>
			parseComponentPin(component, `modePackDefinition.components[${index}]`),
		),
		contentHash: parsed.contentHash as string,
	};
}
