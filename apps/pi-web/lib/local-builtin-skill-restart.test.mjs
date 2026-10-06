import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("editing an explicitly selected shared Skill refreshes a dormant Course Builder session on restart", { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-local-skill-restart-"));
  const skillRoot = join(root, "skills");
  const cwd = join(root, "project");
  cpSync(resolve("../../skills"), skillRoot, { recursive: true });
  mkdirSync(cwd);
  const overrides = {
    PI_SKILLS_DIR: skillRoot,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_LEARNING_HARNESS_DIR: join(root, "harness"),
    PI_MODE_PACK_STORE_PATH: join(root, "mode-packs.json"),
    ANTHROPIC_API_KEY: "local-skill-restart-offline-fixture",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(async () => {
    for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
  const rpc = await jiti.import("./rpc-manager.ts");
  const { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const before = await new ModePackStore().resolve("course-builder", cwd);
  const { reviseModePackSettings } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");
  const selected = reviseModePackSettings(before.snapshot, { skills: [{ id: "education.lesson-blueprint", enabled: true }] }, before.inventory.catalog);
  const sessionId = rpc.createPersistedGenericSession(cwd, "Editable built-in Skill", selected);
  const skillFile = join(skillRoot, "lesson-blueprint", "SKILL.md");
  writeFileSync(skillFile, `${readFileSync(skillFile, "utf8")}\nLocal teacher customization.\n`);
  const sessionPath = await resolveSessionPath(sessionId);
  assert.ok(sessionPath);
  const restarted = await rpc.startRpcSession(sessionId, sessionPath, undefined);
  assert.equal(restarted.realSessionId, sessionId);
  const status = await rpc.getGenericModePackStatus(sessionId);
  assert.equal(status.runtime.verified, true);
  assert.notEqual(status.runtime.binding.snapshot.resourceSnapshotId, selected.resourceSnapshotId);
  assert.equal(status.runtime.binding.snapshot.resources.find((item) => item.id === "education.lesson-blueprint")?.contentHash,
    (await new ModePackStore().resolve("course-builder", cwd)).inventory.catalog.get("skill", "education.lesson-blueprint")?.contentHash);
  await restarted.session.shutdown();

  const store = new ModePackStore();
  await store.saveDraft({
    version: 1, modePackId: "custom.local-teacher", revision: 1,
    title: "Local teacher", description: "Local Skill edit fixture", category: "general",
    role: "general", runtimeMode: "general", provider: null, model: null,
    thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false,
    tools: ["read"], systemPrompt: "Use the selected local Skill.", instructions: [],
    components: [{ type: "skill", id: "education.lesson-blueprint", required: true, enabled: true, delivery: "native-skill" }],
  }, cwd, 0);
  const customBefore = await store.resolve("custom.local-teacher", cwd);
  const customSessionId = rpc.createPersistedGenericSession(cwd, "Custom local Skill", customBefore.snapshot);
  writeFileSync(skillFile, `${readFileSync(skillFile, "utf8")}\nSecond local edit.\n`);
  const customSessionPath = await resolveSessionPath(customSessionId);
  assert.ok(customSessionPath);
  assert.equal((await store.list(cwd)).packs.find((item) => item.definition.modePackId === "custom.local-teacher")?.selectable, true,
    "an editable local Skill change must not disable its mode in the picker");
  const customRestarted = await rpc.startRpcSession(customSessionId, customSessionPath, undefined);
  assert.equal((await rpc.getGenericModePackStatus(customSessionId)).runtime.verified, true);
  assert.equal(store.getCustom("custom.local-teacher")?.revision, 2);
  await customRestarted.session.shutdown();

  writeFileSync(skillFile, `${readFileSync(skillFile, "utf8")}\nThird local edit.\n`);
  const newSessionId = rpc.createPersistedGenericSession(cwd, "Switch to edited Skill");
  const activated = await rpc.activateGenericModePack({
    sessionId: newSessionId, modePackId: "custom.local-teacher", expectedSnapshotId: null,
    idempotencyKey: "switch-after-local-edit",
  });
  assert.equal(activated.runtime.verified, true);
  assert.equal(store.getCustom("custom.local-teacher")?.revision, 3);
  await rpc.getRpcSession(newSessionId).shutdown();

  rmSync(skillFile);
  await assert.rejects(rpc.startRpcSession(customSessionId, customSessionPath, undefined), /missing/i,
    "deleting the required Skill must still fail explicitly");
});
