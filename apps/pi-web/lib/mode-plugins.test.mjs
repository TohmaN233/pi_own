import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
const { readModePlugins } = await jiti.import("./mode-plugins.ts");
const { bundledCodeModePackage } = await jiti.import("./bundled-code-mode-package.ts");

test("plugin inventory includes current mode-owned selections without calling package manager", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-mode-plugins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugins = readModePlugins(new ModePackStore(join(root, "store.json")));
  const byMode = (modePackId) => plugins.filter((plugin) => plugin.modePackId === modePackId);
  // pi-subagents is the single Host baseline owner, not a second mode plugin.
  assert.deepEqual(byMode("coding").filter((plugin) => plugin.enabled).map((plugin) => plugin.id), [
    "code.extension.pi-lsp-extension", "code.extension.pi-permission-system",
    "code.extension.pi-web-access", "code.extension.pi-workspace-history",
  ]);
  assert.equal(byMode("coding").find((plugin) => plugin.id === "code.extension.pi-mcp-adapter")?.enabled, false);
  assert.match(byMode("coding").find((plugin) => plugin.id === "code.extension.pi-lsp-extension")?.source ?? "", /^npm:pi-lsp-extension@/);
  assert.deepEqual(byMode("course-builder").map((plugin) => plugin.id), ["course-builder"]);
  assert.equal(byMode("study-research.study").length, 3);
  assert.equal(byMode("study-research.research").length, 6);
  assert.equal(byMode("general").length, 0);
  assert.equal(byMode("creative").length, 0);
});

test("plugin inventory uses the single edited mode definition", () => {
  const definition = structuredClone(bundledCodeModePackage().definition);
  definition.components = definition.components.filter((component) => component.id !== "code.extension.pi-lsp-extension");
  const plugins = readModePlugins({ listCustom: () => [definition] });
  assert.equal(plugins.some((plugin) => plugin.modePackId === "coding" && plugin.id === "code.extension.pi-lsp-extension"), false);
});
