import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("actual Pi Study/Research inventories switch in the same conversation and reject builtin bypass", { timeout: 90000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-study-runtime-")); const cwd = join(root, "work"); mkdirSync(cwd);
  const env = { PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_LEARNING_HARNESS_DIR: join(root, "data"), PI_MODE_PACK_STORE_PATH: join(root, "packs.json"), ANTHROPIC_API_KEY: "offline-not-a-real-key" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])); Object.assign(process.env, env);
  mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(env.PI_CODING_AGENT_DIR, "host-plugins.json"), JSON.stringify({ "@eko24ive/pi-ask": false, "pi-context-usage": false }));
  const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No model/network calls allowed"); };
  t.after(async () => {
    for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
    globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined;
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const rpc = await jiti.import("./rpc-manager.ts");
  const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
  const { getLearningHarness } = await jiti.import("./harness-server.ts");
  const { studyContext } = await jiti.import("./study-research-service.ts");
  const { ensureStudySessionRuntime } = await jiti.import("./study-session-runtime.ts");
  const { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const resolved = await new ModePackStore().resolve("study-research.study", cwd);
  const sessionId = rpc.createPersistedGenericSession(cwd, "One study conversation", resolved.snapshot);
  const path = await resolveSessionPath(sessionId);
  const projects = getLearningHarness().projectWorkspaces;
  projects.create({ id: "paper", title: "Paper", cwd, defaults: resolved.snapshot, courseProjectId: null }); projects.move(sessionId, "paper");
  await assert.rejects(ensureStudySessionRuntime("unrelated-session"), /independent project/);
  assert.equal((await ensureStudySessionRuntime(sessionId)).sessionId, sessionId);
  let live = rpc.getRpcSession(sessionId);
  await live.waitUntilReady();
  const studyTools = live.inner.getActiveToolNames().sort();
  assert.deepEqual(studyTools, ["caw", "codemode", "study_assignment", "study_paper", "study_visual", "study_workflow"]);
  const cawExtension = live.inner.resourceLoader.getExtensions().extensions.find(extension => extension.path === "<inline:pi-web-caw>");
  assert.ok(cawExtension.commands.has("caw"), "native /caw command is available without a browser launch");
  const cawTool = cawExtension.tools.get("caw").definition;
  const nativeContext = { cwd, sessionManager: live.inner.sessionManager, modelRegistry: live.inner.extensionRunner.getModelRegistry() };
  const studyExtension = live.inner.resourceLoader.getExtensions().extensions.find(extension => extension.tools?.has("study_workflow"));
  assert.ok(studyExtension, "the selected Study mode owns its task-bound Workflow control");
  const studyTool = studyExtension.tools.get("study_workflow").definition;
  const studyTasks = JSON.parse((await studyTool.execute("list", { action: "list" }, undefined, undefined, nativeContext)).content[0].text);
  assert.equal(studyTasks.workflow.ready, true, "the Study Workflow installer is ready before the generic library is used");
  assert.deepEqual(studyTasks.tasks, [], "no Study task has been prepared yet");
  const catalog = JSON.parse((await cawTool.execute("catalog", { action: "list" }, undefined, undefined, nativeContext)).content[0].text);
  const studyWorkflow = catalog.find(workflow => workflow.id === "study-explanation");
  assert.ok(studyWorkflow?.enabled, "the exact Study Workflow is in the selected pi-CAW library");
  await assert.rejects(cawTool.execute("blocked", { action: "run", args: {
    workflow_id: "study-explanation",
    revision_hash: studyWorkflow.revision_hash,
    run_id: `run-${randomUUID()}`,
    workspace: cwd,
    access: "read_only",
    allowed_paths: ["."],
    constraints: { allowed_paths: ["."] },
    inputs: {},
  } }, undefined, undefined, nativeContext), /privately prepared Study task/);
  assert.ok(!live.inner.getActiveToolNames().includes("subagent_supervisor"), "generic Host child execution is excluded by the learning profile, without changing global settings");
  assert.equal((await rpc.getGenericModePackStatus(sessionId)).runtime.verified, true);
  assert.match(live.systemPrompt, /paper-learning|paper.learning|source-grounded/);
  assert.doesNotMatch(live.systemPrompt, /You are an expert coding assistant operating inside pi/u);
  const before = await studyContext(sessionId);
  const research = await rpc.activateGenericModePack({ sessionId, modePackId: "study-research.research", expectedSnapshotId: before.snapshot.resourceSnapshotId, idempotencyKey: "explicit-research" });
  live = rpc.getRpcSession(sessionId);
  assert.deepEqual(live.inner.getActiveToolNames().sort(), ["caw", "codemode", "research_plan", "research_run", "study_assignment", "study_manuscript", "study_paper", "study_results", "study_visual", "study_workflow"]);
  assert.equal(live.sessionFile, path);
  const after = await studyContext(sessionId); assert.equal(after.phase.phase, "research"); assert.equal(after.phase.revision, before.phase.revision + 1);
  const restoredResearch = await ensureStudySessionRuntime(sessionId);
  assert.equal(restoredResearch.verified, true);
  assert.equal((await studyContext(sessionId)).phase.revision, after.phase.revision, "runtime refresh never switches phase");
  await assert.rejects(studyContext(sessionId, before.phase.revision), /revision conflict/);
  await assert.rejects(live.send({ type: "set_tools", toolNames: ["read", "write", "bash"] }), /scoped Host tools/);
  await assert.rejects(live.send({ type: "bash", command: "echo bypass" }), /shell|tool|bash|unavailable|not enabled/i);
  await rpc.activateGenericModePack({ sessionId, modePackId: "study-research.study", expectedSnapshotId: research.binding.snapshot.resourceSnapshotId, idempotencyKey: "explicit-study-return" });
  live = rpc.getRpcSession(sessionId); assert.deepEqual(live.inner.getActiveToolNames().sort(), studyTools);
  assert.equal((await studyContext(sessionId)).phase.phase, "study");
  await live.shutdown();
  live = (await rpc.startRpcSession(sessionId, path, undefined)).session;
  assert.deepEqual(live.inner.getActiveToolNames().sort(), studyTools);
  assert.equal(SessionManager.open(path).buildSessionContext().messages.length, 0, "mode controls never start a model turn");
  await live.shutdown();
  writeFileSync(join(env.PI_CODING_AGENT_DIR, "host-plugins.json"), JSON.stringify({ "pi-caw": false, "pi-subagents": false, "@eko24ive/pi-ask": false, "pi-context-usage": false }));
  live = (await rpc.startRpcSession(sessionId, path, undefined)).session;
  assert.ok(!live.inner.getActiveToolNames().includes("caw"), "global pi-caw off survives restart");
});
