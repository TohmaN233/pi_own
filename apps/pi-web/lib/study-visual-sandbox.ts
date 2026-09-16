export interface StudyVisualInput {
  code: string;
  inputs: Record<string, unknown>;
  channel: string;
}

/** The bridge only reports display status. It never grants validation or publication. */
export function isStudyVisualMessage(
  event: Pick<MessageEvent, "source" | "origin" | "data">,
  frameWindow: Window | null,
  channel: string,
): event is MessageEvent<{ channel: string; type: "rendered" | "error"; message: string; observation?: { elements: Array<{ tag: string; attrs: Record<string, string>; text?: string }> } }> {
  const value: unknown = event.data;
  if (!frameWindow || event.source !== frameWindow || event.origin !== "null") return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.channel === channel
    && (record.type === "rendered" || record.type === "error")
    && typeof record.message === "string" && record.message.length <= 2000;
}

const FRAME_RUNTIME = String.raw`
"use strict";
const settings = JSON.parse(document.getElementById("settings").textContent);
const stage = document.getElementById("stage");
const status = document.getElementById("status");
const report = (type, message, observation) => {
  status.textContent = message.slice(0, 2000);
  parent.postMessage({ channel: settings.channel, type, message: message.slice(0, 2000), ...(observation ? {observation} : {}) }, "*");
};
const workerSource = '"use strict"; onmessage = async ({data}) => { try { const render = new Function("inputs", data.code); const scene = await render(data.inputs); postMessage({ok: true, scene}); } catch (error) { postMessage({ok:false, error:String(error)}); } };';
// Custom code runs off the UI thread and receives no host window, DOM, or capability bridge.
const workerBlob = new Blob([workerSource], {type:"text/javascript"});
const workerUrl = URL.createObjectURL(workerBlob);
const worker = new Worker(workerUrl);
URL.revokeObjectURL(workerUrl);
let settled = false;
const stop = (message) => { if (settled) return; settled = true; worker.terminate(); report("error", message); };
const timeout = setTimeout(() => stop("可视化超过 3 秒执行上限，已终止；请简化计算。"), 3000);
worker.onerror = (event) => { clearTimeout(timeout); stop(event.message || "可视化执行失败"); };
worker.onmessage = ({data}) => {
  if (settled) return;
  clearTimeout(timeout);
  worker.terminate();
  try {
    if (!data || data.ok !== true) throw new Error(data && data.error || "可视化未返回场景");
    if (JSON.stringify(data.scene).length > 1000000) throw new Error("可视化输出超过上限");
    const scene = data.scene;
    if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements) || scene.elements.length > 4096) throw new Error("场景需要至多 4096 个图元");
    const allowed = {
      path: ["d"], circle: ["cx","cy","r"], ellipse: ["cx","cy","rx","ry"],
      line: ["x1","x2","y1","y2"], rect: ["x","y","width","height","rx"],
      polyline: ["points"], polygon: ["points"], text: ["x","y","font-size","text-anchor"]
    };
    const common = ["fill","stroke","stroke-width","opacity","fill-opacity","stroke-opacity"];
    const fragment = document.createDocumentFragment();
    for (const element of scene.elements) {
      if (!element || !Object.hasOwn(allowed, element.tag) || !element.attrs || typeof element.attrs !== "object" || Array.isArray(element.attrs)) throw new Error("不支持的图元");
      const node = document.createElementNS("http://www.w3.org/2000/svg", element.tag);
      for (const [key, value] of Object.entries(element.attrs)) {
        if (![...allowed[element.tag], ...common].includes(key)) throw new Error("不支持的图元属性: " + key);
        if (!["number","string"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new Error("属性不是有限值");
        const text = String(value);
        if (text.length > 65536 || /url\s*\(|[<>"'\\]/i.test(text)) throw new Error("图元属性包含禁止内容");
        node.setAttribute(key, text);
      }
      if (element.tag === "text") {
        if (typeof element.text !== "string" || element.text.length > 4096) throw new Error("文本图元无有效文本");
        node.textContent = element.text;
      }
      fragment.append(node);
    }
    stage.replaceChildren(fragment);
    settled = true;
    // Observe the sanitized DOM, not the untrusted worker's claimed status or metrics.
    const observation = {elements: Array.from(stage.children, node => ({tag: node.localName, attrs: Object.fromEntries(Array.from(node.attributes, item => [item.name, item.value])), ...(node.localName === "text" ? {text: node.textContent} : {})}))};
    report("rendered", typeof scene.summary === "string" ? scene.summary : "草稿已渲染；数学与交互验证另行进行。", observation);
  } catch (error) { stop(String(error)); }
};
worker.postMessage({code: settings.code, inputs: settings.inputs});
`;

export function createStudyVisualFrame(input: StudyVisualInput): string {
  if (!/^[a-zA-Z0-9-]{16,100}$/u.test(input.channel)) throw new Error("Invalid visualization channel");
  if (!input.code.trim() || input.code.length > 131072) throw new Error("Visualization code must contain 1–131072 characters");
  const serialized = JSON.stringify(input);
  if (serialized.length > 262144) throw new Error("Visualization inputs exceed the frame limit");
  const settings = serialized.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  const policy = `default-src 'none'; script-src 'nonce-${input.channel}' 'unsafe-eval'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'nonce-${input.channel}'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style nonce="${input.channel}">body{margin:0;padding:12px;font:14px system-ui;background:#fff;color:#17212b}svg{display:block;width:100%;height:auto;max-height:520px}p{line-height:1.5}</style></head><body><svg id="stage" role="img" aria-label="可定制学习可视化" viewBox="0 0 800 500"></svg><p id="status" role="status">正在运行草稿…</p><script id="settings" type="application/json">${settings}</script><script nonce="${input.channel}">${FRAME_RUNTIME}</script></body></html>`;
}

/** Included in Host environment hashes so a renderer/bridge change invalidates prior checks. */
export function studyVisualRuntimeIdentity() {
  return { protocol: "worker-svg-v1", runtime: FRAME_RUNTIME,
    frameBuilder: createStudyVisualFrame.toString(), messageValidator: isStudyVisualMessage.toString() };
}
