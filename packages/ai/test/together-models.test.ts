import { afterEach, describe, expect, it } from "vitest";
import { getTogetherCompat, getTogetherThinkingLevelMap } from "../scripts/together-reasoning-options.ts";
import { getModels, getSupportedThinkingLevels } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { findCurrentOpenAICompletionsModel } from "./live-model-selection.ts";
import { TOGETHER_KIMI_K2_6_MODEL } from "./model-fixtures.ts";

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	it("registers the current catalog via OpenAI-compatible Chat Completions API", () => {
		const models = getModels("together");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("together");
			expect(model.baseUrl).toBe("https://api.together.ai/v1");
			expect(model.compat).toMatchObject({
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
			});
		}
	});

	it("selects current Together models with the requested live-test capabilities", () => {
		const highReasoning = findCurrentOpenAICompletionsModel("together", { reasoningLevel: "high" });
		const imageReasoning = findCurrentOpenAICompletionsModel("together", {
			inputs: ["image"],
			reasoningLevel: "high",
		});

		expect(highReasoning ? getSupportedThinkingLevels(highReasoning) : []).toContain("high");
		expect(imageReasoning?.input).toContain("image");
		expect(imageReasoning ? getSupportedThinkingLevels(imageReasoning) : []).toContain("high");
	});

	it("models Together reasoning controls from the Together API surface", () => {
		// Exercise generator policy even if a model disappears from the live catalog.
		const gptOss = {
			thinkingLevelMap: getTogetherThinkingLevelMap("openai/gpt-oss-120b", true),
			compat: getTogetherCompat("openai/gpt-oss-120b", true),
		};
		expect(gptOss.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
		});
		expect(gptOss.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const deepSeekV4 = {
			thinkingLevelMap: getTogetherThinkingLevelMap("deepseek-ai/DeepSeek-V4-Pro", true),
			compat: getTogetherCompat("deepseek-ai/DeepSeek-V4-Pro", true),
		};
		expect(deepSeekV4.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
		expect(deepSeekV4.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "together",
		});

		const minimax = {
			thinkingLevelMap: getTogetherThinkingLevelMap("MiniMaxAI/MiniMax-M2.7", true),
			compat: getTogetherCompat("MiniMaxAI/MiniMax-M2.7", true),
		};
		expect(minimax.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
		expect(minimax.compat?.thinkingFormat).toBeUndefined();
		expect(minimax.compat?.supportsReasoningEffort).toBe(false);
	});

	it("keeps the retired Kimi protocol policy test independent of current catalog membership", () => {
		expect(getTogetherCompat(TOGETHER_KIMI_K2_6_MODEL.id, TOGETHER_KIMI_K2_6_MODEL.reasoning)).toEqual(
			TOGETHER_KIMI_K2_6_MODEL.compat,
		);
		expect(getTogetherThinkingLevelMap(TOGETHER_KIMI_K2_6_MODEL.id, TOGETHER_KIMI_K2_6_MODEL.reasoning)).toEqual(
			TOGETHER_KIMI_K2_6_MODEL.thinkingLevelMap,
		);
	});

	it("handles ordinary reasoning toggles and non-reasoning models independently of catalog membership", () => {
		expect(getTogetherCompat("fixture/reasoning", true)).toMatchObject({
			thinkingFormat: "together",
			supportsReasoningEffort: false,
		});
		expect(getTogetherThinkingLevelMap("fixture/reasoning", true)).toEqual({
			minimal: null,
			low: null,
			medium: null,
		});
		expect(getTogetherCompat("fixture/plain", false).thinkingFormat).toBeUndefined();
		expect(getTogetherThinkingLevelMap("fixture/plain", false)).toBeUndefined();
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
