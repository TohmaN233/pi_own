import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
const dir=mkdtempSync(join(tmpdir(),"pi-course-builder-web-"));
const previousHarnessDirectory=process.env.PI_LEARNING_HARNESS_DIR;
process.env.PI_LEARNING_HARNESS_DIR=dir;
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {inspectModePackInventory,buildModePackRuntimePlanFromInventory,collectModePackRuntimeEvidence}=await jiti.import("./mode-pack-inventory.ts");
const {verifyModePackRuntime}=await jiti.import("../../../packages/mode-pack-host/src/index.ts");
const {resolveModePackSnapshot}=await jiti.import("../../../packages/profile-resource-host/src/index.ts");
const {parseCourseBuilderFiles}=await jiti.import("./course-builder-import.ts");
const extension=(await jiti.import("./course-builder-extension.ts")).default;
const {getLearningHarness}=await jiti.import("./harness-server.ts");

test.after(()=>{
 getLearningHarness().close();
 globalThis.__piLearningHarness=undefined;
 if(previousHarnessDirectory===undefined)delete process.env.PI_LEARNING_HARNESS_DIR;
 else process.env.PI_LEARNING_HARNESS_DIR=previousHarnessDirectory;
 rmSync(dir,{recursive:true,force:true});
});
test("Course Builder mode resolves physical plugin and fixed guidance without shell tools",async()=>{
 const inventory=await inspectModePackInventory(dir);const definition=inventory.builtinPacks["course-builder"];
 assert.ok(definition);assert.deepEqual(definition.tools,[]);
 const snapshot=resolveModePackSnapshot({pack:definition,courseVersionId:null,catalog:inventory.catalog});
 const plan=buildModePackRuntimePlanFromInventory({snapshot,inventory,definition});
 assert.equal(plan.extensionPaths.length,2);assert.ok(plan.extensionPaths.some(path=>/course-builder-extension\.ts$/.test(path)));assert.ok(plan.extensionPaths.some(path=>/math-visualization-extension\.ts$/.test(path)));
 assert.match(plan.systemPrompt,/teacher approval/i);assert.match(plan.systemPrompt,/Noi1r/);
 assert.match(plan.systemPrompt,/assignment_state/u);assert.match(plan.systemPrompt,/read_assignment_material/u);
 const teachingSkills = ["education.lesson-blueprint","education.learning-to-learn","education.curriculum-continuity","education.evidence-ledger","shared.revision-discipline","education.learn-by-doing","education.visual-explanation"];
 for(const id of teachingSkills) {
  assert.ok(definition.components.some(c=>c.id===id&&c.required&&c.enabled), `${id} must be required in Course Builder`);
  const resource=inventory.resourcesByKey.get(`skill:${id}`);
  assert.ok(resource);
  assert.equal(resource.synthetic,false,`${id} must be a physical Skill`);
  assert.equal(resource.paths.length,1,`${id} must have one SKILL.md path`);
  assert.ok(plan.systemPrompt.includes(resource.text), `${id} full text must reach the system prompt`);
 }
 assert.match(plan.systemPrompt,/mode-pack-resource id="skill:teacher\.course-planning-beamer" contentHash="sha256:[a-f0-9]{64}"/);
});
test("resource verification rejects empty Skill bodies even when their markers survive",async()=>{
 const inventory=await inspectModePackInventory(dir),definition=inventory.builtinPacks.general;
 const snapshot=resolveModePackSnapshot({pack:definition,courseVersionId:null,catalog:inventory.catalog});
 const plan=buildModePackRuntimePlanFromInventory({snapshot,inventory,definition});
 const loadedSkills=plan.skillPaths.map(filePath=>({filePath}));
 const session={getActiveToolNames:()=>snapshot.tools,agent:{state:{systemPrompt:plan.systemPrompt}},resourceLoader:{getSkills:()=>({skills:loadedSkills}),getExtensions:()=>({extensions:[]}),getPrompts:()=>({prompts:[]}),getThemes:()=>({themes:[]})}};
 assert.equal(verifyModePackRuntime(snapshot,collectModePackRuntimeEvidence(session,plan),plan.expected).verified,true);
 const prompt=plan.systemPrompt.replace(/(<mode-pack-resource id="[^"]+" contentHash="[^"]+">)\n[\s\S]*?\n(<\/mode-pack-resource>)/g,"$1\n\n$2");
 session.agent.state.systemPrompt=prompt;
 const result=verifyModePackRuntime(snapshot,collectModePackRuntimeEvidence(session,plan),plan.expected);
 assert.equal(result.verified,false,"a Skill name and snapshot hash cannot prove its body was loaded");
});
test("Actual extension registers only a dedicated agent surface, with no teacher approval action",async()=>{
 const tools=[];const events=[];extension({registerTool:tool=>tools.push(tool),on:(name)=>events.push(name)});
 assert.ok(events.includes("before_agent_start"));assert.ok(events.includes("agent_end"));
 assert.deepEqual(tools.map(t=>t.name),["course_builder"]);
 const ctx={sessionManager:{getSessionId:()=>"test-unbound-session",getBranch:()=>[]}};
 const result=await tools[0].execute("call",{action:"state"},new AbortController().signal,undefined,ctx);
 assert.equal(JSON.parse(result.content[0].text),null);
 await assert.rejects(tools[0].execute("call",{action:"accept"},undefined,undefined,ctx),/not available/);
});
test("Web importer reads text and retains unknown formats without extension filtering",async()=>{
 const files=await parseCourseBuilderFiles([new File(["# Course"],"course.md"),new File([Uint8Array.of(0,1,2,3)],"notes.docx")]);
 assert.equal(files[0].extractedText,"# Course");assert.equal(files[0].kind,"markdown");
 assert.equal(files[1].kind,"asset");
 assert.match(files[1].extractedText,/no text adapter/i);
});
