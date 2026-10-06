import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { validateData } from "pi-caw/core/workflow-data-schema.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { restoreCleanedCourseRefusal, courseLaunchWasRefused, courseWorkflowRegistry, registerCourseWorkflowControl, courseWorkflowTaskDefinition, courseWorkflowTaskInputs, selectCourseWorkflowTask, selectCourseProductionOperation, assertCourseProductionRunScope, cancelCourseWorkflowTask, validateCourseWorkflowAttachments, courseWorkflowRevisionEvidence } = await jiti.import("./course-workflow-tasks.ts");

test("only exact known pre-Run refusals can be cleaned; missing and ambiguous launches remain recoverable",()=>{
 const r={runId:"run-old",startState:"unconfirmed",startLookupError:{code:"RUN_NOT_FOUND",message:"missing",details:{run_id:"run-old",observation:"run_directory_absent"}},startError:{code:"PI_MAIN_STRICT_CONTEXT",message:"strict refusal"}};
 assert.equal(courseLaunchWasRefused(r),true);assert.equal(courseLaunchWasRefused({...r,startError:{code:null,message:"network timeout"}}),false);
 assert.equal(courseLaunchWasRefused({...r,startLookupError:{...r.startLookupError,details:{run_id:"run-other",observation:"run_directory_absent"}}}),false);
 assert.equal(courseLaunchWasRefused({...r,startState:"confirmed"}),false);
 const cleaned={...r,processCleanedAt:"2026-10-03T00:00:00Z"};assert.equal(restoreCleanedCourseRefusal(cleaned),true);assert.equal(cleaned.processCleanedAt,undefined);assert.equal(cleaned.previousRefusalCleanupAt,"2026-10-03T00:00:00Z");
 assert.equal(restoreCleanedCourseRefusal({...r,processCleanedAt:"old",refusalDiscardedAt:"explicit"}),false);
 assert.equal(restoreCleanedCourseRefusal({...r,processCleanedAt:"old",startError:{code:null,message:"network timeout"}}),false);
});
const { saveChatAttachment } = await jiti.import("./chat-attachments.ts");
const { createCourseBuilderExtension } = await jiti.import("./course-builder-extension.ts");

test("recorded correction reaches the converted writer's changeRequest Root input without altering bundle routing", () => {
  const record={workflowId:"course-slide-revision",taskId:"host-task",task:"  只改第 2 页：保留 α 与所有其他公式。\nDo not rebuild the deck.  ",commitRequestId:"host-commit",compileRequestId:"host-compile"};
  const inputs=courseWorkflowTaskInputs(record);
  // Exact Root names read offline from revision-conversion-state.json:
  // generation_repair.latest_cumulative_plan.proposal.activities[*].inputs (input:* bindings).
  const required=["changeRequest","commitRequestId","compileRequestId","documentKind","format","kind","taskId"];
  const schema={type:"object",required,properties:Object.fromEntries(required.map(name=>[name,{type:"string"}])),additionalProperties:false};
  validateData(inputs,schema);
  assert.equal(inputs.changeRequest,record.task,"the teacher's recorded request is propagated byte-for-byte, without a model paraphrase");
  assert.equal(inputs.kind,"deck"); assert.equal(inputs.format,"tex"); assert.equal(inputs.documentKind,"beamer");
  assert.equal(inputs.commitRequestId,record.commitRequestId); assert.equal(inputs.compileRequestId,record.compileRequestId);
  const {changeRequest,...missingRequest}=inputs;
  assert.throws(()=>validateData(missingRequest,schema),{code:"DATA_INVALID",message:"$: required property is missing: changeRequest"});
  const bundle=courseWorkflowTaskInputs({...record,workflowId:undefined});
  assert.equal(bundle.task,record.task); assert.equal(bundle.kind,"bundle");
  assert.equal(Object.hasOwn(bundle,"changeRequest"),false); assert.equal(Object.hasOwn(bundle,"format"),false);
});

test("legacy new-lesson routing stays bundle; revision selection requires its exact existing deck and keeps reference scope empty", () => {
  assert.deepEqual(courseWorkflowTaskDefinition(),{workflowId:"course-lesson-artifacts",kind:"bundle"});
  assert.deepEqual(courseWorkflowTaskDefinition("course-slide-revision"),{workflowId:"course-slide-revision",kind:"deck"});
  assert.throws(() => courseWorkflowTaskDefinition("untrusted-workflow"),/Unsupported/);
  assert.throws(() => courseWorkflowTaskDefinition(null),/Unsupported/);
  const lesson={lessonPlanId:"existing-lesson",week:5,session:2,materialIds:["whole-course-reference"],status:"approved"};
  const snapshot={semesterPlan:{sessions:[{week:5,session:2,materialIds:["slot-reference"]}]},lessonPlans:[lesson],decks:[{deckId:"existing-deck",lessonPlanId:"existing-lesson"}]};
  const correction={workflowId:"course-slide-revision",target:{lessonId:"existing-lesson"},task:"Replace slide 2’s repeated wording; keep everything else."};
  const selection=selectCourseWorkflowTask(snapshot,correction);
  assert.equal(selection.kind,"deck"); assert.deepEqual(selection.target,{lessonId:"existing-lesson"});
  assert.deepEqual(selection.materialIds,[],"wording/layout edits must not silently read course material");
  assert.deepEqual(selectCourseWorkflowTask(snapshot,{...correction,materialIds:["explicit-reference"]}).materialIds,["explicit-reference"]);
  assert.deepEqual(selectCourseWorkflowTask(snapshot,{target:{week:5,session:2},task:"Original single-lesson request"}).materialIds,["slot-reference"]);
  assert.throws(() => selectCourseWorkflowTask({...snapshot,decks:[]},correction),/尚无课件/);
  assert.throws(() => selectCourseWorkflowTask(snapshot,{...correction,target:{week:5,session:2}}),/已有单课计划/);
  assert.throws(() => selectCourseWorkflowTask(snapshot,{...correction,target:{lessonId:"foreign-lesson"}}),/existing semester slot or lesson/);
});

test("static capabilities need no task; stable admission cancels the exact domain across registry lookups", async () => {
  const sid = "offline-registry-teacher", registry = courseWorkflowRegistry(sid);
  assert.equal(courseWorkflowRegistry(sid), registry);
  assert.equal(Object.keys(registry).length, 4);
  for (const tool of Object.values(registry)) {
    assert.deepEqual(tool.identity, tool.contract.identity);
    assert.equal(tool.attestation.qualified, true);
  }
  const calls = [];
  const domain = id => ({ registry: Object.fromEntries(Object.keys(registry).map(tool => [tool, {
    execute: async invocation => { calls.push(["execute", id, tool]); return { exit_code: 0, output: { taskId: invocation.input.taskId } }; },
    cancel: async () => { calls.push(["cancel", id, tool]); return { termination_confirmed: true, evidence: [{kind:"fixture-exact-domain",sha256:"a".repeat(64)}], effects:{observed:true,changed_paths:[],outside_paths:[],artifacts:[]} }; }
  }])) });
  const records = globalThis.__piCourseWorkflowTasks ??= new Map();
  const a = domain("a"), b = domain("b"), foreign = domain("foreign");
  records.set("offline-a", {record:{sessionId:sid},domain:a});
  records.set("offline-b", {record:{sessionId:sid},domain:b});
  records.set("offline-foreign", {record:{sessionId:"other"},domain:foreign});
  const context = {run_id:"offline-run",node_id:"commit",attempt_id:"one"};
  try {
    await registry.course_artifact_commit.execute({input:{taskId:"offline-a"},context});
    await courseWorkflowRegistry(sid).course_artifact_commit.cancel({context});
    assert.deepEqual(calls,[ ["execute","a","course_artifact_commit"], ["cancel","a","course_artifact_commit"] ]);
    assert.throws(() => registry.course_artifact_commit.execute({input:{taskId:"offline-b"},context}), /different task/);
    assert.throws(() => registry.course_artifact_commit.execute({input:{taskId:"offline-foreign"},context:{...context,attempt_id:"two"}}), /original Pi conversation/);
    const neverAdmitted = await registry.course_artifact_compile.cancel({context:{...context,node_id:"compile",attempt_id:"two"}});
    assert.equal(neverAdmitted.evidence[0].kind,"course-operation-not-admitted");
    assert.match(neverAdmitted.evidence[0].sha256,/^[a-f0-9]{64}$/);
    assert.equal(calls.length,2,"a pending attempt must never cancel another task");
    await assert.rejects(registry.course_artifact_compile.cancel({context:{...context,run_id:"old-owner-run"}}), {code:"COURSE_ADMISSION_RECONCILE_REQUIRED"});
  } finally { for (const id of ["offline-a","offline-b","offline-foreign"]) records.delete(id); }
});

test("session control replacement cannot be removed by an older release", () => {
  const sid="offline-controls", first=async()=>"first", second=async()=>"second";
  const releaseFirst=registerCourseWorkflowControl(sid,first), releaseSecond=registerCourseWorkflowControl(sid,second);
  releaseFirst(); assert.equal(globalThis.__piCourseWorkflowControls.get(sid),second);
  releaseSecond(); assert.equal(globalThis.__piCourseWorkflowControls.has(sid),false);
});

test("static wrappers expose only exact DB files and private bound journal roots, including tasks prepared later", () => {
  const sid="offline-storage-capability", registry=courseWorkflowRegistry(sid), records=globalThis.__piCourseWorkflowTasks ??= new Map();
  const before=registry.course_artifact_commit.attestation.storage_capabilities;
  assert.equal(before.write_files.length,3);assert.ok(before.write_files[0].endsWith("learning-harness.sqlite"));
  assert.deepEqual(before.write_files.slice(1),[`${before.write_files[0]}-wal`,`${before.write_files[0]}-shm`]);assert.deepEqual(before.write_directories,[]);
  const evidence=registry.course_artifact_commit.attestation.evidence_sha256;
  records.set("offline-storage-bound",{record:{sessionId:sid,cwd:process.cwd()},domain:{}});
  records.set("offline-storage-foreign",{record:{sessionId:"foreign",cwd:resolve(process.cwd(),"foreign")},domain:{}});
  try {
    assert.deepEqual(registry.course_artifact_commit.attestation.storage_capabilities.write_directories,[resolve(process.cwd(),".pi","course-workflow-host")]);
    assert.deepEqual(registry.course_artifact_compile.attestation.storage_capabilities,registry.course_artifact_commit.attestation.storage_capabilities);
    assert.deepEqual(registry.course_task_context.attestation.storage_capabilities.write_files,[]);
    assert.equal(registry.course_artifact_commit.attestation.evidence_sha256,evidence,"adding private storage observations preserves broker qualification identity");
    assert.equal(Object.hasOwn(registry.course_artifact_commit.contract.permissions,"storage_capabilities"),false);
  } finally {records.delete("offline-storage-bound");records.delete("offline-storage-foreign");}
});

test("Run access follows the persisted Workflow and exact session/task/workspace, including legacy lesson records", async () => {
  const sid="offline-run-binding", records=globalThis.__piCourseWorkflowTasks ??= new Map(), cancelled=[];
  const workspace=process.cwd(), legacy={sessionId:sid,taskId:"offline-legacy",runId:"offline-run-legacy",taskDirectory:workspace};
  const revision={sessionId:sid,taskId:"offline-revision",runId:"offline-run-revision",taskDirectory:workspace,workflowId:"course-slide-revision"};
  records.set(legacy.taskId,{record:legacy,domain:{}}); records.set(revision.taskId,{record:revision,domain:{}});
  let mismatch={};
  const release=registerCourseWorkflowControl(sid,async(operation,args)=>{
    if(operation==="cancel") {cancelled.push(args.run_id);return {status:"cancellation_requested"};}
    assert.equal(operation,"get"); const record=args.run_id===legacy.runId ? legacy : revision;
    return {run_id:record.runId,main_actor:sid,workflow_id:record.workflowId ?? "course-lesson-artifacts",inputs:{taskId:record.taskId},permissions:{workspace},...mismatch};
  });
  try {
    await cancelCourseWorkflowTask(sid,legacy.taskId); await cancelCourseWorkflowTask(sid,revision.taskId);
    assert.deepEqual(cancelled,[legacy.runId,revision.runId]);
    for(const changed of [{workflow_id:"course-lesson-artifacts"},{main_actor:"another-teacher"},{inputs:{taskId:legacy.taskId}},{permissions:{workspace:"another-workspace"}}]) {
      mismatch=changed;
      await assert.rejects(cancelCourseWorkflowTask(sid,revision.taskId),/Run binding differs/);
    }
    assert.equal(cancelled.length,2,"wrong-Workflow or cross-session status cannot authorize cancellation");
  } finally {release();records.delete(legacy.taskId);records.delete(revision.taskId);}
});

test("Course extension registers exact-session Promise bus control and clears it at shutdown", async () => {
  const bus=new EventEmitter(), hooks=new Map(); let control, released=0;
  const pi={events:{on(name,handler){bus.on(name,handler);return()=>bus.off(name,handler);},emit:(...args)=>bus.emit(...args)},on:(name,handler)=>hooks.set(name,handler),registerTool(){}};
  const host={getSnapshotForSession:()=>({project:{projectId:"course"}}),listCoverageCheckpoints:()=>[]};
  createCourseBuilderExtension(()=>host,()=>{}, {registry:()=>({}),restore:async()=>{},registerControl:(sid,callback)=>{assert.equal(sid,"offline-teacher");control=callback;return()=>released++;}})(pi);
  const ctx={cwd:"fixture",sessionManager:{getSessionId:()=>"offline-teacher",getBranch:()=>[]}};
  await hooks.get("session_start")({},ctx);
  bus.on("pi-caw:host-command", request => {assert.equal(request.session_id,"offline-teacher");request.operation === "list" ? request.resolve(["ready"]) : request.reject(new Error("fixture refusal"));});
  assert.deepEqual(await control("list",{}),["ready"]);
  await assert.rejects(control("cancel",{run_id:"fixture"}),/fixture refusal/);
  hooks.get("session_shutdown")(); assert.equal(released,1);
});


test("every new product has a Host-selected scope and preserves semantic Root task without inventing identities", () => {
 const snapshot={materials:[{materialId:"course-ref",metadata:{storage:"local-link"}},{materialId:"private-ref",metadata:{storage:"local-link",materialScope:"assignment"}},{materialId:"figure",metadata:{storage:"generated-asset"}}],assignments:[{assignmentId:"assignment",materialIds:["private-ref"]}],semesterPlan:{sessions:[{week:1,session:1,materialIds:["course-ref"]}]},lessonPlans:[{lessonPlanId:"lesson",week:1,session:1,materialIds:["course-ref"]}],decks:[{deckId:"deck",lessonPlanId:"lesson"}]};
 const cases=[
 ["course-semester-plan","semester",{course:true}], ["course-material-analysis","analysis",{course:true}],
 ["course-lesson-plan","lesson",{week:1,session:1}], ["course-beamer-deck","deck",{lessonId:"lesson"}],
 ["course-teacher-notes","teacher-notes",{lessonId:"lesson"}], ["course-rmd-lab","rmd",{course:true}],
 ["course-interactive-html","html",{lessonId:"lesson"}], ["course-coverage-checkpoint","checkpoint",{lessonId:"lesson"}],
 ["course-assignment-plan","assignment-plan",{assignmentId:"assignment"}], ["course-assignment-artifacts","assignment-artifacts",{assignmentId:"assignment"}],
 ];
 for(const [workflowId,kind,target] of cases) {
   const selected=selectCourseWorkflowTask(snapshot,{workflowId,target,task:"Keep existing valid content."});
   assert.equal(selected.kind,kind);assert.deepEqual(selected.target,target);
   assert.deepEqual(selected.materialIds,"assignmentId" in target ? ["private-ref"] : ["course-ref"]);
   assert.deepEqual(courseWorkflowTaskInputs({workflowId,taskId:"host-task",task:"Exact teacher request",commitRequestId:"host-commit",compileRequestId:"host-compile"}), {taskId:"host-task",kind:kind.startsWith("assignment") ? "assignment" : kind,commitRequestId:"host-commit",compileRequestId:"host-compile",task:"Exact teacher request"});
 }
 for(const [workflowId,target] of [["course-semester-plan",{lessonId:"lesson"}],["course-assignment-plan",{course:true}],["course-beamer-deck",{week:1,session:1}],["course-interactive-html",{assignmentId:"assignment"}],["course-assignment-artifacts",{assignmentId:"foreign"}]]) assert.throws(()=>selectCourseWorkflowTask(snapshot,{workflowId,target,task:"Teacher request"}),/target|Target|选择|existing Assignment/);
});


test("selected chat attachments are verified before preparation and cannot cross conversation or Assignment boundaries", async()=>{
 const cwd=await mkdtemp(join(tmpdir(),"pi-workflow-attachment-selection-"));
 try {
   const saved=await saveChatAttachment(cwd,new File(["Keep the teacher's notation: T(v)=Av."],"teacher-reference.custom"),{sessionId:"teacher",assignmentId:null});
   const summaries=await validateCourseWorkflowAttachments(cwd,"teacher",{course:true},[saved.id]);
   assert.deepEqual(summaries,[{id:saved.id,name:saved.name,sourceHash:saved.sourceHash,textSha256:createHash("sha256").update("Keep the teacher's notation: T(v)=Av.").digest("hex")}]);
   assert.deepEqual(await validateCourseWorkflowAttachments(cwd,"teacher",{course:true}),[],"old callers select no attachments");
   await assert.rejects(validateCourseWorkflowAttachments(cwd,"another-teacher",{course:true},[saved.id]),/another conversation/);
   await assert.rejects(validateCourseWorkflowAttachments(cwd,"teacher",{assignmentId:"assignment"},[saved.id]),/Assignment/);
   const privateFile=await saveChatAttachment(cwd,new File(["Private solution"],"solution.custom"),{sessionId:"teacher",assignmentId:"assignment"});
   assert.equal((await validateCourseWorkflowAttachments(cwd,"teacher",{assignmentId:"assignment"},[privateFile.id]))[0].id,privateFile.id);
   await assert.rejects(validateCourseWorkflowAttachments(cwd,"teacher",{assignmentId:"other-assignment"},[privateFile.id]),/Assignment/);
   await assert.rejects(validateCourseWorkflowAttachments(cwd,"teacher",{course:true},[privateFile.id]),/Assignment/);
   await assert.rejects(validateCourseWorkflowAttachments(cwd,"teacher",{course:true},[saved.id,saved.id]),/16 distinct/);
 } finally { assert.ok(cwd.startsWith(join(tmpdir(),"pi-workflow-attachment-selection-")));await rm(cwd,{recursive:true,force:true}); }
});


test("teacher feedback completes only after exact successful Run plus current Host revision/hash evidence",()=>{
 const saved={lessonPlanId:"lesson",revision:3,contentHash:"current-hash",week:1,session:1};
 const record={taskId:"host-task",workflowId:"course-lesson-plan",projectId:"course",target:{lessonId:"lesson"}};
 const snapshot={project:{projectId:"course"},lessonPlans:[saved]};
 const state={status:"succeeded",nodes:{commit:{status:"succeeded",output:{taskId:"host-task",kind:"lesson",succeeded:true,lesson:saved}}}};
 const verified=courseWorkflowRevisionEvidence(record,state,snapshot);
 assert.equal(verified.status,"verified");assert.equal(verified.action,"save_lesson");assert.equal(verified.saved,saved);
 for(const status of ["running","failed","cancelled"]) assert.equal(courseWorkflowRevisionEvidence(record,{...state,status},snapshot).status,"pending","compile failure cannot complete teacher feedback despite saved draft");
 assert.equal(courseWorkflowRevisionEvidence(record,{...state,nodes:{}},snapshot).status,"missing");
 assert.equal(courseWorkflowRevisionEvidence(record,{...state,nodes:{commit:{...state.nodes.commit,output:{...state.nodes.commit.output,taskId:"foreign-task"}}}},snapshot).status,"missing");
 assert.equal(courseWorkflowRevisionEvidence(record,state,{...snapshot,lessonPlans:[{...saved,revision:4}]}).status,"stale");
 assert.equal(courseWorkflowRevisionEvidence(record,state,{...snapshot,lessonPlans:[{...saved,contentHash:"human-edited"}]}).status,"stale");
 assert.equal(courseWorkflowRevisionEvidence(record,state,{...snapshot,project:{projectId:"another-course"}}).status,"stale");
 assert.equal(courseWorkflowRevisionEvidence({...record,target:{week:1,session:1}},state,snapshot).status,"verified","a new slot lesson is verified against its exact Host slot");
});

test("Master keeps four original Root inputs and admits only the private recorded intent",async()=>{
 const record={workflowId:"course-production",productAction:"course-beamer-deck",taskId:"master-task",task:"Exact teacher request",commitRequestId:"commit",compileRequestId:"compile",sessionId:"master-session",runId:"master-run",workflowRevision:"exact-revision",taskDirectory:resolve("master-workspace"),startState:"intent"};
 const inputs=courseWorkflowTaskInputs(record);assert.deepEqual(inputs,{taskId:"master-task",task:"Exact teacher request",commitRequestId:"commit",compileRequestId:"compile"});
 const records=globalThis.__piCourseWorkflowTasks??=new Map();records.set(record.taskId,{record,domain:{}});
 const args={workflow_id:"course-production",revision_hash:"exact-revision",run_id:"master-run",workspace:record.taskDirectory,access:"bounded_write",allowed_paths:["."],inputs};
 try {
  await assertCourseProductionRunScope(record.sessionId,args);
  for(const patch of [{run_id:"invented"},{revision_hash:"other"},{inputs:{...inputs,task:"Invented teacher request"}},{inputs:{...inputs,kind:"deck"}},{workspace:resolve("other-workspace")},{allowed_paths:[".."]}])await assert.rejects(assertCourseProductionRunScope(record.sessionId,{...args,...patch}),/private Host intent/);
  await assert.rejects(assertCourseProductionRunScope("other-session",args),/unavailable/);
  record.startState="confirmed";await assert.rejects(assertCourseProductionRunScope(record.sessionId,args),/new Run intent/);
 }finally{records.delete(record.taskId);}
});

test("Master new-versus-revise checks the requested product rather than its dependencies",()=>{
 const lesson={lessonPlanId:"lesson",week:1,session:1},deck={deckId:"deck",lessonPlanId:"lesson"};
 const snapshot={semesterPlan:{},lessonPlans:[lesson],decks:[deck],teacherNotes:[],assignments:[{assignmentId:"assignment",draft:null}],materialAnalysis:null};
 assert.equal(selectCourseProductionOperation(snapshot,"deck",{lessonId:"lesson"}),"revise");
 assert.equal(selectCourseProductionOperation(snapshot,"teacher-notes",{lessonId:"lesson"}),"new","an existing deck does not invent an existing notes baseline");
 assert.equal(selectCourseProductionOperation({...snapshot,teacherNotes:[{deckId:"deck"}]},"teacher-notes",{lessonId:"lesson"}),"revise");
 assert.equal(selectCourseProductionOperation(snapshot,"assignment-plan",{assignmentId:"assignment"}),"new");
 assert.equal(selectCourseProductionOperation({...snapshot,assignments:[{assignmentId:"assignment",draft:{}}]},"assignment-plan",{assignmentId:"assignment"}),"revise");
 assert.equal(selectCourseProductionOperation(snapshot,"rmd",{lessonId:"lesson"}),"new","existing lesson/deck do not invent a standalone Rmd");
 assert.equal(selectCourseProductionOperation(snapshot,"checkpoint",{lessonId:"lesson"},[],[{lessonPlanId:"lesson"}]),"revise");
 const saved={lessonPlanId:"lesson",revision:2,contentHash:"saved"},record={workflowId:"course-production",productAction:"course-lesson-plan",taskId:"master-task",projectId:"course",target:{lessonId:"lesson"}};
 const commit={status:"succeeded",output:{taskId:"master-task",kind:"lesson",succeeded:true,lesson:saved}},state={status:"succeeded",nodes:{branch_specific_commit:commit,other_branch:{status:"skipped"}}};
 assert.equal(courseWorkflowRevisionEvidence(record,state,{project:{projectId:"course"},lessonPlans:[saved]}).status,"verified");
 assert.equal(courseWorkflowRevisionEvidence(record,{...state,nodes:{one:commit,two:commit}},{project:{projectId:"course"},lessonPlans:[saved]}).status,"missing","two successful commits cannot masquerade as one selected branch receipt");
});
