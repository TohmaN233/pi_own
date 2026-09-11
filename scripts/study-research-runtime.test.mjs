import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanStudyDirectory, readStudyFile, runStudyCode, STUDY_OUTPUT_LIMIT } from '../packages/study-research-host/src/index.ts';
const draft=(code,language='python',timeoutSeconds=3)=>({title:'Run fixture',purpose:'study',proposalId:null,hypothesis:'actual code runs',baseline:'known result',ablations:[],metric:'stdout',dataSplit:'toy',seeds:[1],successCriterion:'expected stdout',failureInterpretation:'not a theorem proof',language,code,timeoutSeconds});
test('study directory: bounded index skips secrets and links; real reads reject changes/escapes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'study-source-'));const outside=await mkdtemp(join(tmpdir(),'study-outside-'));
 try{await writeFile(join(root,'paper.md'),'# Test\n');await writeFile(join(root,'.env'),'SECRET');await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','x.js'),'hidden');
 await writeFile(join(outside,'private.md'),'outside');
 if(process.platform!=='win32')await symlink(join(outside,'private.md'),join(root,'linked.md'));
 const scanned=await scanStudyDirectory(root);assert.deepEqual(scanned.sources.map(s=>s.path),['paper.md']);assert.ok(scanned.omitted.includes('.env'));
 assert.equal(Buffer.from(await readStudyFile(scanned.root,scanned.sources[0])).toString(),'# Test\n');
 await writeFile(join(root,'paper.md'),'# Now a different file\n');await assert.rejects(()=>readStudyFile(scanned.root,scanned.sources[0]),/changed/);
 await assert.rejects(()=>readStudyFile(scanned.root,{...scanned.sources[0],path:'../'+outside.split(/[\\/]/).at(-1)+'/private.md'}),/escaped/);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('study execution: real Python and JS, no provider env keys, no implicit trust',async()=>{
 await assert.rejects(()=>runStudyCode(draft('print(42)'),{trusted:false}),/disabled/);
 const old=process.env.STUDY_FAKE_SECRET;process.env.STUDY_FAKE_SECRET='not-to-inherit';
 try{const python=await runStudyCode(draft('import os\nprint(sum(range(1,11)))\nprint(os.getenv("STUDY_FAKE_SECRET"))'),{trusted:true});assert.equal(python.status,'succeeded');assert.equal(python.exitCode,0);assert.equal(python.stdout,'55\nNone\n');
 const js=await runStudyCode(draft('console.log(6*7)','javascript'),{trusted:true});assert.equal(js.stdout,'42\n');assert.equal(js.status,'succeeded');
 }finally{if(old===undefined)delete process.env.STUDY_FAKE_SECRET;else process.env.STUDY_FAKE_SECRET=old;}
});
test('study execution: timeout, output budget, cancellation and missing interpreter fail honestly',async()=>{
 const timed=await runStudyCode(draft('while True: pass','python',1),{trusted:true});assert.equal(timed.status,'timed-out');
 const excessive=await runStudyCode(draft('print("x"*400000)','python'),{trusted:true});assert.equal(excessive.status,'output-limit');assert.ok(Buffer.byteLength(excessive.stdout)+Buffer.byteLength(excessive.stderr)<=STUDY_OUTPUT_LIMIT);
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),100);const aborted=await runStudyCode(draft('import time\ntime.sleep(10)','python',3),{trusted:true,signal:ctrl.signal});clearTimeout(timer);assert.equal(aborted.status,'aborted');
 await assert.rejects(()=>runStudyCode(draft('print(1)'),{trusted:true,python:join(tmpdir(),'does-not-exist-pi-study')}),/ENOENT/);
});
