import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createJiti} from 'jiti';
const directory=resolve('../../.artifacts/study-research/sr-diag'),out=resolve('../../.artifacts/study-research/external-live');await mkdir(out,{recursive:true});
Object.assign(process.env,{PI_CODING_AGENT_DIR:join(directory,'agent'),PI_CODING_AGENT_SESSION_DIR:join(directory,'sessions'),PI_LEARNING_HARNESS_DIR:join(directory,'data'),PI_MODE_PACK_STORE_PATH:join(directory,'packs.json')});
const jiti=createJiti(import.meta.url,{tsconfigPaths:true}),{searchExternalStudyReferences}=await jiti.import('../lib/study-external-references.ts'),{studyContext}=await jiti.import('../lib/study-research-service.ts'),{getLearningHarness}=await jiti.import('../lib/harness-server.ts');
const sessionId='01a09515-fab7-731b-9d79-cc55a0a435ca',query='Efron Second thoughts on the bootstrap 2003',context=await studyContext(sessionId);
try {
const result=await searchExternalStudyReferences({sessionId,expectedPhaseRevision:context.phase.revision,query});
assert.ok(result.references.some(r=>r.doi==='10.1214/ss/1063994968'));
const current=await studyContext(sessionId);assert.equal(current.phase.phase,'study');const source=current.host.listSources(current.scope).find(s=>s.sourceId===result.sourceId);assert.equal(source.sourceRole,'reference');assert.equal(source.contentHash,result.sourceHash);
await writeFile(join(out,'evidence.json'),JSON.stringify({checkedAt:new Date().toISOString(),sessionId,qualification:'Actual public bibliographic query through the product Crossref adapter. Metadata only; no full paper contents or private text sent, no model invocation.',result,phaseUnchanged:true,sourceRole:source.sourceRole},null,2));console.log(JSON.stringify({references:result.references.length,expectedDoi:true,phase:'study'}));
}finally{getLearningHarness().close();globalThis.__piLearningHarness=undefined;}
