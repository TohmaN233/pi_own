import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  expectedModePackActiveTools,
  inspectModePackInventory,
} = await jiti.import("./mode-pack-inventory.ts");
const { inspectModePackAvailability, parseModePackSettingsPatch } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");

test("Code Mode inventory is installable without eagerly materializing its private package", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-own-mode-inventory-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const inventory = await inspectModePackInventory(cwd, { includeBundledCode: true });
  assert.equal(inventory.diagnostics.some((item) => item.severity === "error"), false);
  const definition = inventory.builtinPacks.coding;
  assert.equal(definition.systemPromptMode, "append", "Code is the only built-in mode that opts into Pi's coding prompt");
  assert.ok(definition.tools.includes("codemode"), "Code activates Pi's native codemode tool");
  assert.deepEqual(inspectModePackAvailability(definition, inventory.catalog).missingRequiredResources.filter((id) => id.startsWith("tool:")), [], "all declared Code tools must resolve before dependency installation");
  assert.deepEqual(parseModePackSettingsPatch({ tools: [...definition.tools] }).tools, definition.tools, "model/settings changes must retain every Code tool");
  assert.equal(definition.components.some((item) => item.id === "learning-harness"), false);
  assert.ok(definition.components.some((item) => item.id === "incremental-implementation" && item.delivery === "native-skill"));
  assert.ok(definition.components.some((item) => item.id === "grill-with-docs" && item.delivery === "native-skill"));
  assert.equal(definition.components.some((item) => item.id.startsWith("code.skill.")), false, "Skill identities stay generic and mode selection provides the namespace");
  assert.equal(definition.components.some((item) => item.id === "coding.core" || item.id === "coding" || item.id === "shared.revision-discipline"), false);
  assert.equal(inventory.catalog.get("extension", "code.extension.pi-lsp-extension")?.available, false);
  assert.equal(inventory.resources.some((resource) => resource.id === "learning-harness" || resource.id === "course-builder" || resource.id.startsWith("study.")), false, "packaged mode inventory does not read or expose unrelated mode resources");
});

// PR #3 CI exposed the AgentSessionLike boundary: sourceInfo is unknown.
test("plugin tool selection rejects malformed metadata and accepts only selected physical sources", () => {
  const selected = join(tmpdir(), "pi-own-selected-plugin.ts");
  const other = join(tmpdir(), "pi-own-other-plugin.ts");
  const metadata = [undefined, null, 17, "text", [], {}, { path: null }, { path: 17 }, { path: "" }];
  const tools = metadata.map((sourceInfo, index) => ({ name: `invalid-${index}`, sourceInfo }));
  tools.push(
    { name: "builtin-extra", sourceInfo: { path: "<builtin:extra>" } },
    { name: "unselected", sourceInfo: { path: other } },
    { name: "selected", sourceInfo: { path: selected } },
  );
  const session = {
    getAllTools: () => tools,
    getActiveToolNames: () => [],
    settingsManager: { getDefaultTools: () => undefined },
    resourceLoader: { getExtensions: () => ({ extensions: [] }) },
  };
  const plan = { toolNames: ["read"], extensionPaths: [selected] };
  assert.deepEqual(expectedModePackActiveTools(session, plan), ["read", "selected"]);
  assert.deepEqual(expectedModePackActiveTools(session, { ...plan, extensionPaths: [] }), ["read"]);
});

test("late native MCP tools retain their configured direct, deferred and hidden exposure", () => {
  const tools = new Map([
    ["mcp__fixture__direct", { definition: { exposure: "direct" } }],
    ["mcp__fixture__script", { definition: { exposure: "codemode" } }],
    ["mcp__fixture__deferred", { definition: { exposure: "deferred" } }],
    ["mcp__fixture__hidden", { definition: { exposure: "hidden" } }],
  ]);
  const extensions = [{ path: "<inline:pi-native-mcp>", tools }];
  const session = { getAllTools: () => [], getActiveToolNames: () => [], settingsManager: { getDefaultTools: () => undefined }, resourceLoader: { getExtensions: () => ({ extensions }) } };
  const plan = { toolNames: ["codemode"], extensionPaths: [] };
  assert.deepEqual(expectedModePackActiveTools(session, plan), ["codemode", "mcp__fixture__direct"]);
  tools.set("mcp__fixture__late", { definition: { exposure: "direct" } });
  assert.deepEqual(expectedModePackActiveTools(session, plan), ["codemode", "mcp__fixture__direct", "mcp__fixture__late"]);
});

test("plugin tool selection uses the selected extension registration when SDK source metadata is unavailable", () => {
  const selected = join(tmpdir(), "pi-own-selected-plugin-registration.ts");
  const other = join(tmpdir(), "pi-own-other-plugin-registration.ts");
  const session = {
    getAllTools: () => [{ name: "malformed", sourceInfo: {} }],
    getActiveToolNames: () => [],
    settingsManager: { getDefaultTools: () => undefined },
    resourceLoader: {
      getExtensions: () => ({
        extensions: [
          { path: selected, tools: new Map([["selected-tool", {}]]) },
          { path: other, tools: new Map([["other-tool", {}]]) },
        ],
      }),
    },
  };
  assert.deepEqual(expectedModePackActiveTools(session, { toolNames: ["read"], extensionPaths: [selected] }), ["read", "selected-tool"]);
});
