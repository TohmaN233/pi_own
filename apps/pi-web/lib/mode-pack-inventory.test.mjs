import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  applyModePackToolSelection,
  buildModePackRuntimePlanFromInventory,
  collectModePackRuntimeEvidence,
  inspectModePackInventory,
} = await jiti.import("./mode-pack-inventory.ts");
const { resolveModePackSnapshot } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");
const { verifyModePackRuntime } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");

test("runtime inventory compiles built-in coding resources without the learning-only plugin", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-own-mode-inventory-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const inventory = await inspectModePackInventory(cwd);
  assert.equal(inventory.diagnostics.some((item) => item.severity === "error"), false);
  const definition = inventory.builtinPacks.coding;
  assert.equal(definition.components.some((item) => item.id === "learning-harness"), false);
  const snapshot = resolveModePackSnapshot({
    pack: definition,
    courseVersionId: null,
    catalog: inventory.catalog,
    createdAt: "2026-08-31T21:00:00.000Z",
  });
  const plan = buildModePackRuntimePlanFromInventory({ snapshot, inventory, definition });
  assert.match(plan.systemPrompt, /mode-pack-snapshot:/);
  assert.match(plan.systemPrompt, /shared\.revision-discipline/);
  assert.deepEqual(plan.extensionPaths, []);

  const allTools = snapshot.tools.map((name) => ({ name, sourceInfo: { path: `<builtin:${name}>` } }));
  const active = [];
  const fake = {
    resourceLoader: {
      getExtensions: () => ({ extensions: [] }),
      getSkills: () => ({ skills: [] }),
      getPrompts: () => ({ prompts: [] }),
      getThemes: () => ({ themes: [] }),
    },
    agent: { state: { systemPrompt: plan.systemPrompt } },
    getAllTools: () => allTools,
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (names) => { active.splice(0, active.length, ...names); },
  };
  applyModePackToolSelection(fake, plan);
  const evidence = collectModePackRuntimeEvidence(fake, plan);
  assert.equal(verifyModePackRuntime(snapshot, evidence, plan.expected).verified, true);
});
