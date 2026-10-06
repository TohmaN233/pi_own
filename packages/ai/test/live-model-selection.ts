import type { BuiltinProvider } from "../src/compat.ts";
import { getModels, getSupportedThinkingLevels } from "../src/compat.ts";
import type { Api, Model, ThinkingLevel } from "../src/types.ts";

export interface LiveOpenAICompletionsModelRequirements {
	inputs?: readonly ("text" | "image")[];
	reasoningLevel?: ThinkingLevel;
}

function isOpenAICompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
	return model.api === "openai-completions";
}

/** Selects a currently registered model for credential-gated API integration tests. */
export function findCurrentOpenAICompletionsModel(
	provider: BuiltinProvider,
	requirements: LiveOpenAICompletionsModelRequirements = {},
): Model<"openai-completions"> | undefined {
	const models = getModels(provider).filter(isOpenAICompletionsModel);
	return models.find(
		(model) =>
			(requirements.inputs ?? []).every((input) => model.input.includes(input)) &&
			(requirements.reasoningLevel === undefined ||
				getSupportedThinkingLevels(model).includes(requirements.reasoningLevel)),
	);
}

/** Fails clearly if a supposedly skipped live integration is accidentally run without a catalog model. */
export function requireCurrentOpenAICompletionsModel(
	model: Model<"openai-completions"> | undefined,
	provider: BuiltinProvider,
): Model<"openai-completions"> {
	if (!model) {
		throw new Error(`No suitable current OpenAI-compatible model is registered for live ${provider} integration`);
	}
	return model;
}
