import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	type ModelDataStructure,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";
import type { Api, Model } from "../src/types.ts";
import { historicalFireworksGlm, historicalFireworksKimi, historicalOpenCodeKimi } from "./historical-models.ts";

describe("historical provider compatibility fixtures", () => {
	it("satisfies the production model data validator without consulting the current catalog", () => {
		const models: Model<Api>[] = [
			historicalFireworksKimi,
			...Object.values(historicalFireworksGlm),
			...Object.values(historicalOpenCodeKimi),
		];
		const structure: ModelDataStructure = {};
		const providers: Record<string, Record<string, Record<string, Model<Api>>>> = {};
		for (const model of models) {
			structure[model.provider] ??= {};
			structure[model.provider][model.id] = model.api;
			providers[model.provider] ??= {};
			providers[model.provider][model.api] ??= {};
			providers[model.provider][model.api][model.id] = model;
		}
		const contents = Object.fromEntries(
			Object.entries(providers).map(([provider, data]) => [`${provider}.json`, `${JSON.stringify(data)}\n`]),
		);
		const root = mkdtempSync(join(tmpdir(), "pi-historical-models-"));
		try {
			for (const [filename, data] of Object.entries(contents)) writeFileSync(join(root, filename), data);
			writeFileSync(
				join(root, MODEL_DATA_MANIFEST_FILE),
				JSON.stringify(createModelDataManifest(structure, contents, "2026-09-30T00:00:00.000Z")),
			);
			expect(() => validateModelDataDirectory(structure, root)).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
