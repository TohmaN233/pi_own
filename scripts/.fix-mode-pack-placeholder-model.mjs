import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

const path = "apps/pi-web/lib/mode-pack-pi-runtime.ts";
const source = readFileSync(path, "utf8");
const before = `\tconst sourceModel = source.inner.model;\n\tconst model = sourceModel\n\t\t? services.modelRuntime.getModel(sourceModel.provider, sourceModel.id)\n\t\t: undefined;\n\tif (sourceModel && !model) {\n\t\tthrow Object.assign(\n\t\t\tnew Error(\`Mode Pack candidate cannot restore model \${sourceModel.provider}/\${sourceModel.id}\`),\n\t\t\t{ code: "MODE_MODEL_UNAVAILABLE" },\n\t\t);\n\t}\n`;
const after = `\tconst sourceModel = source.inner.model;\n\t// A new Pi session can expose the SDK's unknown/unknown placeholder before\n\t// any real model has been selected. Preserve only a model that the source\n\t// runtime itself can resolve; otherwise let Pi choose its normal default.\n\tconst sourceRegisteredModel = sourceModel\n\t\t? source.inner.modelRuntime.getModel(sourceModel.provider, sourceModel.id)\n\t\t: undefined;\n\tconst model = sourceRegisteredModel\n\t\t? services.modelRuntime.getModel(sourceRegisteredModel.provider, sourceRegisteredModel.id)\n\t\t: undefined;\n\tif (sourceRegisteredModel && !model) {\n\t\tthrow Object.assign(\n\t\t\tnew Error(\`Mode Pack candidate cannot restore model \${sourceRegisteredModel.provider}/\${sourceRegisteredModel.id}\`),\n\t\t\t{ code: "MODE_MODEL_UNAVAILABLE" },\n\t\t);\n\t}\n`;
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`Expected exactly one source-model block, found ${count}`);
writeFileSync(path, source.replace(before, after), "utf8");
unlinkSync("scripts/.fix-mode-pack-placeholder-model.mjs");
