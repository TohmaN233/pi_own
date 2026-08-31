import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { LearningHarness } = await createJiti(import.meta.url).import("../../../packages/learning-harness/src/index.ts");
const { RuntimeSessionHost } = await createJiti(import.meta.url).import("../../../packages/pi-runtime-host/src/index.ts");
const { bindHarnessCourseOrDiscard, inheritHarnessSessionFile, inheritHarnessSessionFileOrDiscard } = await createJiti(import.meta.url).import("./harness-server.ts");
const { cacheSessionPath, resolveSessionPath } = await createJiti(import.meta.url).import("./session-reader.ts");
const { AgentSessionWrapper, getRpcSession } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");

test("LearningHarness reconciles durable state with a reopened real Pi JSONL session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-jsonl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "course-workspace");
  const sessionDirectory = join(root, "sessions");
  const databasePath = join(root, "learning-harness.sqlite");
  mkdirSync(cwd);

  const harness = new LearningHarness({ databasePath });
  const course = await harness.publishCourseVersion(
    "pi-jsonl-course",
    [{
      name: "lesson.md",
      kind: "markdown",
      mediaType: "text/markdown",
      content: "# Durable lesson\n\nThe Pi JSONL session owns the transcript.",
    }],
    { createdAt: "2026-08-30T14:00:00.000Z" },
  );
  const manager = SessionManager.create(cwd, sessionDirectory);
  const opened = harness.openStudentSession({
    sessionStore: manager,
    courseVersionId: course.courseVersionId,
    createdAt: "2026-08-30T14:00:00.000Z",
  });
  manager.appendMessage({ role: "user", content: "Start the lesson", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Lesson ready" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  assert.equal(manager.getBranch().filter((entry) => entry.type === "custom").length, 2);
  harness.close();

  const reopenedManager = SessionManager.open(sessionFile);
  assert.equal(reopenedManager.getSessionId(), manager.getSessionId());
  assert.equal(reopenedManager.getBranch().filter((entry) => entry.type === "custom").length, 2);
  const reopenedHarness = new LearningHarness({ databasePath });
  const reconciled = reopenedHarness.reconcileRuntimeSession(reopenedManager);
  assert.equal(reconciled?.binding.bindingId, opened.binding.bindingId);
  assert.equal(reconciled?.snapshot.resourceSnapshotId, opened.snapshot.resourceSnapshotId);

  const sourceForFork = SessionManager.open(sessionFile, sessionDirectory);
  const childPath = sourceForFork.createBranchedSession(sourceForFork.getLeafId());
  assert.ok(childPath);
  const childManager = SessionManager.open(childPath, sessionDirectory);
  const inherited = reopenedHarness.inheritStudentSession({
    parentSessionStore: reopenedManager,
    childSessionStore: childManager,
    createdAt: "2026-08-30T14:01:00.000Z",
  });
  assert.ok(inherited);
  assert.equal(inherited.sessionId, childManager.getSessionId());
  assert.notEqual(inherited.binding.bindingId, opened.binding.bindingId);
  assert.equal(inherited.binding.courseVersionId, opened.binding.courseVersionId);
  assert.equal(inherited.snapshot.resourceSnapshotId, opened.snapshot.resourceSnapshotId);
  assert.equal(childManager.getBranch().filter((entry) => entry.type === "custom").length, 3);

  const inheritedParentBinding = childManager.getBranch().find(
    (entry) => entry.type === "custom" && entry.customType === "learning-harness:runtime-journal/v1" && entry.data?.entry?.type === "learning-harness:session-binding" && entry.data.entry.data.sessionId === opened.sessionId,
  );
  assert.ok(inheritedParentBinding);
  const sourceForGrandchild = SessionManager.open(childPath, sessionDirectory);
  const grandchildLeaf = sourceForGrandchild.getLeafId();
  assert.ok(grandchildLeaf);
  const grandchildPath = sourceForGrandchild.createBranchedSession(grandchildLeaf);
  assert.ok(grandchildPath);
  const grandchildManager = SessionManager.open(grandchildPath, sessionDirectory);
  const grandchild = reopenedHarness.inheritStudentSession({
    parentSessionStore: childManager,
    childSessionStore: grandchildManager,
    createdAt: "2026-08-30T14:02:00.000Z",
  });
  assert.ok(grandchild);
  assert.equal(grandchild?.binding.courseVersionId, opened.binding.courseVersionId);
  assert.equal(reopenedHarness.reconcileRuntimeSession(grandchildManager)?.binding.bindingId, grandchild?.binding.bindingId);

  childManager.branch(inheritedParentBinding.id);
  const navigated = reopenedHarness.reconcileRuntimeSession(childManager);
  assert.equal(navigated?.binding.bindingId, inherited.binding.bindingId);
  assert.equal(childManager.getBranch().filter((entry) => entry.type === "custom").length, 3);

  const inheritedSnapshot = childManager.getBranch().find(
    (entry) => entry.type === "custom" && entry.customType === "learning-harness:runtime-journal/v1" && entry.data?.entry?.type === "learning-harness:resource-snapshot",
  );
  assert.ok(inheritedSnapshot);
  const tamperedManager = SessionManager.create(cwd, sessionDirectory);
  tamperedManager.appendCustomEntry("learning-harness:runtime-journal/v1", {
    ...inheritedSnapshot.data,
    sequence: 1,
    idempotencyKey: "tampered-snapshot",
  });
  tamperedManager.appendCustomEntry("learning-harness:runtime-journal/v1", {
    version: 1,
    sequence: 2,
    idempotencyKey: "tampered-ancestry",
    entry: {
      version: 1,
      type: "learning-harness:session-binding",
      data: {
        ...grandchild.binding,
        bindingId: "tampered-binding",
        sessionId: "unrelated-ancestor-session",
        createdAt: "2026-08-30T14:03:00.000Z",
        revision: 1,
      },
    },
  });
  assert.equal(new RuntimeSessionHost(tamperedManager).inspectBindingLineage().at(-1)?.sessionId, "unrelated-ancestor-session");
  assert.throws(
    () => reopenedHarness.inheritStudentSession({
      parentSessionStore: grandchildManager,
      childSessionStore: tamperedManager,
      createdAt: "2026-08-30T14:04:00.000Z",
    }),
    /does not inherit an ancestor binding/,
  );

  const reopenedChild = SessionManager.open(childPath, sessionDirectory);
  const reconciledChild = reopenedHarness.reconcileRuntimeSession(reopenedChild);
  assert.equal(reconciledChild?.binding.bindingId, inherited.binding.bindingId);
  assert.equal(reconciledChild?.binding.sessionId, childManager.getSessionId());
  reopenedHarness.close();
});

test("failed Harness inheritance discards only the newly-created child JSONL and its path cache", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-discard-"));
  const cwd = join(root, "course-workspace");
  const sessionDirectory = join(root, "sessions");
  const databasePath = join(root, "learning-harness.sqlite");
  mkdirSync(cwd);
  const previousHarness = globalThis.__piLearningHarness;
  const harness = new LearningHarness({ databasePath });
  globalThis.__piLearningHarness = harness;
  t.after(() => {
    harness.close();
    if (previousHarness === undefined) delete globalThis.__piLearningHarness;
    else globalThis.__piLearningHarness = previousHarness;
    rmSync(root, { recursive: true, force: true });
  });

  const firstCourse = await harness.publishCourseVersion(
    "first-course",
    [{ name: "first.md", kind: "markdown", mediaType: "text/markdown", content: "# First" }],
    { createdAt: "2026-08-30T15:00:00.000Z" },
  );
  const secondCourse = await harness.publishCourseVersion(
    "second-course",
    [{ name: "second.md", kind: "markdown", mediaType: "text/markdown", content: "# Second" }],
    { createdAt: "2026-08-30T15:00:00.000Z" },
  );
  const parentManager = SessionManager.create(cwd, sessionDirectory);
  harness.openStudentSession({
    sessionStore: parentManager,
    courseVersionId: firstCourse.courseVersionId,
    createdAt: "2026-08-30T15:00:00.000Z",
  });
  const incompatibleManager = SessionManager.create(cwd, sessionDirectory);
  harness.openStudentSession({
    sessionStore: incompatibleManager,
    courseVersionId: secondCourse.courseVersionId,
    createdAt: "2026-08-30T15:00:00.000Z",
  });
  incompatibleManager.appendMessage({ role: "user", content: "Create a child", timestamp: Date.now() });
  incompatibleManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Child source" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const incompatibleFile = incompatibleManager.getSessionFile();
  assert.ok(incompatibleFile);
  const source = SessionManager.open(incompatibleFile, sessionDirectory);
  const childPath = source.createBranchedSession(source.getLeafId());
  assert.ok(childPath);
  const childId = SessionManager.open(childPath, sessionDirectory).getSessionId();
  cacheSessionPath(childId, childPath);
  assert.equal(await resolveSessionPath(childId), childPath);

  await assert.rejects(
    inheritHarnessSessionFileOrDiscard(parentManager, childId, childPath),
    /does not inherit an ancestor binding/,
  );
  assert.equal(existsSync(childPath), false);
  assert.equal(await resolveSessionPath(childId), null);
});

test("only a verified direct empty child may inherit a root Pi fork", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-direct-child-"));
  const cwd = join(root, "course-workspace");
  const sessionDirectory = join(root, "sessions");
  mkdirSync(cwd);
  const previousHarness = globalThis.__piLearningHarness;
  const harness = new LearningHarness({ databasePath: join(root, "learning-harness.sqlite") });
  globalThis.__piLearningHarness = harness;
  t.after(() => {
    harness.close();
    if (previousHarness === undefined) delete globalThis.__piLearningHarness;
    else globalThis.__piLearningHarness = previousHarness;
    rmSync(root, { recursive: true, force: true });
  });

  const course = await harness.publishCourseVersion(
    "direct-child-course",
    [{ name: "lesson.md", kind: "markdown", mediaType: "text/markdown", content: "# Direct child" }],
    { createdAt: "2026-08-30T16:00:00.000Z" },
  );
  const parentManager = SessionManager.create(cwd, sessionDirectory);
  const parent = harness.openStudentSession({
    sessionStore: parentManager,
    courseVersionId: course.courseVersionId,
    createdAt: "2026-08-30T16:00:00.000Z",
  });
  parentManager.appendMessage({ role: "user", content: "Persist parent", timestamp: Date.now() });
  parentManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Persisted parent" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const parentPath = parentManager.getSessionFile();
  assert.ok(parentPath);
  const directChild = SessionManager.create(cwd, sessionDirectory);
  directChild.newSession({ parentSession: parentPath });
  const directChildPath = directChild.getSessionFile();
  assert.ok(directChildPath);
  const directHeader = directChild.getHeader();
  assert.ok(directHeader);
  writeFileSync(directChildPath, `${JSON.stringify(directHeader)}\n`, { encoding: "utf8", flag: "wx" });
  const reopenedDirectChild = SessionManager.open(directChildPath, sessionDirectory);
  assert.equal(reopenedDirectChild.getBranch().length, 0);
  assert.equal(reopenedDirectChild.getHeader().parentSession, parentPath);
  const inherited = inheritHarnessSessionFile(parentManager, directChildPath);
  assert.equal(inherited?.binding.courseVersionId, parent.binding.courseVersionId);

  const unverifiedChild = SessionManager.create(cwd, sessionDirectory);
  unverifiedChild.newSession({ parentSession: join(root, "different-parent.jsonl") });
  const unverifiedPath = unverifiedChild.getSessionFile();
  assert.ok(unverifiedPath);
  const unverifiedHeader = unverifiedChild.getHeader();
  assert.ok(unverifiedHeader);
  writeFileSync(unverifiedPath, `${JSON.stringify(unverifiedHeader)}\n`, { encoding: "utf8", flag: "wx" });
  assert.throws(
    () => inheritHarnessSessionFile(parentManager, unverifiedPath),
    /not directly linked to the supplied parent JSONL/,
  );
});

test("failed new-session binding removes the live wrapper, path cache, and partial JSONL", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-new-session-"));
  const cwd = join(root, "course-workspace");
  const sessionDirectory = join(root, "sessions");
  const databasePath = join(root, "learning-harness.sqlite");
  mkdirSync(cwd);
  const previousHarness = globalThis.__piLearningHarness;
  const previousRegistry = globalThis.__piSessions;
  const harness = new LearningHarness({ databasePath });
  globalThis.__piLearningHarness = harness;
  globalThis.__piSessions = new Map();
  t.after(() => {
    harness.close();
    if (previousHarness === undefined) delete globalThis.__piLearningHarness;
    else globalThis.__piLearningHarness = previousHarness;
    if (previousRegistry === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previousRegistry;
    rmSync(root, { recursive: true, force: true });
  });

  const course = await harness.publishCourseVersion(
    "binding-cleanup-course",
    [{ name: "lesson.md", kind: "markdown", mediaType: "text/markdown", content: "# Cleanup" }],
    { createdAt: "2026-08-30T17:00:00.000Z" },
  );
  const makeWrapper = (label) => {
    const manager = SessionManager.create(cwd, sessionDirectory);
    manager.appendMessage({ role: "user", content: label, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: label }],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const sessionId = manager.getSessionId();
    const wrapper = new AgentSessionWrapper({
      sessionId,
      sessionFile,
      sessionManager: manager,
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      extensionRunner: { emit: async () => undefined },
      agent: { state: {} },
      dispose() {},
    });
    wrapper.onDestroy(() => globalThis.__piSessions?.delete(sessionId));
    globalThis.__piSessions?.set(sessionId, wrapper);
    cacheSessionPath(sessionId, sessionFile);
    return { manager, sessionFile, sessionId, wrapper };
  };

  const unknown = makeWrapper("unknown course");
  await assert.rejects(
    bindHarnessCourseOrDiscard(unknown.wrapper, unknown.sessionId, "missing-course-version"),
    /Unknown course version/,
  );
  assert.equal(getRpcSession(unknown.sessionId), undefined);
  assert.equal(existsSync(unknown.sessionFile), false);
  assert.equal(await resolveSessionPath(unknown.sessionId), null);

  const persistence = makeWrapper("persistence failure");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TRIGGER fail_new_session_binding
    BEFORE UPDATE ON learning_harness_state
    BEGIN
      SELECT RAISE(ABORT, 'injected new-session persistence failure');
    END;
  `);
  database.close();
  await assert.rejects(
    bindHarnessCourseOrDiscard(persistence.wrapper, persistence.sessionId, course.courseVersionId),
    /injected new-session persistence failure/,
  );
  assert.equal(persistence.manager.getBranch().filter((entry) => entry.type === "custom").length, 2);
  assert.equal(getRpcSession(persistence.sessionId), undefined);
  assert.equal(existsSync(persistence.sessionFile), false);
  assert.equal(await resolveSessionPath(persistence.sessionId), null);
});

test("new-session route delegates failed course binding to the rollback seam", () => {
  const source = readFileSync(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.match(source, /bindHarnessCourseOrDiscard\(session, realSessionId, courseVersionId\)/);
  assert.doesNotMatch(source, /bindHarnessCourse\(session\.inner\.sessionManager/);
});
