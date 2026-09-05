import {
	HARNESS_CONTRACT_VERSION,
	type ModePackDefinition,
	type ModePackDraft,
	parseModePackDefinition,
	parseResourceSnapshot,
	type ResourceSnapshot,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId, stableStringify } from "../../harness-core/src/index.ts";
import {
	BUILTIN_MODE_PACK_DRAFTS,
	compileModePackDraft,
	type ResourceCatalog,
} from "../../profile-resource-host/src/index.ts";

export const MODE_PACK_BINDING_CUSTOM_TYPE = "pi-own:mode-pack-binding";

export interface ModePackSessionBinding {
	version: typeof HARNESS_CONTRACT_VERSION;
	bindingId: string;
	sessionId: string;
	snapshot: ResourceSnapshot;
	revision: number;
	previousSnapshotId: string | null;
	parentBindingId: string | null;
	idempotencyKey: string;
	requestHash: string;
	createdAt: string;
}

export interface ModePackBindingRecovery {
	history: ModePackSessionBinding[];
	current: ModePackSessionBinding | null;
	inherited: ModePackSessionBinding | null;
}

export interface ModePackEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface ModePackRuntimeEvidence {
	activeTools: string[];
	loadedSkillIds: string[];
	loadedPluginIds: string[];
	loadedPromptIds: string[];
	loadedThemeIds: string[];
	systemPrompt: string;
}

export interface ModePackRuntimeExpectation {
	activeTools: string[];
	loadedSkillIds: string[];
	loadedPluginIds: string[];
	loadedPromptIds: string[];
	loadedThemeIds: string[];
}

export interface ModePackRuntimeVerification {
	verified: boolean;
	issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${path}.${key}: unknown field`);
	}
	for (const key of keys) {
		if (!(key in value)) throw new Error(`${path}.${key}: missing required field`);
	}
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path}: expected non-empty string`);
	return value;
}

function nullableString(value: unknown, path: string): string | null {
	if (value === null) return null;
	return requiredString(value, path);
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`${path}: expected positive safe integer`);
	}
	return value as number;
}

function timestamp(value: unknown, path: string): string {
	const result = requiredString(value, path);
	if (!Number.isFinite(Date.parse(result))) throw new Error(`${path}: expected ISO-8601 timestamp`);
	return result;
}

function snapshotPayload(snapshot: ResourceSnapshot): Record<string, unknown> {
	return {
		version: snapshot.version,
		profileId: snapshot.profileId,
		profileRevision: snapshot.profileRevision,
		role: snapshot.role,
		mode: snapshot.mode,
		courseVersionId: snapshot.courseVersionId,
		provider: snapshot.provider,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		externalKnowledgePolicy: snapshot.externalKnowledgePolicy,
		tools: snapshot.tools,
		resources: snapshot.resources,
		instructions: snapshot.instructions,
	};
}

export function assertResourceSnapshotIntegrity(value: unknown): ResourceSnapshot {
	const snapshot = parseResourceSnapshot(value);
	const payload = snapshotPayload(snapshot);
	const expectedHash = contentHash(payload);
	if (snapshot.contentHash !== expectedHash) {
		throw new Error(`Resource snapshot ${snapshot.resourceSnapshotId} has an invalid content hash`);
	}
	const expectedId = deterministicId("snapshot", { ...payload, createdAt: snapshot.createdAt });
	if (snapshot.resourceSnapshotId !== expectedId) {
		throw new Error(`Resource snapshot ${snapshot.resourceSnapshotId} has an invalid identity`);
	}
	const toolIds = [...snapshot.tools];
	if (new Set(toolIds).size !== toolIds.length || stableStringify(toolIds) !== stableStringify([...toolIds].sort())) {
		throw new Error(`Resource snapshot ${snapshot.resourceSnapshotId} tools must be unique and sorted`);
	}
	const resourceKeys = snapshot.resources.map((resource) => `${resource.kind}:${resource.id}`);
	if (new Set(resourceKeys).size !== resourceKeys.length) {
		throw new Error(`Resource snapshot ${snapshot.resourceSnapshotId} has duplicate resources`);
	}
	return snapshot;
}

export function assertGenericModePackSnapshot(value: unknown): ResourceSnapshot {
	const snapshot = assertResourceSnapshotIntegrity(value);
	if (snapshot.role !== "general" || snapshot.mode !== "general" || snapshot.courseVersionId !== null) {
		throw new Error("Generic Mode Pack snapshots must use role=general, mode=general, and no course binding");
	}
	if (
		snapshot.resources.some(
			(resource) => resource.kind === "extension" && resource.id === "learning-harness" && resource.enabled,
		)
	) {
		throw new Error("Generic Mode Packs must not load the course-only learning-harness extension");
	}
	return snapshot;
}

function bindingRequestHash(input: {
	sessionId: string;
	snapshotId: string;
	previousSnapshotId: string | null;
	parentBindingId: string | null;
	idempotencyKey: string;
}): string {
	return contentHash(input);
}

export function parseModePackSessionBinding(value: unknown): ModePackSessionBinding {
	if (!isRecord(value)) throw new Error("modePackBinding: expected object");
	exactKeys(
		value,
		[
			"version",
			"bindingId",
			"sessionId",
			"snapshot",
			"revision",
			"previousSnapshotId",
			"parentBindingId",
			"idempotencyKey",
			"requestHash",
			"createdAt",
		],
		"modePackBinding",
	);
	if (value.version !== HARNESS_CONTRACT_VERSION) {
		throw new Error("modePackBinding.version: unsupported contract version");
	}
	const sessionId = requiredString(value.sessionId, "modePackBinding.sessionId");
	const bindingId = requiredString(value.bindingId, "modePackBinding.bindingId");
	const snapshot = assertGenericModePackSnapshot(value.snapshot);
	const revision = positiveInteger(value.revision, "modePackBinding.revision");
	const previousSnapshotId = nullableString(value.previousSnapshotId, "modePackBinding.previousSnapshotId");
	const parentBindingId = nullableString(value.parentBindingId, "modePackBinding.parentBindingId");
	const idempotencyKey = requiredString(value.idempotencyKey, "modePackBinding.idempotencyKey");
	const requestHash = requiredString(value.requestHash, "modePackBinding.requestHash");
	const createdAt = timestamp(value.createdAt, "modePackBinding.createdAt");
	if (bindingId !== deterministicId("mode-pack-binding", { sessionId })) {
		throw new Error("modePackBinding.bindingId: invalid stable binding identity");
	}
	const expectedRequestHash = bindingRequestHash({
		sessionId,
		snapshotId: snapshot.resourceSnapshotId,
		previousSnapshotId,
		parentBindingId,
		idempotencyKey,
	});
	if (requestHash !== expectedRequestHash) {
		throw new Error("modePackBinding.requestHash: invalid activation request hash");
	}
	return {
		version: HARNESS_CONTRACT_VERSION,
		bindingId,
		sessionId,
		snapshot,
		revision,
		previousSnapshotId,
		parentBindingId,
		idempotencyKey,
		requestHash,
		createdAt,
	};
}

function allModePackBindings(entries: readonly ModePackEntryLike[]): ModePackSessionBinding[] {
	const all: ModePackSessionBinding[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODE_PACK_BINDING_CUSTOM_TYPE) continue;
		all.push(parseModePackSessionBinding(entry.data));
	}
	return all;
}

function validateBindingSequence(bindings: readonly ModePackSessionBinding[], sessionId: string): void {
	let previous: ModePackSessionBinding | null = null;
	const idempotency = new Map<string, ModePackSessionBinding>();
	for (const binding of bindings) {
		if (binding.bindingId !== deterministicId("mode-pack-binding", { sessionId })) {
			throw new Error("Mode Pack binding history changed its stable binding id");
		}
		if (binding.revision !== (previous?.revision ?? 0) + 1) {
			throw new Error("Mode Pack binding history has a non-contiguous revision");
		}
		if (binding.previousSnapshotId !== (previous?.snapshot.resourceSnapshotId ?? null)) {
			throw new Error("Mode Pack binding history has a broken snapshot chain");
		}
		if (previous && binding.parentBindingId !== previous.parentBindingId) {
			throw new Error("Mode Pack binding history changed its inherited parent binding");
		}
		const replay = idempotency.get(binding.idempotencyKey);
		if (replay && replay.requestHash !== binding.requestHash) {
			throw new Error("Mode Pack binding history reused an idempotency key for another request");
		}
		idempotency.set(binding.idempotencyKey, binding);
		previous = binding;
	}
}

export function recoverModePackBindingHistory(
	entries: readonly ModePackEntryLike[],
	sessionId: string,
): ModePackBindingRecovery {
	const normalizedSessionId = requiredString(sessionId, "sessionId");
	const all = allModePackBindings(entries);
	const groups = new Map<string, ModePackSessionBinding[]>();
	for (const binding of all) {
		const group = groups.get(binding.sessionId) ?? [];
		group.push(binding);
		groups.set(binding.sessionId, group);
	}
	for (const [ownerSessionId, bindings] of groups) validateBindingSequence(bindings, ownerSessionId);

	const current = groups.get(normalizedSessionId) ?? [];
	const inherited = [...all].reverse().find((binding) => binding.sessionId !== normalizedSessionId) ?? null;
	const first = current[0] ?? null;
	if (first && first.parentBindingId !== (inherited?.bindingId ?? null)) {
		throw new Error("Mode Pack binding history has an invalid inherited parent binding");
	}
	const last = current.at(-1) ?? null;
	return {
		history: current.map((binding) => structuredClone(binding)),
		current: last ? structuredClone(last) : null,
		inherited: inherited ? structuredClone(inherited) : null,
	};
}

export function prepareModePackSessionBinding(options: {
	sessionId: string;
	targetSnapshot: ResourceSnapshot;
	history: readonly ModePackSessionBinding[];
	inherited?: ModePackSessionBinding | null;
	idempotencyKey: string;
	createdAt?: string;
}): { binding: ModePackSessionBinding; replay: boolean } {
	const sessionId = requiredString(options.sessionId, "sessionId");
	const idempotencyKey = requiredString(options.idempotencyKey, "idempotencyKey");
	const snapshot = assertGenericModePackSnapshot(options.targetSnapshot);
	validateBindingSequence(options.history, sessionId);
	if (options.history[0] && options.history[0].parentBindingId !== (options.inherited?.bindingId ?? null)) {
		throw new Error("Mode Pack activation inherited parent binding is inconsistent");
	}
	const replay = options.history.find((binding) => binding.idempotencyKey === idempotencyKey);
	if (replay) {
		const expectedReplayHash = bindingRequestHash({
			sessionId,
			snapshotId: snapshot.resourceSnapshotId,
			previousSnapshotId: replay.previousSnapshotId,
			parentBindingId: replay.parentBindingId,
			idempotencyKey,
		});
		if (replay.requestHash !== expectedReplayHash) {
			throw new Error("Mode Pack activation idempotency key was reused for another request");
		}
		return { binding: structuredClone(replay), replay: true };
	}

	const createdAt = options.createdAt ?? new Date().toISOString();
	timestamp(createdAt, "createdAt");
	const current = options.history.at(-1) ?? null;
	const parentBindingId = current?.parentBindingId ?? options.inherited?.bindingId ?? null;
	const previousSnapshotId = current?.snapshot.resourceSnapshotId ?? null;
	const requestHash = bindingRequestHash({
		sessionId,
		snapshotId: snapshot.resourceSnapshotId,
		previousSnapshotId,
		parentBindingId,
		idempotencyKey,
	});
	return {
		binding: {
			version: HARNESS_CONTRACT_VERSION,
			bindingId: deterministicId("mode-pack-binding", { sessionId }),
			sessionId,
			snapshot,
			revision: (current?.revision ?? 0) + 1,
			previousSnapshotId,
			parentBindingId,
			idempotencyKey,
			requestHash,
			createdAt,
		},
		replay: false,
	};
}

function definitionPayload(definition: ModePackDefinition): Omit<ModePackDefinition, "contentHash"> {
	const { contentHash: _contentHash, ...payload } = definition;
	return payload;
}

export function assertModePackDefinitionIntegrity(value: unknown): ModePackDefinition {
	const definition = parseModePackDefinition(value);
	if (definition.contentHash !== contentHash(definitionPayload(definition))) {
		throw new Error(`Mode Pack ${definition.modePackId} has an invalid content hash`);
	}
	return definition;
}

export function createRuntimeBuiltinModePacks(catalog: ResourceCatalog): Readonly<Record<string, ModePackDefinition>> {
	const entries = Object.entries(BUILTIN_MODE_PACK_DRAFTS).map(([modePackId, draft]) => {
		const normalized: ModePackDraft =
			draft.role === "general" && !draft.courseRequired
				? {
						...draft,
						components: draft.components.filter(
							(component) => !(component.type === "plugin" && component.id === "learning-harness"),
						),
					}
				: draft;
		return [modePackId, compileModePackDraft(normalized, catalog)] as const;
	});
	return Object.freeze(Object.fromEntries(entries));
}

function sorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function compareSet(label: string, actual: readonly string[], expected: readonly string[], issues: string[]): void {
	if (stableStringify(sorted(actual)) !== stableStringify(sorted(expected))) {
		issues.push(
			`${label} mismatch: expected ${sorted(expected).join(", ") || "none"}; got ${sorted(actual).join(", ") || "none"}`,
		);
	}
}

export function verifyModePackRuntime(
	snapshotValue: unknown,
	evidence: ModePackRuntimeEvidence,
	expectation: ModePackRuntimeExpectation,
): ModePackRuntimeVerification {
	const snapshot = assertGenericModePackSnapshot(snapshotValue);
	const issues: string[] = [];
	compareSet("active tools", evidence.activeTools, expectation.activeTools, issues);
	compareSet("loaded skills", evidence.loadedSkillIds, expectation.loadedSkillIds, issues);
	compareSet("loaded plugins", evidence.loadedPluginIds, expectation.loadedPluginIds, issues);
	compareSet("loaded prompts", evidence.loadedPromptIds, expectation.loadedPromptIds, issues);
	compareSet("loaded themes", evidence.loadedThemeIds, expectation.loadedThemeIds, issues);
	if (!evidence.systemPrompt.includes(`mode-pack-snapshot:${snapshot.resourceSnapshotId}`)) {
		issues.push("system prompt is missing the active Mode Pack snapshot marker");
	}
	if (!evidence.systemPrompt.includes(snapshot.contentHash)) {
		issues.push("system prompt is missing the active Mode Pack content hash");
	}
	return { verified: issues.length === 0, issues };
}

export function formatModePackSystemPrompt(
	snapshotValue: unknown,
	loadedResourceText: readonly { id: string; text: string }[] = [],
): string {
	const snapshot = assertGenericModePackSnapshot(snapshotValue);
	const sections = [
		`<mode-pack-snapshot:${snapshot.resourceSnapshotId}>`,
		`Active Mode Pack: ${snapshot.profileId}`,
		`Mode Pack content hash: ${snapshot.contentHash}`,
		"Mode Pack guidance is subordinate to platform security, repository instructions, the active tool allowlist, and explicit source-of-truth boundaries.",
		...snapshot.instructions,
	];
	const seen = new Set<string>();
	for (const resource of [...loadedResourceText].sort((left, right) => left.id.localeCompare(right.id))) {
		const id = requiredString(resource.id, "loadedResourceText.id");
		if (seen.has(id)) throw new Error(`Duplicate Mode Pack resource text: ${id}`);
		seen.add(id);
		sections.push(`<mode-pack-resource id="${id}">\n${resource.text}\n</mode-pack-resource>`);
	}
	sections.push(`</mode-pack-snapshot:${snapshot.resourceSnapshotId}>`);
	return sections.join("\n\n");
}
