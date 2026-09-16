import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const directory = resolve(process.env.PI_STUDY_FIXTURE_DIR || "../../.artifacts/study-research/sr-diag");
const seed = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
const base = "http://127.0.0.1:30185";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(45000);
const errors = []; page.on("pageerror", (error) => errors.push(error.message));
const evidence = { startedAt: new Date().toISOString(), sessionId: seed.sessionId, qualification: "Synthetic geometry engineering acceptance; not independent academic acceptance" };
const action = async (path, click, kind) => {
  const pending = page.waitForResponse((response) => response.url().includes(path) && response.request().method() === "POST" && (!kind || response.request().postDataJSON()?.action === kind), { timeout: 180000 });
  await click(); const response = await pending; const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body)); return body;
};
const visualState = async (visualizationId) => {
  const response = await page.request.get(`${base}/api/study-research/visual-validation?sessionId=${seed.sessionId}&visualizationId=${visualizationId}`);
  const value = await response.json(); assert.equal(response.status(), 200, JSON.stringify(value)); return value;
};
try {
  await page.goto(`${base}/study?sessionId=${seed.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Study 论文工作区" }).waitFor();
  const editor = page.getByRole("region", { name: "定制图代码与参数", exact: true });
  const title = `Scalar position fixture ${Date.now()}`;
  const code = "return {elements:[{tag:'circle',attrs:{cx:inputs.x,cy:100,r:20,fill:'#3b82f6'}}],summary:'Synthetic scalar position',metrics:{value:inputs.x}};";
  await editor.getByRole("button", { name: "新建定制图", exact: true }).click();
  await editor.getByLabel("这张图要解释什么", { exact: true }).fill(title);
  await editor.getByLabel("图形代码", { exact: true }).fill(code);
  await editor.getByLabel("图形参数 JSON", { exact: true }).fill('{"x":150}');
  const created = await action("/api/study-research/visualization", () => editor.getByRole("button", { name: "保存定制图草稿", exact: true }).click());
  evidence.visualization = created.visualization;
  const visual = page.locator("#visuals article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const circle = visual.frameLocator("iframe").locator("circle");
  await circle.waitFor();
  assert.equal(await circle.getAttribute("cx"), "150");
  await visual.getByLabel("Inputs JSON（仅当前浏览器预览）").fill('{"x":250}');
  await visual.getByRole("button", { name: "应用本地预览", exact: true }).click();
  await page.waitForFunction((name) => {
    const section = Array.from(document.querySelectorAll("#visuals article")).find((item) => item.querySelector("h4")?.textContent === name);
    return section?.textContent?.includes("本地预览 · 未写回持久化版本");
  }, title);
  await circle.waitFor();
  for (let i = 0; i < 40 && await circle.getAttribute("cx") !== "250"; i++) await page.waitForTimeout(100);
  assert.equal(await circle.getAttribute("cx"), "250");
  await visual.getByText("验证数值与边界", { exact: true }).click();
  const validation = visual.getByRole("region", { name: "可视化数值验证", exact: true });
  for (const [label, value] of [
    ["验证范围", "Synthetic circle horizontal coordinate and metric equal the supplied scalar x."],
    ["假设（每行一条）", "SVG user coordinates; no statistical or paper-specific interpretation."],
    ["来源说明", "Hand arithmetic fixture accompanying the imported source; not a claim made by the paper."],
    ["推导或独立参考材料", "Independently specified identity x→x: 150→150, 0→0, -1→-1, 350→350."],
    ["来源定位（页码、章节或稳定段落标识）", "Supplementary engineering fixture: identity coordinate mapping; not a paper equation."],
  ]) await validation.getByLabel(label, { exact: true }).fill(value);
  const cases = [["ordinary",150],["boundary",0],["degenerate",-1],["interaction",350]].map(([category,x]) => ({ id:category,category,description:`Independent identity mapping at x=${x}`,inputs:{x},expected:[{path:["metrics","value"],value:x,absoluteTolerance:0,relativeTolerance:0},{path:["elements",0,"attrs","cx"],value:x,absoluteTolerance:0,relativeTolerance:0}] }));
  await validation.getByLabel("四类测试用例 JSON", { exact: true }).fill(JSON.stringify(cases));
  evidence.specification = await action("/api/study-research/visual-validation", () => validation.getByRole("button", { name: "保存冻结规格", exact: true }).click(), "save-specification");
  const start = validation.getByRole("button", { name: "开始数值检查", exact: true });
  await validation.getByLabel("验证范围", { exact: true }).fill("Unsaved scope change must prevent running an older specification.");
  assert.equal(await start.isDisabled(), true);
  await validation.getByLabel("验证范围", { exact: true }).fill(evidence.specification.specification.scope);
  evidence.submitted = await action("/api/study-research/visual-validation", () => start.click(), "start");
  let state;
  for (const deadline = Date.now() + 180000; Date.now() < deadline;) {
    state = await visualState(created.visualization.visualizationId);
    const run = state.runs.find((item) => item.runId === evidence.submitted.run.runId);
    if (run?.currentStatus !== "pending") { evidence.run = run; break; }
    await page.waitForTimeout(1000);
  }
  assert.equal(evidence.run?.currentStatus, "passed", JSON.stringify(state));
  assert.equal(evidence.run.canonical.report.comparisons.length, 4);
  assert.ok(evidence.run.canonical.report.comparisons.every((entry) => entry.checks.every((check) => check.passed)));
  assert.equal("outputKey" in evidence.run, false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await visual.getByText("检查浏览器交互与正式使用状态", { exact: true }).click();
  const interaction=visual.locator('div').filter({has:page.getByRole('heading',{name:'浏览器交互与正式使用',exact:true})}).last();
  await interaction.getByRole('button',{name:'刷新验证状态',exact:true}).click();
  await interaction.getByRole('button',{name:'开始浏览器交互检查',exact:true}).click();
  for(const expected of cases){
    const rendered=interaction.frameLocator('iframe').locator('circle');
    await rendered.waitFor();
    assert.equal(await rendered.getAttribute('cx'),String(expected.inputs.x));
    await interaction.getByRole('button',{name:'记录后切换下一组参数',exact:true}).click();
  }
  evidence.browserReceipt=await action('/api/study-research/visual-interaction',()=>interaction.getByRole('button',{name:'保存交互实测',exact:true}).click());
  assert.equal(evidence.browserReceipt.status,'passed');
  const gateResponse=await page.request.get(`${base}/api/study-research/visual-interaction?sessionId=${seed.sessionId}&visualizationId=${created.visualization.visualizationId}`);
  evidence.gateBeforeIndependentReview=(await gateResponse.json()).gate;
  assert.equal(evidence.gateBeforeIndependentReview.ready,false);
  assert.ok(evidence.gateBeforeIndependentReview.reasons.some(reason=>reason.includes('独立审查')));
  await interaction.screenshot({path:join(directory,'visual-interaction-browser.png')});
  const review = visual.locator('div').filter({has:page.getByRole('heading',{name:'独立审查 · 已保存 r1',exact:true})}).last();
  await review.getByRole('checkbox').first().check();
  const admitted = await action('/api/study-research/review',()=>review.getByRole('button',{name:'开始独立审查',exact:true}).click());
  for(const deadline=Date.now()+90000;Date.now()<deadline;){
    const response=await page.request.get(`${base}/api/study-research/review?sessionId=${seed.sessionId}`);
    const current=await response.json();assert.equal(response.status(),200,JSON.stringify(current));
    const canonical=current.reviews.find(value=>value.taskId===admitted.task.taskId);
    if(canonical){evidence.independentFauxReview=canonical;break;}
    const task=current.tasks.find(value=>value.taskId===admitted.task.taskId);
    if(task&&['failed','needs-input','cancelled'].includes(task.status))throw new Error(JSON.stringify(task));
    await page.waitForTimeout(1000);
  }
  assert.equal(evidence.independentFauxReview?.status,'inconclusive');
  assert.match(evidence.independentFauxReview.manifest.inputHashes.visualEvidence,/^sha256:/);
  assert.equal(evidence.independentFauxReview.targetHash,created.visualization.contentHash);
  await editor.getByRole("button", { name: `编辑：${title} · r1`, exact: true }).click();
  await editor.getByLabel("图形参数 JSON", { exact: true }).fill('{"x":175}');
  evidence.revised = await action("/api/study-research/visualization", () => editor.getByRole("button", { name: "保存定制图草稿", exact: true }).click());
  assert.equal(evidence.revised.visualization.revision, 2);
  state = await visualState(created.visualization.visualizationId);
  assert.equal(state.runs.find((item) => item.runId === evidence.run.runId).currentStatus, "stale");
  await circle.waitFor();
  assert.equal(await circle.getAttribute("cx"), "175");
  assert.deepEqual(errors, []);
  evidence.finishedAt = new Date().toISOString(); evidence.errors = errors;
  await writeFile(join(directory, "visual-browser-evidence.json"), JSON.stringify(evidence, null, 2));
  await visual.screenshot({ path: join(directory, "visual-browser.png") });
  console.log(JSON.stringify({ created: 1, localPreview: 250, numericalCases: 4, status: evidence.run.currentStatus, revision: 2, oldReport: "stale", errors }));
} catch (error) {
  await writeFile(join(directory, "visual-browser-failure.json"), JSON.stringify({ ...evidence, error: String(error) }, null, 2));
  await page.screenshot({ path: join(directory, "visual-browser-failure.png"), fullPage: true });
  throw error;
} finally { await browser.close(); }
