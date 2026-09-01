import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("rpc manager rebuilds and verifies generic Mode Pack runtimes instead of mutating prompt only", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /createAgentSessionServices/);
  assert.match(source, /additionalSkillPaths: plan\.skillPaths/);
  assert.match(source, /additionalExtensionPaths: plan\.extensionPaths/);
  assert.match(source, /noExtensions: true/);
  assert.match(source, /verifyModePackRuntime/);
  assert.match(source, /appendModePackBinding/);
  assert.match(source, /recoverModePackBindingHistory/);
  assert.match(source, /An unpinned Mode Pack must not replace a persisted session.s saved model/);
  assert.match(source, /await existing\.shutdown\(\);\s*appendModePackBinding/);
  assert.match(source, /journalCommitted = true/);
  assert.match(source, /never resurrect the previous runtime/);
  assert.match(source, /Reopen the session to recover the committed snapshot/);
  assert.match(source, /Mode Pack sessions own their tool selection/);
});

// PR #3: actual SDK sessions and JSONL, not a source-pattern substitute for recovery.
// This test makes no provider request and is NOT the credentialed/browser smoke.
test("real Pi runtime switches, restarts, forks, and fails closed after a committed activation", { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-mode-runtime-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const overrides = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_LEARNING_HARNESS_DIR: join(root, "harness"),
    PI_MODE_PACK_STORE_PATH: join(root, "mode-packs.json"),
    // Offline model availability only. The fetch tripwire prohibits requests.
    ANTHROPIC_API_KEY: "mode-pack-smoke-not-a-real-key",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Provider/network access is forbidden in this smoke test"); };
  t.after(async () => {
    for (const wrapper of globalThis.__piSessions?.values() ?? []) {
      await wrapper.shutdown().catch(() => undefined);
    }
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const rpc = await jiti.import("./rpc-manager.ts");
  const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const { recoverModePackBindingHistory } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");

  const initial = await rpc.startRpcSession("__mode_pack_smoke__", "", cwd);
  const sessionId = initial.realSessionId;
  await initial.session.waitUntilReady();
  const models = await initial.session.inner.modelRuntime.getAvailable();
  assert.ok(models.length > 1, "offline provider fixture must offer a non-default model");
  const chosen = models.find((model) => model.id !== initial.session.inner.model?.id) ?? models[0];
  await initial.session.send({ type: "set_model", provider: chosen.provider, modelId: chosen.id });
  const expectedModel = { provider: chosen.provider, id: chosen.id };
  const modelOf = (wrapper) => ({ provider: wrapper.inner.model?.provider, id: wrapper.inner.model?.id });

  const first = await rpc.activateGenericModePack({
    sessionId, modePackId: "coding", expectedSnapshotId: null, idempotencyKey: "smoke-coding",
  });
  assert.equal(first.runtime.verified, true);
  let live = rpc.getRpcSession(sessionId);
  const sessionFile = live.sessionFile;
  assert.deepEqual(modelOf(live), expectedModel);
  const readBinding = () => {
    const disk = SessionManager.open(sessionFile, undefined);
    return recoverModePackBindingHistory(disk.getEntries(), sessionId).current;
  };
  assert.equal(readBinding()?.requestHash, first.binding.requestHash, "binding must exist on disk, not just in memory");

  const second = await rpc.activateGenericModePack({
    sessionId, modePackId: "creative", expectedSnapshotId: first.binding.snapshot.resourceSnapshotId,
    idempotencyKey: "smoke-creative",
  });
  assert.equal(second.runtime.verified, true);
  assert.equal(second.binding.revision, 2);
  assert.equal(readBinding()?.snapshot.profileId, "creative");
  live = rpc.getRpcSession(sessionId);
  assert.deepEqual(modelOf(live), expectedModel);
  await live.shutdown();
  const reopened = await rpc.startRpcSession(sessionId, sessionFile, undefined);
  assert.deepEqual(modelOf(reopened.session), expectedModel);
  assert.equal((await rpc.getGenericModePackStatus(sessionId)).runtime.verified, true);

  // Fail specifically after append/registration, when status verification reads the store.
  const originalList = ModePackStore.prototype.list;
  ModePackStore.prototype.list = async () => { throw new Error("injected post-commit status failure"); };
  try {
    await assert.rejects(rpc.activateGenericModePack({
      sessionId, modePackId: "general", expectedSnapshotId: second.binding.snapshot.resourceSnapshotId,
      idempotencyKey: "smoke-post-commit",
    }), /committed to the Pi transcript/i);
  } finally {
    ModePackStore.prototype.list = originalList;
  }
  assert.equal(rpc.getRpcSession(sessionId)?.isAlive() ?? false, false);
  assert.equal(readBinding()?.snapshot.profileId, "general");
  const recovered = await rpc.startRpcSession(sessionId, sessionFile, undefined);
  assert.equal((await rpc.getGenericModePackStatus(sessionId)).runtime.binding.snapshot.profileId, "general");

  // The real fork command copies the committed binding before this fixture turn.
  // No assistant response is fabricated and no paid API is called.
  const userEntryId = recovered.session.inner.sessionManager.appendMessage({
    role: "user", content: "Mode Pack fork fixture; not a provider request.", timestamp: Date.now(),
  });
  const forked = await recovered.session.send({ type: "fork", entryId: userEntryId });
  assert.equal(forked.cancelled, false);
  assert.notEqual(forked.newSessionId, sessionId);
  const childStatus = await rpc.getGenericModePackStatus(forked.newSessionId);
  assert.equal(childStatus.runtime.inheritedBinding?.snapshot.profileId, "general");
  const childFile = SessionManager.list(cwd, join(root, "sessions"));
  // Resolve the SDK-created child by its persisted header, not by guessing a filename.
  const sessions = await childFile;
  const child = sessions.find((entry) => entry.id === forked.newSessionId);
  assert.ok(child, "fork must be discoverable as a real persisted Pi session");
  const resumedChild = await rpc.startRpcSession(forked.newSessionId, child.path, undefined);
  const inherited = (await rpc.getGenericModePackStatus(forked.newSessionId)).runtime.binding;
  assert.equal(inherited.sessionId, forked.newSessionId);
  assert.equal(inherited.parentBindingId, readBinding().bindingId);
  assert.equal(inherited.revision, 1);
  assert.deepEqual(modelOf(resumedChild.session), expectedModel);

  // A missing required physical Skill blocks restart, never falls back to ordinary Pi.
  const skillDir = join(agentDir, "skills", "mode-pack-required-smoke");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  const skillText = "---\nname: mode-pack-required-smoke\ndescription: Required runtime smoke fixture.\n---\nUse this fixture only for deterministic runtime verification.\n";
  writeFileSync(skillFile, skillText);
  const store = new ModePackStore();
  const listed = await store.list(cwd);
  const requiredSkill = listed.inventory.resources.find((resource) => resource.kind === "skill" && resource.paths.includes(skillFile));
  assert.ok(requiredSkill, "fixture Skill must be discovered by the real inventory");
  const base = listed.inventory.builtinPacks.general;
  const { contentHash: _hash, ...draft } = base;
  const definition = await store.saveDraft({
    ...draft, modePackId: "custom.smoke-required", revision: 1,
    components: [{ type: "skill", id: requiredSkill.id, required: true, enabled: true }],
  }, cwd, 0);
  const required = await rpc.activateGenericModePack({
    sessionId: forked.newSessionId, modePackId: definition.modePackId,
    expectedSnapshotId: inherited.snapshot.resourceSnapshotId, idempotencyKey: "smoke-required",
  });
  assert.equal(required.runtime.verified, true);
  await rpc.getRpcSession(forked.newSessionId).shutdown();
  rmSync(skillFile);
  await assert.rejects(rpc.startRpcSession(forked.newSessionId, child.path, undefined), /required.*missing|missing.*required/i);
  assert.equal(rpc.getRpcSession(forked.newSessionId)?.isAlive() ?? false, false);
  assert.match(readFileSync(child.path, "utf8"), /custom\.smoke-required/);
});
