import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createCourseBuilderExtension } = await jiti.import("./course-builder-extension.ts");
const { CourseBuilderHost, runCourseBuilderCommand } = await jiti.import("../../../packages/course-builder-host/src/index.ts");
const { AuthStorage } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href);
const { createDefaultCourseBuilderProject } = await jiti.import("./course-builder-defaults.ts");

test("one native Pi prompt survives two premature stops and completes only after verified delivery", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-delivery-faux-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No network or paid provider is allowed in this test"); };
  const database = new DatabaseSync(":memory:"), host = new CourseBuilderHost(database);
  let session;
  t.after(() => { session?.dispose(); database.close(); globalThis.fetch = originalFetch; assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), "pi-delivery-faux-"))); rmSync(directory, { recursive: true }); });
  const faux = createFauxCore({});
  const credentials = AuthStorage.inMemory();
  await credentials.modify("faux", async () => ({ type: "api_key", key: "faux-key" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(directory, "models.json"), allowModelNetwork: false });
  const model = faux.getModel();
  modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  const project = host.createProject({ ...createDefaultCourseBuilderProject(), weeks: 1, sessionsPerWeek: 1 });
  host.bindSession(manager.getSessionId(), project.projectId);
  const extension = createCourseBuilderExtension(() => host, (sid, command) => runCourseBuilderCommand(host, sid, command));
  const services = await createAgentSessionServices({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.create(directory, directory), modelRuntime, resourceLoaderOptions: { extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model }));
  session.agent.streamFunction = faux.stream;
  await session.bindExtensions({});
  session.setActiveToolsByName(["course_builder"]);
  const call = (action, spec) => fauxAssistantMessage([fauxToolCall("course_builder", { action, ...spec })], { stopReason: "toolUse" });
  const draft = { title: "Complete plan", rationale: "Learners explain the complete source", sessions: [{ week: 1, session: 1, title: "R workspace and help", objectives: ["Explain R workspace"], prerequisites: [], topics: ["Workspace", "Getting Help"], materialIds: [], activities: ["Find help"], understandingEvidence: ["Explain results"], assessment: null, homework: null, courseGoalsCovered: project.goals, revisits: [], visualOpportunities: [] }] };
  faux.setResponses([
    call("delivery_route", { spec: { kind: "semester", requirements: [{ id: "full", text: "Save a complete plan" }] } }),
    fauxAssistantMessage("I will do it next."),
    call("save_semester", { expectedRevision: 0, draft }),
    fauxAssistantMessage("Saved a plan. Stopping without verification."),
    () => call("delivery_finish", { spec: { id: host.getSnapshotForSession(manager.getSessionId()).semesterPlan.semesterPlanId, checks: [{ requirementId: "full", quote: draft.rationale }] } }),
    fauxAssistantMessage("The complete plan is ready for teacher review."),
  ]);
  await session.prompt("Produce a complete semester plan and finish before stopping.");
  const tasks = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-web:course-delivery").map((entry) => entry.data);
  assert.equal(tasks.at(-1).status, "completed", JSON.stringify(session.messages));
  assert.equal(tasks.at(-1).rounds, 2);
  assert.equal(tasks.at(-1).delivered.revision, 1);
  assert.equal(host.getSnapshotForSession(manager.getSessionId()).semesterPlan.status, "draft");
  const disk = SessionManager.open(manager.getSessionFile());
  assert.equal(disk.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-web:course-delivery").at(-1).data.status, "completed");
});
