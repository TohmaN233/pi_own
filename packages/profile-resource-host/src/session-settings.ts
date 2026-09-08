import {
	type ProfileDefinition,
	parseResourceSnapshot,
	type ResourceSnapshot,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "../../harness-contracts/src/index.ts";
import { contentHash } from "../../harness-core/src/index.ts";
import { type ResourceCatalog, resolveProfileSnapshot } from "./profile-resource-host.ts";

export interface ModePackSettingsPatch {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	tools?: string[];
	skills?: Array<{ id: string; enabled: boolean }>;
}

export function parseModePackSettingsPatch(value: unknown): ModePackSettingsPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mode settings must be an object");
	const item = value as Record<string, unknown>;
	for (const key of Object.keys(item)) {
		if (!["provider", "model", "thinkingLevel", "systemPrompt", "skills", "tools"].includes(key))
			throw new Error(`Unknown mode setting: ${key}`);
	}
	for (const key of ["provider", "model", "systemPrompt"]) {
		if (item[key] !== undefined && (typeof item[key] !== "string" || !item[key].trim()))
			throw new Error(`${key} must be non-empty text`);
	}
	if ((item.provider === undefined) !== (item.model === undefined))
		throw new Error("provider and model must be changed together");
	if (item.thinkingLevel !== undefined && !THINKING_LEVELS.includes(item.thinkingLevel as ThinkingLevel))
		throw new Error("Invalid thinking level");
	if (typeof item.systemPrompt === "string" && item.systemPrompt.length > 64_000)
		throw new Error("System prompt exceeds 64000 characters");
	if (item.tools !== undefined) {
		const builtinTools = new Set(["bash", "powershell", "read", "write", "edit", "grep", "find", "ls"]);
		if (!Array.isArray(item.tools) || item.tools.some((tool) => typeof tool !== "string" || !builtinTools.has(tool)))
			throw new Error("tools must contain only built-in tool names");
		if (new Set(item.tools).size !== item.tools.length) throw new Error("Duplicate tool selection");
	}
	if (item.skills !== undefined) {
		if (!Array.isArray(item.skills)) throw new Error("skills must be an array");
		const ids = new Set<string>();
		for (const skill of item.skills) {
			if (
				!skill ||
				typeof skill.id !== "string" ||
				!skill.id.trim() ||
				typeof skill.enabled !== "boolean" ||
				Object.keys(skill).some((key) => key !== "id" && key !== "enabled")
			)
				throw new Error("Invalid skill selection");
			if (ids.has(skill.id)) throw new Error(`Duplicate skill: ${skill.id}`);
			ids.add(skill.id);
		}
	}
	if (!Object.keys(item).length) throw new Error("No mode settings supplied");
	return structuredClone(item) as ModePackSettingsPatch;
}

export function modeSystemPrompt(snapshot: ResourceSnapshot): string {
	if (!snapshot.instructions[0]?.startsWith("Mode Pack:") || !snapshot.instructions[2])
		throw new Error("This legacy profile has no editable Mode Pack system prompt");
	return snapshot.instructions[2];
}

export function hasSessionSettings(snapshot: ResourceSnapshot): boolean {
	return snapshot.instructions[1]?.startsWith("Session Mode Pack settings hash:") ?? false;
}

/** Revise user settings while retaining role, learner tool and source boundaries. */
export function reviseModePackSettings(
	snapshotValue: ResourceSnapshot,
	value: unknown,
	catalog: ResourceCatalog,
	createdAt?: string,
): ResourceSnapshot {
	const snapshot = parseResourceSnapshot(snapshotValue);
	const patch = parseModePackSettingsPatch(value);
	if (patch.tools !== undefined && snapshot.role === "student")
		throw new Error(
			"Learner tools are controlled by the learning activity; change its mode to select another activity",
		);
	const resourceInstructions = new Set(
		snapshot.resources.flatMap((resource) => catalog.get(resource.kind, resource.id)?.instructions ?? []),
	);
	const instructions = snapshot.instructions.filter(
		(instruction, index) => index < 3 || !resourceInstructions.has(instruction),
	);
	modeSystemPrompt(snapshot);
	if (patch.systemPrompt !== undefined) instructions[2] = patch.systemPrompt.trim();
	const resources = snapshot.resources.map((resource) => ({ ...resource }));
	for (const selection of patch.skills ?? []) {
		const existing = resources.find((resource) => resource.kind === "skill" && resource.id === selection.id);
		if (existing?.required && !selection.enabled)
			throw new Error(`Required Skill cannot be disabled: ${selection.id}`);
		if (existing) existing.enabled = selection.enabled;
		else if (selection.enabled) {
			const installed = catalog.get("skill", selection.id);
			if (!installed) throw new Error(`Unknown Skill: ${selection.id}`);
			resources.push({
				kind: "skill",
				id: installed.id,
				version: installed.version,
				contentHash: installed.contentHash,
				required: false,
				enabled: true,
			});
		} else throw new Error(`Skill is not part of this mode: ${selection.id}`);
	}
	const base: ProfileDefinition = {
		version: snapshot.version,
		profileId: snapshot.profileId,
		revision: snapshot.profileRevision + 1,
		role: snapshot.role,
		mode: snapshot.mode,
		provider: patch.provider ?? snapshot.provider,
		model: patch.model ?? snapshot.model,
		thinkingLevel: patch.thinkingLevel ?? snapshot.thinkingLevel,
		externalKnowledgePolicy: snapshot.externalKnowledgePolicy,
		courseRequired: snapshot.courseVersionId !== null,
		tools: [...(patch.tools ?? snapshot.tools)],
		resources,
		instructions,
	};
	instructions[1] = `Session Mode Pack settings hash: ${contentHash({ ...base, instructions: instructions.filter((_, index) => index !== 1) })}`;
	return resolveProfileSnapshot({
		base,
		catalog,
		courseVersionId: snapshot.courseVersionId,
		...(createdAt ? { createdAt } : {}),
	});
}
