import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
const dir=mkdtempSync(join(tmpdir(),"pi-course-builder-web-"));
process.env.PI_LEARNING_HARNESS_DIR=dir;
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {inspectModePackInventory,buildModePackRuntimePlanFromInventory}=await jiti.import("./mode-pack-inventory.ts");
const {resolveModePackSnapshot}=await jiti.import("../../../packages/profile-resource-host/src/index.ts");
const {parseCourseBuilderFiles}=await jiti.import("./course-builder-import.ts");
const extension=(await jiti.import("./course-builder-extension.ts")).default;
const service=await jiti.import("./course-builder-service.ts");

test.after(()=>{service.getCourseBuilderHost();rmSync(dir,{recursive:true,force:true});});
test("Course Builder mode resolves physical plugin and fixed guidance without shell tools",async()=>{
 const inventory=await inspectModePackInventory(dir);const definition=inventory.builtinPacks["course-builder"];
 assert.ok(definition);assert.deepEqual(definition.tools,[]);
 const snapshot=resolveModePackSnapshot({pack:definition,courseVersionId:null,catalog:inventory.catalog});
 const plan=buildModePackRuntimePlanFromInventory({snapshot,inventory,definition});
 assert.equal(plan.extensionPaths.length,1);assert.match(plan.extensionPaths[0],/course-builder-extension\.ts$/);
 assert.match(plan.systemPrompt,/teacher approval/i);assert.match(plan.systemPrompt,/Noi1r/);
});
test("Actual extension registers only a dedicated agent surface, with no teacher approval action",async()=>{
 const tools=[];extension({registerTool:tool=>tools.push(tool)});
 assert.deepEqual(tools.map(t=>t.name),["course_builder"]);
 const ctx={sessionManager:{getSessionId:()=>"test-unbound-session"}};
 const result=await tools[0].execute("call",{action:"state"},new AbortController().signal,undefined,ctx);
 assert.equal(JSON.parse(result.content[0].text),null);
 await assert.rejects(tools[0].execute("call",{action:"accept"},undefined,undefined,ctx),/not available/);
});
test("Web importer reads actual text/image bytes and rejects unsupported mixed input",async()=>{
 const files=await parseCourseBuilderFiles([new File(["# Course"],"course.md")]);
 assert.equal(files[0].extractedText,"# Course");assert.equal(files[0].kind,"markdown");
 await assert.rejects(parseCourseBuilderFiles([new File(["ok"],"valid.md"),new File(["bad"],"evil.exe")]),/Unsupported/);
 await assert.rejects(parseCourseBuilderFiles([new File(["bad"],"fake.png")]),/Invalid image/);
});
