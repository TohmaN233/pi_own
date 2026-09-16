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
const evidence = { sessionId: seed.sessionId, projectId: seed.projectId, qualification: "Synthetic deterministic engineering acceptance, no paper reproduction claim", startedAt: new Date().toISOString(), runs: [] };
const get = async (path) => { const response = await page.request.get(`${base}${path}?sessionId=${seed.sessionId}`); const body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); return body; };
const researchAction = async (action, click) => {
  const pending = page.waitForResponse((response) => response.url().includes("/api/study-research/research") && response.request().method() === "POST" && response.request().postDataJSON()?.action === action, { timeout: 180000 });
  await click(); const response = await pending; const body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); return body;
};
try {
  await page.goto(`${base}/study?sessionId=${seed.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Study 论文工作区" }).waitFor();
  await page.getByRole("combobox", { name: "Active Mode Pack", exact: true }).selectOption("study-research.research");
  const research = page.locator("#research-execution");
  await research.getByLabel("计划类型", { exact: true }).selectOption("formal");
  for (const [label, value] of [
    ["研究问题", "Do two approved runtimes produce the same deterministic sum?"],
    ["假设 / 假设检验（每行一项）", "The fixed three values sum to 12; no statistical inference."],
    ["数据版本", "Synthetic parameters [2,4,6] v1"], ["划分协议", "All three fixed inputs; no training or test split applies."],
    ["主要指标（每行一项）", "Exact sum = 12"], ["关键方法", "Sum fixed values in Python and R and save result.txt."],
    ["停止条件（每行一项）", "Stop after one run per runtime or on error; two runs maximum."],
  ]) await research.getByLabel(label, { exact: true }).fill(value);
  const created = await researchAction("create-plan", () => research.getByRole("button", { name: "创建计划", exact: true }).click());
  const planId = created.planId;
  const grantForm = research.getByRole("heading", { name: "用户批准执行范围", exact: true }).locator("..");
  await grantForm.locator("select").first().selectOption(planId);
  await grantForm.getByLabel("最多运行次数", { exact: true }).fill("2");
  await grantForm.getByLabel("累计运行时间上限（秒）", { exact: true }).fill("120");
  await grantForm.getByLabel("累计输出上限（MiB）", { exact: true }).fill("32");
  const granted = await researchAction("grant", () => grantForm.getByRole("button", { name: "批准此范围", exact: true }).click());
  const scopeId = granted.scopeId;
  assert.equal(granted.quota.maxRuns, 2);
  assert.equal(granted.quota.maxCumulativeWallTimeMs, 120000);
  for (const language of ["python", "r"]) {
    const cells = page.locator("#code-cells");
    const title = `Approved ${language} ${Date.now()}`;
    await cells.getByRole("button", { name: "新建代码单元", exact: true }).click();
    await cells.getByLabel("标题", { exact: true }).fill(title);
    await cells.getByLabel("这个例子要说明什么").fill("Deterministic engineering acceptance of an approved plan; no scientific claim.");
    await cells.getByLabel("语言", { exact: true }).selectOption(language);
    const code = language === "python"
      ? "import pathlib\nvalue = sum(parameters['values'])\npathlib.Path(output_directory, 'result.txt').write_text(str(value), encoding='utf-8')\nprint('approved-result:', value)\n"
      : "value <- sum(unlist(parameters$values))\nwriteLines(as.character(value), file.path(output_directory, 'result.txt'))\ncat('approved-result:', value, '\\n')\nplot(c(2,4,6), type='b')\n";
    await cells.getByLabel("代码", { exact: true }).fill(code);
    await cells.getByLabel("参数 JSON", { exact: true }).fill('{"values":[2,4,6]}');
    await cells.getByRole("button", { name: "保存代码版本", exact: true }).click();
    await cells.getByRole("heading", { name: title, exact: true }).waitFor();
    const cell = (await get("/api/study-research")).cells.find((item) => item.title === title);
    const runForm = research.getByRole("heading", { name: "执行选定代码单元", exact: true }).locator("..");
    await runForm.locator("select").nth(0).selectOption(planId);
    await runForm.locator("select").nth(1).selectOption(cell.cellId);
    await runForm.locator("select").nth(2).selectOption(scopeId);
    const submitted = await researchAction("run", () => runForm.getByRole("button", { name: "提交 Research 运行", exact: true }).click());
    let run;
    for (const deadline = Date.now() + 420000; Date.now() < deadline;) {
      run = (await get("/api/study-research/research")).runs.find((item) => item.queueJobId === submitted.job.queueJobId);
      if (["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(run?.job?.status)) break;
      await new Promise((ready) => setTimeout(ready, 1500));
    }
    assert.equal(run?.job?.status, "succeeded", JSON.stringify(run));
    assert.match(run.job.result.logs.stdout, /approved-result: 12/);
    assert.equal(run.mode, "grant");
    assert.equal(run.planSnapshot.kind, "formal");
    const artifactQuery = `/api/study-research/execution/artifact?sessionId=${seed.sessionId}&queueJobId=${run.queueJobId}`;
    const listed = await page.request.get(`${base}${artifactQuery}`); assert.equal(listed.status(), 200);
    const artifacts = (await listed.json()).artifacts;
    const output = artifacts.find((entry) => entry.path === "result.txt"); assert.ok(output, JSON.stringify(artifacts));
    const downloaded = await page.request.get(`${base}${artifactQuery}&mode=download&path=${encodeURIComponent(output.path)}&sha256=${encodeURIComponent(output.sha256)}`);
    assert.equal(downloaded.status(), 200); assert.equal((await downloaded.text()).trim(), "12");
    if (language === "r") {
      const plot = artifacts.find((entry) => entry.mediaType === "image/png"); assert.ok(plot);
      const preview = await page.request.get(`${base}${artifactQuery}&mode=preview&path=${encodeURIComponent(plot.path)}&sha256=${encodeURIComponent(plot.sha256)}`);
      assert.equal(preview.status(), 200); assert.ok((await preview.json()).base64.length > 100);
    }
    evidence.runs.push({ language, run, artifacts, verifiedArtifact: output });
    await writeFile(join(directory, "formal-browser-progress.json"), JSON.stringify(evidence, null, 2));
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  const restored = await get("/api/study-research/research");
  assert.ok(evidence.runs.every((entry) => restored.runs.some((run) => run.queueJobId === entry.run.queueJobId && run.job.status === "succeeded")));
  assert.deepEqual(errors, []);
  evidence.finishedAt = new Date().toISOString(); evidence.errors = errors;
  await writeFile(join(directory, "formal-browser-evidence.json"), JSON.stringify(evidence, null, 2));
  await page.locator("#research-execution").screenshot({ path: join(directory, "formal-browser.png") });
  console.log(JSON.stringify({ formal: evidence.runs.map(({ language, run }) => ({ language, status: run.job.status })), errors }));
} catch (error) {
  await writeFile(join(directory, "formal-browser-failure.json"), JSON.stringify({ ...evidence, error: String(error) }, null, 2));
  await page.screenshot({ path: join(directory, "formal-browser-failure.png"), fullPage: true });
  throw error;
} finally { await browser.close(); }
