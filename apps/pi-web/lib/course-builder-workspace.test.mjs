import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("real workspace routes edit and link a dormant course, then activate the same Pi transcript", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-workspace-recovery-"));
  const cwd = join(root, "course");
  mkdirSync(cwd);
  const skillsRoot = join(root, "skills");
  cpSync(new URL("../../../skills/", import.meta.url), skillsRoot, { recursive: true });
  const changedSkill = join(skillsRoot, "recovery-fixture", "SKILL.md");
  mkdirSync(join(skillsRoot, "recovery-fixture"));
  const oldSkill = "---\nname: recovery-fixture\ndescription: Session resource upgrade fixture.\n---\nOriginal fixture teaching instructions.\n";
  writeFileSync(changedSkill, oldSkill);
  const env = { PI_SKILLS_DIR: skillsRoot, PI_LEARNING_HARNESS_DIR: join(root, "harness"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_MODE_PACK_STORE_PATH: join(root, "mode-packs.json"), ANTHROPIC_API_KEY: "offline-fixture-no-provider-request" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("This regression must not contact a model"); };
  t.after(async () => {
    for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
    globalThis.__piLearningHarness?.close();
    globalThis.__piLearningHarness = undefined;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const { getCourseBuilderHost } = await jiti.import("./course-builder-service.ts");
  const { createDefaultCourseBuilderProject } = await jiti.import("./course-builder-defaults.ts");
  const { cacheSessionPath } = await jiti.import("./session-reader.ts");
  const rpc = await jiti.import("./rpc-manager.ts");
  const workspace = await jiti.import("../app/api/course-builder/route.ts");
  const link = await jiti.import("../app/api/course-builder/link/route.ts");
  const activation = await jiti.import("../app/api/course-builder/session/route.ts");
  const manager = SessionManager.create(cwd);
  const sid = manager.getSessionId();
  const file = manager.getSessionFile();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manager.getHeader())}\n`);
  cacheSessionPath(sid, file);
  const originalTranscript = readFileSync(file, "utf8");
  const host = getCourseBuilderHost();
  const input = createDefaultCourseBuilderProject();
  const project = host.createProject(input);
  host.bindSession(sid, project.projectId);
  const request = (path, body) => new Request(`http://127.0.0.1:30141${path}`, {
    method: body ? "POST" : "GET",
    headers: { host: "127.0.0.1:30141", "content-type": "application/json", "x-course-builder-teacher": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const assertOK = async (response) => { const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json; };
  const initial = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.equal(initial.snapshot.project.projectId, project.projectId);
  const library = await assertOK(await workspace.GET(request("/api/course-builder")));
  assert.deepEqual(library.projectSessions[project.projectId], [sid]);
  const edited = await assertOK(await workspace.POST(request("/api/course-builder", { sessionId: sid, action: "update_project", expectedRevision: 1, project: { ...input, title: "Saved edits" } })));
  assert.equal(edited.snapshot.project.title, "Saved edits");
  assert.equal(edited.snapshot.project.revision, 2);
  const conflict = await workspace.POST(request("/api/course-builder", { sessionId: sid, action: "update_project", expectedRevision: 1, project: { ...input, title: "Stale overwrite" } }));
  assert.equal(conflict.status, 400);
  assert.match((await conflict.json()).error, /revision/i);
  assert.equal(host.getProject(project.projectId).title, "Saved edits");
  const materialDir = join(cwd, "materials");
  mkdirSync(materialDir);
  writeFileSync(join(materialDir, "source.unusual"), "PRIVATE FILE BODY NOT FOR CONTEXT");
  const linked = await assertOK(await link.POST(request(`/api/course-builder/link?sessionId=${sid}`, { path: materialDir, expectedRevision: 2 })));
  assert.equal(linked.snapshot.materials.length, 1);
  assert.equal(linked.snapshot.materials[0].name, "source.unusual");
  assert.doesNotMatch(JSON.stringify(linked), /PRIVATE FILE BODY/);
  assert.equal(rpc.getRpcSession(sid), undefined, "reading/editing/linking must not start an agent");
  assert.equal(readFileSync(file, "utf8"), originalTranscript);
  const activated = await assertOK(await activation.POST(request("/api/course-builder/session", { sourceSessionId: sid })));
  assert.equal(activated.sessionId, sid);
  assert.equal(activated.verified, true);
  assert.equal(rpc.getRpcSession(sid).sessionFile, file);
  assert.equal(host.getProjectForSession(sid).projectId, project.projectId);
  const binding = (await rpc.getGenericModePackStatus(sid)).runtime.binding;
  await assertOK(await activation.POST(request("/api/course-builder/session", { sourceSessionId: sid })));
  assert.equal((await rpc.getGenericModePackStatus(sid)).runtime.binding.bindingId, binding.bindingId, "repeated activation of a current runtime is a no-op");

  // A saved personal model/prompt/skill combination must not pin obsolete Skill bytes forever.
  const personalPrompt = "Keep the teacher's carefully edited course prompt.";
  const teacherModel = rpc.getRpcSession(sid).inner.model;
  await rpc.activateGenericModePack({ sessionId: sid, modePackId: "course-builder", expectedSnapshotId: binding.snapshot.resourceSnapshotId, idempotencyKey: "personal-teacher-settings", settingsPatch: { provider: teacherModel.provider, model: teacherModel.id, systemPrompt: personalPrompt, skills: [{ id: "education.feynman-teach-back", enabled: false }, { id: "local.skill.recovery.fixture", enabled: true }] } });
  const customized = (await rpc.getGenericModePackStatus(sid)).runtime.binding;
  await rpc.getRpcSession(sid).shutdown();
  const newSkill = oldSkill.replace("Original fixture teaching instructions.", "Updated fixture teaching instructions.");
  writeFileSync(changedSkill, newSkill);
  const upgraded = await assertOK(await activation.POST(request("/api/course-builder/session", { sourceSessionId: sid })));
  assert.equal(upgraded.sessionId, sid);
  assert.equal(upgraded.verified, true);
  const recovered = (await rpc.getGenericModePackStatus(sid)).runtime.binding;
  assert.notEqual(recovered.snapshot.resourceSnapshotId, customized.snapshot.resourceSnapshotId);
  assert.equal(recovered.snapshot.instructions[2], personalPrompt);
  assert.equal(recovered.snapshot.model, customized.snapshot.model);
  assert.equal(recovered.snapshot.resources.some((item) => item.id === "education.feynman-teach-back" && item.enabled), false);
  assert.ok(rpc.getRpcSession(sid).inner.agent.state.systemPrompt.includes("Updated fixture teaching instructions."));
  assert.ok(!rpc.getRpcSession(sid).inner.agent.state.systemPrompt.includes("Original fixture teaching instructions."));
  assert.ok(!recovered.snapshot.instructions.includes(oldSkill), "old complete Skill instructions must not survive alongside the replacement");
  assert.equal(host.getProjectForSession(sid).projectId, project.projectId);

  writeFileSync(changedSkill, newSkill.replace("Updated fixture", "Second fixture"));
  assert.equal((await rpc.getGenericModePackStatus(sid)).runtime.verified, false);
  const liveUpgradeRequest = { sessionId: sid, modePackId: "course-builder", expectedSnapshotId: recovered.snapshot.resourceSnapshotId, idempotencyKey: "live-skill-refresh-settings", settingsPatch: { thinkingLevel: "low" } };
  const liveUpgrade = await rpc.activateGenericModePack(liveUpgradeRequest);
  assert.equal(liveUpgrade.runtime.verified, true);
  const retryUpgrade = await rpc.activateGenericModePack(liveUpgradeRequest);
  assert.equal(retryUpgrade.binding.bindingId, liveUpgrade.binding.bindingId);
  assert.ok(rpc.getRpcSession(sid).inner.agent.state.systemPrompt.includes("Second fixture teaching instructions."));

  // A new ordinary chat has no course, mode, or transcript inherited from its teacher source.
  const { POST: newConversation } = await jiti.import("../app/api/sessions/[id]/new/route.ts");
  const fresh = await assertOK(await newConversation(new Request(`http://127.0.0.1:30141/api/sessions/${sid}/new`, {
    method: "POST", headers: { host: "127.0.0.1:30141", cookie: "pi-harness-course-version=unrelated-student-course" },
  }), { params: Promise.resolve({ id: sid }) }));
  assert.notEqual(fresh.sessionId, sid);
  const freshStatus = await rpc.getGenericModePackStatus(fresh.sessionId);
  assert.equal(freshStatus.runtime.cwd, cwd);
  assert.equal(freshStatus.runtime.binding, null);
  assert.equal(freshStatus.runtime.inheritedBinding, null);
  assert.equal(host.getProjectForSession(fresh.sessionId), null);
  const { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const freshManager = SessionManager.open(await resolveSessionPath(fresh.sessionId));
  assert.deepEqual(freshManager.buildSessionContext().messages, []);
  assert.equal(freshManager.getHeader().parentSession, undefined);
  assert.equal(rpc.getRpcSession(fresh.sessionId), undefined, "new chat needs no model startup");
  const { POST: sendAgentCommand } = await jiti.import("../app/api/agent/[id]/route.ts");
  await assertOK(await sendAgentCommand(new Request(`http://127.0.0.1:30141/api/agent/${fresh.sessionId}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: "pi-harness-course-version=unrelated-student-course" }, body: JSON.stringify({ type: "get_state" }),
  }), { params: Promise.resolve({ id: fresh.sessionId }) }));
  assert.equal((await rpc.getGenericModePackStatus(fresh.sessionId)).runtime.binding, null, "starting the new runtime must also remain ordinary");
  const { getLearningHarness } = await jiti.import("./harness-server.ts");
  assert.equal(getLearningHarness().findCurrentSession(fresh.sessionId), null);
  assert.equal(host.getProjectForSession(sid).projectId, project.projectId);
  assert.equal((await rpc.getGenericModePackStatus(sid)).runtime.binding.bindingId, binding.bindingId);

  // Teacher tools are editable, while the Course Builder extension and skills survive every selection.
  await rpc.setRpcSessionTools(sid, file, ["read", "bash", "edit", "write"]);
  assert.ok(rpc.getRpcSession(sid).inner.getActiveToolNames().includes("read"));
  assert.ok(rpc.getRpcSession(sid).inner.getActiveToolNames().includes("course_builder"));
  await rpc.getRpcSession(sid).send({ type: "reload" });
  assert.equal((await rpc.getGenericModePackStatus(sid)).runtime.verified, true);
  await rpc.setRpcSessionTools(sid, file, []);
  assert.deepEqual(rpc.getRpcSession(sid).inner.getActiveToolNames().sort(), ["course_builder", "math_visualization"]);
  assert.equal(host.getProjectForSession(sid).projectId, project.projectId);

  const semester = { title: "Review workflow", rationale: "Teach then check understanding", sessions: Array.from({ length: input.weeks }, (_, index) => ({ week: index + 1, session: 1, title: `Week ${index + 1}`, objectives: [input.goals[0]], prerequisites: [], topics: ["Concept"], materialIds: [linked.snapshot.materials[0].materialId], activities: ["Predict and explain"], understandingEvidence: ["Explain the result"], assessment: null, homework: null, courseGoalsCovered: input.goals, revisits: [], visualOpportunities: [] })) };
  const draft = host.saveSemesterPlan(sid, semester, 0);
  const live = rpc.getRpcSession(sid);
  const originalSend = live.send;
  const revisionPrompts = [];
  live.send = async function (command) { if (command.type === "prompt") { revisionPrompts.push(command.message); return { accepted: true }; } return originalSend.call(this, command); };
  const revisionRequest = { sessionId: sid, action: "review_semester", id: draft.semesterPlanId, expectedRevision: 1, decision: "request-changes", note: "Add a prerequisite check in week 2.", requestId: "revision-fixture-1" };
  await assertOK(await workspace.POST(request("/api/course-builder", revisionRequest)));
  assert.equal(revisionPrompts.length, 1, "requesting changes must automatically deliver the teacher note to the agent");
  assert.match(revisionPrompts[0], /Add a prerequisite check in week 2/);
  assert.match(revisionPrompts[0], /save_semester/);
  await assertOK(await workspace.POST(request("/api/course-builder", revisionRequest)));
  assert.equal(revisionPrompts.length, 1, "retrying the same review must not duplicate the prompt");
  const waiting = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.notEqual(waiting.revisionTasks[0].status, "completed", "prompt acceptance alone cannot complete a revision");
  const { courseBuilderCommand } = await jiti.import("./course-builder-service.ts");
  await courseBuilderCommand(sid, { action: "save_semester", expectedRevision: 1, draft: { ...semester, rationale: "Added the prerequisite diagnostic requested by the teacher." } });
  const completed = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.notEqual(completed.revisionTasks[0].status, "completed", "a save alone is not verified delivery");
  assert.equal(completed.snapshot.semesterPlan.status, "draft", "finishing revisions must never approve the new plan");
  live.send = async () => { throw new Error("Fixture prompt admission failed"); };
  const failed = await workspace.POST(request("/api/course-builder", { ...revisionRequest, requestId: "revision-failed", expectedRevision: 2 }));
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /Fixture prompt admission failed/);
  const afterFailure = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.equal(afterFailure.revisionTasks.at(-1).status, "failed");
  assert.equal(afterFailure.snapshot.semesterPlan.status, "changes-requested", "failed dispatch preserves the teacher's recorded instructions");
  live.send = originalSend;
  const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await jiti.import("@earendil-works/pi-ai");
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("course_builder", { action: "delivery_route", specJson: JSON.stringify({kind:"semester",id:draft.semesterPlanId,requirements:[{id:"revision",text:"Apply the teacher's prerequisite diagnostic"}]}) }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("course_builder", { action: "save_semester", expectedRevision: 2, draftJson: JSON.stringify({ ...semester, rationale: "Revised by the real SDK tool loop." }) }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("course_builder", { action: "delivery_finish", specJson: JSON.stringify({id:draft.semesterPlanId,checks:[{requirementId:"revision",quote:"Revised by the real SDK tool loop."}]}) }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Saved revision 3; waiting for teacher review."),
  ]);
  live.inner.agent.streamFunction = (model, context, options) => faux.stream(model, context, options);
  await assertOK(await workspace.POST(request("/api/course-builder", { ...revisionRequest, requestId: "revision-real-agent", expectedRevision: 2 })));
  for (let poll = 0; poll < 150 && live.isRunning(); poll++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(live.isRunning(), false, "the offline SDK turn must settle");
  const actualLoop = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.equal(actualLoop.revisionTasks.at(-1).status, "completed", "real course_builder tool execution must automatically complete the revision task");
  assert.equal(actualLoop.snapshot.semesterPlan.revision, 3);
  assert.equal(actualLoop.snapshot.semesterPlan.status, "draft");
  const taskInput = { sessionId: sid, action: "lesson_task", task: "plan", week: 2, session: 1, additionalRequirements: "Use the extra questions and a geometric example." };
  const notApproved = await workspace.POST(request("/api/course-builder", taskInput));
  assert.equal(notApproved.status, 400);
  assert.match((await notApproved.json()).error, /批准当前学期计划/);
  host.reviewSemesterPlan(sid, draft.semesterPlanId, 3, "approve", "Offline fixture approval");
  live.send = async (command) => {
    assert.equal(command.type, "prompt");
    assert.match(command.message, /week=2, session=1/);
    assert.match(command.message, /Week 2/);
    assert.match(command.message, /expectedRevision=0/);
    assert.ok(command.message.endsWith(`教师额外要求：\n${taskInput.additionalRequirements}`));
    assert.equal(host.getAgentAssignmentScope(sid), null);
    return { accepted: true };
  };
  await assertOK(await workspace.POST(request("/api/course-builder", taskInput)));
  live.send = async (command) => {
    assert.deepEqual(command, { type: "prompt", message: "Only my freeform request" });
    return { accepted: true };
  };
  await assertOK(await workspace.POST(request("/api/course-builder", { sessionId: sid, action: "prompt", message: "Only my freeform request" })));
  const noLesson = await workspace.POST(request("/api/course-builder", { ...taskInput, task: "beamer" }));
  assert.equal(noLesson.status, 400);
  assert.match((await noLesson.json()).error, /单课计划/);
  const lesson = host.saveLessonPlan(sid, { week: 2, session: 1, title: "Week 2", objectives: ["Explain"], prerequisites: [], misconceptions: [], segments: [{ minutes: 15, title: "Practice", teacherAction: "Ask", learnerAction: "Explain", checkForUnderstanding: "Reason" }], examples: [], exercises: [], materialIds: [], visualRequests: [], notes: [] }, 0, 3);
  host.reviewLessonPlan(sid, lesson.lessonPlanId, 1, "approve", "Offline fixture approval");
  live.send = async (command) => {
    assert.match(command.message, /week=2, session=1/);
    assert.ok(command.message.includes(`lessonPlanId=${lesson.lessonPlanId}`));
    return { accepted: true };
  };
  await assertOK(await workspace.POST(request("/api/course-builder", { ...taskInput, task: "beamer" })));
  live.send = originalSend;
  const assignment = host.createAssignment(sid, { title: "Separate assignment", brief: "Work with the assignment's own evidence" });
  const assignmentDraft = { overview: "Assignment fixture", tasks: ["Explain a method"], deliverables: ["Short explanation"], rubric: ["Correct reasoning"], solutionNotes: ["Teacher-only guidance"], materialIds: [] };
  const assignmentSaved = host.saveAssignmentDraft(sid, assignment.assignmentId, assignmentDraft, assignment.revision);
  live.send = async function (command) {
    assert.equal(command.type, "prompt");
    assert.equal(host.getAgentAssignmentScope(sid), assignment.assignmentId, "Assignment revision must set its isolated scope before agent admission");
    assert.match(command.message, /assignment_state/);
    return { accepted: true };
  };
  await assertOK(await workspace.POST(request("/api/course-builder", { sessionId: sid, action: "review_assignment", id: assignment.assignmentId, expectedRevision: assignmentSaved.revision, decision: "request-changes", note: "Clarify the rubric.", requestId: "assignment-revision" })));
  const reviewedAssignmentRevision = host.getAssignment(sid, assignment.assignmentId).revision;
  await assertOK(await workspace.POST(request("/api/course-builder", { sessionId: sid, action: "review_assignment", id: assignment.assignmentId, expectedRevision: assignmentSaved.revision, decision: "request-changes", note: "Clarify the rubric.", requestId: "assignment-retry" })));
  assert.equal(host.getAssignment(sid, assignment.assignmentId).revision, reviewedAssignmentRevision, "retry sends the saved review without reviewing the assignment twice");
  await courseBuilderCommand(sid, { action: "save_assignment", assignmentId: assignment.assignmentId, expectedRevision: reviewedAssignmentRevision, draft: { ...assignmentDraft, rubric: ["Clearly justify each step"] } });
  assert.equal((await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)).then(assertOK)).revisionTasks.at(-1).status, "sent", "Assignment saves also wait for delivery verification");
  live.send = originalSend;
  await live.shutdown();
  const afterRestart = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.deepEqual(afterRestart.revisionTasks.map((task) => task.status), ["completed", "failed", "completed", "sent", "sent"], "revision receipts and unfinished work survive runtime shutdown");

  const { lessonReviewDraft } = await jiti.import("./lesson-review.ts");
  const editInput = { sessionId: sid, action: "edit_lesson", id: lesson.lessonPlanId, expectedRevision: 1, parentRevision: 3, draft: { ...lessonReviewDraft(lesson), title: "Edited by the teacher without an Agent" } };
  const editedLesson = await assertOK(await workspace.POST(request("/api/course-builder", editInput)));
  assert.equal(editedLesson.snapshot.lessonPlans[0].title, editInput.draft.title);
  assert.equal(editedLesson.snapshot.lessonPlans[0].revision, 2);
  assert.equal(editedLesson.snapshot.lessonPlans[0].status, "draft");
  assert.equal((await workspace.POST(request("/api/course-builder", editInput))).status, 400, "an old editor must not overwrite a newer lesson");
  assert.equal((await workspace.POST(request("/api/course-builder", { ...editInput, expectedRevision: 2, draft: { ...editInput.draft, session: 2 } }))).status, 400, "the review editor cannot change the lesson identity");
  const approvedEdit = await assertOK(await workspace.POST(request("/api/course-builder", { action: "review_lesson", sessionId: sid, id: lesson.lessonPlanId, expectedRevision: 2, decision: "approve", note: "Read and approved in the lesson page" })));
  assert.equal(approvedEdit.snapshot.lessonPlans[0].status, "approved");
  assert.equal((await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)).then(assertOK)).snapshot.lessonPlans[0].title, editInput.draft.title);

  // A brand-new ordinary conversation may have no JSONL until its first message.
  // Explicitly saving a course must materialize that existing identity before binding it.
  const transient = await rpc.startRpcSession("__new_course_fixture__", "", cwd);
  const transientFile = transient.session.sessionFile;
  assert.equal(existsSync(transientFile), false);
  await assertOK(await workspace.POST(request("/api/course-builder", { sessionId: transient.realSessionId, action: "create", project: { ...input, courseId: "second-course" } })));
  assert.equal(existsSync(transientFile), true, "saving the course must make its session recoverable after restart");
  await transient.session.shutdown();
  const recoveredWorkspace = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${transient.realSessionId}`)));
  assert.equal(recoveredWorkspace.snapshot.project.courseId, "second-course");

  const directInput = { ...input, courseId: "direct-course", title: "Created directly from the workspace" };
  const createdAt = new Date().toISOString();
  const countBefore = host.listProjects().length;
  const bad = await workspace.POST(request("/api/course-builder", { action: "create", createdAt, project: { ...directInput, weeks: 0 } }));
  assert.equal(bad.status, 400);
  assert.equal(host.listProjects().length, countBefore);
  const createDirect = () => workspace.POST(request("/api/course-builder", { action: "create", createdAt, project: directInput })).then(assertOK);
  const direct = await Promise.all([createDirect(), createDirect(), createDirect()]);
  assert.equal(new Set(direct.map((result) => result.sessionId)).size, 1, "duplicate submissions create exactly one workspace session");
  assert.equal(host.listProjects().length, countBefore + 1);
  assert.equal(rpc.getRpcSession(direct[0].sessionId), undefined, "creating a course does not instantiate a model runtime");
  assert.equal((await createDirect()).sessionId, direct[0].sessionId, "retry after a lost response returns the saved workspace");
  const directState = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${direct[0].sessionId}`)));
  assert.equal(directState.snapshot.project.title, directInput.title);
});
