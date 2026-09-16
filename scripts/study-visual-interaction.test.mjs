import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { contentHash } from '../packages/harness-core/src/index.ts';
import { StudyResearchHost } from '../packages/study-research-host/src/index.ts';
import { StudyTeachingHost, compareBrowserVisualObservations } from '../packages/study-research-host/src/study-teaching-host.ts';
import { CourseBuilderHost } from '../packages/course-builder-host/src/index.ts';

function samples(targetHash) {
 const specification={version:1,targetHash,scope:'Synthetic scalar position only',assumptions:['SVG user coordinates'],oracle:{kind:'hand-calculation',description:'Independently specified scalar positions',material:'0 maps to 0, 1 to 1, -1 to -1, 10 to 10',sourceReferences:[]},cases:['ordinary','boundary','degenerate','interaction'].map((category,i)=>({id:category,category,description:category,inputs:{x:[1,0,-1,10][i]},expected:[{path:['metrics','x'],value:[1,0,-1,10][i],absoluteTolerance:0,relativeTolerance:0},{path:['elements',0,'attrs','cx'],value:[1,0,-1,10][i],absoluteTolerance:0,relativeTolerance:0}]}))};
 const observations=specification.cases.map(c=>({caseId:c.id,inputHash:contentHash(c.inputs),scene:{elements:[{tag:'circle',attrs:{cx:String(c.inputs.x)}}]}}));
 return {specification,observations};
}
test('actual SVG string attributes use the independent oracle; missing, stale, and wrong interaction observations cannot pass',()=>{
 const {specification,observations}=samples(contentHash('visual'));
 assert.equal(compareBrowserVisualObservations(specification,observations).status,'passed');
 assert.equal(compareBrowserVisualObservations(specification,observations.slice(1)).status,'inconclusive');
 const wrong=structuredClone(observations);wrong[3].scene.elements[0].attrs.cx='1';
 assert.equal(compareBrowserVisualObservations(specification,wrong).status,'failed');
 assert.throws(()=>compareBrowserVisualObservations(specification,[{...observations[0],inputHash:contentHash('changed')}]),/identity changed/);
 assert.throws(()=>compareBrowserVisualObservations(specification,[observations[0],observations[0]]),/Duplicate/);
 const invisible=structuredClone(specification);invisible.cases[0].expected=invisible.cases[0].expected.slice(0,1);
 assert.throws(()=>compareBrowserVisualObservations(invisible,observations),/visible SVG/);
});

test('formal visual use binds reviewed numerical and browser evidence, not completion order; changed evidence and runtime revoke readiness',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("CREATE TABLE pi_project_workspace(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE pi_project_member(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL); INSERT INTO pi_project_workspace VALUES ('p','{\"id\":\"p\"}'); INSERT INTO pi_project_member VALUES ('s','p');");
  const study=new StudyResearchHost(db),teaching=new StudyTeachingHost(db,study,new CourseBuilderHost(db));study.bindSession('p','s');
  const scope={projectId:'p',sessionId:'s',expectedPhaseRevision:1};
  const creator=study.registerTrustedRunnerContext(scope,'creator'),validator=study.registerTrustedRunnerContext(scope,'numeric'),reviewer=study.registerTrustedRunnerContext(scope,'independent-reviewer');
  const runtime=contentHash('runtime');
  const visual=study.createVisualizationDraft(scope,{creatorContextId:creator.contextId,purpose:'Synthetic engineering fixture',code:'return {elements:[]}',inputs:{x:1},inputHashes:{},environmentHash:runtime},0);
  const target={targetKind:'visualization',targetId:visual.visualizationId,targetRevision:visual.revision,targetHash:visual.contentHash};
  const finish=(kind,producer,extra={})=>{
   let task=study.reserveStudyTask(scope,{dispatchKey:crypto.randomUUID(),kind,producerContextId:producer.contextId,target,manifest:{codeHash:contentHash(kind),parameterHash:contentHash({}),inputHashes:extra,environmentHash:runtime},admission:{purpose:'Explicit synthetic protocol test; not academic evidence',language:'none',maxWallSeconds:30,maxMemoryMiB:64}}).task;
   for(const nextStatus of ['admitted','launching','running','succeeded'])task=study.transitionTaskFromFrozenAuthorization({taskId:task.taskId,expectedTaskRevision:task.revision,nextStatus,detail:'fixture'});
   return task;
  };
  const numeric=finish('validation',validator);
  study.recordValidationFromFrozenTask({...target,taskId:numeric.taskId,expectedTaskRevision:numeric.revision,status:'passed',findings:['Synthetic protocol fixture']});
  const {specification,observations}=samples(visual.contentHash);
  const record=()=>teaching.recordBrowserInteraction(scope,{visualizationId:visual.visualizationId,revision:1,targetHash:visual.contentHash,runtimeHash:runtime,numericalTaskId:numeric.taskId,specification,observations});
  record();
  let gate=teaching.visualGate(scope,visual.visualizationId,runtime);assert.equal(gate.ready,false);
  const oldReview=finish('review',reviewer,{visualEvidence:contentHash('old observations')});
  study.recordIndependentReviewFromFrozenTask({...target,taskId:oldReview.taskId,expectedTaskRevision:oldReview.revision,status:'passed',findings:['Late finish cannot prove current evidence reviewed']});
  assert.equal(teaching.visualGate(scope,visual.visualizationId,runtime).ready,false);
  gate=teaching.visualGate(scope,visual.visualizationId,runtime);
  const current=finish('review',reviewer,{visualEvidence:contentHash({programmaticChecks:gate.numerical,browserChecks:gate.interactions})});
  study.recordIndependentReviewFromFrozenTask({...target,taskId:current.taskId,expectedTaskRevision:current.revision,status:'passed',findings:['Synthetic exact evidence binding']});
  assert.equal(teaching.visualGate(scope,visual.visualizationId,runtime).ready,true);
  assert.equal(teaching.visualGate(scope,visual.visualizationId,contentHash('new runtime')).ready,false);
  record();assert.equal(teaching.visualGate(scope,visual.visualizationId,runtime).ready,false,'New browser receipt requires a new exact review');
  assert.equal(new StudyTeachingHost(db,study,new CourseBuilderHost(db)).visualGate(scope,visual.visualizationId,runtime).interactions.length,2);
 }finally{db.close();}
});
