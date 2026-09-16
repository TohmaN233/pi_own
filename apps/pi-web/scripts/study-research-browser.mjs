import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const directory = resolve(process.env.PI_STUDY_FIXTURE_DIR || "../../.artifacts/study-research/review-research-browser");
const seed = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
const base = "http://127.0.0.1:30185";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [], downloads = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("download", (download) => downloads.push(download.suggestedFilename()));
page.setDefaultTimeout(45000);
const get = async (path) => { const response = await page.request.get(`${base}${path}?sessionId=${seed.sessionId}`); const body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body)); return body; };
const pause = () => new Promise((ready) => setTimeout(ready, 1500));
const evidence = { ...seed, startedAt: new Date().toISOString(), qualification: "Actual browser and native execution protocol; local faux review only, no scientific correctness claim." };
try {
  await page.goto(`${base}/study?sessionId=${seed.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Study 论文工作区" }).waitFor();
  const review = page.locator("#visuals article").first();
  await review.getByRole("checkbox").first().check();
  const admission = page.waitForResponse((response) => response.url().includes("/api/study-research/review") && response.request().method() === "POST");
  await review.getByRole("button", { name: "开始独立审查", exact: true }).click();
  const admitted = await admission; assert.equal(admitted.status(), 200, await admitted.text());
  const reviewTaskId = (await admitted.json()).task.taskId;
  let reviews;
  for (const deadline = Date.now() + 90000; Date.now() < deadline;) {
    reviews = await get("/api/study-research/review");
    if (reviews.reviews.some((item) => item.taskId === reviewTaskId)) break;
    const task = reviews.tasks.find((item) => item.taskId === reviewTaskId);
    if (task && ["failed", "needs-input", "cancelled"].includes(task.status)) throw new Error(JSON.stringify(task));
    await pause();
  }
  const canonical = reviews.reviews.find((item) => item.taskId === reviewTaskId);
  assert.equal(canonical?.status, "inconclusive");
  const initial = await get("/api/study-research");
  assert.equal(canonical.targetHash, initial.visualizations[0].contentHash);
  assert.ok(canonical.findings.some((finding) => finding.includes("学术")));
  assert.deepEqual((await get("/api/study-research/reading")).tasks, [], "review tasks do not pollute reading counters");
  evidence.canonicalReview = canonical;

  await page.getByRole("combobox", { name: "Active Mode Pack", exact: true }).selectOption("study-research.research");
  await page.locator("#research-execution").waitFor();
  const cells = page.locator("#code-cells");
  const title = `Research native smoke ${Date.now()}`;
  await cells.getByRole("button", { name: "新建代码单元", exact: true }).click();
  await cells.getByLabel("标题", { exact: true }).fill(title);
  await cells.getByLabel("这个例子要说明什么").fill("确认范围内后台执行和模式切换；不作科学结论。");
  await cells.getByLabel("语言", { exact: true }).selectOption("python");
  await cells.getByLabel("代码", { exact: true }).fill("import time\ntime.sleep(8)\nprint('research-native-result:', sum(parameters['values']))\n");
  await cells.getByLabel("参数 JSON", { exact: true }).fill('{"values":[2,4,6]}');
  await cells.getByRole("button", { name: "保存代码版本", exact: true }).click();
  await cells.getByRole("heading", { name: title, exact: true }).waitFor();
  const research = page.locator("#research-execution");
  await research.getByLabel("计划类型", { exact: true }).selectOption("smoke");
  await research.getByLabel("研究问题", { exact: true }).fill("Can a smoke run survive return to Study?");
  await research.getByLabel("演示方法", { exact: true }).fill("Sum three fixed values in isolated Python.");
  await research.getByLabel("观察或判据", { exact: true }).fill("Actual stdout is 12; this is protocol evidence only.");
  await research.getByRole("button", { name: "创建计划", exact: true }).click();
  await research.getByRole("button", { name: "编辑计划", exact: true }).waitFor();
  const submission = page.waitForResponse((response) => response.url().includes("/api/study-research/research") && response.request().method() === "POST" && response.request().postDataJSON()?.action === "run", { timeout: 180000 });
  await research.getByRole("button", { name: "提交 Research 运行", exact: true }).click();
  const submitted = await submission; assert.equal(submitted.status(), 200, await submitted.text());
  const job = (await submitted.json()).job;
  const admittedTask = (await get("/api/study-research")).tasks.find((task) => task.taskId === job.taskId);
  assert.equal(admittedTask.authorization.kind, "learning", "Queue mode records Research phase; smoke authorization remains learning");
  await page.getByRole("combobox", { name: "Active Mode Pack", exact: true }).selectOption("study-research.study");
  await page.reload({ waitUntil: "domcontentloaded" });
  let state, run;
  for (const deadline = Date.now() + 420000; Date.now() < deadline;) {
    state = await get("/api/study-research/research");
    run = state.runs.find((item) => item.queueJobId === job.queueJobId);
    if (run?.job && ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(run.job.status)) break;
    await pause();
  }
  assert.equal(state.phase, "study");
  assert.equal(run?.job?.status, "succeeded", JSON.stringify(run));
  assert.match(run.job.result.logs.stdout, /research-native-result: 12/);
  assert.equal(run.planSnapshot.kind, "smoke");
  assert.equal(JSON.stringify(state).includes('"grantId"'), false);
  assert.equal(await page.locator("#research-execution").getByRole("button", { name: "提交 Research 运行", exact: true }).isDisabled(), true);
  evidence.smokeRun = run; evidence.switchedToStudyDuringRun = true; evidence.refreshedDuringRun = true;
  assert.deepEqual(errors, []); assert.deepEqual(downloads, []);
  evidence.finishedAt = new Date().toISOString(); evidence.errors = errors; evidence.downloads = downloads;
  await page.locator("#research-execution").screenshot({ path: join(directory, "research-browser.png") });
  await writeFile(join(directory, "research-browser-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ review: canonical.status, smoke: run.job.status, switchedToStudyDuringRun: true, errors }));
} catch (error) {
  await writeFile(join(directory, "research-browser-partial-evidence.json"), JSON.stringify({ ...evidence, error: String(error) }, null, 2));
  await page.screenshot({ path: join(directory, "research-browser-failure.png"), fullPage: true });
  await writeFile(join(directory, "research-browser-failure.txt"), await page.locator("body").innerText());
  throw error;
} finally { await browser.close(); }
