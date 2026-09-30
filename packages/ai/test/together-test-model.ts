import { getModels, getSupportedThinkingLevels } from "../src/compat.ts";
import { hasApi } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

// Live provider tests exercise capabilities, not a historical SKU. Choose the
// cheapest current reasoning/vision model, with a stable ID tie-breaker.
export function getTogetherTestModel(
	models: readonly Model<Api>[] = getModels("together"),
): Model<"openai-completions"> {
	const candidates = models
		.filter((model) => hasApi(model, "openai-completions"))
		.filter(
			(model) =>
				model.reasoning && model.input.includes("image") && getSupportedThinkingLevels(model).includes("high"),
		)
		.sort((a, b) => a.cost.input - b.cost.input || a.id.localeCompare(b.id));
	const model = candidates[0];
	if (!model) {
		throw new Error(
			`Together tests require a current reasoning/vision Chat Completions model; catalog: ${models.map((entry) => entry.id).join(", ")}`,
		);
	}
	return model;
}
