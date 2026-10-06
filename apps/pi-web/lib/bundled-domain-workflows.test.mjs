import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { createDraft } from "pi-caw/core/workflow-schema.mjs";
import { revisionHash } from "pi-caw/core/workflow-revisions.mjs";
import { exportWorkflowPackage } from "pi-caw/core/workflow-package.mjs";
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {readBundledDomainWorkflows,installMissingBundledDomainWorkflows,registerBundledDomainWorkflowInstaller}=await jiti.import("./bundled-domain-workflows.ts");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
async function bundle(t,id="course-test") {
  const root=await mkdtemp(join(tmpdir(),"bundled-workflows-"));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
  const workflow={...createDraft(id,"Test shipped Workflow"),status:"ready",finalization:{required:true,node_id:"final"},
    nodes:[{id:"start",type:"start"},{id:"final",type:"agent",executor:{kind:"main"},role:"finalizer",access:"read_only",prompt_template:"Answer the input.",input_bindings:{},outputs_schema:{type:"object",properties:{text:{type:"string"}},required:["text"]},approval:{required:false},retry:{max_attempts:1}},{id:"end",type:"end"}],
    edges:[{id:"a",source:"start",target:"final"},{id:"b",source:"final",target:"end"}]};
  const snapshot={workflow,resources:[],provenance:null,import_report:null};snapshot.revision_hash=revisionHash(snapshot);
  const portable=exportWorkflowPackage(snapshot,{}),bytes=Buffer.from(JSON.stringify(portable));
  const entry={id,path:`${id}.workflow.json`,revisionHash:snapshot.revision_hash,sha256:sha(bytes)};
  await writeFile(join(root,entry.path),bytes);await writeFile(join(root,"manifest.json"),JSON.stringify({version:1,workflows:[entry]}));
  return {root,entry,portable,bytes};
}
function piFixture(){const emitter=new EventEmitter(),messages=[];return {emitter,messages,pi:{events:{on:(name,fn)=>{emitter.on(name,fn);return()=>emitter.off(name,fn);},emit:(name,value)=>emitter.emit(name,value)},sendMessage:message=>messages.push(message)}};}

test("shipped packages must match physical file SHA, package ID and Ready revision before any install",async t=>{
  const f=await bundle(t);assert.equal((await readBundledDomainWorkflows(f.root))[0].packagePath,join(f.root,f.entry.path));
  for(const update of [{path:"../outside.json"},{id:"other"},{revisionHash:"0".repeat(64)},{sha256:"0".repeat(64)}]) {
    await writeFile(join(f.root,"manifest.json"),JSON.stringify({version:1,workflows:[{...f.entry,...update}]}));
    await assert.rejects(readBundledDomainWorkflows(f.root),/Invalid|differs/);
  }
  await assert.rejects(readBundledDomainWorkflows(join(f.root,"missing")),{code:"ENOENT"});
});

test("tampering package bytes and symlink escapes fail instead of falling back",async t=>{
  const f=await bundle(t);await writeFile(join(f.root,f.entry.path),Buffer.from("{}"));
  await assert.rejects(readBundledDomainWorkflows(f.root),/hash or physical path differs/);
  const g=await bundle(t,"linked-test"),link=join(g.root,"outside-link");
  // Directory junctions exercise physical ancestor confinement without Windows symlink privilege.
  await symlink(f.root,link,process.platform==="win32"?"junction":"dir");
  await assert.rejects(readBundledDomainWorkflows(link),/symbolic link/);
});

test("missing-only installation preserves custom existing revisions, and reconciles only atomic exists races",async t=>{
  const f=await bundle(t),entries=await readBundledDomainWorkflows(f.root),calls=[];
  const existing=async(op,args)=>{calls.push([op,args]);return [{id:f.entry.id,revision_hash:"custom-user-revision"}];};
  assert.deepEqual(await installMissingBundledDomainWorkflows(entries,[f.entry.id],existing),{installed:[],preserved:[f.entry.id]});assert.deepEqual(calls.map(call=>call[0]),["list"]);
  calls.length=0;let rows=[];
  const race=async(op,args)=>{calls.push([op,args]);if(op==="list")return rows;rows=[{id:f.entry.id,revision_hash:"new-user-revision"}];throw Object.assign(new Error("Exists"),{code:"WORKFLOW_EXISTS"});};
  assert.deepEqual(await installMissingBundledDomainWorkflows(entries,[f.entry.id],race),{installed:[],preserved:[f.entry.id]});
  assert.equal(calls[1][1].expected_sha256,f.entry.sha256);
  await assert.rejects(installMissingBundledDomainWorkflows(entries,[f.entry.id],async op=>op==="list"?[]:Promise.reject(Object.assign(new Error("Busy"),{code:"WORKFLOW_STORE_BUSY"}))),{code:"WORKFLOW_STORE_BUSY"});
});

for(const alreadyReady of [false,true])test(`startup installation works with Pi-CAW ${alreadyReady?"before":"after"} the domain hook and disposes exact-session listeners`,async t=>{
  const f=await bundle(t),p=piFixture(),calls=[];
  if(alreadyReady)p.emitter.on("pi-caw:host-readiness",request=>{request.ready=request.session_id==="selected-session";});
  p.emitter.on("pi-caw:host-command",request=>{calls.push(request);request.resolve(request.operation==="list"?[]:{workflow:{id:f.entry.id},revision_hash:f.entry.revisionHash});});
  const installer=registerBundledDomainWorkflowInstaller(p.pi,[f.entry.id],{directory:f.root});installer.start("selected-session");
  if(!alreadyReady){p.emitter.emit("pi-caw:host-ready",{session_id:"foreign-session"});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);p.emitter.emit("pi-caw:host-ready",{session_id:"selected-session"});}
  await installer.ensureAvailable("selected-session");assert.deepEqual(calls.map(call=>call.operation),["list","install_workflow_package"]);assert.equal(p.messages.length,0);
  await assert.rejects(installer.ensureAvailable("foreign-session"),/exact active session/);
  installer.dispose();assert.equal(p.emitter.listenerCount("pi-caw:host-ready"),0);p.emitter.emit("pi-caw:host-ready",{session_id:"selected-session"});assert.equal(calls.length,2);
});

test("absent bridge and invalid bundle report once without dispatch or startup timeout",async t=>{
  const f=await bundle(t),p=piFixture();let commands=0;p.emitter.on("pi-caw:host-command",()=>commands++);
  const installer=registerBundledDomainWorkflowInstaller(p.pi,[f.entry.id],{directory:f.root});installer.start("session");
  await assert.rejects(installer.ensureAvailable("session"),/bridge is unavailable/);await assert.rejects(installer.ensureAvailable("session"),/bridge is unavailable/);
  assert.equal(commands,0);assert.equal(p.messages.length,1);installer.dispose();
  const broken=registerBundledDomainWorkflowInstaller(p.pi,[f.entry.id],{directory:join(f.root,"missing")});broken.start("session");
  await assert.rejects(broken.ensureAvailable("session"),{code:"ENOENT"});await new Promise(resolve=>setImmediate(resolve));assert.equal(p.messages.length,2);assert.equal(commands,0);broken.dispose();
});
