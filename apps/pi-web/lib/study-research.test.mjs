import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createJiti} from 'jiti';
const dir=mkdtempSync(join(tmpdir(),'study-web-'));const oldHarness=process.env.PI_LEARNING_HARNESS_DIR,oldAgent=process.env.PI_CODING_AGENT_DIR;
process.env.PI_LEARNING_HARNESS_DIR=join(dir,'harness');process.env.PI_CODING_AGENT_DIR=join(dir,'agent');
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {inspectModePackInventory,buildModePackRuntimePlanFromInventory}=await jiti.import('./mode-pack-inventory.ts');
const {resolveModePackSnapshot}=await jiti.import('../../../packages/profile-resource-host/src/index.ts');
const {getLearningHarness}=await jiti.import('./harness-server.ts');
const service=await jiti.import('./study-research-service.ts');
const rpc=await jiti.import('./rpc-manager.ts');
const {createStudyResearchExtension}=await jiti.import('./study-research-extension.ts');
const {createMathVisualizationExtension}=await jiti.import('./math-visualization-extension.ts');
const {MathVisualizationHost}=await jiti.import('../../../packages/math-visualization-host/src/index.ts');
const api=await jiti.import('../app/api/study-research/route.ts');
const {projectWorkspaceList,createProjectConversation,moveProjectConversation}=await jiti.import('./project-workspaces-service.ts');
test.after(()=>{getLearningHarness().close();globalThis.__piLearningHarness=undefined;if(oldHarness===undefined)delete process.env.PI_LEARNING_HARNESS_DIR;else process.env.PI_LEARNING_HARNESS_DIR=oldHarness;if(oldAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgent;rmSync(dir,{recursive:true,force:true});});
test('Study and Course Builder resolve the SAME physical math plugin, with complete physical Skills and no default shell',async()=>{
 const inv=await inspectModePackInventory(dir);
 for(const name of ['study-research','course-builder']){const pack=inv.builtinPacks[name];assert.ok(pack);assert.deepEqual(pack.tools,[]);const snapshot=resolveModePackSnapshot({pack,courseVersionId:null,catalog:inv.catalog});const plan=buildModePackRuntimePlanFromInventory({snapshot,inventory:inv,definition:pack});assert.ok(plan.extensionPaths.some(p=>p.endsWith('math-visualization-extension.ts')));assert.ok(plan.systemPrompt.includes('Shared mathematical visualization'));if(name==='study-research'){assert.ok(plan.systemPrompt.includes('Critical study, not unquestioning summarization'));assert.equal(plan.extensionPaths.length,2);}}
});
test('native study extension awaits exact runtime identity and cannot write after cancellation/mode change',async()=>{
 const tools=[];const wrapper={};let snapshotId='one';let wrote=false;
 const ext=createStudyResearchExtension(async(_sid,_cmd,assertActive)=>{snapshotId='two';await assertActive();wrote=true;},async()=>({wrapper,snapshotId}));ext({registerTool:t=>tools.push(t)});
 assert.deepEqual(tools.map(t=>t.name),['study_research']);
 await assert.rejects(()=>tools[0].execute('a',{action:'save_note'},new AbortController().signal,null,{sessionManager:{getSessionId:()=>'s1'}}),/Runtime changed/);assert.equal(wrote,false);
 const actions=tools[0].parameters.properties.action.anyOf.map(v=>v.const);assert.ok(!actions.some(a=>/approve|run_experiment|progress/.test(a)));
});
test('actual math extension registers a shared scoped tool and uses numeric Host data',async()=>{
 const db=new DatabaseSync(':memory:');const host=new MathVisualizationHost(db);const tools=[];const ext=createMathVisualizationExtension(async()=>({scope:'study:one',snapshotId:'x',wrapper:{}}),()=>host);ext({registerTool:t=>tools.push(t)});
 const params={action:'create',spec:{kind:'matrix2d',title:'test',purpose:'area',xLabel:'x',yLabel:'y',matrix:[[2,0],[0,3]]}};const result=await tools[0].execute('x',params,undefined,undefined,{sessionManager:{getSessionId:()=>'s1'}});const artifact=JSON.parse(result.content[0].text);assert.equal(artifact.data[1].x[2],2);assert.throws(()=>host.get('study:two',artifact.id),/not in/);db.close();
});
test('actual Study API creates native session, reads source, saves math notes and keeps project conversations bound',async()=>{
 const folder=join(dir,'papers');mkdirSync(folder);writeFileSync(join(folder,'paper.md'),'# Local source\nContinuity alone does not imply boundedness.\n');
 const request=body=>new Request('http://localhost/api/study-research',{method:'POST',headers:{host:'localhost','content-type':'application/json','x-study-user':'1'},body:JSON.stringify(body)});
 const created=await api.POST(request({action:'create',requestId:'test-one',title:'Critical paper',directory:folder}));assert.equal(created.status,200);const {project,sessionId}=await created.json();assert.ok(sessionId);
 const repeated=await api.POST(request({action:'create',requestId:'test-one',title:'Critical paper',directory:folder}));assert.equal((await repeated.json()).sessionId,sessionId);
 const source=await api.POST(request({action:'read_source',sessionId,id:project.sources[0].id}));assert.equal(source.status,200);const chunk=await source.json();assert.match(chunk.text,/Continuity/);
 const note=await api.POST(request({action:'save_note',sessionId,expectedRevision:0,draft:{nodeId:null,anchor:{sourceId:chunk.sourceId,sourceHash:chunk.sourceHash,startLine:2,endLine:2,quote:'Continuity alone does not imply boundedness.'},body:'Try $f(x)=x$ on $\\mathbb R$.'}}));assert.equal(note.status,200);assert.equal((await note.json()).data.author,'user');
 const listed=await projectWorkspaceList();assert.match(listed.conversations.find(c=>c.id===sessionId).href,/study-research/);
 const second=await createProjectConversation({projectId:project.id,requestId:'test-second',title:'Proof details'});assert.equal(service.getStudyHost().projectForSession(second.sessionId).id,project.id);assert.match(second.href,/study-research/);
 await service.activateStudyRuntime(sessionId); const runtime=await rpc.getGenericModePackStatus(sessionId);assert.equal(runtime.runtime.verified,true);assert.equal(runtime.runtime.binding.snapshot.profileId,'study-research');assert.deepEqual([...rpc.getRpcSession(sessionId).inner.getActiveToolNames()].sort(),['math_visualization','study_research']);await rpc.getRpcSession(sessionId).shutdown();
 await assert.rejects(()=>moveProjectConversation(sessionId,null),/绑定/);
 const bad=new Request('http://localhost/api/study-research',{method:'POST',headers:{host:'localhost',origin:'https://evil.invalid','content-type':'application/json','x-study-user':'1'},body:'{}'});assert.equal((await api.POST(bad)).status,403);
 const fake=new Request('http://localhost/api/study-research',{method:'POST',headers:{host:'localhost','content-type':'application/json'},body:JSON.stringify({action:'approve_experiment'})});assert.equal((await api.POST(fake)).status,403);
});
