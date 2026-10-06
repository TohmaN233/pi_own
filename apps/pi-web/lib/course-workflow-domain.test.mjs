import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CourseBuilderHost, runBoundedProcess } from "../../../packages/course-builder-host/src/index.ts";
import { createDefaultCourseBuilderProject } from "./course-builder-defaults.ts";
import { createCourseWorkflowDomain, courseWorkflowToolContracts, courseWorkflowAuthorSchema } from "./course-workflow-domain.ts";
import { COURSE_PRODUCTION_BRANCHES, COURSE_PRODUCTION_ROUTE_SCHEMA } from "./course-production-policy.ts";
import { describeCourseBuilderLocalFile } from "./course-builder-local-materials.ts";
import { validateDataSchema } from "pi-caw/core/workflow-data-schema.mjs";
import { HostToolRunner, validateHostToolContract } from "pi-caw/core/execution/host-tool-runner.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const draft = { title: "Monte Carlo variance reduction", objectives: ["Explain an unbiased estimator"], prerequisites: ["Sample means"], misconceptions: [], segments: [{ minutes: 50, title: "Estimate then compare", teacherAction: "Explain and simulate", learnerAction: "Compare estimator variance", checkForUnderstanding: "Explain unbiasedness" }], examples: ["Control variates"], exercises: ["Antithetic pair"], visualRequests: [], notes: ["Pending teacher review"] };
const tex = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{Monte Carlo}Compare unbiased estimators and variance.\end{frame}
\end{document}`;
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-course-workflow-")), directory = join(cwd, "task"); await mkdir(directory);
  const dbPath = join(cwd, "fixture.sqlite"), db = new DatabaseSync(dbPath), host = new CourseBuilderHost(db);
  const project = host.createProject({ ...createDefaultCourseBuilderProject(), courseId: "workflow-test", weeks: 5, sessionsPerWeek: 2, language: "English" }); host.bindSession("teacher", project.projectId);
  const materials = host.importMaterials("teacher", ["selected", "unrelated"].map(name => ({ name: `${name}.txt`, kind: "text", sourceBytes: Buffer.from(name), extractedText: name === "selected" ? "Control variates reduce estimator variance." : "Unrelated source must not leak" })), 1);
  const semester = host.saveSemesterPlan("teacher", { title: "Semester", rationale: "Course fixture", sessions: Array.from({ length: 10 }, (_, index) => ({ week: Math.floor(index / 2) + 1, session: index % 2 + 1, title: `Session ${index + 1}`, objectives: ["Explain core concept"], prerequisites: [], topics: ["Monte Carlo"], materialIds: [materials[0].materialId], activities: ["Compare"], understandingEvidence: ["Explain"], assessment: null, homework: null, courseGoalsCovered: project.goals, revisits: [], visualOpportunities: [] })) }, 0);
  host.reviewSemesterPlan("teacher", semester.semesterPlanId, 1, "approve", "Teacher fixture approval");
  const options = { sessionId: "teacher", taskId: "task-fixture", cwd, taskDirectory: directory, target: { week: 5, session: 2 }, materialIds: [materials[0].materialId], storagePaths: [dbPath, `${dbPath}-wal`, `${dbPath}-shm`], getHost: () => host, trustedExecution: true, compiler: process.env.PI_TEST_XELATEX_PATH, rscript: process.env.PI_TEST_RSCRIPT };
  const domain = createCourseWorkflowDomain(options);
  // Trusted fixture qualification is external to the pinned implementation,
  // just as production supplies private storage through its session wrapper.
  for (const [id, tool] of Object.entries(domain.registry)) {
    tool.attestation = { ...tool.attestation, storage_capabilities: { write_files: id === "course_task_context" ? [] : options.storagePaths.map(path => resolve(path)),
      write_directories: [resolve(cwd, ".pi", "course-workflow-host", options.taskId)] } };
  }
  let attempt = 0;
  const invoke = (id, input, extra = {}) => domain.registry[id].execute({ input: { taskId: options.taskId, ...input }, context: { run_id: "fixture-run", node_id: id, attempt_id: `attempt-${++attempt}`, workspace: directory }, ...extra });
  return { cwd, directory, db, host, project, materials, options, domain, invoke, close: async () => { db.close(); assert.ok(resolve(cwd).startsWith(resolve(tmpdir()))); await rm(cwd, { recursive: true, force: true }); } };
}
async function source(f, name, value) { const path = join(f.directory, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); return { path, sha256: hash(value), bytes: Buffer.byteLength(value) }; }

test("master contracts expose one private scalar router and frameOutline uses the direct commit bound", () => {
  const contracts = courseWorkflowToolContracts(); contracts.forEach(validateHostToolContract);
  const route = contracts.find(item=>item.id === "course_task_route");
  assert.deepEqual(route.input_schema.required,["taskId"]); assert.deepEqual(Object.keys(route.input_schema.properties),["taskId"]);
  assert.deepEqual(route.output_schema,COURSE_PRODUCTION_ROUTE_SCHEMA); assert.equal(COURSE_PRODUCTION_BRANCHES.length,22);
  assert.equal(new Set(COURSE_PRODUCTION_BRANCHES).size,22); assert.equal(route.idempotency.mode,"safe");
  const frame = courseWorkflowAuthorSchema("deck").properties.frameOutline;
  assert.deepEqual(frame,contracts.find(item=>item.id === "course_artifact_commit").input_schema.properties.frameOutline);
  assert.equal(frame.maxItems,100); assert.equal(frame.items.maxLength,4096);
});

test("master route uses the prepared product baseline and rejects attempts to choose another branch", async () => {
  const f = await fixture(); try {
    const production = {action:"course-lesson-plan",operation:"new"};
    const options = {...f.options,kind:"lesson",production}, domain = createCourseWorkflowDomain(options);
    production.bindingSha256 = domain.contextBinding().sha256;
    const invoke = (input={taskId:options.taskId})=>domain.registry.course_task_route.execute({input,context:{run_id:"fixture-route",node_id:"route",attempt_id:`route-${Math.random()}`,workspace:f.directory}});
    const routed = await invoke(); assert.equal(routed.exit_code,0,routed.diagnostic);
    assert.deepEqual(routed.output,{action:"course-lesson-plan",product:"lesson",operation:"new",branch:"lesson:new",kind:"lesson"});
    assert.throws(()=>invoke({taskId:options.taskId,branch:"deck:revise"}),{code:"ROUTE_INPUT_SCOPE"});
    f.host.saveLessonPlan("teacher",{week:5,session:2,...draft,materialIds:[f.materials[0].materialId]},0,f.host.getSnapshotForSession("teacher").semesterPlan.revision);
    const stale = await invoke(); assert.equal(stale.exit_code,1); assert.match(stale.diagnostic,/PRODUCTION_OPERATION_MISMATCH|PRODUCTION_BASELINE_CHANGED/);
    const revised = {action:"course-lesson-plan",operation:"revise"}, next = createCourseWorkflowDomain({...f.options,kind:"lesson",production:revised});
    revised.bindingSha256 = next.contextBinding().sha256;
    const result=await next.registry.course_task_route.execute({input:{taskId:f.options.taskId},context:{run_id:"fixture-revise",node_id:"route",attempt_id:"revise",workspace:f.directory}});
    assert.equal(result.exit_code,0,result.diagnostic); assert.equal(result.output.branch,"lesson:revise");
  } finally { await f.close(); }
});

test("master repair can freeze a successful commit even when compilation has not succeeded", async () => {
  const f = await fixture(); try {
    const context=(await f.invoke("course_task_context",{})).output;
    const file=await source(f,"sources/saved.Rmd","# Saved source\n\nRepair the compile configuration.\n");
    const committed=await f.invoke("course_artifact_commit",{requestId:"saved-before-compile",bindingSha256:context.bindingSha256,kind:"experiment",format:"rmd",source:file});
    assert.equal(committed.exit_code,0,committed.diagnostic);
    const receipt=await f.domain.committedReceipt("saved-before-compile"); assert.deepEqual(receipt.files,committed.output.files);
    const production={action:"course-rmd-lab",operation:"revise"}, options={...f.options,taskId:"repair-task",taskDirectory:join(f.cwd,"repair"),target:{course:true},kind:"rmd",production,repairBaselineFiles:[{path:file.path,format:"rmd"}]};
    await mkdir(options.taskDirectory); const repair=createCourseWorkflowDomain(options); production.bindingSha256=repair.contextBinding().sha256;
    const route=await repair.registry.course_task_route.execute({input:{taskId:options.taskId},context:{run_id:"repair",node_id:"route",attempt_id:"route",workspace:options.taskDirectory}});
    assert.equal(route.exit_code,0,route.diagnostic); assert.equal(route.output.branch,"rmd:revise");
    await writeFile(file.path,"Changed after the exact saved receipt");
    const changed=await repair.registry.course_task_route.execute({input:{taskId:options.taskId},context:{run_id:"repair",node_id:"route",attempt_id:"changed",workspace:options.taskDirectory}});
    assert.equal(changed.exit_code,1); assert.match(changed.diagnostic,/OUTPUT_CAS_CONFLICT/);
  } finally {await f.close();}
});
function assetPng() {
  const chunk = (name, data) => {
    const payload = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

test("contracts qualify against the actual Host runner and context isolates W5S2/explicit references", async () => {
  const f = await fixture(); try {
    const contracts = courseWorkflowToolContracts(); contracts.forEach(validateHostToolContract);
    for (const [id, tool] of Object.entries(f.domain.registry)) {
      assert.deepEqual(tool.attestation.storage_capabilities, { write_files: id === "course_task_context" ? [] : f.options.storagePaths.map(path => resolve(path)),
        write_directories: [resolve(f.cwd, ".pi", "course-workflow-host", f.options.taskId)] });
      assert.equal(Object.hasOwn(tool.contract ?? contracts.find(contract => contract.id === id), "storage_capabilities"), false, "private Host storage is not a public/model write grant");
    }
    const commitSchema = contracts.find(item => item.id === "course_artifact_commit").output_schema;
    assert.deepEqual(commitSchema.properties.source, contracts.find(item => item.id === "course_artifact_compile").input_schema.properties.source);
    assert.deepEqual(commitSchema.properties.artifact.required, ["deckId", "revision", "sourceHash"]);
    assert.ok(commitSchema.required.includes("files"));
    for (const optionalBranchField of ["source", "artifact"]) assert.ok(!commitSchema.required.includes(optionalBranchField));
    const context = { run_id: "run", node_id: "context", attempt_id: "first", workspace: f.directory, permissions: { access: "bounded_write", allowed_paths: ["."] } };
    const result = await new HostToolRunner({ registry: f.domain.registry }).execute(contracts[0], { taskId: "task-fixture" }, context);
    assert.equal(result.receipt.status, "succeeded", JSON.stringify(result.receipt));
    assert.equal(result.output.bindingSha256, result.output.binding.sha256);
    assert.equal(result.output.context.semester.session.week, 5); assert.equal(result.output.context.semester.session.session, 2);
    assert.equal(result.output.context.materials.length, 1); assert.match(result.output.context.materials[0].text, /Control variates/);
    assert.doesNotMatch(JSON.stringify(result.output), /Unrelated source|unrelated.txt/); assert.equal(result.output.context.semester.sessions, undefined);
    assert.throws(() => f.invoke("course_task_context", { taskId: "foreign-task" }), { code: "TASK_ID_MISMATCH" });
  } finally { await f.close(); }
});

test("bundle creates one draft, records observed SQLite effects, replays durable outcome and never self-approves", async () => {
  const f = await fixture(); try {
    const ctx = (await f.invoke("course_task_context", {})).output;
    const files = [{ format: "tex", source: await source(f, "lesson.tex", tex), expectedPages: 1 }, { format: "rmd", source: await source(f, "lesson.Rmd", "# Test\n\n```{r}\nstopifnot(mean(c(1,3)) == 2)\nmean(c(1,3))\n```\n"), outputMode: "knit" }];
    const input = { requestId: "bundle", bindingSha256: ctx.binding.sha256, kind: "bundle", lessonDraft: draft, files };
    const saved = await f.invoke("course_artifact_commit", input); assert.equal(saved.exit_code, 0, saved.diagnostic);
    assert.equal(saved.output.bindingSha256, saved.output.binding.sha256);
    assert.equal(saved.output.lesson.week, 5); assert.equal(saved.output.lesson.session, 2); assert.equal(saved.output.lesson.status, "draft"); assert.equal(saved.output.lesson.review, null);
    assert.equal(f.host.getSnapshotForSession("teacher").decks.length, 0);
    assert.ok(saved.effects.outside_paths.includes(join(f.cwd, "fixture.sqlite")) || saved.effects.outside_paths.some(path => path.endsWith("-wal")));
    const replay = await createCourseWorkflowDomain(f.options).registry.course_artifact_commit.execute({ input: { taskId: "task-fixture", ...input }, context: { run_id: "fixture-run", node_id: "replay", attempt_id: "replay", workspace: f.directory } });
    assert.deepEqual(replay.output, saved.output); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans[0].revision, 1);
    const forbidden = await f.invoke("course_artifact_commit", { requestId: "not-approved", bindingSha256: saved.output.binding.sha256, kind: "deck", source: files[0].source, title: "Deck", frameOutline: ["Monte Carlo"] });
    assert.equal(forbidden.exit_code, 1); assert.match(forbidden.diagnostic, /LESSON_APPROVAL_REQUIRED/);
    const retryDifferent = await f.invoke("course_artifact_commit", { ...input, lessonDraft: { ...draft, title: "Different" } }); assert.match(retryDifferent.diagnostic, /REQUEST_ID_CONFLICT/);
  } finally { await f.close(); }
});

test("new semantic paths receive Host hashes and durable replay preserves the captured byte identity", async () => {
  const f = await fixture(); try {
    const ctx = (await f.invoke("course_task_context", {})).output;
    const texRef = await source(f, "sources/new-lesson.tex", tex), rmdRef = await source(f, "sources/new-lesson.Rmd", "# Semantic source\n");
    const input = { taskId: "task-fixture", requestId: "semantic-paths", bindingSha256: ctx.bindingSha256, kind: "bundle", lessonDraft: draft, files: [{ format: "tex", path: "sources/new-lesson.tex", documentKind: "beamer", expectedPages: 1 }, { format: "rmd", path: "sources/new-lesson.Rmd", outputMode: "knit" }] };
    const runner = new HostToolRunner({ registry: f.domain.registry });
    const saved = await runner.execute(f.domain.contracts.find(item => item.id === "course_artifact_commit"), input, { run_id: "semantic", node_id: "commit", attempt_id: "first", workspace: f.directory, permissions: { access: "bounded_write", allowed_paths: ["."] } });
    assert.equal(saved.receipt.status, "succeeded", JSON.stringify(saved.receipt));
    assert.equal(saved.output.bindingSha256, saved.output.binding.sha256);
    assert.deepEqual(saved.output.files, [{ format: "tex", documentKind: "beamer", expectedPages: 1, source: texRef }, { format: "rmd", outputMode: "knit", source: rmdRef }]);
    assert.equal(saved.output.lesson.status, "draft"); assert.equal(saved.output.lesson.review, null); assert.equal(saved.output.files[0].path, undefined);
    await writeFile(texRef.path, `${tex}\nChanged after commit`);
    const replay = await f.invoke("course_artifact_commit", input); assert.deepEqual(replay.output, saved.output); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans[0].revision, 1);
    const journalPath = join(f.cwd, ".pi", "course-workflow-host", "task-fixture", "request-semantic-paths.json"), legacyJournal = JSON.parse(await readFile(journalPath, "utf8")); delete legacyJournal.output.bindingSha256; await writeFile(journalPath, JSON.stringify(legacyJournal));
    const legacyReplay = await f.invoke("course_artifact_commit", input); assert.deepEqual(legacyReplay.output, saved.output); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans[0].revision, 1);
    legacyJournal.output.bindingSha256 = "0".repeat(64); await writeFile(journalPath, JSON.stringify(legacyJournal));
    const conflictingReplay = await f.invoke("course_artifact_commit", input); assert.equal(conflictingReplay.exit_code, 1); assert.match(conflictingReplay.diagnostic, /BINDING_OUTPUT_MISMATCH/); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans[0].revision, 1);
    const changed = await f.invoke("course_artifact_compile", { requestId: "changed-capture", bindingSha256: saved.output.bindingSha256, files: saved.output.files }); assert.equal(changed.exit_code, 1); assert.match(changed.diagnostic, /SOURCE_HASH_MISMATCH/);
    await assert.rejects(runner.execute(f.domain.contracts.find(item => item.id === "course_artifact_compile"), { taskId: "task-fixture", requestId: "path-only-compile", bindingSha256: saved.output.binding.sha256, files: input.files }, { run_id: "semantic", node_id: "compile", attempt_id: "path-only", workspace: f.directory, permissions: { access: "bounded_write", allowed_paths: ["."] } }), { code: "DATA_INVALID" });
  } finally { await f.close(); }
});

test("new path scope, ambiguous references, regular-file limits and formats fail before saving a lesson", async () => {
  const f = await fixture(); try {
    const ctx = (await f.invoke("course_task_context", {})).output;
    const ref = await source(f, "sources/new-lesson.tex", tex); await source(f, "current-context.tex", tex); await source(f, "sources/oversized.tex", "x".repeat(2097153));
    const cases = [
      [{ format: "tex", path: "sources/new-lesson.tex", source: ref }, "FILE_REFERENCE_AMBIGUOUS"],
      [{ format: "tex" }, "FILE_REFERENCE_AMBIGUOUS"],
      [{ format: "tex", path: "current-context.tex" }, "SOURCE_PATH_SCOPE"],
      [{ format: "tex", path: "sources/../current-context.tex" }, "SOURCE_PATH_SCOPE"],
      [{ format: "tex", path: ref.path }, "SOURCE_PATH_SCOPE"],
      [{ format: "tex", path: "sources" }, "SOURCE_PATH_SCOPE"],
      [{ format: "tex", path: "sources/oversized.tex" }, "SOURCE_LIMIT"],
      [{ format: "rmd", path: "sources/new-lesson.tex" }, "ARTIFACT_FORMAT_MISMATCH"],
    ];
    for (let index = 0; index < cases.length; index++) {
      const [file, expected] = cases[index], result = await f.invoke("course_artifact_commit", { requestId: `invalid-new-path-${index}`, bindingSha256: ctx.binding.sha256, kind: "bundle", lessonDraft: draft, files: [file] });
      assert.equal(result.exit_code, 1); assert.ok(result.diagnostic.startsWith(`${expected}:`), result.diagnostic); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans.length, 0);
    }
  } finally { await f.close(); }
});

test("single experimental artifact captures a semantic path with the same source-bound contract", async () => {
  const f = await fixture(); try {
    const binding = f.domain.contextBinding(), ref = await source(f, "sources/single.Rmd", '# Experiment only\n\n```{r}\nstopifnot(mean(c(1,3)) == 2)\ncat("INDEPENDENT_RMD_CHUNK_OK")\n```\n');
    const input = { requestId: "single-experiment", bindingSha256: binding.sha256, kind: "experiment", format: "rmd", path: "sources/single.Rmd" };
    const result = await new HostToolRunner({ registry: f.domain.registry }).execute(f.domain.contracts.find(item => item.id === "course_artifact_commit"), { taskId: "task-fixture", ...input }, { run_id: "experiment", node_id: "commit", attempt_id: "first", workspace: f.directory, permissions: { access: "bounded_write", allowed_paths: ["."] } });
    assert.equal(result.receipt.status, "succeeded", JSON.stringify(result.receipt)); assert.deepEqual(result.output.source, ref); assert.equal(result.output.teacherReviewPending, true); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans.length, 0);
    assert.equal(result.output.bindingSha256, result.output.binding.sha256);
    const ambiguous = await f.invoke("course_artifact_commit", { ...input, requestId: "single-ambiguous", source: ref }); assert.equal(ambiguous.exit_code, 1); assert.match(ambiguous.diagnostic, /FILE_REFERENCE_AMBIGUOUS/);
    const outOfScope = await f.invoke("course_artifact_commit", { ...input, requestId: "single-out-of-scope", path: "current-context.Rmd" }); assert.match(outOfScope.diagnostic, /SOURCE_PATH_SCOPE/);
    if (process.env.PI_TEST_RSCRIPT) {
      const compiled = await new HostToolRunner({ registry: f.domain.registry }).execute(f.domain.contracts.find(item => item.id === "course_artifact_compile"), { taskId: "task-fixture", requestId: "single-knit", bindingSha256: result.output.bindingSha256, source: result.output.source, format: "rmd", outputMode: "knit" }, { run_id: "experiment", node_id: "compile", attempt_id: "first", workspace: f.directory, permissions: { access: "bounded_write", allowed_paths: ["."] } });
      assert.equal(compiled.receipt.status, "succeeded", JSON.stringify(compiled.receipt)); assert.equal(compiled.output.succeeded, true, JSON.stringify(compiled.output));
      assert.match(await readFile(compiled.output.artifacts[0].output.path, "utf8"), /INDEPENDENT_RMD_CHUNK_OK/);
      assert.equal(compiled.output.artifacts[0].domainReceipt, null); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans.length, 0);
    }
  } finally { await f.close(); }
});

test("CAS, source mismatch, authority revocation and teacher-owned fields fail without partial lesson save", async () => {
  const f = await fixture(); try {
    const ctx = (await f.invoke("course_task_context", {})).output;
    const ref = await source(f, "lesson.tex", tex); await writeFile(ref.path, `${tex}\nchanged`);
    const badSource = await f.invoke("course_artifact_commit", { requestId: "changed", bindingSha256: ctx.binding.sha256, kind: "bundle", lessonDraft: draft, files: [{ format: "tex", source: ref }] });
    assert.match(badSource.diagnostic, /SOURCE_HASH_MISMATCH/); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans.length, 0);
    const approval = await f.invoke("course_artifact_commit", { requestId: "approval", bindingSha256: ctx.binding.sha256, kind: "lesson", draft: { ...draft, status: "approved" } }); assert.match(approval.diagnostic, /HOST_OWNED_FIELDS/);
    let admitted = 0;
    const revoked = await f.invoke("course_artifact_commit", { requestId: "revoked", bindingSha256: ctx.binding.sha256, kind: "lesson", draft }, { authorize: () => { if (++admitted > 1) throw Object.assign(new Error("Owner revoked"), { code: "OWNER_REVOKED" }); } });
    assert.match(revoked.diagnostic, /OWNER_REVOKED/); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans.length, 0);
    const saved = await f.invoke("course_artifact_commit", { requestId: "first", bindingSha256: ctx.binding.sha256, kind: "lesson", draft }); assert.equal(saved.exit_code, 0);
    assert.equal(saved.output.bindingSha256, saved.output.binding.sha256);
    const stale = await f.invoke("course_artifact_commit", { requestId: "stale", bindingSha256: ctx.binding.sha256, kind: "lesson", draft }); assert.match(stale.diagnostic, /CAS_CONFLICT/); assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans[0].revision, 1);
    const unknown = await f.invoke("course_artifact_commit", { requestId: "revoked", bindingSha256: ctx.binding.sha256, kind: "lesson", draft }); assert.match(unknown.diagnostic, /RECONCILE_REQUIRED/);
  } finally { await f.close(); }
});

test("cancellation waits for process-tree close before the operation is quiescent", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-course-process-"));
  try {
    const marker = join(dir, "pid.txt"), childMarker = join(dir, "child-pid.txt"), runner = join(dir, "wait.cjs");
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(childMarker)},String(process.pid));setInterval(()=>{},1000);`;
    await writeFile(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const operation = runBoundedProcess({ command: process.execPath, args: [runner], cwd: dir, timeoutMs: 10000, maxOutputBytes: 65536, signal: controller.signal });
    for (let i = 0; i < 100; i++) { try { await access(childMarker); break; } catch { await new Promise(done => setTimeout(done, 20)); } }
    const pid = Number(await readFile(marker, "utf8")), childPid = Number(await readFile(childMarker, "utf8")); controller.abort(new Error("Fixture cancellation"));
    await assert.rejects(operation, /Fixture cancellation/); assert.throws(() => process.kill(pid, 0)); assert.throws(() => process.kill(childPid, 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("existing approved lesson/deck identity, outline and assets survive an exact-source update", async () => {
  const f = await fixture(); try {
    const assetBytes = assetPng(), asset = f.host.importMaterials("teacher", [{ name: "original.png", kind: "asset", sourceBytes: assetBytes, extractedText: "" }], f.host.getSnapshotForSession("teacher").project.revision)[0];
    const lesson = f.host.saveLessonPlan("teacher", { ...draft, week: 5, session: 2, materialIds: [f.materials[0].materialId] }, 0, 1);
    f.host.reviewLessonPlan("teacher", lesson.lessonPlanId, 1, "approve", "Actual teacher fixture review");
    const originalSource = tex.replace("variance.", String.raw`variance.\includegraphics[width=1cm]{assets/${asset.materialId}.png}`);
    const deck = f.host.saveBeamerDeck("teacher", { lessonPlanId: lesson.lessonPlanId, title: "Original", source: originalSource, frameOutline: ["Monte Carlo"], assetMaterialIds: [asset.materialId] }, 0, 1);
    const domain = createCourseWorkflowDomain({ ...f.options, target: { lessonId: lesson.lessonPlanId }, materialIds: [] }), runner = new HostToolRunner({ registry: domain.registry });
    const context = node => ({ run_id: "fixture", node_id: node, attempt_id: node, workspace: f.directory, permissions: { access: "bounded_write", allowed_paths: ["."] } });
    const frozen = await runner.execute(domain.contracts.find(item => item.id === "course_task_context"), { taskId: "task-fixture" }, context("context"));
    assert.equal(frozen.receipt.status, "succeeded", JSON.stringify(frozen.receipt)); assert.deepEqual(frozen.output.context.materials, []);
    const artifactContext = frozen.output.context.currentArtifact;
    assert.equal(artifactContext.workspacePath, `current-${deck.deckId}-1.tex`);
    assert.equal(resolve(f.directory, artifactContext.workspacePath), artifactContext.source.path);
    assert.equal(await readFile(join(f.directory, artifactContext.workspacePath), "utf8"), originalSource);
    assert.deepEqual(frozen.output.context.currentArtifact.assetMaterialIds, [asset.materialId]);
    const replacement = await source(f, "sources/revised.tex", originalSource.replace("Compare unbiased estimators", "Predict unbiased estimators"));
    const result = await runner.execute(domain.contracts.find(item => item.id === "course_artifact_commit"), { taskId: "task-fixture", requestId: "deck-update", bindingSha256: frozen.output.bindingSha256, kind: "deck", path: "sources/revised.tex" }, context("commit"));
    assert.equal(result.receipt.status, "succeeded", JSON.stringify(result.receipt)); const updated = f.host.getSnapshotForSession("teacher").decks[0];
    assert.equal(result.output.bindingSha256, result.output.binding.sha256);
    assert.equal(updated.deckId, deck.deckId); assert.equal(updated.revision, 2); assert.equal(updated.title, deck.title); assert.deepEqual(updated.frameOutline, deck.frameOutline); assert.deepEqual(updated.assetMaterialIds, deck.assetMaterialIds);
    assert.deepEqual(result.output.source, replacement); assert.equal(deck.source, originalSource);
    assert.deepEqual(result.output.artifact, { deckId: updated.deckId, revision: 2, sourceHash: updated.sourceHash });
    assert.deepEqual(f.host.getDeckForCompile("teacher", deck.deckId).assets[0].bytes, new Uint8Array(assetBytes));
    const ambiguous = await domain.registry.course_artifact_commit.execute({ input: { taskId: "task-fixture", requestId: "deck-ambiguous", bindingSha256: result.output.binding.sha256, kind: "deck", path: "sources/revised.tex", source: replacement }, context: context("ambiguous") }); assert.match(ambiguous.diagnostic, /FILE_REFERENCE_AMBIGUOUS/); assert.equal(f.host.getSnapshotForSession("teacher").decks[0].revision, 2);
    const wrongFormat = await domain.registry.course_artifact_commit.execute({ input: { taskId: "task-fixture", requestId: "deck-wrong-format", bindingSha256: result.output.binding.sha256, kind: "deck", path: "sources/revised.tex", format: "rmd" }, context: context("wrong-format") }); assert.match(wrongFormat.diagnostic, /ARTIFACT_FORMAT_MISMATCH/); assert.equal(f.host.getSnapshotForSession("teacher").decks[0].revision, 2);
    if (process.env.PI_TEST_XELATEX_PATH) {
      const compiled = await runner.execute(domain.contracts.find(item => item.id === "course_artifact_compile"), { taskId: "task-fixture", requestId: "deck-compile", bindingSha256: result.output.bindingSha256, source: result.output.source, format: "tex", documentKind: "beamer", expectedPages: 1 }, context("compile"));
      assert.equal(compiled.receipt.status, "succeeded", JSON.stringify(compiled.receipt)); assert.equal(compiled.output.succeeded, true, JSON.stringify(compiled.output));
      assert.equal(compiled.output.bindingSha256, compiled.output.binding.sha256);
      const receipt = compiled.output.artifacts[0].domainReceipt; assert.equal(receipt.deckId, deck.deckId); assert.equal(receipt.deckRevision, 2); assert.equal(receipt.sourceHash, updated.sourceHash);
      assert.equal(f.host.getSnapshotForSession("teacher").compileReceipts.length, 1);
      assert.equal(hash(await readFile(compiled.output.artifacts[0].output.path)), compiled.output.artifacts[0].output.sha256);
    }
  } finally { await f.close(); }
});

test("real Rmd cancellation returns quiescent evidence and observed partial effects", { skip: !process.env.PI_TEST_RSCRIPT, timeout: 30000 }, async () => {
  const f = await fixture(); try {
    const ctx = (await f.invoke("course_task_context", {})).output;
    const ref = await source(f, "cancel.Rmd", '# Pending\n\n```{r}\nwriteLines(as.character(Sys.getpid()), "running.pid")\nSys.sleep(60)\n```\n');
    const contracts = f.domain.contracts, contract = contracts.find(item => item.id === "course_artifact_compile"), controller = new AbortController();
    const operation = new HostToolRunner({ registry: f.domain.registry }).execute(contract, { taskId: "task-fixture", requestId: "cancel", bindingSha256: ctx.binding.sha256, files: [{ format: "rmd", source: ref }] }, { run_id: "fixture-cancel", node_id: "compile", attempt_id: "first", workspace: f.directory, permissions: { access: "bounded_write", allowed_paths: ["."] } }, { signal: controller.signal });
    const marker = join(f.directory, "running.pid");
    for (let index = 0; index < 500; index++) { try { await access(marker); break; } catch { await new Promise(done => setTimeout(done, 20)); } }
    const pid = Number((await readFile(marker, "utf8")).trim()); controller.abort(new Error("Fixture owner revoked"));
    const result = await operation; assert.equal(result.receipt.status, "cancelled"); assert.equal(result.receipt.reconciliation.termination_confirmed, true); assert.equal(result.output, null); assert.throws(() => process.kill(pid, 0));
    assert.ok(result.receipt.effects.changed_paths.includes("running.pid"));
    const ledger = JSON.parse(await readFile(join(f.cwd, ".pi", "course-workflow-host", "task-fixture", "request-cancel.json"), "utf8")); assert.equal(ledger.status, "started");
  } finally { await f.close(); }
});

test("real experimental W5S2 PDF and executed Rmd stay pending teacher review", { skip: !process.env.PI_TEST_RSCRIPT || !process.env.PI_TEST_XELATEX_PATH, timeout: 90000 }, async () => {
  const f = await fixture(); try {
    const ctx = (await f.invoke("course_task_context", {})).output;
    await source(f, "sources/lesson.tex", tex); await source(f, "sources/lesson.Rmd", "# Computed estimator\n\n```{r}\nset.seed(17)\nx <- rnorm(100)\nstopifnot(length(x)==100)\nmean(x)\n```\n");
    const files = [{ format: "tex", path: "sources/lesson.tex", expectedPages: 1 }, { format: "rmd", path: "sources/lesson.Rmd", outputMode: "knit" }];
    const saved = await f.invoke("course_artifact_commit", { requestId: "real-save", bindingSha256: ctx.bindingSha256, kind: "bundle", lessonDraft: draft, files }); assert.equal(saved.exit_code, 0, saved.diagnostic);
    const compiled = await f.invoke("course_artifact_compile", { requestId: "real-compile", bindingSha256: saved.output.bindingSha256, files: saved.output.files });
    assert.equal(compiled.exit_code, 0, compiled.diagnostic); assert.equal(compiled.output.succeeded, true, JSON.stringify(compiled.output));
    assert.equal(compiled.output.bindingSha256, compiled.output.binding.sha256);
    assert.equal(compiled.output.artifacts[0].pageCount, 1); assert.match(await readFile(compiled.output.artifacts[1].output.path, "utf8"), /Computed estimator/);
    for (const artifact of compiled.output.artifacts) assert.equal(hash(await readFile(artifact.output.path)), artifact.output.sha256);
    assert.equal(f.host.getSnapshotForSession("teacher").lessonPlans[0].status, "draft"); assert.equal(compiled.output.teacherReviewPending, true);
    const failed = await f.invoke("course_artifact_compile", { requestId: "wrong-pages", bindingSha256: saved.output.bindingSha256, files: [{ ...saved.output.files[0], expectedPages: 16 }] }); assert.equal(failed.output.succeeded, false); assert.equal(failed.output.bindingSha256, failed.output.binding.sha256); assert.match(failed.output.artifacts[0].diagnostic, /PDF_PAGE_COUNT_MISMATCH/);
  } finally { await f.close(); }
});
function scoped(f, overrides) {
  const options = { ...f.options, taskId: `scoped-${overrides.kind}`, ...overrides };
  const domain = createCourseWorkflowDomain(options); let attempt = 0;
  const invoke = (id, input, extra={}) => domain.registry[id].execute({input:{taskId:options.taskId,...input},context:{run_id:options.taskId,node_id:id,attempt_id:`attempt-${++attempt}`,workspace:f.directory},...extra});
  return {domain,invoke,options};
}
async function saveApprovedLesson(f) {
  const state=f.host.getSnapshotForSession("teacher");
  const lesson=f.host.saveLessonPlan("teacher",{...draft,week:5,session:2,materialIds:[f.materials[0].materialId]},0,state.semesterPlan.revision);
  return f.host.reviewLessonPlan("teacher",lesson.lessonPlanId,lesson.revision,"approve","Teacher approval");
}
const article=String.raw`\documentclass{article}
\begin{document}Explain unbiased estimators and the variance reduction demonstration.\end{document}`;
const html='<!DOCTYPE html><html><head><title>Variance Explorer</title></head><body><input type="range" id="n"><svg id="plot"><circle r="5"/></svg><script>document.querySelector("#n").oninput=event=>document.querySelector("circle").setAttribute("r",event.target.value);</script></body></html>';

test("closed author schemas cover every product without Host identities",()=>{
  for(const kind of ["analysis","checkpoint","semester","lesson","deck","teacher-notes","assignment-plan","assignment-artifacts","rmd","html","bundle"]) {
    const schema=courseWorkflowAuthorSchema(kind);validateDataSchema(schema);
    assert.equal(schema.additionalProperties,false);assert.ok(schema.required.includes("files"));
    assert.equal(schema.properties.files.items.additionalProperties,false);
    assert.equal(schema.properties.files.items.properties.source,undefined);
    assert.equal(schema.properties.draft?.properties.materialIds,undefined);
    const findIds=(value,path="")=>Object.entries(value.properties??{}).flatMap(([name,child])=>[...(name.endsWith("Id")||name.endsWith("Ids")?[`${path}.${name}`]:[]),...findIds(child,`${path}.${name}`)]).concat(value.items?findIds(value.items,`${path}[]`):[]);
    assert.deepEqual(findIds(schema),[],`Author schema ${kind} must contain no Host IDs at any depth`);
  }
});

test("semester target preserves omitted content, allocates slot identities and validates state-only commit",async()=>{
 const f=await fixture();try {
   const original=f.host.getSnapshotForSession("teacher").semesterPlan;
   f.host.saveSemesterPlan("teacher",{title:original.title,rationale:original.rationale,sessions:original.sessions.map((slot,index)=>({...slot,revisits:index===0?[{conceptId:"legacy-existing-concept",progression:"transfer",note:"Preserve the established revisit binding"}]:slot.revisits}))},original.revision);
   const task=scoped(f,{kind:"semester",target:{course:true}}),ctx=(await task.invoke("course_task_context",{})).output;
   assert.equal(ctx.context.lesson,null);assert.equal(ctx.context.semester.sessions.length,10);
   const before=f.host.getSnapshotForSession("teacher").semesterPlan;
   const saved=await task.invoke("course_artifact_commit",{requestId:"semester",bindingSha256:ctx.bindingSha256,kind:"semester",draft:{rationale:"Revise sequencing"},files:[]});
   assert.equal(saved.exit_code,0,saved.diagnostic);assert.equal(saved.output.product.title,before.title);assert.deepEqual(saved.output.product.sessions,before.sessions);
   assert.equal(saved.output.product.sessions[0].revisits[0].conceptId,"legacy-existing-concept");
   assert.equal(saved.output.product.status,"draft");assert.equal(saved.output.product.review,null);assert.deepEqual(saved.output.files,[]);
   const validated=await task.invoke("course_artifact_compile",{requestId:"validate",bindingSha256:saved.output.bindingSha256,files:[]});assert.equal(validated.output.succeeded,true);assert.deepEqual(validated.output.artifacts,[]);
   const uncommitted=scoped(f,{kind:"semester",target:{course:true},taskId:"uncommitted-semester"});
   const falseValidation=await uncommitted.invoke("course_artifact_compile",{requestId:"false",bindingSha256:uncommitted.domain.contextBinding().sha256,files:[]});assert.match(falseValidation.diagnostic,/COMMIT_RECEIPT_REQUIRED/);
   const lab=scoped(f,{kind:"rmd",target:{course:true}});await source(f,"sources/lab.Rmd","# Standalone lab\n");
   const labSaved=await lab.invoke("course_artifact_commit",{requestId:"lab",bindingSha256:lab.domain.contextBinding().sha256,kind:"rmd",files:[{format:"rmd",path:"sources/lab.Rmd"}]});assert.equal(labSaved.exit_code,0,labSaved.diagnostic);
 }finally{await f.close();}
});

test("lesson-only revision preserves fields, gate and Host identity without artifact copies",async()=>{
 const f=await fixture();try {
   const lesson=await saveApprovedLesson(f),task=scoped(f,{kind:"lesson",target:{lessonId:lesson.lessonPlanId}});
   const ctx=(await task.invoke("course_task_context",{})).output;
   const saved=await task.invoke("course_artifact_commit",{requestId:"lesson",bindingSha256:ctx.bindingSha256,kind:"lesson",draft:{notes:["New instructional cue"]},files:[]});
   assert.equal(saved.exit_code,0,saved.diagnostic);assert.equal(saved.output.lesson.lessonPlanId,lesson.lessonPlanId);assert.equal(saved.output.lesson.title,lesson.title);assert.deepEqual(saved.output.lesson.objectives,lesson.objectives);assert.equal(saved.output.lesson.status,"draft");assert.equal(saved.output.lesson.review,null);
   const compiled=await task.invoke("course_artifact_compile",{requestId:"validate",bindingSha256:saved.output.bindingSha256,files:saved.output.files});assert.equal(compiled.output.succeeded,true);
 }finally{await f.close();}
});

test("deck CAS ignores unrelated library additions and notes while target changes still conflict",async()=>{
 const f=await fixture();try {
   const lesson=await saveApprovedLesson(f),deck=f.host.saveBeamerDeck("teacher",{lessonPlanId:lesson.lessonPlanId,title:"Deck",source:tex,frameOutline:["Monte Carlo"],assetMaterialIds:[]},0,lesson.revision);
   const task=scoped(f,{kind:"deck",target:{lessonId:lesson.lessonPlanId},materialIds:[]}),ctx=(await task.invoke("course_task_context",{})).output;
   f.host.importMaterials("teacher",[{name:"another.txt",kind:"text",sourceBytes:Buffer.from("Other"),extractedText:"Other"}],f.host.getSnapshotForSession("teacher").project.revision);
   f.host.saveTeacherNotes("teacher",{deckId:deck.deckId,deckRevision:deck.revision,title:"Notes",source:article},0);
   assert.equal(task.domain.contextBinding().sha256,ctx.bindingSha256);
   await source(f,"sources/revised.tex",tex+'\n% corrected\n');
   const saved=await task.invoke("course_artifact_commit",{requestId:"revise",bindingSha256:ctx.bindingSha256,kind:"deck",files:[{format:"tex",path:"sources/revised.tex"}]});assert.equal(saved.exit_code,0,saved.diagnostic);assert.equal(saved.output.artifact.deckId,deck.deckId);
   const stale=await task.invoke("course_artifact_commit",{requestId:"stale",bindingSha256:ctx.bindingSha256,kind:"deck",files:[{format:"tex",path:"sources/revised.tex"}]});assert.match(stale.diagnostic,/CAS_CONFLICT/);
 }finally{await f.close();}
});

test("teacher notes save on a draft deck and revisions preserve identity plus native compiler options",async()=>{
 const f=await fixture();try {
   const lesson=await saveApprovedLesson(f),deck=f.host.saveBeamerDeck("teacher",{lessonPlanId:lesson.lessonPlanId,title:"Deck",source:tex,frameOutline:["Monte Carlo"],assetMaterialIds:[]},0,lesson.revision);
   assert.equal(deck.status,"draft");
   const task=scoped(f,{kind:"teacher-notes",target:{lessonId:lesson.lessonPlanId}});await source(f,"sources/notes.tex",article);
   const saved=await task.invoke("course_artifact_commit",{requestId:"notes",bindingSha256:task.domain.contextBinding().sha256,kind:"teacher-notes",files:[{format:"tex",path:"sources/notes.tex"}]});assert.equal(saved.exit_code,0,saved.diagnostic);assert.equal(saved.output.product.deckId,deck.deckId);assert.equal(saved.output.files[0].documentKind,"teacher-notes");
   const revised=await task.invoke("course_artifact_commit",{requestId:"notes-revision",bindingSha256:saved.output.bindingSha256,kind:"teacher-notes",files:[{format:"tex",path:"sources/notes.tex"}],title:"Edited script"});assert.equal(revised.output.product.notesId,saved.output.product.notesId);assert.equal(revised.output.product.revision,2);
   if(process.env.PI_TEST_XELATEX_PATH) {const compiled=await task.invoke("course_artifact_compile",{requestId:"notes-compile",bindingSha256:revised.output.bindingSha256,files:revised.output.files});assert.equal(compiled.exit_code,0,compiled.diagnostic);assert.equal(compiled.output.succeeded,true,JSON.stringify(compiled.output));assert.equal(compiled.output.artifacts[0].domainReceipt.notesId,revised.output.product.notesId);assert.ok(f.host.getTeacherNotesPdf("teacher",compiled.output.artifacts[0].domainReceipt.receiptId).byteLength>0);}
 }finally{await f.close();}
});

test("Assignment plans and two source roles stay inside the exact selected Assignment",async()=>{
 const f=await fixture();try {
   const assignment=f.host.createAssignment("teacher",{title:"Variance homework",brief:"Compare estimators"}),other=f.host.createAssignment("teacher",{title:"Other homework",brief:"Unrelated assignment"});
   const root=join(f.cwd,"assignment-references");await mkdir(root);await writeFile(join(root,"reference.txt"),"Assignment only reference");
   const described=await describeCourseBuilderLocalFile(root,join(root,"reference.txt"),{kind:"assignment",assignmentId:assignment.assignmentId,assignmentTitle:assignment.title});
   const materials=f.host.syncAssignmentMaterials("teacher",assignment.assignmentId,root,[described],assignment.revision);
   const outputDirectory=join(f.cwd,"assignment-output");await mkdir(outputDirectory);const student=join(outputDirectory,"student.tex"),solution=join(outputDirectory,"solution.Rmd");await writeFile(student,article);await writeFile(solution,"# Original solution\n");
   const common={target:{assignmentId:assignment.assignmentId},materialIds:[materials[0].materialId],outputDirectory};
   const plan=scoped(f,{...common,kind:"assignment-plan"}),ctx=(await plan.invoke("course_task_context",{})).output;assert.match(ctx.context.materials[0].text,/Assignment only/);assert.doesNotMatch(JSON.stringify(ctx.context),/Other homework|Control variates reduce/);
   const planDraft={overview:"Compare Monte Carlo estimators",tasks:["Estimate variance"],deliverables:["student.tex","solution.Rmd"],rubric:["Correct unbiasedness argument"],solutionNotes:["Use fixed seeds"]};
   const saved=await plan.invoke("course_artifact_commit",{requestId:"plan",bindingSha256:ctx.bindingSha256,kind:"assignment",draft:planDraft,files:[]});assert.equal(saved.exit_code,0,saved.diagnostic);assert.equal(saved.output.product.assignmentId,assignment.assignmentId);assert.equal(saved.output.product.status,"draft");assert.deepEqual(saved.output.product.draft.materialIds,[materials[0].materialId]);
   const checked=await plan.invoke("course_artifact_compile",{requestId:"plan-validation",bindingSha256:saved.output.bindingSha256,files:[]});assert.equal(checked.output.succeeded,true);
   f.host.setAgentAssignmentScope("teacher",other.assignmentId);
   const artifacts=scoped(f,{...common,kind:"assignment-artifacts",baselineFiles:[{path:student,format:"tex",role:"student"},{path:solution,format:"rmd",role:"solution"}]});await artifacts.invoke("course_task_context",{});await source(f,"sources/student.tex",article+'\n% amended\n');await source(f,"sources/solution.Rmd","# New solution\n");
   const generated=await artifacts.invoke("course_artifact_commit",{requestId:"artifacts",bindingSha256:artifacts.domain.contextBinding().sha256,kind:"assignment",files:[{format:"tex",role:"student",path:"sources/student.tex"},{format:"rmd",role:"solution",path:"sources/solution.Rmd"}]});assert.equal(generated.exit_code,0,generated.diagnostic);assert.match(await readFile(student,"utf8"),/amended/);assert.equal(await readFile(solution,"utf8"),"# New solution\n");assert.ok(generated.effects.outside_paths.includes(student));assert.ok(generated.effects.outside_paths.includes(solution));assert.equal(f.host.getAssignment("teacher",other.assignmentId).draft,null);
   const resumed=scoped(f,artifacts.options);assert.equal(resumed.domain.contextBinding().sha256,generated.output.bindingSha256);const resumedContext=await resumed.invoke("course_task_context",{});assert.equal(resumedContext.exit_code,0,resumedContext.diagnostic);
   if(process.env.PI_TEST_XELATEX_PATH && process.env.PI_TEST_RSCRIPT) {
     const compiled=await resumed.invoke("course_artifact_compile",{requestId:"assignment-compile",bindingSha256:generated.output.bindingSha256,files:generated.output.files});assert.equal(compiled.exit_code,0,compiled.diagnostic);assert.equal(compiled.output.succeeded,true,JSON.stringify(compiled.output));assert.equal(compiled.output.artifacts.length,2);assert.ok((await readFile(join(outputDirectory,"student.pdf"))).subarray(0,5).equals(Buffer.from("%PDF-")));assert.match(await readFile(join(outputDirectory,"solution.md"),"utf8"),/New solution/);assert.equal(compiled.output.artifacts[0].domainReceipt,null);
   }
   const isolated=scoped(f,{...common,kind:"assignment-plan",taskId:"foreign-material",materialIds:[f.materials[0].materialId]});const wrong=await isolated.invoke("course_task_context",{});assert.match(wrong.diagnostic,/MATERIAL_SCOPE_MISMATCH/);
 }finally{await f.close();}
});

test("selected course files classified as assets remain readable references",async()=>{
 const f=await fixture();try {
   const root=join(f.cwd,"code");await mkdir(root);await writeFile(join(root,"Dec1.R"),"mean(x)\n");
   const described=await describeCourseBuilderLocalFile(root,join(root,"Dec1.R"));
   assert.equal(described.kind,"asset");
   const [asset]=f.host.importMaterials("teacher",[described],f.host.getSnapshotForSession("teacher").project.revision);
   const task=scoped(f,{kind:"lesson",target:{week:5,session:2},materialIds:[asset.materialId]});
   const ctx=await task.invoke("course_task_context",{});
   assert.equal(ctx.exit_code,0,ctx.diagnostic);
   assert.equal(ctx.output.context.materials[0].kind,"asset");
   assert.match(ctx.output.context.materials[0].text,/mean\(x\)/);
 }finally{await f.close();}
});

test("interactive HTML uses the real validator and selected material folder; large unrelated library stays unobserved",async()=>{
 const f=await fixture();try {
   const state=f.host.getSnapshotForSession("teacher"),lesson=f.host.saveLessonPlan("teacher",{...draft,week:5,session:2,materialIds:[f.materials[0].materialId]},0,state.semesterPlan.revision);
   const root=join(f.cwd,"teacher-materials");await mkdir(root);await writeFile(join(root,"reference.txt"),"Reference");
   f.host.importMaterials("teacher",[await describeCourseBuilderLocalFile(root,join(root,"reference.txt"))],state.project.revision);
   await Promise.all(Array.from({length:520},(_,index)=>writeFile(join(root,`unrelated-${index}.txt`),"Unrelated content")));
   const task=scoped(f,{kind:"html",target:{lessonId:lesson.lessonPlanId},materialRoot:root});const ctx=(await task.invoke("course_task_context",{})).output;
   assert.ok(ctx);await source(f,"sources/variance.html",html);
   const saved=await task.invoke("course_artifact_commit",{requestId:"html",bindingSha256:ctx.bindingSha256,kind:"html",files:[{format:"html",path:"sources/variance.html"}]});assert.equal(saved.exit_code,0,saved.diagnostic);assert.equal(saved.output.product.format,"interactive-html");assert.equal(saved.output.product.validation.hasControls,true);assert.equal(f.host.getMaterial("teacher",saved.output.product.materialId).metadata.sourceRoot,root);assert.equal(await readFile(join(root,"variance.html"),"utf8"),html);assert.ok(saved.effects.outside_paths.includes(join(root,"variance.html")));assert.ok(saved.effects.outside_paths.every(path=>!path.includes("unrelated-")));
   const validated=await task.invoke("course_artifact_compile",{requestId:"html-validation",bindingSha256:saved.output.bindingSha256,files:saved.output.files});assert.equal(validated.output.succeeded,true);
   await source(f,"sources/invalid.html","<html><body><table>Static</table></body></html>");const invalid=await task.invoke("course_artifact_commit",{requestId:"invalid",bindingSha256:task.domain.contextBinding().sha256,kind:"html",files:[{format:"html",path:"sources/invalid.html"}]});assert.equal(invalid.exit_code,1);assert.match(invalid.diagnostic,/HTML must be 80|requires inline/);await assert.rejects(access(join(root,"invalid.html")));
 }finally{await f.close();}
});

test("material analysis binds its library and checkpoint semantic coverage receives Host IDs and hashes",async()=>{
 const f=await fixture();try {
   const root=join(f.cwd,"analysis-root");await mkdir(root);await writeFile(join(root,"book.txt"),"Estimator sequence");
   const materials=f.host.importMaterials("teacher",[await describeCourseBuilderLocalFile(root,join(root,"book.txt"))],f.host.getSnapshotForSession("teacher").project.revision);
   const analysis=scoped(f,{kind:"analysis",target:{course:true},materialIds:[materials[0].materialId]});
   const values=Object.fromEntries(["topicChains","prerequisiteGaps","duplicates","sequenceGaps","terminologyConflicts","practiceOpportunities","visualOpportunities"].map(name=>[name,[]]));values.topicChains=["Estimator then variance"];
   const saved=await analysis.invoke("course_artifact_commit",{requestId:"analysis",bindingSha256:analysis.domain.contextBinding().sha256,kind:"analysis",draft:values,files:[]});assert.equal(saved.exit_code,0,saved.diagnostic);assert.deepEqual(saved.output.product.materialIds,[materials[0].materialId]);
   const lesson=await saveApprovedLesson(f),checkpoint=scoped(f,{kind:"checkpoint",target:{lessonId:lesson.lessonPlanId},materialIds:[materials[0].materialId]});
   const savedCheckpoint=await checkpoint.invoke("course_artifact_commit",{requestId:"checkpoint",bindingSha256:checkpoint.domain.contextBinding().sha256,kind:"checkpoint",draft:{coverage:[{summary:"Variance reduction",position:"Estimator section",nextLesson:"Control variates"}],completed:["Unbiased estimates"],remaining:["Confidence intervals"],nextLesson:"Control variates"},files:[]});assert.equal(savedCheckpoint.exit_code,0,savedCheckpoint.diagnostic);assert.equal(savedCheckpoint.output.product.status,"planned");assert.equal(savedCheckpoint.output.product.coverage[0].materialId,materials[0].materialId);assert.equal(savedCheckpoint.output.product.coverage[0].sourceHash,materials[0].sourceHash);assert.equal(savedCheckpoint.output.product.confirmedAt,null);
 }finally{await f.close();}
});
import { createJiti } from "jiti";
test("selected attachments freeze verified text only and reject cross-session IDs or changed originals",async()=>{
 const f=await fixture();try {
   const {saveChatAttachment,readChatAttachmentSource}=await createJiti(import.meta.url).import("./chat-attachments.ts");
   const attachment=await saveChatAttachment(f.cwd,new File(["Attached worksheet\n".repeat(1600)],"worksheet.txt"),{sessionId:"teacher",assignmentId:null});
   const verified=await readChatAttachmentSource(f.cwd,attachment.id,{sessionId:"teacher",assignmentId:null});
   const summaries=[{id:verified.id,name:verified.name,sourceHash:verified.sourceHash,textSha256:hash(verified.text)}];
   const task=scoped(f,{kind:"rmd",target:{course:true},materialIds:[],attachmentIds:[attachment.id],attachmentSources:summaries,readAttachment:id=>readChatAttachmentSource(f.cwd,id,{sessionId:"teacher",assignmentId:null})});
   const context=await task.invoke("course_task_context",{});assert.equal(context.exit_code,0,context.diagnostic);assert.equal(context.output.context.attachments.length,1);assert.equal(context.output.context.attachments[0].textWindow.truncated,true);assert.equal(await readFile(join(f.directory,context.output.context.attachments[0].workspaceTextPath),"utf8"),verified.text);assert.equal((await (await import("node:fs/promises")).readdir(f.directory)).some(name=>name.endsWith(".source")),false);
   const foreign=scoped(f,{...task.options,taskId:"foreign-attachment",readAttachment:id=>readChatAttachmentSource(f.cwd,id,{sessionId:"another-session",assignmentId:null})});const wrong=await foreign.invoke("course_task_context",{});assert.equal(wrong.exit_code,1);assert.match(wrong.diagnostic,/another conversation/);
   await writeFile(attachment.path,"Changed original");await source(f,"sources/attachment-lab.Rmd","# Lab\n");const changed=await task.invoke("course_artifact_commit",{requestId:"changed-attachment",bindingSha256:context.output.bindingSha256,kind:"rmd",files:[{format:"rmd",path:"sources/attachment-lab.Rmd"}]});assert.equal(changed.exit_code,1);assert.match(changed.diagnostic,/Attachment content changed/);
 }finally{await f.close();}
});

test("long selected references use bounded text windows and no original binary/source clones",async()=>{
 const f=await fixture();try {
   const bytes=Buffer.from("Long selected reference\n".repeat(3000));
   const [material]=f.host.importMaterials("teacher",[{name:"long.txt",kind:"text",sourceBytes:bytes,extractedText:bytes.toString("utf8")}],f.host.getSnapshotForSession("teacher").project.revision);
   const task=scoped(f,{kind:"rmd",target:{course:true},materialIds:[material.materialId]});
   const result=await task.invoke("course_task_context",{});assert.equal(result.exit_code,0,result.diagnostic);
   const reference=result.output.context.materials[0];assert.equal(reference.text.length,2000);assert.equal(reference.textWindow.totalCharacters,bytes.length);assert.equal(reference.textWindow.truncated,true);assert.equal(reference.source.path,undefined);assert.equal(reference.source.sha256,hash(bytes));assert.equal(await readFile(join(f.directory,reference.workspaceTextPath),"utf8"),bytes.toString("utf8"));
   assert.ok(Buffer.byteLength(JSON.stringify(result.output))<131072);
 }finally{await f.close();}
});
test("first semester sessions choose material ordinals and Host assigns slot identity and goal strings",async()=>{
 const f=await fixture();try {
   const project=f.host.createProject({...createDefaultCourseBuilderProject(),courseId:"first-plan",weeks:1,sessionsPerWeek:2,language:"English"});f.host.bindSession("first-plan",project.projectId);
   const materials=f.host.importMaterials("first-plan",["First reference","Second reference"].map((text,index)=>({name:`book-${index}.txt`,kind:"text",sourceBytes:Buffer.from(text),extractedText:text})),project.revision);
   const task=scoped(f,{sessionId:"first-plan",kind:"semester",taskId:"first-semester",target:{course:true},materialIds:materials.map(item=>item.materialId)});
   const session=index=>({title:`Teaching unit ${index}`,objectives:["Compare estimators"],prerequisites:[],topics:["Variance"],activities:["Explore"],understandingEvidence:["Explain"],assessment:"",homework:"",goalIndexes:project.goals.map((_,index)=>index),materialIndexes:[index],revisits:[{concept:index===0?"Estimator variance":"  estimator   VARIANCE ",progression:index===0?"complexity":"transfer",note:"Use a fresh setting to revisit variance"}],visualOpportunities:[]});
   const generated=await task.invoke("course_artifact_commit",{requestId:"first-plan",bindingSha256:task.domain.contextBinding().sha256,kind:"semester",draft:{title:"Course sequence",rationale:"Variance then control variates",sessions:[session(0),session(1)]},files:[]});assert.equal(generated.exit_code,0,generated.diagnostic);assert.deepEqual(generated.output.product.sessions.map(item=>({week:item.week,session:item.session,materialIds:item.materialIds})),[{week:1,session:1,materialIds:[materials[0].materialId]},{week:1,session:2,materialIds:[materials[1].materialId]}]);assert.deepEqual(generated.output.product.sessions[0].courseGoalsCovered,project.goals);assert.equal(generated.output.product.sessions[0].assessment,null);
   const revisits=generated.output.product.sessions.map(item=>item.revisits[0]);assert.match(revisits[0].conceptId,/^concept_[a-f0-9]{64}$/);assert.equal(revisits[0].conceptId,revisits[1].conceptId);assert.equal(revisits[0].concept,undefined);assert.equal(revisits[0].note,"Use a fresh setting to revisit variance");
   const revision=scoped(f,{sessionId:"first-plan",kind:"semester",taskId:"semester-revision",target:{course:true},materialIds:materials.map(item=>item.materialId)}),invalid=await revision.invoke("course_artifact_commit",{requestId:"reject-concept-id",bindingSha256:revision.domain.contextBinding().sha256,kind:"semester",draft:{sessions:[{revisits:[{conceptId:revisits[0].conceptId,progression:"transfer",note:"Model must not copy this identity"}]},{}]},files:[]});assert.equal(invalid.exit_code,1);assert.match(invalid.diagnostic,/HOST_OWNED_FIELDS/);assert.equal(f.host.getSnapshotForSession("first-plan").semesterPlan.revision,1);
 }finally{await f.close();}
});

test("512 selected reference manifest fits the Host output budget and avoids inline library content",async()=>{
 const f=await fixture();try {
   const added=f.host.importMaterials("teacher",Array.from({length:510},(_,index)=>({name:`bounded-${index}.txt`,kind:"text",sourceBytes:Buffer.from(`Selected reference ${index}`),extractedText:`Selected reference ${index}`})),f.host.getSnapshotForSession("teacher").project.revision);
   const ids=[...f.materials,...added].map(item=>item.materialId),task=scoped(f,{kind:"rmd",target:{course:true},materialIds:ids});
   const result=await task.invoke("course_task_context",{});assert.equal(result.exit_code,0,result.diagnostic);assert.equal(result.output.context.materialCount,512);assert.equal(result.output.context.materials.length,16);assert.equal(result.output.binding.materialIds.length,32);assert.ok(Buffer.byteLength(JSON.stringify(result.output))<131072);
   const manifest=JSON.parse(await readFile(join(f.directory,result.output.context.materialIndexPath),"utf8"));assert.equal(manifest.length,512);assert.equal(manifest[511].materialId,ids[511]);assert.ok(manifest.every(reference=>reference.source.path === undefined));assert.ok(manifest.reduce((sum,item)=>sum+item.text.length,0)<=12000);
 }finally{await f.close();}
});
