import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url);
const { CourseBuilderHost,runCourseBuilderCommand }=await jiti.import("../../../packages/course-builder-host/src/index.ts");
const { CourseDeliveryLoop }=await jiti.import("./course-builder-delivery.ts");
const { createDefaultCourseBuilderProject }=await jiti.import("./course-builder-defaults.ts");
const { describeCourseBuilderLocalFile,readLinkedCourseBuilderMaterial,inspectLinkedCourseBuilderMaterial }=await jiti.import("./course-builder-local-materials.ts");
const { saveCourseLibraryFiles, addCourseMaterial }=await jiti.import("./course-builder-material-library.ts");
async function fixture(t, linked=true) {
  const root=await mkdtemp(join(tmpdir(),"pi-material-library-")),library=join(root,"teacher-existing-folder"),cwd=join(root,"app");
  await mkdir(library);await mkdir(cwd);await writeFile(join(library,"existing.md"),"Existing course reference");
  const db=new DatabaseSync(":memory:"),host=new CourseBuilderHost(db),project=host.createProject(createDefaultCourseBuilderProject());host.bindSession("teacher",project.projectId);
  if(linked)host.importMaterials("teacher",[await describeCourseBuilderLocalFile(library,join(library,"existing.md"))],1);
  t.after(async()=>{db.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+"pi-material-library-"));await rm(root,{recursive:true});});
  return {root,library,cwd,host,revision:linked?2:1};
}

test("material availability exposes deleted and changed links without reading their content",async t=>{
  const f=await fixture(t),material=f.host.getSnapshotForSession("teacher").materials[0];
  assert.equal((await inspectLinkedCourseBuilderMaterial(material)).status,"available");
  await writeFile(join(f.library,"existing.md"),"A changed reference with different bytes");
  assert.equal((await inspectLinkedCourseBuilderMaterial(material)).status,"changed");
  await rm(join(f.library,"existing.md"));
  assert.equal((await inspectLinkedCourseBuilderMaterial(material)).status,"missing");
  await assert.rejects(readLinkedCourseBuilderMaterial(material),/missing on disk.*Do not retry/s);
  assert.equal(f.host.getSnapshotForSession("teacher").materials.length,1,"diagnostics never silently remove historical source identities");
});
test("new arbitrary-extension user file goes to the existing external library and reads on demand",async t=>{
  const f=await fixture(t),source=join(f.cwd,"exercise.custom");await writeFile(source,"Additional exercise from the user");
  const initial=f.host.getSnapshotForSession("teacher").materials[0];
  const result=await addCourseMaterial(f.host,"teacher",{path:source,purpose:"Reference exercise"},f.revision);
  assert.equal(result.root,f.library);assert.equal(result.materials[0].path,join(f.library,"exercise.custom"));
  assert.equal(await readFile(result.materials[0].path,"utf8"),"Additional exercise from the user");
  assert.deepEqual(await readdir(f.cwd),["exercise.custom"]);
  const material=f.host.getMaterial("teacher",result.materials[0].materialId);
  assert.equal(material.extractedText,"");assert.equal(await readLinkedCourseBuilderMaterial(material),"Additional exercise from the user");
  assert.deepEqual(f.host.getMaterial("teacher",initial.materialId),initial);
  const replay=await addCourseMaterial(f.host,"teacher",{path:source},result.revision);assert.equal(replay.replay,true);assert.equal(replay.revision,result.revision);
});
test("conflicting filenames retain existing bytes and register a versioned filename",async t=>{
  const f=await fixture(t);const result=await saveCourseLibraryFiles(f.host,"teacher",[{name:"existing.md",bytes:Buffer.from("New reference revision")}],f.revision);
  assert.equal(await readFile(join(f.library,"existing.md"),"utf8"),"Existing course reference");
  assert.match(result.materials[0].name,/^existing-[a-f0-9]+\.md$/);
  assert.equal(f.host.getSnapshotForSession("teacher").materials.length,2);
});
test("actual Host material command binds and completes a library delivery, including verified replay",async t=>{
  const f=await fixture(t),source=join(f.cwd,"web-capture.md");await writeFile(source,"# User suggested reference\n\nRead this source on demand.");
  let task;const loop=new CourseDeliveryLoop({snapshot:()=>f.host.getSnapshotForSession("teacher"),load:()=>task,save:value=>{task=value;}});
  for(let attempt=0;attempt<2;attempt++) {
    loop.start("Add this source to the existing course materials");
    loop.route({kind:"materials",requirements:[{id:"import",text:"Register the reference in the course folder", verification:"materials"}]});
    const command={action:"add_material",expectedRevision:f.host.getProjectForSession("teacher").revision,spec:{path:source}};
    const result=await runCourseBuilderCommand(f.host,"teacher",loop.prepare(command),{addMaterial:(spec,revision)=>addCourseMaterial(f.host,"teacher",spec,revision)});
    loop.observe(command,result);
    for(const id of loop.materialImportsToVerify()) await runCourseBuilderCommand(f.host,"teacher",{action:"read_material",id,limit:1},{readLinkedMaterial:readLinkedCourseBuilderMaterial});
    assert.equal(loop.finish({checks:[]}).status,"completed");
  }
  assert.equal(f.host.getSnapshotForSession("teacher").materials.length,2);
});
test("missing or unconfigured roots fail without inventing a folder; runtime failure rolls back only newly written files",async t=>{
  const f=await fixture(t,false),files=[{name:"new.md",bytes:Buffer.from("A new source")}];
  await assert.rejects(saveCourseLibraryFiles(f.host,"teacher",files,1),/链接你的素材文件夹/);
  f.host.importMaterials("teacher",[await describeCourseBuilderLocalFile(f.library,join(f.library,"existing.md"))],1);
  await assert.rejects(saveCourseLibraryFiles(f.host,"teacher",files,2,f.cwd),/已链接/);
  let calls=0;await assert.rejects(saveCourseLibraryFiles(f.host,"teacher",files,2,undefined,()=>{if(++calls===2)throw new Error("runtime changed");}),/runtime changed/);
  assert.deepEqual(await readdir(f.library),["existing.md"]);
  assert.equal(f.host.getSnapshotForSession("teacher").materials.length,1);
  await assert.rejects(saveCourseLibraryFiles(f.host,"teacher",files,1),/版本已变化/);
});
