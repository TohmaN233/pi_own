import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

// Actual SDK sessions and JSONL, not a source-pattern substitute for recovery.
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
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const rpc = await jiti.import("./rpc-manager.ts");
  const { resolveSessionPath } = await jiti.import("./session-reader.ts");
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
  ModePackStore.prototype.list = async () => {
    await assert.rejects(rpc.startRpcSession(sessionId, sessionFile, undefined), /activation is in progress/i);
    throw new Error("injected post-commit status failure");
  };
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

  // Fork before the first assistant message; do not fabricate a provider response.
  const userEntryId = recovered.session.inner.sessionManager.appendMessage({
    role: "user", content: "Mode Pack fork fixture; not a provider request.", timestamp: Date.now(),
  });
  const forked = await recovered.session.send({ type: "fork", entryId: userEntryId });
  assert.equal(forked.cancelled, false);
  assert.notEqual(forked.newSessionId, sessionId);
  const childStatus = await rpc.getGenericModePackStatus(forked.newSessionId);
  assert.equal(childStatus.runtime.inheritedBinding?.snapshot.profileId, "general");
  const childPath = await resolveSessionPath(forked.newSessionId);
  assert.ok(childPath && existsSync(childPath), "fork must be a real persisted Pi session");
  const resumedChild = await rpc.startRpcSession(forked.newSessionId, childPath, undefined);
  const inherited = (await rpc.getGenericModePackStatus(forked.newSessionId)).runtime.binding;
  assert.equal(inherited.sessionId, forked.newSessionId);
  assert.equal(inherited.parentBindingId, readBinding().bindingId);
  assert.equal(inherited.revision, 1);
  assert.deepEqual(modelOf(resumedChild.session), expectedModel);

  // A historical cut before the first binding must still inherit the active pack.
  const firstEntry = resumedChild.session.inner.sessionManager.getEntries()[0];
  assert.equal(firstEntry.parentId, null);
  const earlyFork = await resumedChild.session.send({ type: "fork", entryId: firstEntry.id });
  assert.equal(earlyFork.cancelled, false);
  const grandchildPath = await resolveSessionPath(earlyFork.newSessionId);
  assert.ok(grandchildPath && existsSync(grandchildPath));
  const grandchild = await rpc.startRpcSession(earlyFork.newSessionId, grandchildPath, undefined);
  const grandchildBinding = (await rpc.getGenericModePackStatus(earlyFork.newSessionId)).runtime.binding;
  assert.equal(grandchildBinding.parentBindingId, inherited.bindingId);
  assert.equal(grandchildBinding.snapshot.profileId, "general");
  assert.deepEqual(modelOf(grandchild.session), expectedModel);

  // A missing required physical Skill blocks restart, never falls back to ordinary Pi.
  const skillDir = join(agentDir, "skills", "mode-pack-required-smoke");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "---\nname: mode-pack-required-smoke\ndescription: Required runtime smoke fixture.\n---\nUse this fixture only for deterministic runtime verification.\n");
  const store = new ModePackStore();
  const listed = await store.list(cwd);
  const requiredSkill = listed.inventory.resources.find((resource) => resource.kind === "skill" && resource.paths.includes(skillFile));
  assert.ok(requiredSkill, "fixture Skill must be discovered by the real inventory");
  const draft = { ...listed.inventory.builtinPacks.general };
  delete draft.contentHash;
  const definition = await store.saveDraft({
    ...draft, modePackId: "custom.smoke-required", revision: 1,
    components: [{ type: "skill", id: requiredSkill.id, required: true, enabled: true }],
  }, cwd, 0);
  const required = await rpc.activateGenericModePack({
    sessionId: earlyFork.newSessionId, modePackId: definition.modePackId,
    expectedSnapshotId: grandchildBinding.snapshot.resourceSnapshotId, idempotencyKey: "smoke-required",
  });
  assert.equal(required.runtime.verified, true);
  await rpc.getRpcSession(earlyFork.newSessionId).shutdown();
  rmSync(skillFile);
  await assert.rejects(rpc.startRpcSession(earlyFork.newSessionId, grandchildPath, undefined), /required.*missing|missing.*required/i);
  assert.equal(rpc.getRpcSession(earlyFork.newSessionId)?.isAlive() ?? false, false);
  assert.match(readFileSync(grandchildPath, "utf8"), /custom\.smoke-required/);

  // An explicit upgrade of a dormant stale session must keep its JSONL identity.
  writeFileSync(skillFile, "---\nname: mode-pack-required-smoke\ndescription: Required runtime smoke fixture.\n---\nUpdated complete instructions for the same required skill.\n");
  const beforeUpgrade = SessionManager.open(grandchildPath, undefined).getEntries();
  await assert.rejects(rpc.startRpcSession(earlyFork.newSessionId, grandchildPath, undefined), /resource identity changed/i);
  await store.saveDraft({
    ...draft, modePackId: definition.modePackId, revision: 2,
    components: [{ type: "skill", id: requiredSkill.id, required: true, enabled: true }],
  }, cwd, 1);
  const upgraded = await rpc.activateGenericModePack({
    sessionId: earlyFork.newSessionId, modePackId: definition.modePackId,
    expectedSnapshotId: required.binding.snapshot.resourceSnapshotId, idempotencyKey: "upgrade-dormant-stale",
  });
  assert.equal(upgraded.sessionId, earlyFork.newSessionId);
  assert.equal(upgraded.runtime.verified, true);
  assert.equal(rpc.getRpcSession(earlyFork.newSessionId).sessionFile, grandchildPath);
  const afterUpgrade = SessionManager.open(grandchildPath, undefined).getEntries();
  for (const entry of beforeUpgrade) assert.deepEqual(afterUpgrade.find((item) => item.id === entry.id), entry);
  assert.notEqual(upgraded.binding.snapshot.resourceSnapshotId, required.binding.snapshot.resourceSnapshotId);

  // A candidate rejected AFTER SDK construction must not change the old saved model.
  const parent = await rpc.startRpcSession(sessionId, sessionFile, undefined);
  const otherModel = models.find((model) => model.id !== chosen.id);
  const rejectedPack = await store.saveDraft({
    ...draft, modePackId: "custom.smoke-rejected", revision: 1,
    provider: otherModel.provider, model: otherModel.id, thinkingLevel: "low", components: [],
  }, cwd, 0);
  const prototype = Object.getPrototypeOf(parent.session.inner);
  const originalActiveTools = prototype.getActiveToolNames;
  prototype.getActiveToolNames = function () {
    const tools = originalActiveTools.call(this);
    return this === parent.session.inner ? tools : [...tools, "injected-unexpected-candidate-tool"];
  };
  try {
    await assert.rejects(rpc.activateGenericModePack({
      sessionId, modePackId: rejectedPack.modePackId,
      expectedSnapshotId: readBinding().snapshot.resourceSnapshotId, idempotencyKey: "smoke-rejected-candidate",
    }), /runtime verification failed/i);
  } finally {
    prototype.getActiveToolNames = originalActiveTools;
  }
  assert.equal(readBinding().snapshot.profileId, "general");
  assert.deepEqual(modelOf(rpc.getRpcSession(sessionId)), expectedModel);
  assert.deepEqual(SessionManager.open(sessionFile, undefined).buildSessionContext().model, {
    provider: expectedModel.provider, modelId: expectedModel.id,
  }, "a rejected candidate must not alter the authoritative saved model");

  // The ordinary model selector must work inside a Mode Pack and survive restart.
  const beforeSettings = readBinding();
  const { POST: commandPost } = await jiti.import("../app/api/agent/[id]/route.ts");
  const switchResponse = await commandPost(new Request(`http://localhost/api/agent/${sessionId}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "set_model", provider: otherModel.provider, modelId: otherModel.id }),
  }), { params: Promise.resolve({ id: sessionId }) });
  assert.equal(switchResponse.status, 200);
  assert.deepEqual((await switchResponse.json()).data, { provider: otherModel.provider, id: otherModel.id });
  const changed = rpc.getRpcSession(sessionId);
  assert.deepEqual(modelOf(changed), { provider: otherModel.provider, id: otherModel.id });
  const { buildSessionContext } = await jiti.import("./session-reader.ts");
  assert.deepEqual(SessionManager.open(sessionFile, undefined).buildSessionContext().model, {
    provider: otherModel.provider, modelId: otherModel.id,
  }, "the model selector's reload must read the newly selected model from JSONL");
  assert.deepEqual(buildSessionContext(changed.inner.sessionManager.getEntries(), changed.inner.sessionManager.getLeafId()).model, {
    provider: otherModel.provider, modelId: otherModel.id,
  }, "the session HTTP reader must expose the committed selection");
  assert.equal(readBinding().revision, beforeSettings.revision + 1);
  assert.equal(readBinding().snapshot.profileId, beforeSettings.snapshot.profileId);
  await changed.send({ type: "set_thinking_level", level: "low" });
  assert.equal(SessionManager.open(sessionFile, undefined).buildSessionContext().thinkingLevel, "low");
  const { GET: getSession } = await jiti.import("../app/api/sessions/[id]/route.ts");
  const response = await getSession(new Request(`http://localhost/api/sessions/${sessionId}`), { params: Promise.resolve({ id: sessionId }) });
  assert.equal(response.status, 200);
  const readback = await response.json();
  assert.deepEqual(readback.context.model, { provider: otherModel.provider, modelId: otherModel.id });
  assert.equal(readback.context.thinkingLevel, "low");
  await rpc.getRpcSession(sessionId).shutdown();
  // Simulate an older deployment: the committed snapshot is new but the
  // ordinary model entry still points at the old selection.
  SessionManager.open(sessionFile).appendModelChange(chosen.provider, chosen.id);
  const restartedSettings = await rpc.startRpcSession(sessionId, sessionFile, undefined);
  assert.deepEqual(modelOf(restartedSettings.session), { provider: otherModel.provider, id: otherModel.id });
  assert.deepEqual(SessionManager.open(sessionFile).buildSessionContext().model, { provider: otherModel.provider, modelId: otherModel.id }, "reopening repairs stale settings from the committed snapshot");
  const { createFauxCore, fauxAssistantMessage } = await jiti.import("@earendil-works/pi-ai");
  const faux = createFauxCore({});
  faux.setResponses([{ ...fauxAssistantMessage("Offline model selection verification."), provider: otherModel.provider, model: otherModel.id }]);
  let requestedModel;
  restartedSettings.session.inner.agent.streamFunction = (model, context, options) => {
    requestedModel = { provider: model.provider, id: model.id };
    return faux.stream(model, context, options);
  };
  await restartedSettings.session.inner.prompt("Verify the selected model without calling a provider.");
  assert.deepEqual(requestedModel, { provider: otherModel.provider, id: otherModel.id }, "the next SDK turn must use the selected model");

  const { getSessionModeSettings, updateSessionModeSettings } = await jiti.import("./mode-settings-service.ts");
  const beforePrompt = await getSessionModeSettings(sessionId);
  assert.ok(beforePrompt.skills.length >= 10, "the built-in local skill library must be visible even if this mode uses none");
  const prompt = "Help this teacher plan a statistics lesson. Keep evidence separate from conjecture.";
  const patch = { systemPrompt: prompt, skills: [{ id: "education.visual-explanation", enabled: true }] };
  const request = { sessionId, expectedSnapshotId: beforePrompt.snapshotId, idempotencyKey: "settings-prompt-skills", settingsPatch: patch };
  const edited = await updateSessionModeSettings(request);
  assert.equal(edited.systemPrompt, prompt);
  assert.ok(edited.skills.find((skill) => skill.id === "education.visual-explanation").loaded);
  assert.ok(rpc.getRpcSession(sessionId).inner.agent.state.systemPrompt.includes(prompt));
  const revision = readBinding().revision;
  await updateSessionModeSettings(request);
  assert.equal(readBinding().revision, revision, "retry must not create another revision");
  await assert.rejects(updateSessionModeSettings({ ...request, settingsPatch: { systemPrompt: "different" } }), /idempotency key/i);
  const away = await rpc.activateGenericModePack({ sessionId, modePackId: "creative", expectedSnapshotId: edited.snapshotId, idempotencyKey: "settings-away" });
  assert.notEqual((await getSessionModeSettings(sessionId)).systemPrompt, prompt);
  await rpc.activateGenericModePack({ sessionId, modePackId: "general", expectedSnapshotId: away.binding.snapshot.resourceSnapshotId, idempotencyKey: "settings-return" });
  assert.equal((await getSessionModeSettings(sessionId)).systemPrompt, prompt);
  const current = await getSessionModeSettings(sessionId);
  const off = await updateSessionModeSettings({ sessionId, expectedSnapshotId: current.snapshotId, idempotencyKey: "settings-skill-off", settingsPatch: { skills: [{ id: "education.visual-explanation", enabled: false }] } });
  assert.equal(off.skills.find((skill) => skill.id === "education.visual-explanation").loaded, false);
  assert.ok(!rpc.getRpcSession(sessionId).inner.agent.state.systemPrompt.includes('<mode-pack-resource id="skill:education.visual-explanation"'));

  // Ordinary controls revise the pack without dropping its prompt/skills or identity.
  const setTools = async (toolNames) => {
    const response = await commandPost(new Request(`http://localhost/api/agent/${sessionId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "set_tools", toolNames }),
    }), { params: Promise.resolve({ id: sessionId }) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.data.sessionId, sessionId);
  };
  await setTools(["read", "bash", "edit", "write"]);
  assert.deepEqual(readBinding().snapshot.tools, ["bash", "edit", "read", "write"]);
  assert.equal((await getSessionModeSettings(sessionId)).systemPrompt, prompt);
  if (process.platform === "win32") {
    const { writePowerShellToolEnabled } = await jiti.import("./powershell-settings.ts");
    await writePowerShellToolEnabled(true);
    await rpc.getRpcSession(sessionId).send({ type: "reload" });
    let active = rpc.getRpcSession(sessionId).inner.getActiveToolNames();
    assert.ok(active.includes("powershell"));
    assert.ok(!active.includes("bash"));
    assert.equal((await rpc.getGenericModePackStatus(sessionId)).runtime.verified, true);
    await writePowerShellToolEnabled(false);
    await rpc.getRpcSession(sessionId).send({ type: "reload" });
    active = rpc.getRpcSession(sessionId).inner.getActiveToolNames();
    assert.ok(active.includes("bash"));
    assert.ok(!active.includes("powershell"));
  }
  await rpc.getRpcSession(sessionId).shutdown();
  await setTools(["read", "grep", "find", "ls"]);
  assert.deepEqual(rpc.getRpcSession(sessionId).inner.getActiveToolNames().sort(), ["find", "grep", "ls", "read"]);
  assert.equal((await getSessionModeSettings(sessionId)).systemPrompt, prompt);
  await setTools([]);
  assert.deepEqual(rpc.getRpcSession(sessionId).inner.getActiveToolNames(), []);
});
