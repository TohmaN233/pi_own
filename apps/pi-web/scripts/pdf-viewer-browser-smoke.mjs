// Exercise the real static viewer without Next/Agent startup. Include a browser
// configured to download PDFs, malformed documents, navigation and zoom.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const body = "0.1 0.3 0.7 rg 20 20 180 80 re f";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>", `<< /Length ${body.length} >>\nstream\n${body}\nendstream`, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>"];
let pdf = "%PDF-1.4\n"; const offsets = [];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/pdf-content") {
      const bytes = Buffer.from(url.searchParams.get("file") === "/api/files/broken.pdf" ? "not a pdf" : pdf);
      response.writeHead(200, { "content-type": "application/json", "x-content-type-options": "nosniff" }); response.end(JSON.stringify({ data: bytes.toString("base64"), byteLength: bytes.length })); return;
    }
    let path;
    if (url.pathname === "/pdf-viewer.html" || url.pathname === "/pdf-viewer.mjs") path = join(process.cwd(), "public", url.pathname.slice(1));
    else if (/^\/api\/pdfjs\/(build|cmaps|standard_fonts|wasm|iccs)\/[\w.-]+$/.test(url.pathname)) path = join(process.cwd(), "node_modules/pdfjs-dist", url.pathname.slice("/api/pdfjs/".length));
    else { response.writeHead(404); response.end(); return; }
    const bytes = await readFile(path);
    response.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html" : path.endsWith(".mjs") ? "text/javascript" : "application/octet-stream" }); response.end(bytes);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "pi-pdf-render-test-"));
await mkdir(join(profile, "Default"));
await writeFile(join(profile, "Default/Preferences"), JSON.stringify({ plugins: { always_open_pdf_externally: true } }));
let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: true });
  const page = await context.newPage(); const downloads = [];
  page.on("pageerror", (error) => console.error("[pdf-browser-test] page error", error.message));
  page.on("console", (message) => { if (message.type() === "error" || message.text().startsWith("[pdf-preview]")) console.error("[pdf-browser-test]", message.text()); });
  page.on("response", (response) => { if (!response.ok()) console.error("[pdf-browser-test] HTTP", response.status(), response.url()); });
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/pdf-viewer.html?file=${encodeURIComponent("/api/files/fixture.pdf")}`);
  await page.locator('.page[data-page="1"][data-rendered="true"] canvas').waitFor({ timeout: 15000 }).catch(async (error) => { console.error(await page.locator("body").innerText()); throw error; });
  assert.equal(await page.locator("#page-count").textContent(), "/ 2");
  assert.ok(await page.locator('.page[data-page="1"] canvas').evaluate((canvas) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, index) => index % 4 === 0 && value < 200);
  }));
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await page.locator("#page-number").inputValue(), "2");
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.locator('.page[data-page="2"][data-rendered="true"] canvas').waitFor();
  assert.equal(await page.locator("#zoom-label").textContent(), "125%");
  assert.deepEqual(downloads, []);
  await page.goto(`${base}/pdf-viewer.html?file=${encodeURIComponent("/api/files/broken.pdf")}`);
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").textContent(), /PDF 预览失败/);
  console.log("PASS: PDF page pixels, page navigation, zoom, JSON transport without download, visible invalid-PDF error; native PDF downloads enabled.");
} finally {
  await context?.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
