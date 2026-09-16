import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createStudyVisualFrame, isStudyVisualMessage } = await jiti.import("../lib/study-visual-sandbox.ts");
const channel = "test-channel-0123456789";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  const network = [];
  page.on("request", (request) => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.setContent('<p id="secret">host secret</p><iframe sandbox="allow-scripts"></iframe>');
  async function render(code, inputs = {}) {
    const html = createStudyVisualFrame({ code, inputs, channel });
    await page.evaluate((src) => { window.results = []; window.onmessage = (event) => window.results.push({origin:event.origin, data:event.data}); document.querySelector("iframe").srcdoc = src; }, html);
    await page.waitForFunction(() => window.results.length > 0, null, { timeout: 7000 });
    return page.evaluate(() => window.results.at(-1));
  }
  let result = await render('return {elements:[{tag:"circle",attrs:{cx:inputs.x,cy:100,r:20,fill:"#123456"}}],summary:"curve demo"}', {x:123});
  assert.equal(result.origin, "null"); assert.equal(result.data.type, "rendered");
  let child = page.frames().find((frame) => frame !== page.mainFrame());
  assert.equal(await child.locator("circle").getAttribute("cx"), "123");
  result = await render('return {elements:[{tag:"circle",attrs:{cx:inputs.x,cy:100,r:20}}]}', {x:321});
  child = page.frames().find((frame) => frame !== page.mainFrame());
  assert.equal(await child.locator("circle").getAttribute("cx"), "321");
  result = await render('return {elements:[{tag:"image",attrs:{href:"https://example.invalid/leak"}}]}');
  assert.equal(result.data.type, "error");
  result = await render('return fetch("https://example.invalid/leak").then(() => ({elements:[]}))');
  assert.equal(result.data.type, "error"); assert.match(result.data.message, /fetch/i); assert.doesNotMatch(result.data.message, /SyntaxError/);
  result = await render('return {elements:[],summary:parent.document.cookie}');
  assert.equal(result.data.type, "error");
  result = await render('while(true) {}');
  assert.equal(result.data.type, "error"); assert.match(result.data.message, /3 秒/);
  const fakeWindow = {};
  assert.equal(isStudyVisualMessage({source:{},origin:"null",data:{channel,type:"rendered",message:"forged"}},fakeWindow,channel),false);
  assert.equal(isStudyVisualMessage({source:fakeWindow,origin:"https://evil.invalid",data:{channel,type:"rendered",message:"forged"}},fakeWindow,channel),false);
  assert.deepEqual(network, []);
  assert.equal(await page.locator("#secret").textContent(), "host secret");
  console.log("PASS: actual SVG rendering/input changes; network and host access denied; invalid SVG rejected; infinite worker terminated; forged bridge message rejected.");
} finally { await browser.close(); }
