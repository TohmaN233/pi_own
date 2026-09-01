import type { HARNESS_CONTRACT_VERSION, HarnessRole } from "./contracts.ts";
import type { ExternalKnowledgePolicy, ProfileMode, ThinkingLevel } from "./domain.ts";

export const MODE_PACK_CATEGORIES = ["education", "coding", "creative", "general"] as const;
export type ModePackCategory = (typeof MODE_PACK_CATEGORIES)[number];

export const MODE_PACK_COMPONENT_TYPES = ["skill", "plugin", "prompt", "workflow", "theme"] as const;
export type ModePackComponentType = (typeof MODE_PACK_COMPONENT_TYPES)[number];

export interface ModePackComponentRef {
	type: ModePackComponentType;
	id: string;
	required: boolean;
	enabled: boolean;
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
	instructions: string[];
}

export interface ModePackDefinition extends Omit<ModePackDraft, "components"> {
	components: ModePackComponentPin[];
	contentHash: string;
}
