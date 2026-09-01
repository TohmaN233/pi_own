import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, startRpcSession, warmSwitchHarnessProfile, withExtensionTools } = await jiti.import("./rpc-manager.ts");
const { getLearningHarness, bindHarnessCourse } = await jiti.import("./harness-server.ts");
const { RuntimeSessionHost } = await jiti.import("../../../packages/pi-runtime-host/src/index.ts");

function materializeSessionJsonl(manager) {
  manager.appendMessage({ role: "user", content: "persist transcript", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

test("bound chat-only sessions retain only the internal grounded submit tool", () => {
  const session = {
    settingsManager: { getDefaultTools: () => ["read", "bash"] },
    getAllTools: () => [
      { name: "read" },
      { name: "bash" },
      { name: "submit_grounded_answer" },
      { name: "unrelated_extension" },
    ],
  };
  assert.deepEqual(withExtensionTools(session, [], ["submit_grounded_answer"]), ["submit_grounded_answer"]);
  assert.deepEqual(withExtensionTools(session, [], []), []);
});

test("startRpcSession installs the submit tool only for an explicitly course-bound chat-only session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-rpc-grounded-tools-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const originalHarnessDir = process.env.PI_LEARNING_HARNESS_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = join(directory, "sessions");
  process.env.PI_LEARNING_HARNESS_DIR = join(directory, "harness");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  try {
    const bound = await startRpcSession(`bound-${Date.now()}`, "", directory, {
      toolNames: [],
      harnessCourseVersionId: "course-version-fixture",
    });
    assert.deepEqual(bound.session.inner.getActiveToolNames(), ["submit_grounded_answer"]);
    assert.ok(bound.session.inner.getAllTools().some((tool) => tool.name === "submit_grounded_answer"));
    await bound.session.shutdown();

    const ordinary = await startRpcSession(`ordinary-${Date.now()}`, "", directory, { toolNames: [] });
    assert.deepEqual(ordinary.session.inner.getActiveToolNames(), []);
    assert.equal(ordinary.session.inner.getAllTools().some((tool) => tool.name === "submit_grounded_answer"), false);
    await ordinary.session.shutdown();
  } finally {
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
    if (originalHarnessDir === undefined) delete process.env.PI_LEARNING_HARNESS_DIR;
    else process.env.PI_LEARNING_HARNESS_DIR = originalHarnessDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("warm profile switch rebuilds one bound Pi session with a strict snapshot allowlist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-rpc-profile-switch-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHarnessDir = process.env.PI_LEARNING_HARNESS_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(directory, "harness");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  try {
    const harness = getLearningHarness();
    const course = await harness.publishCourseVersion("switch-course", [{
      name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Switch\n\nGrounded evidence.",
    }], { createdAt: "2026-08-30T18:00:00.000Z" });
    const started = await startRpcSession(`switch-${Date.now()}`, "", directory, { harnessCourseVersionId: course.courseVersionId });
    const bound = bindHarnessCourse(started.session.inner.sessionManager, course.courseVersionId);
    started.session.activateHarnessProfile(bound.snapshot);
    const sessionId = started.realSessionId;
		materializeSessionJsonl(started.session.inner.sessionManager);
    const sessionFile = started.session.sessionFile;
		assert.ok(sessionFile);
    const practice = harness.prepareProfileTransition({
      sessionId,
      targetProfileId: "practice",
      expectedSnapshotId: bound.snapshot.resourceSnapshotId,
      idempotencyKey: "test-to-practice",
      createdAt: "2026-08-30T18:00:01.000Z",
    });
    let switched;
    try {
      const switching = warmSwitchHarnessProfile(sessionId, practice);
      await assert.rejects(
        () => started.session.send({ type: "prompt", message: "must not enter while profile changes" }),
        /profile transition is in progress/i,
      );
      switched = await switching;
    } catch (error) {
      console.error("warm profile switch fixture failed", error);
      throw error;
    }
    assert.equal(switched.sessionId, sessionId);
    assert.equal(switched.sessionFile, sessionFile);
    assert.deepEqual(switched.inner.getActiveToolNames(), []);
    assert.equal(harness.findCurrentSession(sessionId)?.snapshot.profileId, "practice");
    assert.equal(harness.findCurrentSession(sessionId)?.binding.revision, 2);
		const journalEntries = switched.inner.sessionManager.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "learning-harness:runtime-journal/v1");
		assert.equal(journalEntries.length, 4);
    await assert.rejects(
      () => jiti.import("./rpc-manager.ts").then(({ setRpcSessionTools }) => setRpcSessionTools(sessionId, sessionFile, ["bash"])),
      /Profile selector instead of set_tools/,
    );
    await switched.shutdown();
  } finally {
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHarnessDir === undefined) delete process.env.PI_LEARNING_HARNESS_DIR;
    else process.env.PI_LEARNING_HARNESS_DIR = previousHarnessDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile candidate failure aborts pending state and the transition lock rejects mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-rpc-profile-abort-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHarnessDir = process.env.PI_LEARNING_HARNESS_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(directory, "harness");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  try {
    const harness = getLearningHarness();
    const course = await harness.publishCourseVersion("abort-course", [{
      name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Abort\n\nEvidence.",
    }], { createdAt: "2026-08-30T19:00:00.000Z" });
    const started = await startRpcSession(`abort-${Date.now()}`, "", directory, { harnessCourseVersionId: course.courseVersionId });
    const bound = bindHarnessCourse(started.session.inner.sessionManager, course.courseVersionId);
    started.session.activateHarnessProfile(bound.snapshot);
    materializeSessionJsonl(started.session.inner.sessionManager);
    started.session.setProfileTransitionLocked(true);
    await assert.rejects(() => started.session.send({ type: "prompt", message: "blocked" }), /profile transition is in progress/i);
    await started.session.send({ type: "get_state" });
    started.session.setProfileTransitionLocked(false);

    const prepared = harness.prepareProfileTransition({
      sessionId: started.realSessionId,
      targetProfileId: "practice",
      expectedSnapshotId: bound.snapshot.resourceSnapshotId,
      idempotencyKey: "candidate-failure",
      createdAt: "2026-08-30T19:00:01.000Z",
    });
    await assert.rejects(
      () => warmSwitchHarnessProfile(started.realSessionId, {
        idempotencyKey: prepared.idempotencyKey,
        snapshot: { ...prepared.snapshot, resources: [] },
      }),
      /missing its required learning-harness extension/i,
    );
    assert.equal(harness.findCurrentSession(started.realSessionId)?.pendingProfileTransition, null);
    assert.equal(harness.findCurrentSession(started.realSessionId)?.snapshot.resourceSnapshotId, bound.snapshot.resourceSnapshotId);
    assert.equal((await started.session.send({ type: "get_state" })).sessionId, started.realSessionId);
    assert.equal(harness.prepareProfileTransition({
      sessionId: started.realSessionId,
      targetProfileId: "practice",
      expectedSnapshotId: bound.snapshot.resourceSnapshotId,
      idempotencyKey: "retry-after-candidate-failure",
      createdAt: "2026-08-30T19:00:02.000Z",
    }).targetProfileId, "practice");
    harness.abortPreparedProfileTransition(started.realSessionId, "retry-after-candidate-failure", bound.snapshot.resourceSnapshotId);
    await started.session.shutdown();
  } finally {
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHarnessDir === undefined) delete process.env.PI_LEARNING_HARNESS_DIR;
    else process.env.PI_LEARNING_HARNESS_DIR = previousHarnessDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile transition acquisition rejects a prompt already waiting for extension admission", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let releaseBinding;
  const binding = new Promise((resolve) => { releaseBinding = resolve; });
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    subscribe() { return () => {}; },
    extensionRunner: { emit: async () => undefined },
    bindExtensions: async () => binding,
    agent: { state: {} },
    prompt: async (_message, options) => { options.preflightResult?.(true); },
    dispose() {},
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  const pendingPrompt = wrapper.send({ type: "prompt", message: "wait for extension bind" });
  await Promise.resolve();
  assert.equal(wrapper.tryAcquireProfileTransition(), false);
  releaseBinding();
  await pendingPrompt;
  assert.equal(wrapper.tryAcquireProfileTransition(), true);
  wrapper.releaseProfileTransition();
  wrapper.destroy();
});

test("reopening a journal-ahead profile uses the reconciled snapshot allowlist in both directions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-rpc-profile-reopen-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHarnessDir = process.env.PI_LEARNING_HARNESS_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(directory, "harness");
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  try {
    let harness = getLearningHarness();
    const course = await harness.publishCourseVersion("reopen-course", [{
      name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Reopen\n\nEvidence.",
    }], { createdAt: "2026-08-30T20:00:00.000Z" });
    let started = await startRpcSession(`reopen-${Date.now()}`, "", directory, { harnessCourseVersionId: course.courseVersionId });
    const bound = bindHarnessCourse(started.session.inner.sessionManager, course.courseVersionId);
    started.session.activateHarnessProfile(bound.snapshot);
    materializeSessionJsonl(started.session.inner.sessionManager);
    const sessionId = started.realSessionId;
    const sessionFile = started.session.sessionFile;

    const appendJournalAhead = (prepared, binding) => {
      const runtime = new RuntimeSessionHost(started.session.inner.sessionManager);
      runtime.recordResourceSnapshot({
        version: prepared.snapshot.version,
        resourceSnapshotId: prepared.snapshot.resourceSnapshotId,
        profileId: prepared.snapshot.profileId,
        profileRevision: prepared.snapshot.profileRevision,
        courseVersionId: prepared.snapshot.courseVersionId,
        contentHash: prepared.snapshot.contentHash,
        createdAt: prepared.snapshot.createdAt,
      }, `resource-snapshot:${prepared.snapshot.resourceSnapshotId}`);
      runtime.recordSessionBinding({
        ...binding,
        resourceSnapshotId: prepared.snapshot.resourceSnapshotId,
        revision: binding.revision + 1,
      }, `session-binding:${binding.bindingId}:revision:${binding.revision + 1}`);
    };

    const practice = harness.prepareProfileTransition({
      sessionId, targetProfileId: "practice", expectedSnapshotId: bound.snapshot.resourceSnapshotId,
      idempotencyKey: "reopen-practice", createdAt: "2026-08-30T20:00:01.000Z",
    });
    appendJournalAhead(practice, bound.binding);
    await started.session.shutdown();
    harness.close();
    globalThis.__piLearningHarness = undefined;
    started = await startRpcSession(sessionId, sessionFile, undefined);
    harness = getLearningHarness();
    assert.equal(harness.findCurrentSession(sessionId)?.snapshot.profileId, "practice");
    assert.deepEqual(started.session.inner.getActiveToolNames(), []);

    const learn = harness.prepareProfileTransition({
      sessionId, targetProfileId: "student-learn", expectedSnapshotId: practice.snapshot.resourceSnapshotId,
      idempotencyKey: "reopen-learn", createdAt: "2026-08-30T20:00:02.000Z",
    });
    appendJournalAhead(learn, harness.findCurrentSession(sessionId).binding);
    await started.session.shutdown();
    harness.close();
    globalThis.__piLearningHarness = undefined;
    started = await startRpcSession(sessionId, sessionFile, undefined);
    assert.equal(getLearningHarness().findCurrentSession(sessionId)?.snapshot.profileId, "student-learn");
    assert.deepEqual(started.session.inner.getActiveToolNames(), ["submit_grounded_answer"]);
    await started.session.shutdown();
  } finally {
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHarnessDir === undefined) delete process.env.PI_LEARNING_HARNESS_DIR;
    else process.env.PI_LEARNING_HARNESS_DIR = previousHarnessDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("get_tools preserves the SDK tool definition fields", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const getToolsSource = source.slice(
    source.indexOf('case "get_tools"'),
    source.indexOf('case "get_commands"'),
  );

  assert.match(getToolsSource, /\.getAllTools\(\)/);
  assert.match(getToolsSource, /\.\.\.t,/);
  assert.match(getToolsSource, /active: active\.has\(t\.name\)/);
});

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("built-in subagents persist their selected resource policy", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(subagentSource, /SessionManager\.create\(parent\.cwd, undefined, \{ parentSession: parent\.sessionFile \}\)/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_META_TYPE/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_RESULT_TYPE/);
  assert.match(subagentSource, /dependencies\.registerSession\(inner, \{/);
  assert.match(subagentSource, /noExtensions: !profile\.loadExtensions/);
  assert.match(subagentSource, /noSkills: !profile\.loadSkills/);
  assert.match(subagentSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(subagentSource, /withSubagentExtensionTools\(profile\.tools, extensionToolNames\)/);
  assert.match(subagentSource, /resourceSnapshot:/);
  assert.match(startupSource, /readSubagentSessionResources\(/);
  assert.match(startupSource, /resourceLoaderOptions: subagentResources/);
  assert.match(startupSource, /appendSystemPrompt: subagentResources\.appendSystemPrompt/);
  assert.match(startupSource, /noExtensions: !subagentResources\.loadExtensions/);
  assert.match(startupSource, /noSkills: !subagentResources\.loadSkills/);
  assert.match(startupSource, /excludeTools: \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\]/);
  assert.match(startupSource, /let toolsOption: string\[\] \| undefined = subagentResources\?\.tools/);
  assert.match(source, /createSubagentController\(/);
  assert.match(source, /suppressCompletionNotifications: true/);
  assert.match(source, /suppressCompletionNotifications: Boolean\(subagentResources\)/);
  assert.match(startupSource, /createSubagentExtension\([\s\S]*?SUBAGENT_CONTROLLER\.extensionRuntime,[\s\S]*?\(\) => listSubagentProfiles\(sessionCwd\),[\s\S]*?isBuiltInSubagentsEnabled/);
  assert.match(startupSource, /preferPiWebSubagentExtension\(base\)/);
});

test("running snapshots expose sessions with suppressed completion notifications", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const runningRouteSource = await readFile(new URL("../app/api/agent/running/route.ts", import.meta.url), "utf8");
  const sessionsRouteSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  const snapshotSource = source.slice(
    source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds")),
  );

  assert.match(snapshotSource, /session\.isRunning\(\) && session\.hasSuppressedCompletionNotifications\(\)/);
  assert.match(runningRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
  assert.match(sessionsRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSessionFromServices(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: initial\.scopedModels/);
  assert.match(startupSource, /model: initial\.model/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.getBranch\(\)\.some\(\(entry\) => entry\.type === "message"\)/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /sessionManager\.buildSessionContext\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  beginExtensionBinding"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "clone"'),
  );
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );
  const replacementShutdownSource = source.slice(
    source.indexOf("  private async shutdownAfterSessionReplacement"),
    source.indexOf("  async send("),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(replacementShutdownSource, /await this\.shutdown\(\)/);
  assert.match(forkSource, /shutdownAfterSessionReplacement\("fork"\)/);
  assert.match(cloneSource, /shutdownAfterSessionReplacement\("clone"\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("clone copies the requested leaf into a child session", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(cloneSource, /typeof command\.leafId === "string"/);
  assert.match(cloneSource, /branchHasAssistant/);
  assert.match(cloneSource, /createBranchedSession\(leafId\)/);
  assert.match(cloneSource, /cacheSessionPath\(newSessionId, clonedPath\)/);
  assert.match(cloneSource, /invalidateSessionListCache\(\)/);
  assert.match(cloneSource, /return \{ cancelled: false, newSessionId \}/);
});

test("grounded outbound gate suppresses raw assistant deltas and exposes only the canonical final message", () => {
  const manager = SessionManager.inMemory(tmpdir());
  let subscribed;
  const canonical = { role: "assistant", content: [{ type: "text", text: "<!-- learning-harness:published receipt -->" }] };
  const raw = { role: "assistant", content: [{ type: "text", text: "raw model text" }] };
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    subscribe(listener) { subscribed = listener; return () => {}; },
    extensionRunner: { emit: async () => {} },
    agent: { state: { streamingMessage: raw } },
    dispose() {},
  }, {
    groundedAnswerGate: {
      isActive: () => true,
      suppressSnapshot: () => true,
      enforceFinalMessage: (message) => {
        message.content = canonical.content;
        return message;
      },
    },
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  wrapper.start();
  const user = { role: "user", content: "question" };
  subscribed({ type: "message_start", message: user });
  subscribed({ type: "message_start", message: raw });
  subscribed({ type: "message_update", message: raw, assistantMessageEvent: { type: "text_delta", delta: "raw" } });
  const end = { type: "message_end", message: raw };
  subscribed(end);
  assert.equal(wrapper.streamingMessage, undefined);
  assert.deepEqual(events, [
    { type: "message_start", message: user },
    { type: "message_end", message: raw },
  ]);
  assert.equal(end.message, raw);
  assert.equal(events[1].message, raw);
  assert.deepEqual(raw.content, canonical.content);
  wrapper.destroy();
});

test("root fork materializes an empty child JSONL linked to its exact parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-root-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "root fork fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  const rootEntry = manager.getBranch().find((entry) => !entry.parentId);
  assert.ok(sourceFile);
  assert.ok(rootEntry);
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => undefined },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: rootEntry.id });
    assert.equal(result.cancelled, false);
    const sessions = await SessionManager.list(root, sessionDir);
    const childInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(childInfo);
    const child = SessionManager.open(childInfo.path, sessionDir);
    assert.equal(child.getHeader()?.parentSession, sourceFile);
    assert.equal(child.getBranch().length, 0);
  } finally {
    wrapper.destroy();
    const sessions = await SessionManager.list(root, sessionDir);
    await Promise.all(sessions.map((session) => unlink(session.path)));
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("session replacement rejects active work and clone writes one reopenable child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const cloneLeafId = manager.getLeafId();
  manager.appendSessionInfo("source-only metadata");

  const sourceFile = manager.getSessionFile();
  let clonedFile;
  let releaseModelRefresh;
  let signalModelRefresh;
  const modelRefreshStarted = new Promise((resolve) => { signalModelRefresh = resolve; });
  const modelRefreshHeld = new Promise((resolve) => { releaseModelRefresh = resolve; });
  let releaseShutdown;
  let signalShutdown;
  const shutdownStarted = new Promise((resolve) => { signalShutdown = resolve; });
  const shutdownHeld = new Promise((resolve) => { releaseShutdown = resolve; });
  let finishPrompt;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    prompt: (_message, options) => new Promise((resolve) => {
      finishPrompt = resolve;
      options.preflightResult?.(true);
    }),
    modelRuntime: {
      getModel: () => undefined,
      refresh: async () => {
        signalModelRefresh();
        await modelRefreshHeld;
      },
    },
    extensionRunner: {
      emit: async () => {
        signalShutdown();
        await shutdownHeld;
        throw new Error("fixture shutdown failure");
      },
    },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const modelChange = wrapper.send({ type: "set_model", provider: "test", modelId: "missing" });
    await modelRefreshStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Cannot clone while another session command is running/,
    );
    releaseModelRefresh();
    await assert.rejects(modelChange, /Model not found/);

    await wrapper.send({ type: "prompt", message: "keep this run active" });
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: manager.getLeafId() }),
      /Cannot fork while the session is running/,
    );
    assert.ok(finishPrompt);
    finishPrompt();
    await new Promise((resolve) => setImmediate(resolve));

    const firstClone = wrapper.send({ type: "clone", leafId: cloneLeafId });
    await shutdownStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Session is being copied to a new session/,
    );
    let shutdownErrorLog = "";
    const originalConsoleError = console.error;
    console.error = (...args) => { shutdownErrorLog = args.join(" "); };
    let result;
    try {
      releaseShutdown();
      result = await firstClone;
    } finally {
      console.error = originalConsoleError;
    }
    assert.match(shutdownErrorLog, /clone succeeded, but source session shutdown failed/);

    const sessions = await SessionManager.list(root, sessionDir);
    const clonedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(clonedInfo);
    clonedFile = clonedInfo.path;

    const cloned = SessionManager.open(clonedFile, sessionDir);
    assert.equal(cloned.getHeader().parentSession, sourceFile);
    assert.equal(cloned.getLeafId(), cloneLeafId);
    assert.deepEqual(cloned.buildSessionContext().messages, manager.buildSessionContext().messages);
  } finally {
    wrapper.destroy();
    if (clonedFile) await unlink(clonedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("cancelled session replacement releases its lock", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let autoRetryEnabled = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: "missing" }), { cancelled: true });
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    wrapper.destroy();
  }
});

test("clone cancels an assistant-free branch without creating a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-empty-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "no assistant yet", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "clone" }), { cancelled: true });
    assert.equal((await SessionManager.list(root, sessionDir)).length, 0);
  } finally {
    wrapper.destroy();
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
  assert.match(source, /const courseVersionId = harnessCourseVersionId \?\? selectedCourseVersion\(req\)/);
  assert.match(source, /harnessCourseVersionId: courseVersionId/);
});

test("prompt routes mark only preflight failures as rejected", async () => {
  const existingRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  for (const source of [existingRoute, newRoute]) {
    assert.match(source, /let promptAccepted = false/);
    assert.match(source, /await .*\.send\(/);
    assert.match(source, /promptAccepted = .*\.type === "prompt"/);
    assert.match(source, /commandType === "prompt" && !promptAccepted/);
  }
});

test("the wrapper reapplies an exact prompt after SDK preflight", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "abort"'),
  );

  assert.match(promptSource, /preflightResult: \(success\) => \{[\s\S]*?this\.applyExactSystemPrompt\(\);[\s\S]*?acceptPreflight\(\)/);
  assert.doesNotMatch(promptSource, /requestedToolNames/);
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyExactSystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("normal sessions restore persisted tool selections before loading resources", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const registrationSource = source.slice(
    source.indexOf("function registerRpcWrapper"),
    source.indexOf("const SUBAGENT_CONTROLLER"),
  );

  assert.match(startupSource, /readSessionToolSelection\(sessionManager\.getEntries\(\)/);
  assert.match(startupSource, /const selectedToolNames = subagentResources\?\.tools \?\? persistedToolNames \?\? requestedToolNames/);
  assert.match(startupSource, /appendSessionToolSelection\(sessionManager, requestedToolNames\)/);
  assert.ok(startupSource.indexOf("const chatOnly") < startupSource.indexOf("createAgentSessionServices("));
  assert.match(startupSource, /\.\.\.CHAT_ONLY_RESOURCE_LOADER_OPTIONS/);
  assert.match(startupSource, /const trustReloadOptions = subagentResources[\s\S]*?subagentLoadsResources[\s\S]*?projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(registrationSource, /if \(!wrapper\.isChatOnly\(\)\) wrapper\.beginExtensionBinding\(\)/);
});

test("crossing the Chat-only boundary persists and rebuilds the wrapper", async () => {
  const source = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const switchSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("export function getRunningRpcSessionIds"),
  );

  assert.match(switchSource, /!hasCurrentResourcePolicy\s*\|\| existing\.isChatOnly\(\) !== \(toolNames\.length === 0\)/);
  assert.match(switchSource, /appendSessionToolSelection\(existing\.inner\.sessionManager, toolNames\)/);
  assert.match(switchSource, /await existing\.shutdown\(\)/);
  assert.match(switchSource, /__recreate__\$\{randomUUID\(\)\}/);
  assert.match(switchSource, /sessionId: started\.realSessionId/);
});
