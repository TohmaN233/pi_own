import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { getTogetherTestModel } from "./together-test-model.ts";

function model(id: string, overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "together",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...overrides,
	};
}

describe("Together live test model selection", () => {
	it("selects a capable replacement after a historical ID disappears", () => {
		const replacement = model("replacement");
		expect(
			getTogetherTestModel([
				model("text-only", { input: ["text"] }),
				model("no-reasoning", { reasoning: false }),
				model("no-high", { thinkingLevelMap: { high: null } }),
				replacement,
			]),
		).toBe(replacement);
	});

	it("chooses by input price then ID regardless of catalog order", () => {
		const first = model("a");
		const second = model("b");
		const expensive = model("0", { cost: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } });
		expect(getTogetherTestModel([second, expensive, first])).toBe(first);
		expect(getTogetherTestModel([first, expensive, second])).toBe(first);
	});

	it("fails explicitly when the catalog has no model with the required capabilities", () => {
		expect(() => getTogetherTestModel([])).toThrow("require a current reasoning/vision Chat Completions model");
		expect(() => getTogetherTestModel([model("text-only", { input: ["text"] })])).toThrow("catalog: text-only");
	});

	it("selects a capable model from the fresh runtime catalog", () => {
		const selected = getTogetherTestModel();
		expect(selected.provider).toBe("together");
		expect(selected.api).toBe("openai-completions");
		expect(selected.reasoning).toBe(true);
		expect(selected.input).toContain("image");
		expect(getSupportedThinkingLevels(selected)).toContain("high");
	});
});
