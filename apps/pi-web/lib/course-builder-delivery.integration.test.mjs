import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createCourseBuilderExtension } = await jiti.import("./course-builder-extension.ts");
const { deliveryRequest, DELIVERY_REQUEST_ENTRY } = await jiti.import("./course-builder-delivery.ts");
const { CourseBuilderHost, runCourseBuilderCommand } = await jiti.import("../../../packages/course-builder-host/src/index.ts");
const { AuthStorage } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href);
const { createDefaultCourseBuilderProject } = await jiti.import("./course-builder-defaults.ts");
const { addCourseMaterial } = await jiti.import("./course-builder-material-library.ts");
const { describeCourseBuilderLocalFile, readLinkedCourseBuilderMaterial } = await jiti.import("./course-builder-local-materials.ts");

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
  const extension = createCourseBuilderExtension(() => host, (sid, command) => runCourseBuilderCommand(host, sid, command,{trustedTex:true,addMaterial:(spec,revision)=>addCourseMaterial(host,sid,spec,revision),readLinkedMaterial:readLinkedCourseBuilderMaterial}));
  const services = await createAgentSessionServices({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.create(directory, directory), modelRuntime, resourceLoaderOptions: { extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model }));
  session.agent.streamFunction = faux.stream;
  await session.bindExtensions({});
  session.setActiveToolsByName(["course_builder"]);
  const call = (action, spec) => fauxAssistantMessage([fauxToolCall("course_builder", { action, ...spec })], { stopReason: "toolUse" });
  const draft = { title: "Complete plan", rationale: "Learners explain the complete source", sessions: [{ week: 1, session: 1, title: "R workspace and help", objectives: ["Explain R workspace"], prerequisites: [], topics: ["Workspace", "Getting Help"], materialIds: [], activities: ["Find help"], understandingEvidence: ["Explain results"], assessment: null, homework: null, courseGoalsCovered: project.goals, revisits: [], visualOpportunities: [] }] };
  faux.setResponses([
    call("delivery_route", { spec: { kind: "semester", requirements: [{ id: "full", text: "Save a complete plan", verification:"content" }] } }),
    fauxAssistantMessage("I will do it next."),
    call("save_semester", { expectedRevision: 0, draft }),
    fauxAssistantMessage("Saved a plan. Stopping without verification."),
    () => call("delivery_finish", { spec: { checks: [{ requirementId: "full", quote: draft.rationale }] } }),
    fauxAssistantMessage("The complete plan is ready for teacher review."),
  ]);
  const prompt = "Produce a complete semester plan and finish before stopping.";
  manager.appendCustomEntry(DELIVERY_REQUEST_ENTRY, deliveryRequest(prompt, { kind: "semester" }));
  await session.prompt(prompt);
  const tasks = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-web:course-delivery").map((entry) => entry.data);
  assert.equal(tasks.at(-1).status, "completed", JSON.stringify(session.messages));
  assert.equal(tasks.at(-1).rounds, 2);
  assert.equal(tasks.at(-1).delivered.revision, 1);
  assert.equal(tasks.at(-1).delivered.id, host.getSnapshotForSession(manager.getSessionId()).semesterPlan.semesterPlanId);
  assert.equal(manager.getEntries().filter((entry)=>entry.type==="custom"&&entry.customType===DELIVERY_REQUEST_ENTRY).at(-1).data.consumed, true);
  assert.equal(host.getSnapshotForSession(manager.getSessionId()).semesterPlan.status, "draft");
  const disk = SessionManager.open(manager.getSessionFile());
  assert.equal(disk.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-web:course-delivery").at(-1).data.status, "completed");

  // Exercise the reported path through real tool validation, Host saves and native
  // JSONL: a new deck for a selected lesson, with no product ID copied at finish.
  const sid = manager.getSessionId();
  const semester = host.getSnapshotForSession(sid).semesterPlan;
  host.reviewSemesterPlan(sid, semester.semesterPlanId, 1, "approve", "Fixture approval");
  const lesson = host.saveLessonPlan(sid, { week: 1, session: 1, title: "Workspace", objectives: ["Explain the workspace"], prerequisites: [], misconceptions: [], segments: [{ minutes: 40, title: "Explore", teacherAction: "Demonstrate", learnerAction: "Predict and explain", checkForUnderstanding: "Explain the result" }], examples: ["Inspect objects"], exercises: ["Find help"], materialIds: [], visualRequests: [], notes: [] }, 0, 1);
  host.reviewLessonPlan(sid, lesson.lessonPlanId, 1, "approve", "Fixture approval");
  const source = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{Workspace}
The workspace holds named R objects. Inspect the objects and explain their values.
\end{frame}
\end{document}`;
  faux.setResponses([
    call("delivery_route", { spec: { kind: "deck", id: lesson.lessonPlanId, requirements: [{ id: "objects", text: "Explain workspace objects", verification:"content" }] } }),
    call("save_deck", { expectedRevision: 0, parentRevision: 1, draft: { title: "Workspace", source, frameOutline: ["Workspace"], assetMaterialIds: [] } }),
    call("delivery_finish", { spec: { checks: [{ requirementId: "objects", quote: "The workspace holds named R objects." }] } }),
    ...Array.from({length:4},()=>fauxAssistantMessage("Compilation has not run in this fixture.")),
  ]);
  const deckPrompt = "Create slides for the selected lesson.";
  manager.appendCustomEntry(DELIVERY_REQUEST_ENTRY, deliveryRequest(deckPrompt, { kind: "deck", week: 1, session: 1 }));
  await session.prompt(deckPrompt);
  const deckTask = manager.getEntries().filter((entry)=>entry.type==="custom"&&entry.customType==="pi-web:course-delivery").at(-1).data;
  const deck = host.getSnapshotForSession(sid).decks[0];
  assert.equal(deckTask.target.id, deck.deckId);
  assert.equal(deckTask.target.lessonPlanId, lesson.lessonPlanId);
  assert.notEqual(deckTask.target.id, lesson.lessonPlanId);
  assert.equal(deck.revision, 1);
  assert.equal(deck.source, source);
  assert.equal(deckTask.status, "blocked", "identity fix must not bypass compile validation");
  assert.match(deckTask.lastError, /compile this revision/);
  assert.doesNotMatch(deckTask.lastError, /target|artifact ID/);
  assert.equal(SessionManager.open(manager.getSessionFile()).getEntries().filter((entry)=>entry.type==="custom"&&entry.customType==="pi-web:course-delivery").at(-1).data.target.id, deck.deckId);

  // Start a new material task after an explicit cancellation, through the same
  // native tool schema. Finish reads the imported text, not metadata or a mock quote.
  manager.appendCustomEntry("pi-web:course-delivery",{...deckTask,status:"cancelled"});
  const library=join(directory,"existing-materials");mkdirSync(library);
  writeFileSync(join(library,"initial.md"),"Existing material");
  host.importMaterials(sid,[await describeCourseBuilderLocalFile(library,join(library,"initial.md"))],host.getProjectForSession(sid).revision);
  const captured=join(directory,"captured.md");writeFileSync(captured,"# Captured chapter\nThe objective is the negative log likelihood.");
  let capturedId;
  faux.setResponses([
    call("delivery_route",{spec:{kind:"materials",requirements:[{id:"body",text:"Capture the optimization chapter",verification:"content"},{id:"registered",text:"Register it in the course",verification:"materials"}]}}),
    call("add_material",{expectedRevision:host.getProjectForSession(sid).revision,spec:{path:captured}}),
    call("delivery_status",{}),
    ()=>{capturedId=host.getSnapshotForSession(sid).materials.find(item=>item.name==="captured.md").materialId;return call("delivery_finish",{spec:{checks:[{requirementId:"body",materialId:capturedId,offset:0,quote:"The objective is the negative log likelihood."}]}});},
    fauxAssistantMessage("The captured chapter is registered and read back."),
  ]);
  await session.prompt("Import the captured optimization chapter as course material.");
  const materialTask=manager.getEntries().filter(entry=>entry.type==="custom"&&entry.customType==="pi-web:course-delivery").at(-1).data;
  assert.equal(materialTask.status,"completed",JSON.stringify(materialTask));
  assert.equal(materialTask.delivered.checks[0].materialId,capturedId);
  assert.equal(materialTask.delivered.hostEvidence[0].records[0].materialId,capturedId);
  // Real XeLaTeX is optional in CI; enable it for the full native script chain.
  if(process.env.PI_TEST_XELATEX === "1") {
  // Existing Beamer -> independent teacher script through actual Pi tool schema.
  const script=String.raw`\documentclass{article}
\begin{document}
Explain aloud how $x^2$ changes when $x$ doubles; ask students to predict first.
\end{document}`;
  faux.setResponses([
    call("delivery_route",{spec:{kind:"teacher-notes",requirements:[{id:"speaking",text:"Teacher explanation and prediction prompt",verification:"content"}]}}),
    call("read_deck",{id:deck.deckId}),
    call("save_teacher_notes",{expectedRevision:0,draft:{deckRevision:deck.revision,title:"Classroom lecture",source:script}}),
    fauxAssistantMessage("The teacher script has been saved."),
    ()=>call("read_teacher_notes",{id:host.getSnapshotForSession(sid).teacherNotes[0].notesId}),
    ()=>call("compile_teacher_notes",{id:host.getSnapshotForSession(sid).teacherNotes[0].notesId,expectedRevision:1}),
    call("delivery_finish",{spec:{checks:[{requirementId:"speaking",quote:"Explain aloud how $x^2$ changes when $x$ doubles; ask students to predict first."}]}}),
    fauxAssistantMessage("The saved teacher script is ready to edit."),
  ]);
  const scriptPrompt="Create the teacher speaking script for this existing Beamer.";
  manager.appendCustomEntry(DELIVERY_REQUEST_ENTRY,deliveryRequest(scriptPrompt,{kind:"teacher-notes",deckId:deck.deckId}));
  await session.prompt(scriptPrompt);
  const scriptTask=manager.getEntries().filter(entry=>entry.type==="custom"&&entry.customType==="pi-web:course-delivery").at(-1).data;
  assert.equal(scriptTask.status,"completed",JSON.stringify(scriptTask));
  assert.equal(scriptTask.rounds,1,"a save-only stop continues to read-back and finish");
  assert.equal(host.getSnapshotForSession(sid).teacherNotes[0].source,script);
  assert.deepEqual(host.getSnapshotForSession(sid).decks[0],deck,"independent scripts must not rewrite or reapprove their deck");
  assert.equal(host.getSnapshotForSession(sid).teacherNotesCompileReceipts.at(-1).succeeded,true);
  }
  const statusMessage=session.messages.filter(message=>message.role==="toolResult"&&message.toolName==="course_builder").map(message=>message.content.filter(c=>c.type==="text").map(c=>c.text).join(""));
  assert.ok(statusMessage.some(text=>text.includes('"finishTemplate":{"checks":[{"requirementId":"body","materialId":"","offset":0,"quote":""}]}')));
});
