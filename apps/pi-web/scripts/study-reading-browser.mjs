import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const directory = resolve("../../.artifacts/study-research/reading-browser");
const seed = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
const base = "http://127.0.0.1:30185";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [], downloads = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("download", (download) => downloads.push(download.suggestedFilename()));
page.setDefaultTimeout(45000);
try {
  await page.goto(`${base}/study?sessionId=${seed.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Study 论文工作区" }).waitFor();
  const source = page.locator("#sources article").filter({ has: page.getByRole("heading", { name: "paper.tex", exact: true }) });
  await source.getByRole("button").click();
  const chat = page.getByRole("complementary", { name: "学习与研究对话", exact: true });
  await chat.locator("textarea").first().waitFor();
  const admission = page.waitForResponse((response) => response.url().includes("/api/study-research/reading") && response.request().method() === "POST");
  await page.getByRole("button", { name: "开始后台阅读", exact: true }).click();
  const admitted = await admission;
  assert.equal(admitted.status(), 200, await admitted.text());
  const initial = await admitted.json();
  assert.equal(initial.tasks.length, 2);
  const taskIds = initial.tasks.map((task) => task.taskId);
  await page.getByText("正在阅读", { exact: true }).first().waitFor();
  const promptAt = new Date().toISOString();
  await chat.locator("textarea").first().fill("后台继续阅读，请先解释期望和方差的区别。这是本机工程协议测试。");
  await chat.locator("textarea").first().press("Enter");
  await chat.getByText("前台对话仍可立即响应；这是离线协议测试回复。", { exact: false }).waitFor();
  const repliedAt = new Date().toISOString();
  await page.reload({ waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 90000;
  let tasks;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${base}/api/study-research/reading?sessionId=${seed.sessionId}`);
    assert.equal(response.status(), 200, await response.text());
    tasks = (await response.json()).tasks;
    if (tasks.length === 2 && tasks.every((task) => ["succeeded", "failed", "needs-input", "cancelled"].includes(task.status))) break;
    await new Promise((ready) => setTimeout(ready, 1000));
  }
  assert.deepEqual(tasks.map((task) => task.taskId).sort(), taskIds.sort());
  assert.ok(tasks.every((task) => task.status === "succeeded"), JSON.stringify(tasks));
  await page.getByText("2 / 2 个片段已完成", { exact: true }).waitFor();
  const observations = JSON.parse(await readFile(join(directory, "local-model-observations.json"), "utf8"));
  const foreground = observations.find((item) => !item.background && item.startedAt >= promptAt);
  assert.ok(foreground, "foreground request used the local fixture provider");
  assert.ok(observations.some((item) => item.background && item.startedAt <= foreground.startedAt && item.finishedAt >= foreground.startedAt), "foreground prompt ran while background model request was active");
  assert.equal(observations.filter((item) => item.background).length, 4, "two independent packets each use one report turn and one final stop");
  assert.ok(observations.filter((item) => item.background).every((item) => item.toolNames.join(",") === "study_task_report"));
  assert.ok(!foreground.toolNames.some((name) => ["bash", "read", "write", "grep", "edit"].includes(name)));
  assert.deepEqual(errors, []); assert.deepEqual(downloads, []);
  await page.screenshot({ path: join(directory, "reading-browser.png"), fullPage: false });
  await writeFile(join(directory, "reading-browser-evidence.json"), JSON.stringify({ sessionId: seed.sessionId, projectId: seed.projectId,
    taskIds, promptAt, repliedAt, refreshedDuringReading: true, foregroundDuringBackground: true, tasks, observations, errors, downloads,
    qualification: "Local protocol fixture only; no academic correctness claim or paid provider call." }, null, 2));
  console.log(JSON.stringify({ completed: tasks.length, foregroundDuringBackground: true, refreshedDuringReading: true, errors }));
} catch (error) {
  await page.screenshot({ path: join(directory, "reading-browser-failure.png"), fullPage: true });
  await writeFile(join(directory, "reading-browser-failure.txt"), await page.locator("body").innerText());
  throw error;
} finally { await browser.close(); }
