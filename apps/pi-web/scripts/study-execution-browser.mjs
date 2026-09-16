import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const directory = resolve("../../.artifacts/study-research/workspace-smoke");
const seed = JSON.parse(await readFile(join(directory, "seed.json"), "utf8"));
const base = "http://127.0.0.1:30183";
const language = process.argv[2] ?? "python";
assert.ok(["python", "r"].includes(language));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], downloads = [], pdfTransports = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("download", (download) => downloads.push(download.suggestedFilename()));
page.on("response", (response) => { if (response.url().includes("/api/pdf-content?")) pdfTransports.push({ url: response.url(), status: response.status(), contentType: response.headers()["content-type"] }); });
page.setDefaultTimeout(30000);
try {
  await page.goto(`${base}/study?sessionId=${seed.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Study 论文工作区" }).waitFor();
  const stateResponse = await page.request.get(`${base}/api/study-research?sessionId=${seed.sessionId}`);
  assert.equal(stateResponse.status(), 200);
  const state = await stateResponse.json();
  const paper = state.sources.find((source) => source.kind === "pdf");
  assert.ok(paper, "registered paper PDF is required");
  await page.locator("#sources article").filter({ has: page.getByRole("heading", { name: paper.relativePath, exact: true }) }).getByRole("button").click();
  await page.getByRole("button", { name: "预览原始 PDF", exact: true }).click();
  await page.frameLocator(`iframe[title="${paper.relativePath} 原始 PDF"]`).locator('.page[data-page="1"][data-rendered="true"] canvas').waitFor({ timeout: 60000 });
  const cells = page.locator("#code-cells");
  const title = `${language} 后台输出验收 ${Date.now()}`;
  await cells.getByRole("button", { name: "新建代码单元", exact: true }).click();
  await cells.getByLabel("标题", { exact: true }).fill(title);
  await cells.getByLabel("这个例子要说明什么").fill("验证参数、冻结输入和 PDF 产物传输；不作科学结论。");
  await cells.getByLabel("语言", { exact: true }).selectOption(language);
  await cells.getByLabel("代码", { exact: true }).fill(language === "python"
    ? "import pathlib, shutil\nprint('browser-cell-result:', sum(parameters['values']))\nshutil.copyfile(inputs['paper.pdf'], pathlib.Path(output_directory) / 'paper-copy.pdf')\n"
    : "cat('browser-cell-result:', sum(unlist(parameters$values)), '\\n')\nstopifnot(file.copy(inputs[['paper.pdf']], file.path(output_directory, 'paper-copy.pdf')))\nplot(c(2,4,6), main='R cell output fixture')\n");
  await cells.getByLabel("参数 JSON", { exact: true }).fill('{"values":[2,4,6]}');
  await cells.getByLabel("代码单元来源").selectOption(paper.sourceId);
  await cells.getByLabel("运行时输入文件名").fill("paper.pdf");
  await cells.getByRole("button", { name: "添加输入", exact: true }).click();
  await cells.getByRole("button", { name: "保存代码版本", exact: true }).click();
  const cell = cells.locator("li").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const submission = page.waitForResponse((response) => response.url().includes("/api/study-research/execution?") && response.request().method() === "POST", { timeout: 120000 });
  await cell.getByRole("button", { name: "运行 r1", exact: true }).click();
  const submitted = await submission;
  assert.equal(submitted.status(), 200, await submitted.text());
  await cell.getByRole("button", { name: "取消运行", exact: true }).waitFor({ timeout: 120000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  const deadline = Date.now() + 360000;
  let run;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${base}/api/study-research/execution?sessionId=${seed.sessionId}`);
    const execution = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(execution));
    run = execution.runs.find((entry) => entry.title === title);
    if (run && ["succeeded", "failed", "cancelled", "limit-reached"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.equal(run?.status, "succeeded", JSON.stringify(run));
  await cell.getByLabel("标准输出").waitFor();
  assert.match(await cell.getByLabel("标准输出").textContent(), /browser-cell-result: 12/);
  await cell.locator("div").filter({ has: page.locator("span", { hasText: /^paper-copy\.pdf ·/ }) }).filter({ has: page.getByRole("button", { name: "查看", exact: true }) }).last().getByRole("button", { name: "查看", exact: true }).click();
  const canvas = cell.frameLocator('iframe[title="paper-copy.pdf"]').locator('.page[data-page="1"][data-rendered="true"] canvas');
  await canvas.waitFor({ timeout: 60000 });
  assert.ok(await canvas.evaluate((canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 0 && value < 200)));
  assert.deepEqual(errors, []); assert.deepEqual(downloads, []);
  assert.equal(pdfTransports.length, 2);
  assert.ok(pdfTransports.every((response) => response.status === 200 && response.contentType.includes("application/json")));
  if (language === "r") assert.match(await cell.innerText(), /plot-001\.png/);
  await cell.screenshot({ path: join(directory, `execution-browser-${language}.png`) });
  await writeFile(join(directory, `execution-browser-${language}-evidence.json`), JSON.stringify({ title, run, errors, downloads, pdfTransports, refreshedDuringRun: true, paperAndArtifactCanvasRendered: true }, null, 2));
  console.log(JSON.stringify({ status: run.status, refreshedDuringRun: true, paperAndArtifactCanvasRendered: true, downloads }));
} catch (error) {
  await page.screenshot({ path: join(directory, "execution-browser-failure.png"), fullPage: true });
  await writeFile(join(directory, "execution-browser-failure.txt"), await page.locator("body").innerText());
  throw error;
} finally { await browser.close(); }
