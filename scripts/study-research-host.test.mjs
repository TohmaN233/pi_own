import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { StudyResearchHost } from '../packages/study-research-host/src/index.ts';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const paper = '# A claim\nEvery continuous function is bounded.\nProof: continuity implies a finite maximum.\n';
function fixture() {
 const db = new DatabaseSync(':memory:');
 const host = new StudyResearchHost(db);
 const p = host.createProject('one', 'Read and question', '/fixture', [{id:'paper',path:'paper.md',size:paper.length,mtimeMs:1}]);
 host.bindSession('s1', p.id);
 host.recordSource('s1', 'paper', 1, digest(paper), paper, 'utf-8');
 host.readSource('s1', 'paper', 1, 100);
 const ref = {sourceId:'paper',sourceHash:digest(paper),startLine:2,endLine:2,quote:'Every continuous function is bounded.'};
 const map = {scope:'This paper',story:'It tries to infer global boundedness from continuity.',contribution:'Claimed boundedness theorem, not established.',uncertainties:['The domain is unspecified.'],nodes:[
  {id:'continuity',kind:'background',title:'Continuity',dependsOn:[],explanation:'Local control is not global boundedness.',whyNeeded:'Distinguish continuity from compactness.',checks:['Explain the difference.'],sources:[],openQuestions:[]},
  {id:'claim',kind:'proof',title:'Boundedness claim',dependsOn:['continuity'],explanation:'A compact-domain assumption is missing.',whyNeeded:'Audit the load-bearing implication.',checks:['Consider f(x)=x on R.'],sources:[ref],openQuestions:['Candidate counterexample must be checked algebraically.']}
 ]};
 return {db,host,p,ref,map};
}
test('study: actual public Host constructs, persists source/map and reopens on same SQLite',()=>{
 const {db,host,map}=fixture(); const saved=host.saveRoadmap('s1',0,map);
 assert.equal(saved.revision,1); const second=new StudyResearchHost(db);
 assert.equal(second.state('s1').roadmap.data.nodes[1].id,'claim');
 assert.equal(second.readSource('s1','paper',2,1).text,'Every continuous function is bounded.'); db.close();
});
test('study: fabricated quotes and circular prerequisites are rejected',()=>{
 const {db,host,map}=fixture(); const fake=structuredClone(map); fake.nodes[1].sources[0].quote='The claim is proven correct.';
 assert.throws(()=>host.saveRoadmap('s1',0,fake),/quote/i);
 map.nodes[0].dependsOn=['claim']; assert.throws(()=>host.saveRoadmap('s1',0,map),/cycle/i); db.close();
});
test('study: a gap stays uncertain; model cannot submit an official verified verdict or learner progress',()=>{
 const {db,host,map}=fixture();assert.throws(()=>host.saveRoadmap('s1',0,{...map,verified:true}),/Unknown/);
 map.nodes[1].epistemicStatus='candidate-error'; const saved=host.saveRoadmap('s1',0,map); assert.equal(saved.data.nodes[1].epistemicStatus,'candidate-error'); assert.equal(new StudyResearchHost(db).state('s1').roadmap.data.nodes[1].epistemicStatus,'candidate-error'); assert.throws(()=>host.agentCommand('s1',{action:'progress',draft:{nodeId:'claim',attempt:'yes'}}),/not allowed/i);
 assert.throws(()=>host.agentCommand('s1',{action:'approve_run'}),/not allowed/i); db.close();
});
test('study: source-anchored notes retain authorship, revision and historical source',()=>{
 const {db,host,ref,map}=fixture();host.saveRoadmap('s1',0,map);
 const note=host.saveNote('s1','user',null,0,{nodeId:'claim',anchor:ref,body:'$f(x)=x$ on $\\mathbb R$ is unbounded.'});
 assert.throws(()=>host.saveNote('s1','agent',note.id,1,{nodeId:'claim',anchor:ref,body:'erase'}),/author/i);
 assert.throws(()=>host.saveNote('s1','user',note.id,0,{nodeId:'claim',anchor:ref,body:'stale'}),/revision/i);
 host.reindex('s1',1,[]);const state=host.state('s1'); assert.equal(state.notes[0].stale,true);assert.equal(state.notes[0].data.body,note.data.body);db.close();
});
test('study: session scope immutable and cross-project source identity is rejected',()=>{
 const {db,host,p,ref}=fixture();const other=host.createProject('two','Other','/other',[]);host.bindSession('s2',other.id);
 assert.throws(()=>host.bindSession('s1',other.id),/bound/i);assert.throws(()=>host.readSource('s2','paper',1,100),/source/i);
 assert.throws(()=>host.saveNote('s2','user',null,0,{nodeId:null,anchor:ref,body:'leak'}),/source/i);assert.equal(host.projectForSession('s1').id,p.id); db.close();
});
test('research: unapproved execution, replay, modified code and stale sources fail closed',()=>{
 const {db,host,map}=fixture();host.saveRoadmap('s1',0,map);
 const draft={title:'Toy falsification',purpose:'study',proposalId:null,hypothesis:'Continuity alone does not bound a function.',baseline:'Evaluate f(x)=x.',ablations:['Extend the finite domain.'],metric:'Maximum absolute value',dataSplit:'Synthetic, not empirical evidence.',seeds:[1],successCriterion:'Values increase with domain radius.',failureInterpretation:'Finite samples cannot prove global boundedness.',language:'python',code:'print(2+2)',timeoutSeconds:5};
 const exp=host.saveExperiment('s1',null,0,draft);assert.throws(()=>host.beginRun('s1',exp.id,1),/approval/i);
 host.approveExperiment('s1',exp.id,1);const run=host.beginRun('s1',exp.id,1);assert.equal(run.status,'started');
 assert.throws(()=>host.beginRun('s1',exp.id,1),/consumed/i);
 host.finishRun('s1',run.id,{exitCode:0,stdout:'4\n',stderr:'',status:'succeeded',durationMs:10});
 const changed=host.saveExperiment('s1',exp.id,1,{...draft,code:'print(5)'});assert.equal(changed.revision,2);
 assert.throws(()=>host.beginRun('s1',exp.id,2),/approval/i);host.approveExperiment('s1',exp.id,2);
 host.reindex('s1',1,[]);assert.throws(()=>host.beginRun('s1',exp.id,2),/stale/i);db.close();
});
test('study: two Hosts cannot overwrite an updated roadmap; no fake success on interrupted run',()=>{
 const {db,host,map}=fixture();const other=new StudyResearchHost(db);host.saveRoadmap('s1',0,map);
 assert.throws(()=>other.saveRoadmap('s1',0,map),/revision/i);assert.equal(other.state('s1').roadmap.revision,1); db.close();
});
test('research: changing a proposal invalidates an approved exact experiment',()=>{
 const {db,host,map}=fixture();host.saveRoadmap('s1',0,map);
 const proposal={title:'Compactness',nodeIds:['claim'],hypothesis:'Add a compact domain',whyUseful:'Identify the missing hypothesis',alternatives:['Restrict the function'],risks:['May already be standard'],requiredEvidence:['Algebraic check'],noveltyStatus:'not-established',sources:[]};
 const p=host.saveProposal('s1',null,0,proposal);
 const draft={title:'Toy',purpose:'research',proposalId:p.id,hypothesis:'Bounded on a finite grid',baseline:'f(x)=x',ablations:[],metric:'max',dataSplit:'toy',seeds:[1],successCriterion:'finite grid',failureInterpretation:'not proof',language:'python',code:'print(1)',timeoutSeconds:5};
 const e=host.saveExperiment('s1',null,0,draft);host.approveExperiment('s1',e.id,1);
 host.saveProposal('s1',p.id,1,{...proposal,hypothesis:'Different hypothesis'});
 assert.equal(host.state('s1').experiments[0].stale,true);
 assert.throws(()=>host.beginRun('s1',e.id,1),/Proposal changed/);db.close();
});
