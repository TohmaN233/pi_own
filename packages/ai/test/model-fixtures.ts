import type { Model } from "../src/types.ts";

/**
 * Historical model records used only to exercise provider protocols offline.
 * Live catalog membership is asserted by the provider registration tests.
 */
export const TOGETHER_KIMI_K2_6_MODEL = {
	id: "moonshotai/Kimi-K2.6",
	name: "Kimi K2.6",
	api: "openai-completions",
	provider: "together",
	baseUrl: "https://api.together.ai/v1",
	reasoning: true,
	thinkingLevelMap: { minimal: null, low: null, medium: null },
	input: ["text", "image"],
	cost: { input: 1.2, output: 4.5, cacheRead: 0.2, cacheWrite: 0 },
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		thinkingFormat: "together",
		supportsStrictMode: false,
		supportsLongCacheRetention: false,
	},
	contextWindow: 262144,
	maxTokens: 131000,
} satisfies Model<"openai-completions">;

export const OPENCODE_KIMI_K2_6_MODEL = {
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
} satisfies Model<"openai-completions">;

export const OPENCODE_GO_KIMI_K2_6_MODEL = {
	...OPENCODE_KIMI_K2_6_MODEL,
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	thinkingLevelMap: { minimal: null, low: null, medium: null },
} satisfies Model<"openai-completions">;

export const MOONSHOT_CN_KIMI_K2_6_MODEL = {
	id: "kimi-k2.6",
	name: "Kimi K2.6",
	api: "openai-completions",
	provider: "moonshotai-cn",
	baseUrl: "https://api.moonshot.cn/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 262144,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
		thinkingFormat: "deepseek",
	},
} satisfies Model<"openai-completions">;

export const FIREWORKS_KIMI_K2_6_MODEL = {
	id: "accounts/fireworks/models/kimi-k2p6",
	name: "Kimi K2.6",
	api: "anthropic-messages",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
	contextWindow: 262000,
	maxTokens: 262000,
	compat: {
		sendSessionAffinityHeaders: true,
		supportsEagerToolInputStreaming: false,
		supportsCacheControlOnTools: false,
		supportsLongCacheRetention: false,
	},
} satisfies Model<"anthropic-messages">;

export const FIREWORKS_GLM_5P2_MODEL = {
	id: "accounts/fireworks/models/glm-5p2",
	name: "GLM 5.2",
	api: "openai-completions",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
	contextWindow: 1048575,
	maxTokens: 131072,
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
} satisfies Model<"openai-completions">;

export const FIREWORKS_GLM_5P2_FAST_MODEL = {
	...FIREWORKS_GLM_5P2_MODEL,
	id: "accounts/fireworks/routers/glm-5p2-fast",
	name: "GLM 5.2 Fast",
} satisfies Model<"openai-completions">;

const FIREWORKS_KIMI_K3_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "openai",
	deferredToolsMode: "kimi",
	sendSessionAffinityHeaders: true,
	supportsLongCacheRetention: false,
} satisfies NonNullable<Model<"openai-completions">["compat"]>;

const FIREWORKS_KIMI_K3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: "max",
} as const;

export const FIREWORKS_KIMI_K3_MODEL = {
	id: "accounts/fireworks/models/kimi-k3",
	name: "Kimi K3",
	api: "openai-completions",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 131072,
	compat: FIREWORKS_KIMI_K3_COMPAT,
	thinkingLevelMap: FIREWORKS_KIMI_K3_THINKING_LEVEL_MAP,
} satisfies Model<"openai-completions">;

export const FIREWORKS_KIMI_K3_FAST_MODEL = {
	...FIREWORKS_KIMI_K3_MODEL,
	id: "accounts/fireworks/routers/kimi-k3-fast",
	name: "Kimi K3 Fast",
	cost: { input: 4.5, output: 22.5, cacheRead: 0.45, cacheWrite: 0 },
} satisfies Model<"openai-completions">;

function createOpenCodeCacheFixture(provider: "opencode" | "opencode-go", id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: provider === "opencode" ? "https://opencode.ai/zen/v1" : "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 16384,
		compat: { supportsLongCacheRetention: false },
	};
}

export const OPENCODE_CACHE_RETENTION_MODELS: Model<"openai-completions">[] = [
	createOpenCodeCacheFixture("opencode", "deepseek-v4-flash"),
	createOpenCodeCacheFixture("opencode", "deepseek-v4-pro"),
	createOpenCodeCacheFixture("opencode", "kimi-k2.5"),
	OPENCODE_KIMI_K2_6_MODEL,
	createOpenCodeCacheFixture("opencode", "minimax-m2.7"),
	OPENCODE_GO_KIMI_K2_6_MODEL,
];
