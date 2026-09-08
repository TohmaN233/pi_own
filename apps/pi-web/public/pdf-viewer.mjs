import { getDocument, GlobalWorkerOptions } from "/api/pdfjs/build/pdf.min.mjs";

GlobalWorkerOptions.workerSrc = "/api/pdfjs/build/pdf.worker.min.mjs";
const pages = document.getElementById("pages");
const status = document.getElementById("status");
const errorBox = document.getElementById("error");
const pageNumber = document.getElementById("page-number");
const previous = document.getElementById("previous");
const next = document.getElementById("next");
const zoomIn = document.getElementById("zoom-in");
const zoomOut = document.getElementById("zoom-out");
const fit = document.getElementById("fit");
let pdf;
let loading;
let zoom = 1;
let fitWidth = true;
let generation = 0;
let observer;
let resizeTimer;
let disposed = false;
const tasks = new Set();
const pageViews = [];

function fail(error) {
  if (disposed) return;
  console.error("[pdf-preview] render failed", error);
  errorBox.hidden = false;
  errorBox.textContent = `PDF 预览失败：${error instanceof Error ? error.message : String(error)}`;
  status.textContent = "未能完成预览；可使用外侧的下载按钮保存文件。";
}
function updatePage(number) {
  pageNumber.value = String(number);
  previous.disabled = number <= 1;
  next.disabled = number >= pdf.numPages;
}
function goToPage(number) {
  const value = Math.max(1, Math.min(pdf.numPages, Number(number) || 1));
  pages.scrollTo({ top: pageViews[value - 1].element.offsetTop - pages.offsetTop - 16 });
  updatePage(value);
}
async function draw(view, epoch) {
  if (view.epoch === epoch || epoch !== generation || disposed) return;
  view.epoch = epoch;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `PDF 第 ${view.number} 页`);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = view.page.getViewport({ scale: view.scale });
  canvas.width = Math.ceil(viewport.width * ratio);
  canvas.height = Math.ceil(viewport.height * ratio);
  view.element.replaceChildren(canvas);
  const task = view.page.render({ canvas, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
  tasks.add(task);
  try {
    await task.promise;
    if (epoch !== generation || disposed) return;
    view.element.dataset.rendered = "true";
    status.textContent = `共 ${pdf.numPages} 页 · 滚动阅读，或输入页码跳转`;
  } catch (error) {
    // A resize/close deliberately cancels the old render, not a document failure.
    if (epoch === generation && !disposed) fail(error);
  } finally { tasks.delete(task); }
}
function layout() {
  const epoch = ++generation;
  observer?.disconnect();
  for (const task of tasks) task.cancel();
  const available = Math.max(160, pages.clientWidth - 40);
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) void draw(pageViews[Number(entry.target.dataset.page) - 1], epoch);
  }, { root: pages, rootMargin: "500px" });
  for (const view of pageViews) {
    const natural = view.page.getViewport({ scale: 1 });
    view.scale = (fitWidth ? available / natural.width : 1) * zoom;
    const viewport = view.page.getViewport({ scale: view.scale });
    view.element.style.width = `${viewport.width}px`;
    view.element.style.height = `${viewport.height}px`;
    view.element.dataset.rendered = "false";
    view.element.replaceChildren();
    const label = document.createElement("span"); label.className = "page-label"; label.textContent = `第 ${view.number} 页`; view.element.append(label);
    observer.observe(view.element);
  }
  document.getElementById("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
}
async function open() {
  const file = new URLSearchParams(location.search).get("file");
  if (!file) throw new Error("缺少 PDF 地址");
  const url = new URL(file, location.origin);
  if (url.origin !== location.origin || !(url.pathname === "/api/course-builder/export" || url.pathname.startsWith("/api/files/"))) throw new Error("只允许预览本机工作区文件");
  // Native download managers may hijack even fetch(application/pdf), replacing
  // its response with 204 and launching a download. Only JSON crosses the network.
  const response = await fetch(`/api/pdf-content?file=${encodeURIComponent(url.pathname + url.search)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`读取 PDF 失败 (HTTP ${response.status})：${(await response.text()).slice(0, 500)}`);
  const payload = await response.json();
  if (typeof payload.data !== "string" || !Number.isSafeInteger(payload.byteLength)) throw new Error("PDF 预览响应格式错误");
  const data = Uint8Array.from(atob(payload.data), (character) => character.charCodeAt(0));
  if (!data.byteLength || data.byteLength !== payload.byteLength) throw new Error("PDF 预览数据不完整");
  console.info("[pdf-preview] received content", { bytes: data.byteLength });
  if (disposed) return;
  loading = getDocument({ data, cMapUrl: "/api/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/api/pdfjs/standard_fonts/", wasmUrl: "/api/pdfjs/wasm/", iccUrl: "/api/pdfjs/iccs/", isEvalSupported: false });
  pdf = await loading.promise;
  if (disposed) return;
  console.info("[pdf-preview] loaded", { pages: pdf.numPages });
  document.getElementById("page-count").textContent = `/ ${pdf.numPages}`;
  pageNumber.max = String(pdf.numPages);
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    if (disposed) return;
    const element = document.createElement("section");
    element.className = "page"; element.dataset.page = String(number); element.setAttribute("aria-label", `第 ${number} 页`);
    pages.append(element); pageViews.push({ page, number, element, epoch: 0, scale: 1 });
  }
  for (const control of [pageNumber, zoomIn, zoomOut, fit]) control.disabled = false;
  updatePage(1); layout();
}
previous.onclick = () => goToPage(Number(pageNumber.value) - 1);
next.onclick = () => goToPage(Number(pageNumber.value) + 1);
pageNumber.onchange = () => goToPage(pageNumber.value);
zoomIn.onclick = () => { zoom = Math.min(3, zoom + .25); layout(); };
zoomOut.onclick = () => { zoom = Math.max(.25, zoom - .25); layout(); };
fit.onclick = () => { fitWidth = true; zoom = 1; layout(); };
pages.onscroll = () => {
  if (!pdf) return;
  const top = pages.getBoundingClientRect().top;
  const current = pageViews.find((view) => view.element.getBoundingClientRect().bottom > top + 24);
  if (current) updatePage(current.number);
};
const resize = new ResizeObserver(() => { clearTimeout(resizeTimer); if (pdf) resizeTimer = setTimeout(layout, 120); });
resize.observe(pages);
window.addEventListener("pagehide", () => { disposed = true; generation++; clearTimeout(resizeTimer); resize.disconnect(); observer?.disconnect(); for (const task of tasks) task.cancel(); void loading?.destroy(); });
void open().catch(fail);
