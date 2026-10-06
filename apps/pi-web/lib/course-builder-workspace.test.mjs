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
  assert.doesNotMatch(rpc.getRpcSession(sid).systemPrompt, /You are an expert coding assistant operating inside pi/u, "Course Builder owns its prompt and must not inherit Pi's coding persona");
  assert.match(rpc.getRpcSession(sid).systemPrompt, /course-production/u);
  assert.match(rpc.getRpcSession(sid).systemPrompt, /workflow_prepare/u);
  assert.doesNotMatch(rpc.getRpcSession(sid).systemPrompt, /Assume earlier scheduled lessons have been taught/u);
  assert.equal(rpc.getRpcSession(sid).sessionFile, file);
  assert.equal(host.getProjectForSession(sid).projectId, project.projectId);
  const binding = (await rpc.getGenericModePackStatus(sid)).runtime.binding;
  await assertOK(await activation.POST(request("/api/course-builder/session", { sourceSessionId: sid })));
  assert.equal((await rpc.getGenericModePackStatus(sid)).runtime.binding.bindingId, binding.bindingId, "repeated activation of a current runtime is a no-op");

  // Course Builder is a committed Mode Pack: a session-only settings patch
  // cannot add an ambient Skill outside that pack's resource inventory.
  const personalPrompt = "Keep the teacher's carefully edited course prompt.";
  const teacherModel = rpc.getRpcSession(sid).inner.model;
  await assert.rejects(
    rpc.activateGenericModePack({ sessionId: sid, modePackId: "course-builder", expectedSnapshotId: binding.snapshot.resourceSnapshotId, idempotencyKey: "unsupported-personal-skill", settingsPatch: { skills: [{ id: "local.skill.recovery-fixture", enabled: true }] } }),
    /Unknown Skill: local\.skill\.recovery-fixture/,
  );
  assert.equal((await rpc.getGenericModePackStatus(sid)).runtime.binding.bindingId, binding.bindingId, "a rejected resource addition leaves the live Course Builder binding intact");
  await rpc.activateGenericModePack({ sessionId: sid, modePackId: "course-builder", expectedSnapshotId: binding.snapshot.resourceSnapshotId, idempotencyKey: "personal-teacher-settings", settingsPatch: { provider: teacherModel.provider, model: teacherModel.id, systemPrompt: personalPrompt } });
  const customized = (await rpc.getGenericModePackStatus(sid)).runtime.binding;
  await rpc.getRpcSession(sid).shutdown();
  const resumed = await assertOK(await activation.POST(request("/api/course-builder/session", { sourceSessionId: sid })));
  assert.equal(resumed.sessionId, sid);
  assert.equal(resumed.verified, true);
  const recovered = (await rpc.getGenericModePackStatus(sid)).runtime.binding;
  assert.notEqual(recovered.snapshot.resourceSnapshotId, customized.snapshot.resourceSnapshotId, "reopening rebases saved settings onto the current Mode Pack snapshot");
  assert.equal(recovered.snapshot.instructions[2], personalPrompt);
  assert.equal(recovered.snapshot.model, customized.snapshot.model);
  assert.equal(host.getProjectForSession(sid).projectId, project.projectId);

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
  let activeTools = rpc.getRpcSession(sid).inner.getActiveToolNames();
  assert.ok(activeTools.includes("subagents_enable"), "native pi-subagents starts with its authorized-use loader for this model");
  assert.ok(!activeTools.includes("subagent"), "the native subagent schema stays lazy until the loader is called");
  assert.ok(activeTools.includes("bg_wait"), "native background runs remain observable before delegation is enabled");
  assert.ok(activeTools.includes("subagent_supervisor"), `teacher Mode Pack must attach the native supervisor tool; active tools: ${JSON.stringify(activeTools)}`);
  assert.ok(!activeTools.some((name) => ["Agent", "get_subagent_result", "steer_subagent"].includes(name)), "retired custom subagent tools must not return");
  await rpc.getRpcSession(sid).send({ type: "reload" });
  assert.equal((await rpc.getGenericModePackStatus(sid)).runtime.verified, true);
  activeTools = rpc.getRpcSession(sid).inner.getActiveToolNames();
  assert.ok(activeTools.includes("subagents_enable"), "native lazy activation survives resource reload");
  assert.ok(!activeTools.includes("subagent"));
  const subagentExtension = rpc.getRpcSession(sid).inner.resourceLoader.getExtensions().extensions.find((extension) => extension.path === "<inline:pi-web-subagents>");
  assert.ok(subagentExtension?.tools.has("subagents_enable"), "the native extension owns the loader");
  const enabled = await subagentExtension.tools.get("subagents_enable").definition.execute("enable-teacher-subagents", {}, undefined, undefined, {});
  assert.match(enabled.content?.[0]?.text ?? "", /Enabled: subagent/);
  activeTools = rpc.getRpcSession(sid).inner.getActiveToolNames();
  assert.ok(activeTools.includes("subagent"), "calling the native loader enables delegation for the next model request");
  const { resolveSubagentCapabilityCeiling } = await jiti.import("pi-subagents/capability-ceiling");
  const childCeiling = resolveSubagentCapabilityCeiling(sid);
  assert.ok(childCeiling?.allowedTools?.includes("subagent"), "the public native capability ceiling must allow the newly enabled delegation tool on this first turn");
  assert.deepEqual(childCeiling.sources, ["pi-web-mode-pack"], "the committed Mode Pack supplies the sole effective registered-capability ceiling");
  await rpc.setRpcSessionTools(sid, file, []);
  activeTools = rpc.getRpcSession(sid).inner.getActiveToolNames();
  assert.ok(activeTools.includes("course_builder"));
  assert.ok(activeTools.includes("subagents_enable"));
  assert.ok(activeTools.includes("subagent_supervisor"));
  assert.ok(!activeTools.some((name) => ["read", "write", "bash", "edit"].includes(name)), "clearing teacher tools must retain only extensions and host controls");
  assert.equal(host.getProjectForSession(sid).projectId, project.projectId);

  const semester = { title: "Review workflow", rationale: "Teach then check understanding", sessions: Array.from({ length: input.weeks }, (_, index) => ({ week: index + 1, session: 1, title: `Week ${index + 1}`, objectives: [input.goals[0]], prerequisites: [], topics: ["Concept"], materialIds: [linked.snapshot.materials[0].materialId], activities: ["Predict and explain"], understandingEvidence: ["Explain the result"], assessment: null, homework: null, courseGoalsCovered: input.goals, revisits: [], visualOpportunities: [] })) };
  const draft = host.saveSemesterPlan(sid, semester, 0);
  const live = rpc.getRpcSession(sid);
  const { registerCourseWorkflowControl, statusCourseWorkflowTask } = await jiti.import("./course-workflow-tasks.ts");
  const workflowRevision = "fixture-course-production-revision";
  const workflowRuns = new Map();
  let refuseNextWorkflowStart = false;
  const releaseWorkflowControl = registerCourseWorkflowControl(sid, async (operation, args) => {
    if (operation === "list") return [{ id: "course-production", status: "ready", enabled: true, revision_hash: workflowRevision, validation: { valid: true, errors: [] } }];
    if (operation === "cleanup_run_history") return { deleted: [], bytes: 0, protected: [] };
    if (operation === "run") {
      if (refuseNextWorkflowStart) {
        refuseNextWorkflowStart = false;
        throw new Error("Native Workflow start refused by fixture");
      }
      const state = { run_id: args.run_id, main_actor: sid, workflow_id: args.workflow_id, inputs: args.inputs,
        permissions: { workspace: args.workspace }, status: "running", updated_at: new Date().toISOString(), nodes: {} };
      workflowRuns.set(args.run_id, state);
      return { run_id: args.run_id };
    }
    if (operation === "get") {
      const state = workflowRuns.get(args.run_id);
      if (!state) throw Object.assign(new Error("Exact fixture Run not found"), { code: "RUN_NOT_FOUND", details: { run_id: args.run_id, observation: "run_directory_absent" } });
      return state;
    }
    throw new Error(`Unexpected native Workflow operation: ${operation}`);
  });
  t.after(() => releaseWorkflowControl());
  const runCount = () => [...workflowRuns.keys()].length;
  const revisionRequest = { sessionId: sid, action: "review_semester", id: draft.semesterPlanId, expectedRevision: 1, decision: "request-changes", note: "Add a prerequisite check in week 2.", requestId: "revision-fixture-1" };
  const revisionResponse = await assertOK(await workspace.POST(request("/api/course-builder", revisionRequest)));
  const revisionTask = revisionResponse.revisionTask;
  assert.equal(revisionTask.status, "sent", "teacher changes are handed to the selected native Workflow");
  assert.equal(revisionTask.action, "review_semester");
  assert.equal(revisionTask.baseRevision, 1);
  assert.ok(revisionTask.workflowTaskId);
  assert.ok(revisionTask.runId);
  assert.equal(runCount(), 1);
  const storedRevision = globalThis.__piCourseWorkflowTasks.get(revisionTask.workflowTaskId).record;
  assert.equal(storedRevision.workflowId, "course-production");
  assert.equal(storedRevision.productAction, "course-semester-plan");
  assert.deepEqual(storedRevision.target, { course: true });
  assert.match(storedRevision.task, /Add a prerequisite check in week 2/);
  assert.equal(workflowRuns.get(revisionTask.runId).status, "running");
  const runningStatus = await statusCourseWorkflowTask(sid, revisionTask.workflowTaskId);
  assert.equal(runningStatus.run.status, "running");
  assert.equal(runningStatus.teacherReviewPending, true);
  const retryResponse = await assertOK(await workspace.POST(request("/api/course-builder", revisionRequest)));
  assert.equal(retryResponse.revisionTask.workflowTaskId, revisionTask.workflowTaskId, "retrying the same request ID returns its saved workflow handoff");
  assert.equal(runCount(), 1, "an idempotent review retry does not launch another Run");

  const revisedSemester = host.saveSemesterPlan(sid, { ...semester, rationale: "Added the prerequisite diagnostic requested by the teacher." }, 1);
  assert.equal(revisedSemester.status, "draft");
  const runningRun = workflowRuns.get(revisionTask.runId);
  runningRun.status = "succeeded";
  runningRun.updated_at = new Date().toISOString();
  const missingReceipt = await statusCourseWorkflowTask(sid, revisionTask.workflowTaskId);
  assert.equal(missingReceipt.revisionReconciliation.status, "missing");
  const unverified = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.equal(unverified.revisionTasks[0].status, "sent", "a saved draft or successful Run without its exact Host receipt cannot complete teacher feedback");

  runningRun.nodes = { commit: { status: "succeeded", output: { taskId: revisionTask.workflowTaskId, succeeded: true, kind: "semester",
    product: { semesterPlanId: revisedSemester.semesterPlanId, revision: revisedSemester.revision, contentHash: revisedSemester.contentHash } } } };
  const verifiedStatus = await statusCourseWorkflowTask(sid, revisionTask.workflowTaskId);
  assert.equal(verifiedStatus.revisionReconciliation.status, "verified");
  const completed = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.equal(completed.revisionTasks[0].status, "completed", "exact successful Run and current Host revision/hash evidence complete the review");
  assert.equal(completed.snapshot.semesterPlan.status, "draft", "finishing revisions must never approve the new plan");

  refuseNextWorkflowStart = true;
  const failed = await workspace.POST(request("/api/course-builder", { ...revisionRequest, requestId: "revision-failed", expectedRevision: 2, note: "Add a worked example." }));
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /Native Workflow start refused by fixture/);
  const afterFailure = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.equal(afterFailure.revisionTasks.at(-1).status, "failed");
  assert.equal(afterFailure.snapshot.semesterPlan.status, "changes-requested", "failed dispatch preserves the teacher's recorded instructions");

  const taskInput = { sessionId: sid, action: "lesson_task", task: "plan", week: 2, session: 1, additionalRequirements: "Use the extra questions and a geometric example." };
  const notApproved = await workspace.POST(request("/api/course-builder", taskInput));
  assert.equal(notApproved.status, 400);
  assert.match((await notApproved.json()).error, /genuine teacher approval/);
  host.reviewSemesterPlan(sid, draft.semesterPlanId, revisedSemester.revision, "approve", "Offline fixture approval");
  const beforeLessonRun = runCount();
  await assertOK(await workspace.POST(request("/api/course-builder", taskInput)));
  assert.equal(runCount(), beforeLessonRun + 1, "lesson planning starts a native Workflow instead of a legacy prompt loop");
  const lessonTask = [...globalThis.__piCourseWorkflowTasks.values()].map((item) => item.record).find((record) => record.productAction === "course-lesson-plan");
  assert.ok(lessonTask);
  assert.deepEqual(lessonTask.target, { week: 2, session: 1 });
  assert.match(lessonTask.task, /Use the extra questions and a geometric example/);

  const originalSend = live.send;
  live.send = async (command) => {
    assert.deepEqual(command, { type: "prompt", message: "Only my freeform request" });
    return { accepted: true };
  };
  await assertOK(await workspace.POST(request("/api/course-builder", { sessionId: sid, action: "prompt", message: "Only my freeform request" })));
  const noLesson = await workspace.POST(request("/api/course-builder", { ...taskInput, task: "beamer" }));
  assert.equal(noLesson.status, 400);
  assert.match((await noLesson.json()).error, /单课计划/);
  const lesson = host.saveLessonPlan(sid, { week: 2, session: 1, title: "Week 2", objectives: ["Explain"], prerequisites: [], misconceptions: [], segments: [{ minutes: 15, title: "Practice", teacherAction: "Ask", learnerAction: "Explain", checkForUnderstanding: "Reason" }], examples: [], exercises: [], materialIds: [], visualRequests: [], notes: [] }, 0, revisedSemester.revision);
  host.reviewLessonPlan(sid, lesson.lessonPlanId, 1, "approve", "Offline fixture approval");
  live.send = async () => { throw new Error("Selected native Workflow tasks must not use legacy Pi prompt admission"); };
  const beforeBeamerRun = runCount();
  const beamerResponse = await assertOK(await workspace.POST(request("/api/course-builder", { ...taskInput, task: "beamer" })));
  assert.equal(beamerResponse.queued, true);
  assert.equal(runCount(), beforeBeamerRun + 1);
  const beamerTask = [...globalThis.__piCourseWorkflowTasks.values()].map((item) => item.record).find((record) => record.productAction === "course-beamer-deck");
  assert.ok(beamerTask);
  assert.deepEqual(beamerTask.target, { lessonId: lesson.lessonPlanId });

  const assignment = host.createAssignment(sid, { title: "Separate assignment", brief: "Work with the assignment's own evidence" });
  const assignmentDraft = { overview: "Assignment fixture", tasks: ["Explain a method"], deliverables: ["Short explanation"], rubric: ["Correct reasoning"], solutionNotes: ["Teacher-only guidance"], materialIds: [] };
  const assignmentSaved = host.saveAssignmentDraft(sid, assignment.assignmentId, assignmentDraft, assignment.revision);
  const assignmentRevisionRequest = { sessionId: sid, action: "review_assignment", id: assignment.assignmentId, expectedRevision: assignmentSaved.revision, decision: "request-changes", note: "Clarify the rubric.", requestId: "assignment-revision" };
  const beforeAssignmentRun = runCount();
  const assignmentResponse = await assertOK(await workspace.POST(request("/api/course-builder", assignmentRevisionRequest)));
  assert.equal(assignmentResponse.revisionTask.status, "sent");
  assert.equal(runCount(), beforeAssignmentRun + 1);
  const assignmentWorkflowTask = globalThis.__piCourseWorkflowTasks.get(assignmentResponse.revisionTask.workflowTaskId).record;
  assert.equal(assignmentWorkflowTask.productAction, "course-assignment-plan");
  assert.deepEqual(assignmentWorkflowTask.target, { assignmentId: assignment.assignmentId }, "native Workflow intent binds the exact Assignment instead of a mutable ambient agent scope");
  const reviewedAssignmentRevision = host.getAssignment(sid, assignment.assignmentId).revision;
  const assignmentRetry = await assertOK(await workspace.POST(request("/api/course-builder", assignmentRevisionRequest)));
  assert.equal(host.getAssignment(sid, assignment.assignmentId).revision, reviewedAssignmentRevision, "retry sends the saved review without reviewing the assignment twice");
  assert.equal(assignmentRetry.revisionTask.workflowTaskId, assignmentResponse.revisionTask.workflowTaskId);
  assert.equal(runCount(), beforeAssignmentRun + 1, "the same review request does not dispatch a second native Run");
  host.saveAssignmentDraft(sid, assignment.assignmentId, { ...assignmentDraft, rubric: ["Clearly justify each step"] }, reviewedAssignmentRevision);
  assert.equal((await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)).then(assertOK)).revisionTasks.at(-1).status, "sent", "Assignment saves also wait for delivery verification");
  live.send = originalSend;
  await live.shutdown();
  const afterRestart = await assertOK(await workspace.GET(request(`/api/course-builder?sessionId=${sid}`)));
  assert.deepEqual(afterRestart.revisionTasks.map((task) => task.status), ["completed", "failed", "sent"], "verified and unfinished native workflow revision records survive runtime shutdown");

  const { lessonReviewDraft } = await jiti.import("./lesson-review.ts");
  const editInput = { sessionId: sid, action: "edit_lesson", id: lesson.lessonPlanId, expectedRevision: 1, parentRevision: revisedSemester.revision, draft: { ...lessonReviewDraft(lesson), title: "Edited by the teacher without an Agent" } };
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
