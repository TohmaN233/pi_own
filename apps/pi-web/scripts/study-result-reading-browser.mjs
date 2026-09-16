import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const fixture=resolve('../../.artifacts/study-research/sr-diag'),out=resolve('../../.artifacts/study-research/result-reading');
const {sessionId}=JSON.parse(await readFile(join(fixture,'seed.json'),'utf8'));
const require=createRequire(import.meta.url),{chromium}=require(process.env.PI_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1500,height:1050}});page.setDefaultTimeout(45000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base='http://127.0.0.1:30185',startedAt=new Date().toISOString();
try {
 await page.goto(`${base}/study?sessionId=${sessionId}`,{waitUntil:'domcontentloaded'});
 await page.getByRole('complementary',{name:'学习与研究对话',exact:true}).locator('textarea').first().waitFor({state:'visible'});
 const before=await(await page.request.get(`${base}/api/study-research?sessionId=${sessionId}`)).json();
 await page.locator('#research-results').getByRole('button',{name:'理解此结果',exact:true}).first().click();
 let observations=[];
 for(const deadline=Date.now()+90000;Date.now()<deadline;){
  observations=JSON.parse(await readFile(join(fixture,'local-model-observations.json'),'utf8')).filter(r=>r.startedAt>=startedAt);
  if(observations.some(r=>r.resultField&&r.finishedAt))break;
  await page.waitForTimeout(500);
 }
 const request=observations.find(r=>r.resultRead),receipt=observations.find(r=>r.resultField);assert.ok(request,JSON.stringify(observations));assert.ok(receipt,JSON.stringify(observations));assert.ok(request.promptChars<2000);assert.equal(request.resultRead.action,'read_result');assert.equal(receipt.resultField.identity.resultId,request.resultRead.resultId);assert.equal(receipt.resultField.identity.resultRevision,request.resultRead.expectedResultRevision);
 const after=await(await page.request.get(`${base}/api/study-research?sessionId=${sessionId}`)).json();assert.deepEqual(after.phase,before.phase);assert.deepEqual(errors,[]);
 await page.screenshot({path:join(out,'browser.png')});await writeFile(join(out,'browser-evidence.json'),JSON.stringify({startedAt,checkedAt:new Date().toISOString(),sessionId,phaseUnchanged:true,qualification:'Actual original Pi conversation and real scoped field service; local faux model, no academic correctness claim.',observations,errors},null,2));console.log(JSON.stringify({status:'passed',promptChars:request.promptChars,receipt:receipt.resultField,phaseUnchanged:true,errors}));
}catch(error){await page.screenshot({path:join(out,'browser-failure.png'),fullPage:true});await writeFile(join(out,'browser-failure.json'),JSON.stringify({startedAt,sessionId,error:String(error),errors},null,2));throw error;}finally{await browser.close();}
