import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, rename } from "node:fs/promises";
import { hostToolContractsCompatible } from "pi-caw/core/execution/host-tool-runner.mjs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { studyContext } from "./study-research-service";
import { preferredStudySources } from "./study-source-preference";
import { assertStudyExplanationGraph } from "./study-workflow-admission";
export { assertStudyExplanationGraph } from "./study-workflow-admission";
import { readExactStudySourceBytes } from "./study-source-bytes";
import { createStudyWorkflowDomain, studyWorkflowToolContracts, STUDY_WORKFLOW_TOOL_IDENTITIES, type StudyWorkflowBroker } from "./study-workflow-domain";
import { dispatchCourseWorkflowLaunch, observeCourseWorkflowLaunch, courseWorkflowLaunchCanRetry, resetRefusedCourseWorkflowLaunch, courseWorkflowStartState, type CourseWorkflowLaunchRecord } from "./course-workflow-launch-state";

export const STUDY_WORKFLOW_ID = "study-explanation";
export type StudyWorkflowPrepareInput = { question: string; sourceIds?: string[] };
export type StudyWorkflowControl = (operation: "list" | "run" | "get" | "cancel", args: Record<string, unknown>) => Promise<unknown>;
type RecordTask = CourseWorkflowLaunchRecord & {version:1;sessionId:string;projectId:string;phase:"study"|"research";phaseRevision:number;cwd:string;taskId:string;question:string;taskDirectory:string;journalDirectory:string;selectedSources:{sourceId:string;sourceHash:string;version:number}[];createdAt:string;requestId:string;workflowRevision?:string;commitNodeId?:string};
type Domain = ReturnType<typeof createStudyWorkflowDomain>;
type Scope = {registry:Record<string,StudyWorkflowBroker & {contract:ReturnType<typeof studyWorkflowToolContracts>[number]}>;admitted:Map<string,Domain>;knownRuns:Set<string>};
declare global {var __piStudyWorkflowTasks:Map<string,{record:RecordTask;domain:Domain}>|undefined;var __piStudyWorkflowControls:Map<string,StudyWorkflowControl>|undefined;var __piStudyWorkflowScopes:Map<string,Scope>|undefined;var __piStudyWorkflowStarting:Set<string>|undefined;}
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const tasks=()=>globalThis.__piStudyWorkflowTasks ??=new Map<string,{record:RecordTask;domain:Domain}>();
const controls=()=>globalThis.__piStudyWorkflowControls ??=new Map<string,StudyWorkflowControl>();
const root=(cwd:string,projectId:string)=>join(cwd,".pi","study-workflow-host",projectId);
export function registerStudyWorkflowControl(sessionId:string,control:StudyWorkflowControl){controls().set(sessionId,control);return ()=>{if(controls().get(sessionId)===control)controls().delete(sessionId);};}
function controlFor(sessionId:string){const control=controls().get(sessionId);if(!control)throw new Error("当前学习会话的 pi-CAW 未连接；请重新连接后查看已保存任务。");return control;}
function taskFor(sessionId:string,taskId:string){const task=tasks().get(taskId);if(!task||task.record.sessionId!==sessionId)throw new Error("Study Workflow task unavailable in this conversation");return task;}
function storagePaths(){const database=resolve(process.env.PI_LEARNING_HARNESS_DIR||join(getAgentDir(),"learning-harness"),"learning-harness.sqlite");return [database,`${database}-wal`,`${database}-shm`];}
function domainFor(record:RecordTask){return createStudyWorkflowDomain({...record,storagePaths:storagePaths(),getContext:()=>studyContext(record.sessionId,record.phaseRevision,{reconcilePhase:false}),verifySource:async source=>{await readExactStudySourceBytes(source,256*1024*1024);}});}
function view(record:RecordTask){return {taskId:record.taskId,workflowId:STUDY_WORKFLOW_ID,question:record.question,sourceCount:record.selectedSources.length,createdAt:record.createdAt,runId:record.runId,startState:courseWorkflowStartState(record),started:record.startState==="confirmed",startError:record.startError,startLookupError:record.startLookupError};}
async function save(record:RecordTask){const path=join(record.journalDirectory,"host-task.json"),temporary=`${path}.${randomUUID()}.tmp`,handle=await open(temporary,"wx");try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}await rename(temporary,path);}
export function studyWorkflowTaskInputs(record:Pick<RecordTask,"taskId"|"requestId"|"question">){return {taskId:record.taskId,requestId:record.requestId,question:record.question};}
export async function prepareStudyWorkflowTask(sessionId:string,input:StudyWorkflowPrepareInput){
  if(typeof input.question!=="string"||!input.question.trim()||input.question.length>16000||Object.keys(input).some(key=>!["question","sourceIds"].includes(key)))throw new Error("Provide a bounded current Study question");
  const context=await studyContext(sessionId),available=context.host.listSources(context.scope).filter(source=>source.current);
  const ids=input.sourceIds??preferredStudySources(available.filter(source=>source.sourceRole==="primary")).map(source=>source.sourceId);
  if(!Array.isArray(ids)||ids.length>32||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"||!available.some(source=>source.sourceId===id)))throw new Error("Select at most 32 distinct current sources from this Study project");
  const selectedSources=ids.map(id=>{const source=available.find(source=>source.sourceId===id)!;return {sourceId:id,sourceHash:source.contentHash,version:source.version};});
  const cwd=resolve(context.project.cwd),taskId=randomUUID(),journalDirectory=join(root(cwd,context.project.id),taskId),taskDirectory=join(cwd,".pi","study-workflow-tasks",context.project.id,taskId);
  const record:RecordTask={version:1,sessionId,projectId:context.project.id,phase:context.phase.phase,phaseRevision:context.phase.revision,cwd,taskId,question:input.question,taskDirectory,journalDirectory,selectedSources,createdAt:new Date().toISOString(),requestId:randomUUID()};
  const domain=domainFor(record);await domain.prepareContext();await save(record);tasks().set(taskId,{record,domain});
  console.info("[study-workflow] prepared",{sessionId,taskId,projectId:record.projectId,phaseRevision:record.phaseRevision,sourceCount:ids.length});return view(record);
}
export async function restoreStudyWorkflowTasks(sessionId:string){
  const context=await studyContext(sessionId),cwd=resolve(context.project.cwd),directory=root(cwd,context.project.id);let entries;
  try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  for(const entry of entries){if(!entry.isDirectory()||entry.isSymbolicLink())continue;const record:RecordTask=JSON.parse(await readFile(join(directory,entry.name,"host-task.json"),"utf8"));if(record.sessionId!==sessionId)continue;
    if(record.version!==1||record.projectId!==context.project.id||record.taskId!==entry.name||resolve(record.cwd)!==cwd||resolve(record.taskDirectory)!==join(cwd,".pi","study-workflow-tasks",context.project.id,entry.name)||resolve(record.journalDirectory)!==join(directory,entry.name))throw new Error("Study Workflow private binding is corrupt");
    courseWorkflowStartState(record);if(!tasks().has(record.taskId))tasks().set(record.taskId,{record,domain:domainFor(record)});if(record.runId)registryScope(sessionId).knownRuns.add(record.runId);
  }
}
export async function listStudyWorkflowTasks(sessionId:string){await restoreStudyWorkflowTasks(sessionId);const rows=await controlFor(sessionId)("list",{});if(!Array.isArray(rows))throw new Error("Invalid Workflow catalog");const row=rows.find(item=>item.id===STUDY_WORKFLOW_ID);const disabledReason=!row?"尚未安装 study-explanation Workflow。":row.status!=="ready"?`Workflow 状态为 ${row.status}；需要 Ready。`:!row.enabled?"Workflow 已停用。":row.validation?.valid!==true?"Workflow 验证失败。":null;return {workflow:{id:STUDY_WORKFLOW_ID,ready:!disabledReason,revision:row?.revision_hash,disabledReason},tasks:[...tasks().values()].filter(task=>task.record.sessionId===sessionId).map(task=>view(task.record))};}
async function preflight(sessionId:string,taskId:string){const task=taskFor(sessionId,taskId),result=await task.domain.registry.study_task_context.execute({input:{taskId},context:{run_id:`preflight-${taskId}`,node_id:"context",attempt_id:randomUUID(),workspace:task.record.taskDirectory}});if(result.exit_code!==0)throw new Error(result.diagnostic);return result.output;}
type RunState={run_id:string;main_actor:string;workflow_id:string;inputs:Record<string,unknown>;permissions:{workspace:string};status:string;updated_at:string;error?:unknown;nodes:Record<string,{status:string;output?:{taskId?:string;succeeded?:boolean;bindingSha256?:string;answerSha256?:string;note?:{noteId:string;revision:number;contentHash:string}};error?:unknown}>};
async function exactRun(sessionId:string,record:RecordTask){const run=await controlFor(sessionId)("get",{run_id:record.runId}) as RunState;if(!run||run.run_id!==record.runId||run.main_actor!==sessionId||run.workflow_id!==STUDY_WORKFLOW_ID||canonical(run.inputs)!==canonical(studyWorkflowTaskInputs(record))||resolve(run.permissions?.workspace??"")!==record.taskDirectory)throw new Error("Study Run differs from its exact private task");return run;}
export async function startStudyWorkflowTask(sessionId:string,taskId:string) {
  const starting=globalThis.__piStudyWorkflowStarting??=new Set<string>();
  if(starting.has(taskId))throw new Error("Study task is already starting");
  starting.add(taskId);
  try {
    const task=taskFor(sessionId,taskId);
    if(task.record.runId) {
      await observeCourseWorkflowLaunch(task.record,()=>exactRun(sessionId,task.record),save);
      if(!courseWorkflowLaunchCanRetry(task.record))throw new Error(`Task is already bound to Run ${task.record.runId}; inspect its status`);
      task.record=resetRefusedCourseWorkflowLaunch(task.record);await save(task.record);
    }
    const catalog=await listStudyWorkflowTasks(sessionId);
    if(!catalog.workflow.ready||!catalog.workflow.revision)throw new Error(catalog.workflow.disabledReason??"Workflow is not Ready");
    await preflight(sessionId,taskId);
    const next={...task.record,runId:`run-${randomUUID()}`,workflowRevision:catalog.workflow.revision};
    await dispatchCourseWorkflowLaunch(next,()=>controlFor(sessionId)("run",{workflow_id:STUDY_WORKFLOW_ID,revision_hash:next.workflowRevision,
      run_id:next.runId,workspace:next.taskDirectory,access:"read_only",allowed_paths:["."],constraints:{allowed_paths:["."]},inputs:studyWorkflowTaskInputs(next)}),
      ()=>exactRun(sessionId,next),async updated=>{
        await save(updated);task.record=updated;registryScope(sessionId).knownRuns.add(updated.runId!);
        console.info("[study-workflow] launch observation",{sessionId,taskId,runId:updated.runId,state:updated.startState,error:updated.startError});
      });
    return view(task.record);
  } finally {starting.delete(taskId);}
}
export async function statusStudyWorkflowTask(sessionId:string,taskId:string){await restoreStudyWorkflowTasks(sessionId);const task=taskFor(sessionId,taskId),run=await observeCourseWorkflowLaunch(task.record,()=>exactRun(sessionId,task.record),save);if(!run)return {...view(task.record),run:null,response:null};let response:null|{answer:string;noteId:string}=null;const commit=recordCommit(run,task.record);if(run.status==="succeeded"&&commit?.status==="succeeded"){const output=commit.output;if(output?.taskId!==taskId||output.succeeded!==true||output.bindingSha256!==task.domain.binding.bindingSha256||!output.note)throw new Error("Successful Study Run lacks its exact Host receipt");const context=await studyContext(sessionId,task.record.phaseRevision),note=context.host.getKnowledge(context.scope).notes.find(note=>note.noteId===output.note?.noteId);if(!note||note.revision!==output.note.revision||note.contentHash!==output.note.contentHash||createHash("sha256").update(note.body).digest("hex")!==output.answerSha256)throw new Error("Study note differs from its saved Run receipt");response={answer:note.body,noteId:note.noteId};}return {...view(task.record),run:{runId:run.run_id,status:run.status,updatedAt:run.updated_at,error:run.error},response};}
export async function cancelStudyWorkflowTask(sessionId:string,taskId:string){const task=taskFor(sessionId,taskId);await exactRun(sessionId,task.record);await controlFor(sessionId)("cancel",{run_id:task.record.runId});return statusStudyWorkflowTask(sessionId,taskId);}
/** All model/API origins must match the exact Host start intent and pinned public contracts. */
export async function assertStudyWorkflowRunScope(sessionId:string,args:Record<string,unknown>){
  const input=args.inputs as Record<string,unknown>|undefined;if(!input||typeof input.taskId!=="string")throw new Error("Learning execution requires a privately prepared Study task");await restoreStudyWorkflowTasks(sessionId);const task=taskFor(sessionId,input.taskId),record=task.record;
  const constraints=args.constraints as Record<string,unknown>|undefined;
  if(args.workflow_id!==STUDY_WORKFLOW_ID||args.revision_hash!==record.workflowRevision||args.run_id!==record.runId||resolve(String(args.workspace??""))!==record.taskDirectory||args.access!=="read_only"||canonical(input)!==canonical(studyWorkflowTaskInputs(record))||JSON.stringify(args.allowed_paths)!==JSON.stringify(["."])||JSON.stringify(constraints?.allowed_paths)!==JSON.stringify(["."]))throw new Error("Learning Run does not match the privately bound explanation task");
  const commitNodeId=assertStudyExplanationGraph(args.workflow);if(record.commitNodeId&&record.commitNodeId!==commitNodeId)throw new Error("Study finalizer changed within its pinned revision");record.commitNodeId=commitNodeId;await save(record);
  const contracts=args.host_tool_contracts as unknown[];
  if(!Array.isArray(contracts)||contracts.length!==2||studyWorkflowToolContracts().some(expected=>!contracts.some(actual=>hostToolContractsCompatible(actual,expected))))throw new Error("Learning Workflow must bind only the compatible registered Study context and response tools");
  if(Object.keys(constraints??{}).some(key=>key!=="allowed_paths"))throw new Error("Study task does not grant additional execution constraints");
  await preflight(sessionId,record.taskId);
}
function registryScope(sessionId:string):Scope{const scopes=globalThis.__piStudyWorkflowScopes??=new Map<string,Scope>();const prior=scopes.get(sessionId);if(prior)return prior;const admitted=new Map<string,Domain>(),knownRuns=new Set<string>(),attemptKey=(id:string,context:{run_id:string;node_id:string;attempt_id:string})=>JSON.stringify([id,context.run_id,context.node_id,context.attempt_id]);
  const registry=Object.fromEntries(studyWorkflowToolContracts().map(contract=>{const identity=STUDY_WORKFLOW_TOOL_IDENTITIES[contract.id];return [contract.id,{identity,contract,attestation:{qualified:true,cancellable:true,effect_observation:true,tool_identity:identity,broker_id:"pi-own-study-workflow-v1",evidence_sha256:createHash("sha256").update(JSON.stringify({identity,protocol:"exact-session-task-run-source-binding-readonly-note-ledger"})).digest("hex"),get storage_capabilities(){const records=[...tasks().values()].filter(task=>task.record.sessionId===sessionId).map(task=>task.record);return {write_files:contract.id==="study_response_commit"?storagePaths():[],write_directories:contract.id==="study_response_commit"?records.map(record=>record.journalDirectory):[]};}},execute:(invocation:Parameters<StudyWorkflowBroker["execute"]>[0])=>{const task=taskFor(sessionId,invocation.input.taskId);if(task.record.runId!==invocation.context.run_id||!knownRuns.has(invocation.context.run_id))throw new Error("Study broker requires its exact admitted Run");const key=attemptKey(contract.id,invocation.context),previous=admitted.get(key);if(previous&&previous!==task.domain)throw new Error("Study attempt changed its task");admitted.set(key,task.domain);return task.domain.registry[contract.id].execute(invocation);},cancel:async(invocation:Parameters<StudyWorkflowBroker["cancel"]>[0])=>{const domain=admitted.get(attemptKey(contract.id,invocation.context));if(domain)return domain.registry[contract.id].cancel(invocation);if(!knownRuns.has(invocation.context.run_id))throw new Error("Study Run admission history unavailable; reconcile the original Host owner");return {termination_confirmed:true as const,evidence:[{kind:"study-operation-not-admitted",sha256:createHash("sha256").update(JSON.stringify([sessionId,invocation.context])).digest("hex")}],effects:{observed:true as const,changed_paths:[],outside_paths:[],artifacts:[]}};}}];}));const scope={registry,admitted,knownRuns};scopes.set(sessionId,scope);return scope;
}
function recordCommit(run:RunState,record:RecordTask){if(run.status==="succeeded"&&!record.commitNodeId)throw new Error("Study finalizer identity was not attested at admission");return record.commitNodeId?run.nodes?.[record.commitNodeId]:undefined;}
export function studyWorkflowRegistry(sessionId:string){return registryScope(sessionId).registry;}
