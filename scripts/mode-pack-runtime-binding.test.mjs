import { execFileSync } from "node:child_process";
import test from "node:test";

const source = String.raw`
import assert from "node:assert/strict";
import {
  createDefaultResourceCatalog,
  resolveModePackSnapshot,
} from "./packages/profile-resource-host/src/index.ts";
import {
  MODE_PACK_BINDING_CUSTOM_TYPE,
  assertGenericModePackSnapshot,
  createRuntimeBuiltinModePacks,
  formatModePackSystemPrompt,
  prepareModePackSessionBinding,
  recoverModePackBindingHistory,
  verifyModePackRuntime,
} from "./packages/mode-pack-host/src/index.ts";

const catalog = createDefaultResourceCatalog();
const packs = createRuntimeBuiltinModePacks(catalog);
const coding = packs.coding;
assert.equal(coding.role, "general");
assert.equal(coding.components.some((item) => item.type === "plugin" && item.id === "learning-harness"), false);
const firstSnapshot = resolveModePackSnapshot({
  pack: coding,
  courseVersionId: null,
  catalog,
  createdAt: "2026-08-31T20:00:00.000Z",
});
assertGenericModePackSnapshot(firstSnapshot);
const first = prepareModePackSessionBinding({
  sessionId: "session-mode-1",
  targetSnapshot: firstSnapshot,
  history: [],
  idempotencyKey: "activate-coding",
  createdAt: "2026-08-31T20:00:01.000Z",
});
assert.equal(first.binding.revision, 1);
assert.equal(first.binding.previousSnapshotId, null);
const firstEntries = [{ type: "custom", customType: MODE_PACK_BINDING_CUSTOM_TYPE, data: first.binding }];
const recoveredFirst = recoverModePackBindingHistory(firstEntries, "session-mode-1");
assert.equal(recoveredFirst.current?.snapshot.profileId, "coding");

const creativeSnapshot = resolveModePackSnapshot({
  pack: packs.creative,
  courseVersionId: null,
  catalog,
  createdAt: "2026-08-31T20:00:02.000Z",
});
const second = prepareModePackSessionBinding({
  sessionId: "session-mode-1",
  targetSnapshot: creativeSnapshot,
  history: recoveredFirst.history,
  idempotencyKey: "activate-creative",
  createdAt: "2026-08-31T20:00:03.000Z",
});
assert.equal(second.binding.revision, 2);
assert.equal(second.binding.previousSnapshotId, firstSnapshot.resourceSnapshotId);
const recoveredSecond = recoverModePackBindingHistory([
  ...firstEntries,
  { type: "custom", customType: MODE_PACK_BINDING_CUSTOM_TYPE, data: second.binding },
], "session-mode-1");
assert.equal(recoveredSecond.current?.snapshot.profileId, "creative");
assert.throws(() => recoverModePackBindingHistory([
  { type: "custom", customType: MODE_PACK_BINDING_CUSTOM_TYPE, data: { ...second.binding, revision: 3 } },
], "session-mode-1"), /non-contiguous revision/i);
assert.throws(() => assertGenericModePackSnapshot({
  ...firstSnapshot,
  contentHash: "sha256:forged",
}), /invalid content hash/i);

const prompt = formatModePackSystemPrompt(firstSnapshot, [
  { id: "skill:shared.revision-discipline", text: "Read, edit narrowly, and verify." },
]);
const expected = {
  activeTools: firstSnapshot.tools,
  loadedSkillIds: ["shared.revision-discipline"],
  loadedPluginIds: [],
  loadedPromptIds: ["coding.core", "workflow:coding"],
  loadedThemeIds: [],
};
const evidence = {
  ...expected,
  systemPrompt: prompt,
};
assert.equal(verifyModePackRuntime(firstSnapshot, evidence, expected).verified, true);
assert.equal(verifyModePackRuntime(firstSnapshot, { ...evidence, activeTools: ["read"] }, expected).verified, false);
`;

test("generic Mode Pack bindings are immutable, chained, recoverable, and runtime-verifiable", () => {
  execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });
});
