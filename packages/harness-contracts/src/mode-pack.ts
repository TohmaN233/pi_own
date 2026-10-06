import type { HARNESS_CONTRACT_VERSION, HarnessRole } from "./contracts.ts";
import type { ExternalKnowledgePolicy, ProfileMode, ThinkingLevel } from "./domain.ts";

export const MODE_PACK_CATEGORIES = ["education", "coding", "creative", "general"] as const;
export type ModePackCategory = (typeof MODE_PACK_CATEGORIES)[number];

export const MODE_PACK_COMPONENT_TYPES = ["skill", "plugin", "prompt", "workflow", "theme"] as const;
export type ModePackComponentType = (typeof MODE_PACK_COMPONENT_TYPES)[number];

/** How a selected resource reaches Pi.  Omission is the v1 legacy prompt path. */
export const MODE_PACK_RESOURCE_DELIVERIES = ["system-instruction", "native-skill", "native-prompt-template"] as const;
export type ModePackResourceDelivery = (typeof MODE_PACK_RESOURCE_DELIVERIES)[number];

/** Whether a mode owns the complete prompt or extends Pi's coding prompt. */
export const MODE_PACK_SYSTEM_PROMPT_MODES = ["replace", "append"] as const;
export type ModePackSystemPromptMode = (typeof MODE_PACK_SYSTEM_PROMPT_MODES)[number];

export interface ModePackComponentRef {
	type: ModePackComponentType;
	id: string;
	required: boolean;
	enabled: boolean;
	/** Missing on a persisted v1 definition means system-instruction. */
	delivery?: ModePackResourceDelivery;
}

export interface ModePackComponentPin extends ModePackComponentRef {
	version: string;
	contentHash: string;
}

export interface ModePackDraft {
	version: typeof HARNESS_CONTRACT_VERSION;
	modePackId: string;
	revision: number;
	title: string;
	description: string;
	category: ModePackCategory;
	role: HarnessRole;
	runtimeMode: ProfileMode;
	provider: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
	externalKnowledgePolicy: ExternalKnowledgePolicy;
	courseRequired: boolean;
	tools: string[];
	components: ModePackComponentRef[];
	systemPrompt: string;
	/** Missing on persisted v1 packs is resolved by the Host compatibility policy. */
	systemPromptMode?: ModePackSystemPromptMode;
	instructions: string[];
	packageContentHash?: string;
}

export interface ModePackDefinition extends Omit<ModePackDraft, "components"> {
	components: ModePackComponentPin[];
	contentHash: string;
}
