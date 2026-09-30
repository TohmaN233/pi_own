import type { Model } from "../src/types.ts";

// Snapshots of generated public provider metadata retained before the 2026-09-30
// catalog refresh removed these IDs. These are inputs for offline compatibility
// regressions, never replacements for the production catalog or live API tests.
export const historicalFireworksKimi: Model<"anthropic-messages"> = {
	id: "accounts/fireworks/models/kimi-k2p6",
	name: "Kimi K2.6",
	provider: "fireworks",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	contextWindow: 262000,
	maxTokens: 262000,
	api: "anthropic-messages",
	baseUrl: "https://api.fireworks.ai/inference",
	compat: {
		sendSessionAffinityHeaders: true,
		supportsEagerToolInputStreaming: false,
		supportsCacheControlOnTools: false,
		supportsLongCacheRetention: false,
	},
};

export const historicalFireworksGlm: Record<
	"accounts/fireworks/models/glm-5p2" | "accounts/fireworks/routers/glm-5p2-fast",
	Model<"openai-completions">
> = {
	"accounts/fireworks/models/glm-5p2": {
		id: "accounts/fireworks/models/glm-5p2",
		name: "GLM 5.2",
		provider: "fireworks",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
		contextWindow: 1048575,
		maxTokens: 131072,
		api: "openai-completions",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			sendSessionAffinityHeaders: true,
			supportsLongCacheRetention: false,
		},
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: "high",
			medium: "high",
			high: "high",
			xhigh: null,
			max: "max",
		},
	},
	"accounts/fireworks/routers/glm-5p2-fast": {
		id: "accounts/fireworks/routers/glm-5p2-fast",
		name: "GLM 5.2 Fast",
		provider: "fireworks",
		reasoning: true,
		input: ["text"],
		cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 },
		contextWindow: 1048575,
		maxTokens: 131072,
		api: "openai-completions",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			sendSessionAffinityHeaders: true,
			supportsLongCacheRetention: false,
		},
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: "high",
			medium: "high",
			high: "high",
			xhigh: null,
			max: "max",
		},
	},
};

export const historicalOpenCodeKimi: Record<"opencode" | "opencode-go", Model<"openai-completions">> = {
	opencode: {
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			thinkingFormat: "deepseek",
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
		contextWindow: 262144,
		maxTokens: 65536,
	},
	"opencode-go": {
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			thinkingFormat: "deepseek",
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
		contextWindow: 262144,
		maxTokens: 65536,
		thinkingLevelMap: { minimal: null, low: null, medium: null },
	},
};
