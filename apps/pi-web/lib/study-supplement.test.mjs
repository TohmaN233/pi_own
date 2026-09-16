import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {readStudySupplement}=await jiti.import('./study-supplement.ts');
const {readExactStudySourceBytes}=await jiti.import('./study-source-bytes.ts');
const {validateFrozenExecutionPayload,executionSha256,frozenEnvironmentDescriptorHash}=await jiti.import('../../../packages/study-execution-host/src/execution-payloads.ts');

test('selected code and binary bytes remain exact; external paths, invalid encoding and changed bytes fail',async()=>{
 const base=fileURLToPath(new URL('../../../.artifacts/study-research/supplement-tests',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'inputs-'));
 await writeFile(join(root,'sample.R'),'x <- 1\nprint(x)\n');const code=await readStudySupplement(root,'sample.R');assert.equal(code.kind,'code');assert.equal(code.chunks.map(c=>c.text).join(''),'x <- 1\nprint(x)\n');
 const bytes=Buffer.alloc(8*1024*1024,71);await writeFile(join(root,'data.mat'),bytes);const binary=await readStudySupplement(root,'data.mat');assert.equal(binary.kind,'asset');assert.match(binary.chunks[0].text,/not been interpreted/);assert.deepEqual(await readExactStudySourceBytes(binary,16*1024*1024),bytes);
 await writeFile(join(root,'sample.R'),'x <- 2\n');await assert.rejects(readExactStudySourceBytes(code,1000),/changed since import/);
 await writeFile(join(root,'bad.csv'),Buffer.from([255]));await assert.rejects(readStudySupplement(root,'bad.csv'),/encoded data/i);
 await writeFile(join(base,'outside.R'),'print(3)');await assert.rejects(readStudySupplement(root,'../outside.R'),/escapes/);
 await writeFile(join(root,'large.mat'),Buffer.alloc(16*1024*1024+1));await assert.rejects(readStudySupplement(root,'large.mat'),/16 MiB/);
});

test('large canonical frozen inputs do not overflow regex stack and aggregate is enforced',()=>{
 const environment={adapterKind:'fixture',executablePath:'C:\\fixture.exe',files:[{absolutePath:'C:\\fixture.exe',sha256:executionSha256('runtime')}]};environment.descriptorHash=frozenEnvironmentDescriptorHash(environment);
 const build=(sizes)=>{const inputs=sizes.map((size,i)=>{const bytes=Buffer.alloc(size,i+1);return {name:`input-${i}.mat`,bytesBase64:bytes.toString('base64'),sha256:executionSha256(bytes)};});return {version:1,taskId:'t',projectId:'p',sessionId:'s',language:'rscript',manifest:{codeHash:executionSha256('print(1)'),parameterHash:executionSha256('{}'),inputHashes:Object.fromEntries(inputs.map(i=>[i.name,i.sha256])),environmentHash:environment.descriptorHash},program:{fileName:'main.R',content:'print(1)',sha256:executionSha256('print(1)')},parameters:{canonicalJson:'{}',sha256:executionSha256('{}')},inputs,environment,outputLimitBytes:1024};};
 assert.equal(validateFrozenExecutionPayload(build([8*1024*1024])).inputs.length,1);
 assert.equal(validateFrozenExecutionPayload(build([16*1024*1024])).inputs.length,1);
 assert.throws(()=>validateFrozenExecutionPayload(build([16*1024*1024+1])),/byte limit/);
 assert.throws(()=>validateFrozenExecutionPayload(build([11*1024*1024,11*1024*1024,11*1024*1024])),/byte limit/);
 const invalid=build([1]);invalid.inputs[0].bytesBase64='A===';assert.throws(()=>validateFrozenExecutionPayload(invalid),/canonical base64/);
});
