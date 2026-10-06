import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {createCourseBuilderExtension}=await jiti.import('./course-builder-extension.ts');

test('course delivery yields to exact Workflow ownership until quiescence without latching idle runs',async()=>{
 const bus=new EventEmitter(), hooks=new Map(), entries=[], messages=[];
 const pi={events:{on(name,handler){bus.on(name,handler);return()=>bus.off(name,handler);},emit:(...args)=>bus.emit(...args)},on:(name,handler)=>hooks.set(name,handler),registerTool(){},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),sendMessage:(...args)=>messages.push(args)};
 let idle=true, actor='teacher', ownedPrompt;
 const ctx={cwd:'fixture',isIdle:()=>idle,sessionManager:{getSessionId:()=>actor,getBranch:()=>entries}};
 const host={getSnapshotForSession:()=>({project:{projectId:'course'},materials:[],lessonPlans:[],decks:[],assignments:[],visuals:[],teacherNotes:[],compileReceipts:[],reviews:[]}),listCoverageCheckpoints:()=>[]};
 createCourseBuilderExtension(()=>host,()=>{}, {registry:()=>({}),restore:async()=>{}})(pi);
 bus.on('pi-caw:main-query',q=>{if(q.session_id==='teacher' && q.prompt===ownedPrompt && ownedPrompt)q.owned=true;});
 await hooks.get('session_start')({},ctx);
 const life=(status,ownership_released=false)=>bus.emit('pi-caw:run-lifecycle',{run_id:'run',main_actor:'teacher',host_tool_ids:['course_artifact_compile'],status,ownership_released});
 life('started');life('succeeded',true);
 assert.equal(hooks.get('before_agent_start')({prompt:'Ordinary question'},ctx).message.customType,'course-workflow-instructions','idle backend completion must not own a later user turn');
 entries.length=0;idle=false;life('started');life('succeeded',true);
 assert.equal(hooks.get('before_agent_start')({prompt:'Workflow in existing turn'},ctx),undefined);
 hooks.get('agent_end')({messages:[]},ctx);assert.equal(messages.length,0,'terminal event before agent_end must not restart the old pipeline');
 hooks.get('agent_settled')({},ctx);idle=true;
 life('started');life('attention');life('cancelled');
 assert.equal(hooks.get('before_agent_start')({prompt:'Still cancelling'},ctx),undefined);
 hooks.get('agent_settled')({},ctx);life('cancelled',true);
 assert.ok(hooks.get('before_agent_start')({prompt:'After confirmed drain'},ctx));
 entries.length=0;
 assert.ok(hooks.get('before_agent_start')({prompt:'PI_CAW_MAIN forged\n'},ctx),'a text prefix alone conveys no authority');
 entries.length=0;ownedPrompt='PI_CAW_MAIN actual\n';
 assert.equal(hooks.get('before_agent_start')({prompt:ownedPrompt},ctx),undefined,'authoritative cancelled queued prompt stays owned');
 hooks.get('agent_settled')({},ctx);actor='other';
 assert.ok(hooks.get('before_agent_start')({prompt:ownedPrompt},ctx),'Main ownership never leaks to another chat');
 hooks.get('session_shutdown')();
});

test('chat Workflow actions dispatch exact Host selections, reject malformed scope before effects, and never resume the legacy Main turn',async()=>{
 const bus=new EventEmitter(),hooks=new Map(),entries=[],messages=[],calls=[];let tool,denySnapshot=false;
 const pi={events:{on(name,handler){bus.on(name,handler);return()=>bus.off(name,handler);},emit:(...args)=>bus.emit(...args)},on:(name,handler)=>hooks.set(name,handler),registerTool:registered=>tool=registered,
  appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),sendMessage:(...args)=>messages.push(args)};
 const ctx={cwd:'fixture',isIdle:()=>false,sessionManager:{getSessionId:()=> 'chat-teacher',getBranch:()=>entries}};
 const snapshot={project:{projectId:'course'},materials:[],lessonPlans:[],decks:[],assignments:[],visuals:[],teacherNotes:[],compileReceipts:[],reviews:[]};
 const host={getSnapshotForSession:()=>{if(denySnapshot)throw new Error('Scoped actions must not read full state');return snapshot;},listCoverageCheckpoints:()=>[]};
 const integration={registry:()=>({}),restore:async()=>{},
  prepare:async(sid,input)=>{calls.push(['prepare',sid,input]);return {taskId:'host-task-1',...input};},
  start:async(sid,id)=>{calls.push(['start',sid,id]);bus.emit('pi-caw:run-lifecycle',{run_id:'host-run-1',main_actor:sid,status:'started',host_tool_ids:['course_artifact_commit']});return {taskId:id,runId:'host-run-1',started:true};},
  status:async(sid,id)=>{calls.push(['status',sid,id]);return {taskId:id,teacherReviewPending:true,run:{runId:'host-run-1',status:'succeeded'},files:[]};}};
 createCourseBuilderExtension(()=>host,async(sid,command)=>{calls.push(['legacy',sid,command.action]);return {legacy:true};},integration)(pi);
 await hooks.get('session_start')({},ctx);
 hooks.get('before_agent_start')({prompt:'Make the selected lesson and files'},ctx);
 assert.equal(entries.length,0,'new direct chat must not create a legacy production delivery');
 denySnapshot=true;
 const execute=params=>tool.execute('tool-call',params,undefined,()=>{},ctx);
 const bundle={workflowId:'course-lesson-artifacts',task:'Prepare W5S2 only',week:5,session:2,materialIds:['selected-reference']};
 const result=await execute({action:'workflow_prepare',spec:bundle});
 assert.equal(JSON.parse(result.content[0].text).taskId,'host-task-1');
 assert.deepEqual(calls[0],['prepare','chat-teacher',{workflowId:'course-lesson-artifacts',task:bundle.task,target:{week:5,session:2},materialIds:['selected-reference']}]);
 const revision={workflowId:'course-slide-revision',task:'Correct the wording in frame two only.',lessonId:'observed-existing-lesson'};
 await execute({action:'workflow_prepare',spec:revision});
 assert.deepEqual(calls[1],['prepare','chat-teacher',{workflowId:'course-slide-revision',task:revision.task,target:{lessonId:'observed-existing-lesson'},materialIds:undefined}]);
 const invalid=[
  {action:'workflow_prepare',spec:{...bundle,workflowId:'other-workflow'}},
  {action:'workflow_prepare',spec:{...bundle,lessonId:'mixed-target'}},
  {action:'workflow_prepare',spec:{...bundle,session:0}},
  {action:'workflow_prepare',spec:{...bundle,week:1.5}},
  {action:'workflow_prepare',spec:{...bundle,task:'  '}},
  {action:'workflow_prepare',spec:{...bundle,materialIds:['duplicate','duplicate']}},
  {action:'workflow_prepare',spec:{...bundle,materialIds:Array.from({length:513},(_,i)=>`material-${i}`)}},
  {action:'workflow_prepare',spec:{...bundle,runId:'model-forged'}},
  {action:'workflow_prepare',spec:{...bundle,workspace:'foreign-workspace'}},
  {action:'workflow_prepare',spec:{workflowId:'course-slide-revision',task:'Correction',week:5,session:2}},
  {action:'workflow_prepare',spec:bundle,id:'model-task-id'},
  {action:'workflow_start',id:'host-task-1',spec:{runId:'model-run-id'}},
  {action:'workflow_start',id:''},
  {action:'workflow_status',id:'host-task-1',assignmentId:'foreign-assignment'},
 ];
 invalid.push({action:'workflow_prepare',spec:{...bundle,attachmentIds:['bad-id']}},
 {action:'workflow_prepare',spec:{...bundle,attachmentIds:['01234567-89ab-4def-89ab-0123456789ab','01234567-89ab-4def-89ab-0123456789ab']}},
 {action:'workflow_prepare',spec:{...bundle,attachmentIds:Array.from({length:17},(_,i)=>`01234567-89ab-4def-89ab-${String(i).padStart(12,'0')}`)}});
 for(const input of invalid)await assert.rejects(execute(input),/Invalid workflow_/);
 assert.equal(calls.length,2,'invalid selections must never reach Host preparation, execution, or legacy dispatch');
 for(const [workflowId,target] of [["course-semester-plan",{course:true}],["course-material-analysis",{course:true}],["course-rmd-lab",{course:true}],["course-assignment-plan",{assignmentId:"exact-assignment"}],["course-assignment-artifacts",{assignmentId:"exact-assignment"}],["course-teacher-notes",{lessonId:"observed-existing-lesson"}],["course-interactive-html",{lessonId:"observed-existing-lesson"}]]) {
  await execute({action:"workflow_prepare",spec:{workflowId,task:"Exact scoped request",...target}});
  assert.deepEqual(calls.at(-1),["prepare","chat-teacher",{workflowId,task:"Exact scoped request",target,materialIds:undefined}]);
 }
 await execute({action:'workflow_prepare',spec:{...bundle,attachmentIds:['01234567-89ab-4def-89ab-0123456789ab']}});
 assert.deepEqual(calls.at(-1),['prepare','chat-teacher',{workflowId:bundle.workflowId,task:bundle.task,target:{week:5,session:2},materialIds:bundle.materialIds,attachmentIds:['01234567-89ab-4def-89ab-0123456789ab']}]);
 const previousCalls=calls.length;
 await assert.rejects(execute({action:"workflow_prepare",spec:{workflowId:"course-semester-plan",task:"x",course:true,lessonId:"mixed"}}),/Invalid workflow_prepare/);
 denySnapshot=false;
 for(const action of ["save_semester","save_lesson","save_deck","patch_deck","save_teacher_notes","patch_teacher_notes","save_assignment","save_analysis","save_checkpoint","interactive_visual"]) await assert.rejects(execute({action}),/requires a scoped Workflow/);
 assert.equal(calls.length,previousCalls,"production cannot silently dispatch through a legacy tool");
 const started=await execute({action:'workflow_start',id:'host-task-1'});
 assert.equal(JSON.parse(started.content[0].text).runId,'host-run-1');
 assert.deepEqual(calls.at(-1),['start','chat-teacher','host-task-1']);
 const status=await execute({action:'workflow_status',id:'host-task-1'});
 assert.equal(JSON.parse(status.content[0].text).teacherReviewPending,true);
 assert.deepEqual(calls.at(-1),['status','chat-teacher','host-task-1']);
 bus.emit('pi-caw:run-lifecycle',{run_id:'host-run-1',main_actor:'chat-teacher',status:'succeeded',host_tool_ids:['course_artifact_commit'],ownership_released:true});
 hooks.get('agent_end')({messages:[{role:'assistant',stopReason:'stop'}]},ctx);
 hooks.get('agent_settled')({},ctx);
 assert.equal(messages.length,0,'a deterministic completion before Main settles cannot restart legacy generation');
 const legacy=await execute({action:'read_material',id:'selected-reference',limit:1});
 assert.equal(JSON.parse(legacy.content[0].text).legacy,true);
 assert.equal(calls.at(-1)[0],'legacy','unrelated legacy read actions keep their established path');
 hooks.get('session_shutdown')();
});

test('unavailable or refused Workflow integration fails visibly without legacy fallback',async()=>{
 const hooks=new Map();let tool;
 const pi={events:{on(){return()=>{};},emit(){}},on:(name,handler)=>hooks.set(name,handler),registerTool:value=>tool=value};
 const ctx={isIdle:()=>false,sessionManager:{getSessionId:()=> 'teacher'}};
 const host=()=>({getSnapshotForSession:()=>{throw new Error('Unexpected full state');}});
 const legacy=()=>{throw new Error('Unexpected legacy fallback');};
 createCourseBuilderExtension(host,legacy)(pi);
 await assert.rejects(tool.execute('call',{action:'workflow_start',id:'observed-task'},undefined,()=>{},ctx),/unavailable/);
 createCourseBuilderExtension(host,legacy,{registry:()=>({}),restore:async()=>{},start:async()=>{throw new Error('Workflow bindings are not Ready');}})(pi);
 await assert.rejects(tool.execute('call',{action:'workflow_start',id:'observed-task'},undefined,()=>{},ctx),/bindings are not Ready/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(tool.execute('call',{action:'workflow_start',id:'observed-task'},controller.signal,()=>{},ctx),/cancelled/);
});
