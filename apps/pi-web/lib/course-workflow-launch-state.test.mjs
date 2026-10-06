import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { courseWorkflowStartState, courseWorkflowStartLabel, courseWorkflowStartError, courseWorkflowLaunchCanRetry, resetRefusedCourseWorkflowLaunch, observeCourseWorkflowLaunch, dispatchCourseWorkflowLaunch } from "./course-workflow-launch-state.ts";

const intended = () => ({ runId:"fixture-run", commitRequestId:"fixture-commit", compileRequestId:"fixture-compile" });
const missing = (runId="fixture-run", observation="run_directory_absent") => Object.assign(new Error("The exact Run directory is absent now"), {code:"RUN_NOT_FOUND",details:{run_id:runId,observation}});
async function fixture(t, record=intended()) {
  const directory=await mkdtemp(join(tmpdir(),"course-launch-")), path=join(directory,"host-task.json"), snapshots=[];
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {record,snapshots, async persist(value){const copy=JSON.parse(JSON.stringify(value));snapshots.push(copy);await writeFile(path,JSON.stringify(copy));}, async stored(){return JSON.parse(await readFile(path,"utf8"));}};
}

test("intent is durable before dispatch; only exact Run observation confirms and survives reload", async t => {
  const f=await fixture(t), run={run_id:f.record.runId,status:"running"};let observed=false;
  const result=await dispatchCourseWorkflowLaunch(f.record,async()=>{
    assert.equal((await f.stored()).startState,"intent");assert.equal(courseWorkflowStartLabel(f.record),"启动核验中");return {run_id:f.record.runId};
  },async()=>{observed=true;assert.equal(f.record.startState,"intent");return run;},f.persist);
  assert.equal(result,run);assert.equal(observed,true);
  assert.deepEqual(f.snapshots.map(item=>item.startState),["intent","confirmed"]);
  const saved=await f.stored();assert.equal(courseWorkflowStartLabel(saved),"已启动");assert.ok(saved.startIntentAt);assert.ok(saved.startConfirmedAt);
  await assert.rejects(dispatchCourseWorkflowLaunch(saved,async()=>assert.fail("must not dispatch twice"),async()=>run,f.persist),/intent is already recorded/);
});

test("status refresh during pending dispatch cannot revoke the exact Course Host admission intent", async t => {
  const f=await fixture(t), sid="offline-launch-race", taskId="offline-launch-race-task";
  const {createJiti}=await import("jiti"), jiti=createJiti(import.meta.url,{tsconfigPaths:true});
  const {assertCourseProductionRunScope,courseWorkflowTaskInputs}=await jiti.import("./course-workflow-tasks.ts");
  const separate=await jiti.import("./course-workflow-launch-state.ts");
  Object.assign(f.record,{sessionId:sid,taskId,task:"Prepare the selected lesson",workflowId:"course-production",productAction:"course-lesson-plan",
    taskDirectory:tmpdir(),workflowRevision:"fixture-revision"});
  const records=globalThis.__piCourseWorkflowTasks??=new Map();records.set(taskId,{record:f.record,domain:{}});
  t.after(()=>records.delete(taskId));
  const args={workflow_id:f.record.workflowId,run_id:f.record.runId,revision_hash:f.record.workflowRevision,
    workspace:f.record.taskDirectory,access:"bounded_write",allowed_paths:["."],inputs:courseWorkflowTaskInputs(f.record)};
  let lookups=0,created=false;
  const run={run_id:f.record.runId,status:"running"};
  await dispatchCourseWorkflowLaunch(f.record,async()=>{
    // The UI starts polling immediately after prepare, before CAW creates the Run.
    await separate.observeCourseWorkflowLaunch(f.record,async()=>{lookups++;throw missing();},f.persist);
    await assertCourseProductionRunScope(sid,args);
    assert.equal(f.record.startState,"intent");
    created=true;
    return {run_id:f.record.runId};
  },async()=>{if(!created)throw missing();return run;},f.persist);
  assert.equal(lookups,0,"pending launch is owned by the dispatcher, not status reconciliation");
  assert.equal(f.record.startState,"confirmed");assert.equal(f.record.startError,undefined);
});

test("failed intent persistence releases live ownership while restart reconciliation keeps durable ambiguity", async t => {
  const f=await fixture(t), failure=new Error("intent storage failed");
  await assert.rejects(dispatchCourseWorkflowLaunch(f.record,async()=>assert.fail("no dispatch before durable intent"),async()=>assert.fail("no lookup"),async()=>{throw failure;}),value=>value===failure);
  assert.equal(globalThis.__piWorkflowPendingLaunches.has(f.record.runId),false);
  assert.equal(await observeCourseWorkflowLaunch(f.record,async()=>{throw missing();},f.persist),null);
  assert.equal(f.record.startState,"unconfirmed","absent live ownership never means it is safe to replay");
});

test("ambiguous dispatch plus existing exact Run is confirmed with the original structured failure retained", async t => {
  const f=await fixture(t), error=Object.assign(new Error("lost dispatch reply"),{code:"TRANSPORT_INTERRUPTED",details:{phase:"dispatch"}}), run={run_id:f.record.runId,status:"attention"};let calls=0;
  assert.equal(await dispatchCourseWorkflowLaunch(f.record,async()=>{calls++;throw error;},async()=>run,f.persist),run);
  assert.equal(calls,1);assert.equal(f.record.startState,"confirmed");assert.deepEqual(f.record.startError,{code:error.code,message:error.message,details:error.details});
  assert.deepEqual(f.snapshots.map(item=>item.startState),["intent","unconfirmed","confirmed"]);
});

test("unconfirmed missing Run retains identities and original failure; reload status exposes rather than retries it", async t => {
  const f=await fixture(t), error=Object.assign(new Error("launch rejected before acknowledgment"),{code:"START_PRECONDITION",details:{reason:"bounded task"}});
  await assert.rejects(dispatchCourseWorkflowLaunch(f.record,async()=>{throw error;},async()=>{throw missing();},f.persist),value=>value===error);
  const saved=await f.stored();assert.equal(saved.startState,"unconfirmed");assert.equal(courseWorkflowStartLabel(saved),"启动未确认");
  assert.equal(saved.runId,"fixture-run");assert.equal(saved.commitRequestId,"fixture-commit");assert.equal(saved.compileRequestId,"fixture-compile");
  assert.deepEqual(saved.startError,{code:error.code,message:error.message,details:error.details});assert.equal(saved.startLookupError.code,"RUN_NOT_FOUND");
  const count=f.snapshots.length;
  assert.equal(await observeCourseWorkflowLaunch(saved,async()=>{throw missing();},f.persist),null);
  assert.equal(f.snapshots.length,count,"unchanged missing observation need not rewrite the record on every poll");
});

test("missing classification requires every exact evidence field and never suppresses corruption/auth/binding errors", async t => {
  for(const error of [Object.assign(new Error("missing journal"),{code:"ENOENT"}),Object.assign(new Error("wrong actor"),{code:"UNAUTHORIZED"}),Object.assign(new Error("corrupt pins"),{code:"RUN_PINS_CORRUPT"}),new Error("Run binding differs"),missing("another-run"),missing("fixture-run","unknown"),Object.assign(new Error("no evidence"),{code:"RUN_NOT_FOUND"})]) {
    const f=await fixture(t,{...intended(),startState:"unconfirmed",startError:{code:"DISPATCH_FAILED",message:"original failure"}});
    await assert.rejects(observeCourseWorkflowLaunch(f.record,async()=>{throw error;},f.persist),value=>value===error);
    assert.equal(f.snapshots.length,0);assert.equal(f.record.startError.message,"original failure");
  }
  const f=await fixture(t,{...intended(),startState:"confirmed"}), error=missing();
  await assert.rejects(observeCourseWorkflowLaunch(f.record,async()=>{throw error;},f.persist),value=>value===error);
  assert.equal(f.record.startState,"confirmed");assert.equal(f.snapshots.length,0,"loss of an already confirmed Run is not an unconfirmed-start response");
});

test("legacy Run IDs stay visibly unverified until exact confirmation; legacy error evidence is retained", async t => {
  const f=await fixture(t,{...intended(),startError:"old plain text failure"});
  assert.equal(courseWorkflowStartState(f.record),"unconfirmed");assert.match(courseWorkflowStartLabel(f.record),/旧版记录/);
  assert.deepEqual(courseWorkflowStartError(f.record.startError),{code:null,message:"old plain text failure",legacy:true});
  assert.equal(await observeCourseWorkflowLaunch(f.record,async()=>{throw missing();},f.persist),null);
  assert.equal(f.record.legacyStartRecord,true);assert.match(courseWorkflowStartLabel(f.record),/旧版记录/);
  const run={run_id:f.record.runId,status:"failed"};assert.equal(await observeCourseWorkflowLaunch(f.record,async()=>run,f.persist),run);
  const saved=await f.stored();assert.equal(saved.startState,"confirmed");assert.equal(saved.legacyStartRecord,true);assert.equal(saved.startError,"old plain text failure");
  assert.equal(courseWorkflowStartLabel(saved),"已启动");
});

test("acknowledgment alone cannot confirm; lookup failures stay structured, while mismatched acknowledgments are reconciled", async t => {
  const f=await fixture(t), error=Object.assign(new Error("binding mismatch"),{code:"RUN_BINDING_MISMATCH"});
  await assert.rejects(dispatchCourseWorkflowLaunch(f.record,async()=>({run_id:f.record.runId}),async()=>{throw error;},f.persist),value=>value===error);
  assert.equal(f.record.startState,"unconfirmed");assert.equal(f.record.startError.code,"RUN_BINDING_MISMATCH");assert.equal(f.record.startLookupError.code,"RUN_BINDING_MISMATCH");
  const other=await fixture(t), run={run_id:other.record.runId};
  assert.equal(await dispatchCourseWorkflowLaunch(other.record,async()=>({run_id:"wrong-run"}),async()=>run,other.persist),run);
  assert.equal(other.record.startState,"confirmed");assert.equal(other.record.startError.code,"COURSE_WORKFLOW_ACK_MISMATCH");
});

test("prepared and corrupt record states never claim a started Run", () => {
  assert.equal(courseWorkflowStartState({}),"prepared");assert.equal(courseWorkflowStartLabel({}),"待启动");
  assert.throws(()=>courseWorkflowStartState({startState:"confirmed"}),/no intended Run/);
  assert.throws(()=>courseWorkflowStartState({runId:"fixture-run",startState:"invented"}),/corrupt/);
});

test("a known pre-creation binding refusal remains retryable instead of permanently ambiguous", async t => {
  const f=await fixture(t), error=Object.assign(new Error("Workflow host-tool bindings do not match the registered qualified implementations"),{
    code:"HOST_TOOL_BINDING_STALE",details:{admission:{run_id:f.record.runId,phase:"before_run_creation",execution_started:false}},
  });
  await assert.rejects(dispatchCourseWorkflowLaunch(f.record,async()=>{throw error;},async()=>{throw missing();},f.persist),value=>value===error);
  const stored=await f.stored();assert.equal(stored.startState,"refused");assert.match(courseWorkflowStartLabel(stored),/可重试/);
  assert.equal(courseWorkflowLaunchCanRetry(stored),true);
  const reset=resetRefusedCourseWorkflowLaunch(stored);
  assert.equal(reset.runId,undefined);assert.equal(reset.startState,undefined);assert.equal(reset.commitRequestId,stored.commitRequestId);
  assert.equal(reset.previousLaunches[0].runId,stored.runId);assert.deepEqual(reset.previousLaunches[0].startError,stored.startError);
  reset.runId='next-run';let calls=0;
  await dispatchCourseWorkflowLaunch(reset,async()=>{calls++;return {run_id:reset.runId};},async()=>({run_id:reset.runId,status:'running'}),f.persist);
  assert.equal(calls,1);assert.equal(reset.startState,'confirmed');
  assert.throws(()=>resetRefusedCourseWorkflowLaunch(reset),/Only a confirmed pre-Run refusal/);
  const legacy={...intended(),startState:"unconfirmed",startError:{code:error.code,message:error.message}};
  assert.equal(await observeCourseWorkflowLaunch(legacy,async()=>{throw missing();},f.persist),null);
  assert.equal(legacy.startState,"refused","historical binding refusals had no Run or executable effect");
});
