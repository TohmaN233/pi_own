import type { ThinkingLevelMap } from "../src/types.ts";

export function getFireworksThinkingLevelMap(modelId: string): ThinkingLevelMap | undefined {
	if (!modelId.includes("glm-5p2")) return undefined;
	return { off: "none", minimal: null, low: "high", medium: "high", max: "max" };
}
