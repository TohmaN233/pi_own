import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const out=resolve('../../.artifacts/study-research/execution-notices-browser');await mkdir(out,{recursive:true});
const seed=JSON.parse(await readFile(resolve('../../.artifacts/study-research/sr-diag/seed.json'),'utf8'));
const sessionId=seed.sessionId,base='http://127.0.0.1:30185';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PI_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1500,height:1100}});page.setDefaultTimeout(90000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));const evidence={sessionId,startedAt:new Date().toISOString()};
async function state(){const r=await page.request.get(`${base}/api/study-research?sessionId=${sessionId}`);assert.equal(r.status(),200);return r.json();}
async function post(path,click){const[r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST'),click()]);const body=await r.json();assert.equal(r.status(),200,JSON.stringify(body));return body;}
try {
 await page.goto(`${base}/study?sessionId=${sessionId}`,{waitUntil:'domcontentloaded'});evidence.phaseBefore=(await state()).phase;
 const cells=page.locator('#code-cells'),title=`Observed progress cancel ${Date.now()}`;
 await cells.getByRole('button',{name:'新建代码单元',exact:true}).click();await cells.getByLabel('标题',{exact:true}).fill(title);await cells.getByLabel('这个例子要说明什么',{exact:true}).fill('验证实际运行进度、接近限制提醒、取消及部分输出保留。');await cells.getByLabel('语言',{exact:true}).selectOption('python');
 await cells.getByLabel('代码',{exact:true}).fill("import time\nfrom pathlib import Path\nPath(output_directory, 'partial.txt').write_text('partial-before-cancel', encoding='utf-8')\nprint('observed-before-cancel', flush=True)\ntime.sleep(90)\n");await cells.getByLabel('参数 JSON',{exact:true}).fill('{}');
 await post('/api/study-research',()=>cells.getByRole('button',{name:'保存代码版本',exact:true}).click());
 const card=cells.locator('li').filter({has:page.getByRole('heading',{name:title,exact:true})}).first();
 await card.getByText('运行设置：自动读取本机资源，可调整',{exact:true}).click();await card.getByLabel('最长运行秒数',{exact:true}).fill('45');
 await card.getByText(/运行不会自动创建检查点或自动恢复/).waitFor();
 const submitted=await post('/api/study-research/execution',()=>card.getByRole('button',{name:'运行 r1',exact:true}).click());evidence.queueJobId=submitted.job.queueJobId;await writeFile(join(out,'progress.json'),JSON.stringify(evidence,null,2));
 await card.getByText(/^接近资源限制：/).first().waitFor({timeout:180000});
 const history=card.getByLabel('运行事件历史');assert.equal(await history.getByText(/^接近资源限制：/).count(),1);evidence.warning=await history.innerText();await card.screenshot({path:join(out,'warning.png')});
 await post('/api/study-research/execution',()=>card.getByRole('button',{name:'取消运行',exact:true}).click());
 await card.getByText('r1 · 已取消',{exact:true}).waitFor();
 const runs=await (await page.request.get(`${base}/api/study-research/execution?sessionId=${sessionId}`)).json();evidence.run=runs.runs.find(r=>r.queueJobId===evidence.queueJobId);assert.equal(evidence.run.status,'cancelled');assert.ok(evidence.run.result.usage.wallTimeMs>=36000);assert.match(evidence.run.result.logs.stdout,/observed-before-cancel/);
 await card.getByText('partial.txt',{exact:false}).first().waitFor();
 await page.reload({waitUntil:'domcontentloaded'});await card.getByText('r1 · 已取消',{exact:true}).waitFor();await card.getByLabel('运行事件历史').getByText(/已取消/).waitFor();await card.getByText('partial.txt',{exact:false}).first().waitFor();await card.screenshot({path:join(out,'cancelled-reloaded.png')});
 evidence.phaseAfter=(await state()).phase;assert.ok(evidence.phaseBefore?.revision);assert.deepEqual(evidence.phaseAfter,evidence.phaseBefore);assert.deepEqual(errors,[]);Object.assign(evidence,{finishedAt:new Date().toISOString(),errors});await writeFile(join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({status:'passed',queueJobId:evidence.queueJobId,usage:evidence.run.result.usage,warning:evidence.warning,phaseUnchanged:true,errors}));
}catch(e){await writeFile(join(out,'failure.json'),JSON.stringify({...evidence,error:String(e),errors},null,2));await page.screenshot({path:join(out,'failure.png'),fullPage:true});throw e;}finally{await browser.close();}
