import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createCourseBuilderExtension } = await jiti.import("./course-builder-extension.ts");
const { createDefaultCourseBuilderProject } = await jiti.import("./course-builder-defaults.ts");
const { getLearningHarness } = await jiti.import("./harness-server.ts");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
const { readBundledDomainWorkflows } = await jiti.import("./bundled-domain-workflows.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("Course Builder hands a prepared product to one native course-production Run", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-course-workflow-native-"));
  const cwd = join(root, "course");
  mkdirSync(cwd);
  const savedEnvironment = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    PI_LEARNING_HARNESS_DIR: process.env.PI_LEARNING_HARNESS_DIR,
  };
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_LEARNING_HARNESS_DIR: join(root, "harness"),
  });
  const hooks = new Map();
  const tools = [];
  const messages = [];
  const requests = [];
  const runs = new Map();
  const emitter = new EventEmitter();
  let manager;
  let sessionId;
  let extensionShutdown = false;
  t.after(async () => {
    if (extensionShutdown) hooks.get("session_shutdown")?.();
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const bridge = {
    events: {
      on(name, handler) { emitter.on(name, handler); return () => emitter.off(name, handler); },
      emit(name, value) {
        if (name === "pi-caw:host-readiness") {
          value.ready = value.session_id === sessionId;
          return;
        }
        return emitter.emit(name, value);
      },
    },
    on(name, handler) { hooks.set(name, handler); },
    registerTool(tool) { tools.push(tool); },
    appendEntry(type, data) { manager.appendCustomEntry(type, data); },
    sendMessage(message) { messages.push(message); },
  };
  emitter.on("pi-caw:host-command", (request) => {
    requests.push({ operation: request.operation, args: request.args });
    if (request.session_id !== sessionId) return request.reject(new Error("Native bridge request escaped its active session"));
    if (request.operation === "list") {
      return request.resolve([{ id: "course-production", status: "ready", enabled: true, revision_hash: bundle.revisionHash, validation: { valid: true, errors: [] } }]);
    }
    if (request.operation === "run") {
      const args = request.args;
      assert.equal(args.workflow_id, "course-production");
      assert.equal(args.revision_hash, bundle.revisionHash);
      assert.equal(args.access, "bounded_write");
      assert.deepEqual(args.allowed_paths, ["."]);
      assert.deepEqual(args.constraints, { allowed_paths: ["."] });
      assert.deepEqual(Object.keys(args.inputs).sort(), ["commitRequestId", "compileRequestId", "task", "taskId"]);
      assert.equal(runs.has(args.run_id), false, "one Host start dispatch creates one native Run");
      const state = {
        run_id: args.run_id,
        main_actor: sessionId,
        workflow_id: args.workflow_id,
        inputs: args.inputs,
        permissions: { workspace: args.workspace },
        status: "running",
        updated_at: new Date().toISOString(),
        nodes: {},
      };
      runs.set(args.run_id, state);
      return request.resolve({ run_id: args.run_id });
    }
    if (request.operation === "get") {
      const state = runs.get(request.args.run_id);
      if (!state) return request.reject(Object.assign(new Error("Exact Run not found"), { code: "RUN_NOT_FOUND", details: { run_id: request.args.run_id, observation: "run_directory_absent" } }));
      return request.resolve(state);
    }
    return request.reject(new Error(`Unexpected native pi-CAW operation: ${request.operation}`));
  });

  const bundle = (await readBundledDomainWorkflows()).find((entry) => entry.id === "course-production");
  assert.ok(bundle, "the pinned native course-production Workflow bundle must exist");
  const host = getLearningHarness().courseBuilder;
  const project = host.createProject({ ...createDefaultCourseBuilderProject(), weeks: 1, sessionsPerWeek: 1 });
  manager = SessionManager.create(cwd, process.env.PI_CODING_AGENT_SESSION_DIR);
  sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify(manager.getHeader())}\n`);
  cacheSessionPath(sessionId, sessionFile);
  host.bindSession(sessionId, project.projectId);

  createCourseBuilderExtension()(bridge);
  const context = { cwd, sessionManager: manager, isIdle: () => true };
  await hooks.get("session_start")({}, context);
  extensionShutdown = true;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "course_builder");
  const call = (params) => tools[0].execute("fixture-call", params, new AbortController().signal, undefined, context);
  const value = (result) => JSON.parse(result.content.find((part) => part.type === "text").text);

  const prepared = value(await call({ action: "workflow_prepare", spec: {
    productAction: "course-semester-plan", course: true, task: "Create one complete semester plan for this course.",
  } }));
  assert.equal(prepared.workflowId, "course-production");
  assert.equal(prepared.productAction, "course-semester-plan");
  assert.deepEqual(prepared.target, { course: true });
  assert.equal(prepared.started, false);
  assert.ok(existsSync(join(prepared.workspace, "sources")), "preparation creates the exact private task workspace");

  await assert.rejects(call({ action: "save_semester", expectedRevision: 0, draft: {} }), /requires a scoped Workflow: use workflow_prepare and workflow_start/);
  assert.equal(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "pi-web:course-delivery"), false, "legacy delivery tasks do not resume after migration");

  const started = value(await call({ action: "workflow_start", id: prepared.taskId }));
  assert.equal(started.workflowId, "course-production");
  assert.equal(started.productAction, "course-semester-plan");
  assert.equal(started.taskId, prepared.taskId);
  assert.equal(started.started, true);
  assert.equal(started.startState, "confirmed", "the bridge acknowledgement is checked against the exact Run identity");
  assert.equal(runs.has(started.runId), true);
  const runDispatch = requests.find((request) => request.operation === "run");
  assert.ok(runDispatch);
  assert.equal(runDispatch.args.inputs.taskId, prepared.taskId);
  assert.equal(runDispatch.args.workspace, prepared.workspace);
  assert.deepEqual(Object.keys(runDispatch.args.inputs).sort(), ["commitRequestId", "compileRequestId", "task", "taskId"]);

  const status = value(await call({ action: "workflow_status", id: prepared.taskId }));
  assert.equal(status.run.runId, started.runId);
  assert.equal(status.run.status, "running");
  assert.equal(status.teacherReviewPending, true);
  assert.ok(requests.some((request) => request.operation === "get" && request.args.run_id === started.runId), "status reads the exact native Run");
  assert.equal(messages.length, 0, "the host bridge does not fabricate a user-facing success message");
  assert.equal(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "pi-web:course-delivery"), false);

  hooks.get("session_shutdown")();
  extensionShutdown = false;
});
