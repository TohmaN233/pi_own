// Read-only deployed-server check. All browser POSTs are blocked, so opening the
// teacher page cannot start an Agent, edit an artifact, or send a model request.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.PI_SMOKE_URL || "http://127.0.0.1:30141";
const sessionId = process.env.PI_SMOKE_SESSION;
assert.ok(sessionId, "Set PI_SMOKE_SESSION to an existing teacher conversation");
async function read(url) {
  const response = await fetch(`${base}${url}`);
  assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
  return response;
}
const query = `sessionId=${encodeURIComponent(sessionId)}`;
const { snapshot } = await (await read(`/api/course-builder?${query}`)).json();
const summary = snapshot.decks.at(-1);
assert.ok(summary, "Existing course needs a saved Beamer deck");
assert.equal(summary.source, undefined, "This check must exercise the real source-free overview");
const { deck } = await (await read(`/api/course-builder/deck?${query}&id=${summary.deckId}`)).json();
const source = await (await read(`/api/course-builder/export?${query}&kind=tex&id=${summary.deckId}`)).text();
assert.equal(deck.source, source); assert.ok(source.length > 100);
const receipt = snapshot.compileReceipts.filter((item) => item.deckId === deck.deckId && item.deckRevision === deck.revision && item.succeeded).at(-1);
assert.ok(receipt, "Existing deck needs a successful compile receipt");
const profile = mkdtempSync(join(tmpdir(), "pi-pdf-preview-browser-"));
mkdirSync(join(profile, "Default"));
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ plugins: { always_open_pdf_externally: true } }));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: true, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const downloads = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await context.route("**/api/**", (route) => route.request().method() === "GET" ? route.continue() : route.fulfill({ status: 409, json: { error: "Read-only artifact check: Agent activation and writes are disabled." } }));
  await page.goto(`${base}/course-builder?${query}`);
  await page.getByRole("link", { name: "编辑 .tex", exact: true }).last().click();
  const editor = page.getByLabel("编辑 TeX 源码", { exact: true });
  await editor.waitFor();
  assert.equal(await editor.inputValue(), source, "Actual saved TeX must be visible without edits");
  if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-live-tex.png") });
  await page.getByRole("button", { name: "关闭文件预览", exact: true }).click();
  await page.getByRole("link", { name: "打开 PDF", exact: true }).last().click();
  const preview = page.getByRole("complementary", { name: "文件预览", exact: true });
  const frame = preview.locator("iframe").contentFrame();
  await frame.locator('.page[data-page="1"][data-rendered="true"] canvas').waitFor({ timeout: 30000 });
  assert.equal(await frame.locator("#page-count").textContent(), `/ ${receipt.pageCount}`);
  assert.ok(await frame.locator('.page[data-page="1"] canvas').evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index + 3] && data[index] < 180) dark++;
    return dark > 100;
  }), "Real course PDF must paint visible contents");
  await frame.locator("#page-number").fill(String(receipt.pageCount));
  await frame.locator("#page-number").press("Enter");
  await frame.locator(`.page[data-page="${receipt.pageCount}"][data-rendered="true"] canvas`).waitFor();
  assert.equal(await frame.locator("#error").isVisible(), false);
  assert.deepEqual(downloads, [], "PDF must render even with native PDF handling configured to download");
  if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-live-pdf.png") });
  console.log(`PASS: real TeX r${deck.revision}, ${source.length} characters; PDF ${receipt.pageCount} pages with painted first/last pages; native PDF downloads enabled, zero downloads; no writes/model calls.`);
} finally {
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
}
