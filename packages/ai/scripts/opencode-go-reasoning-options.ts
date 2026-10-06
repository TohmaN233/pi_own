import type { ThinkingLevelMap } from "../src/types.ts";

export function getOpenCodeGoThinkingLevelMap(modelId: string): ThinkingLevelMap | undefined {
	if (modelId !== "kimi-k2.6") return undefined;
	// OpenCode Go exposes Kimi K2.6 thinking as on/off, not distinct effort tiers.
	return { minimal: null, low: null, medium: null };
}
