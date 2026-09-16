import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const directory = resolve(process.env.PI_STUDY_SELECTION_ARTIFACT_DIR || "../../.artifacts/study-research/selection");
await mkdir(directory, { recursive: true });
const base = "http://127.0.0.1:30185";
const sessionId = "selection-browser-session";
const projectId = "selection-browser-project";
const originalHash = "sha256:selection-original";
const changedHash = "sha256:selection-changed";
const primaryChunkText = "Selection fixture: raw <b>marker</b> & quote for source selection. Only this bounded quote should travel.";
const secondaryChunkText = "Second source fixture: this text must never be included in a question about the primary selection.";
const now = "2026-09-12T12:00:00.000Z";
const selectedQuestion = "这段摘录中的关键前提是什么？";
const state = {
  sourceHashChanged: false,
  revision: 1,
  notes: Array.from({ length: 25 }, (_, index) => ({
    noteId: `fixture-note-${index + 1}`,
    nodeIds: [],
    body: `Note ${index + 1} · synthetic pagination fixture`,
    author: "user",
    createdAt: now,
    updatedAt: now,
    sourceId: "source-primary",
    sourceHash: originalHash,
    stale: false,
  })),
  promptPayloads: [],
  notePayloads: [],
};

function jsonResponse(route, value, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

function sourceVersion(sourceId, relativePath, contentHash, sourceRole) {
  return {
    sourceId,
    sourceRoot: "C:\\selection-fixture",
    relativePath,
    kind: "tex",
    sourceRole,
    version: state.sourceHashChanged && sourceId === "source-primary" ? 2 : 1,
    contentHash,
    current: true,
    createdAt: now,
    parser: "selection-browser-fixture",
    diagnostics: [],
  };
}

function workspace() {
  const primaryHash = state.sourceHashChanged ? changedHash : originalHash;
  return {
    project: { id: projectId, title: "来源选择 · 浏览器协议夹具", cwd: "C:\\selection-fixture" },
    phase: { projectId, sessionId, phase: "study", revision: 1, changedAt: now },
    snapshotId: "snapshot-selection-fixture",
    revision: state.revision,
    sources: [
      sourceVersion("source-primary", "primary.tex", primaryHash, "primary"),
      sourceVersion("source-secondary", "appendix.tex", "sha256:selection-secondary", "reference"),
    ],
    knowledge: {
      notes: state.notes,
      nodes: Array.from({ length: 25 }, (_, index) => ({
        nodeId: `fixture-node-${index + 1}`,
        title: `Node ${index + 1}`,
        statement: `Node ${index + 1} · synthetic pagination fixture`,
        kind: "claim",
        scope: "study",
        sourceHash: index % 2 === 0 ? primaryHash : null,
        stale: false,
      })),
      relations: [],
    },
    tasks: [],
    checkpoints: [],
    visualizations: [],
    plans: [],
    sourceUpdates: [],
    cells: [],
  };
}

function readChunks(sourceId, sourceHash) {
  const isPrimary = sourceId === "source-primary";
  const text = isPrimary ? primaryChunkText : secondaryChunkText;
  return [{
    chunkId: `${sourceId}-chunk-1`,
    sourceId,
    sourceHash,
    textHash: `sha256:text-${sourceId}`,
    ordinal: 1,
    locator: JSON.stringify({ kind: "tex-lines", startLine: isPrimary ? 42 : 8, endLine: isPrimary ? 44 : 10 }),
    text,
  }];
}

function sessionInfo() {
  return {
    path: "C:\\selection-fixture\\session.jsonl",
    id: sessionId,
    cwd: "C:\\selection-fixture",
    name: "原始 Study 论文对话",
    created: now,
    modified: now,
    messageCount: 0,
    firstMessage: "",
  };
}

function sessionData() {
  return {
    sessionId,
    filePath: "C:\\selection-fixture\\session.jsonl",
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    toolNames: [],
    context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: { provider: "fixture", modelId: "selection" } },
  };
}

function agentState() {
  return {
    running: false,
    state: {
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: false,
      isCompacting: false,
      queuedMessages: { steering: [], followUp: [] },
      thinkingLevel: "off",
      systemPrompt: "Study browser fixture",
      extensionStatuses: [],
      extensionWidgets: [],
    },
  };
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
const requestUrls = [];
const downloads = [];
page.setDefaultTimeout(45000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => requestUrls.push(request.url()));
page.on("download", (download) => downloads.push(download.suggestedFilename()));

// Keep the test local and deterministic while still mounting the production
// StudyConversation and ChatWindow. The real product sends the same prompt
// through its own EventSource implementation; this shim only supplies the
// readiness handshake without starting another server or provider.
await page.addInitScript(() => {
  class SelectionFixtureEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = SelectionFixtureEventSource.CONNECTING;
    onmessage = null;
    onerror = null;
    constructor(url) {
      this.url = url;
      setTimeout(() => {
        if (this.readyState === SelectionFixtureEventSource.CLOSED) return;
        this.readyState = SelectionFixtureEventSource.OPEN;
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "connected" }) }));
      }, 0);
    }
    close() {
      this.readyState = SelectionFixtureEventSource.CLOSED;
    }
  }
  window.EventSource = SelectionFixtureEventSource;
});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;
  if (pathname === "/api/study-research/session" && request.method() === "POST") {
    assert.equal(request.postDataJSON().sessionId, sessionId);
    return jsonResponse(route, { sessionId, verified: true });
  }
  if (pathname === "/api/study-research/reading") return jsonResponse(route, { tasks: [] });
  if (pathname === "/api/study-research/execution") return jsonResponse(route, { runs: [], capacity: null, capacityError: null, policy: null });
  if (pathname === "/api/study-research/environment") return jsonResponse(route, { plans: [], operations: [] });
  if (pathname === "/api/study-research" && request.method() === "GET") {
    if (url.searchParams.get("action") === "read") {
      const sourceId = url.searchParams.get("sourceId") || "";
      const sourceHash = url.searchParams.get("sourceHash") || "";
      const expectedHash = sourceId === "source-primary" && state.sourceHashChanged ? changedHash
        : sourceId === "source-primary" ? originalHash : "sha256:selection-secondary";
      assert.equal(sourceHash, expectedHash, "reader requested the selected source version");
      return jsonResponse(route, { chunks: readChunks(sourceId, sourceHash), nextOffset: null });
    }
    return jsonResponse(route, workspace());
  }
  if (pathname === "/api/study-research" && request.method() === "POST") {
    const body = request.postDataJSON();
    if (body.action === "note") {
      state.notePayloads.push(body);
      state.notes.unshift({
        noteId: "fixture-note-saved",
        nodeIds: [],
        body: body.body,
        author: "user",
        createdAt: now,
        updatedAt: now,
        sourceId: body.sourceId,
        sourceHash: body.sourceHash,
        stale: false,
      });
      state.revision += 1;
    }
    return jsonResponse(route, workspace());
  }
  if (pathname === "/api/agent/" + sessionId && request.method() === "POST") {
    const body = request.postDataJSON();
    if (body.type === "prompt") state.promptPayloads.push(body);
    return jsonResponse(route, { success: true, data: body.type === "get_state" ? agentState().state : { accepted: true } });
  }
  if (pathname === "/api/agent/" + sessionId && request.method() === "GET") return jsonResponse(route, agentState());
  if (pathname === "/api/sessions/" + sessionId && request.method() === "GET") {
    return url.search ? jsonResponse(route, sessionData()) : jsonResponse(route, { info: sessionInfo() });
  }
  if (pathname === "/api/sessions/" + sessionId + "/state" && request.method() === "GET") return jsonResponse(route, agentState());
  if (pathname === "/api/models" && request.method() === "GET") {
    return jsonResponse(route, {
      models: { "fixture/selection": "Selection fixture" },
      modelList: [{ id: "selection", name: "Selection fixture", provider: "fixture" }],
      defaultModel: { provider: "fixture", modelId: "selection" },
      thinkingLevels: { "fixture/selection": ["off"] },
      thinkingLevelMaps: { "fixture/selection": { off: "off" } },
    });
  }
  if (pathname === "/api/projects" && request.method() === "GET") {
    return jsonResponse(route, {
      projects: [{ id: projectId, title: "来源选择 · 浏览器协议夹具", cwd: "C:\\selection-fixture", courseProjectId: null, defaults: null, revision: 1 }],
      conversations: [{ id: sessionId, title: "原始 Study 论文对话", modified: now, messageCount: 0, cwd: "C:\\selection-fixture", projectId, href: `/study?sessionId=${sessionId}`, student: false }],
    });
  }
  if (pathname === "/api/app-update" && request.method() === "GET") return jsonResponse(route, { updateAvailable: false });
  return route.continue();
});

const evidence = { sessionId, projectId, startedAt: new Date().toISOString(), qualification: "Actual browser UI and local API interception only; synthetic fixture, no academic correctness claim or paid provider call." };
let activePage = page;
try {
  await writeFile(join(directory, "seed.json"), JSON.stringify({ sessionId, projectId, base }, null, 2));
  await page.goto(`${base}/study?sessionId=${sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Study 论文工作区", exact: true }).waitFor();
  const chat = page.getByRole("complementary", { name: "学习与研究对话", exact: true });
  await chat.locator("textarea").first().waitFor({ state: "visible" });
  const firstChunk = page.locator('pre[data-selection-source-id="source-primary"]').first();
  await firstChunk.waitFor({ state: "visible" });
  await firstChunk.focus();
  assert.equal(await firstChunk.evaluate((element) => document.activeElement === element), true, "reader chunk is keyboard focusable");

  const selectionResult = await firstChunk.evaluate((element) => {
    const textNode = element.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) throw new Error("fixture chunk did not render as text");
    const text = textNode.textContent || "";
    const quote = "raw <b>marker</b> & quote";
    const start = text.indexOf(quote);
    if (start < 0) throw new Error("selection quote not found in fixture chunk");
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + quote.length);
    const selection = window.getSelection();
    if (!selection) throw new Error("browser selection API unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", code: "ArrowRight", bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    return { quote, selectedText: selection.toString() };
  });
  assert.equal(selectionResult.selectedText, selectionResult.quote);
  const selectionPanel = page.getByRole("region", { name: "已选择来源片段", exact: true });
  await selectionPanel.waitFor({ state: "visible" });
  assert.equal(await selectionPanel.locator("pre").innerText(), selectionResult.quote);
  assert.equal(await selectionPanel.locator("b").count(), 0, "raw quote stays text, not HTML");
  assert.match(await selectionPanel.innerText(), new RegExp(originalHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  evidence.selection = { ...selectionResult, sourceHash: originalHash, chunkId: "source-primary-chunk-1", locator: JSON.stringify({ kind: "tex-lines", startLine: 42, endLine: 44 }), keyboardFocusable: true };

  await selectionPanel.getByRole("button", { name: "加入笔记", exact: true }).click();
  assert.match(await page.locator("#study-note-body").inputValue(), /raw <b>marker<\/b> & quote/);
  await page.locator("#study-note-title").fill("Selection fixture note");
  const noteResponse = page.waitForResponse((response) => response.url().endsWith("/api/study-research") && response.request().method() === "POST");
  await page.locator("#study-note-form").getByRole("button", { name: "保存笔记", exact: true }).click();
  const savedNoteResponse = await noteResponse;
  assert.equal(savedNoteResponse.status(), 200, await savedNoteResponse.text());
  assert.equal(state.notePayloads.length, 1);
  assert.equal(state.notePayloads[0].sourceHash, originalHash);
  assert.match(state.notePayloads[0].body, /raw <b>marker<\/b> & quote/);
  evidence.note = { sourceHash: state.notePayloads[0].sourceHash, body: state.notePayloads[0].body, saved: true };

  const promptResponse = page.waitForResponse((response) => response.url().includes(`/api/agent/${sessionId}`) && response.request().method() === "POST" && response.request().postDataJSON()?.type === "prompt");
  await selectionPanel.getByLabel("针对选中内容提问", { exact: true }).fill(selectedQuestion);
  await selectionPanel.getByRole("button", { name: "发送到当前对话", exact: true }).click();
  const sentPromptResponse = await promptResponse;
  assert.equal(sentPromptResponse.status(), 200, await sentPromptResponse.text());
  await page.getByRole("status").filter({ hasText: "问题已发送到当前原始 Pi 对话" }).waitFor();
  assert.equal(state.promptPayloads.length, 1, "question used the original Pi prompt command");
  const prompt = state.promptPayloads[0];
  assert.equal(prompt.type, "prompt");
  assert.match(prompt.message, new RegExp(`sourceHash: ${originalHash}`));
  assert.match(prompt.message, /chunkId: source-primary-chunk-1/);
  assert.match(prompt.message, /locator: \{"kind":"tex-lines","startLine":42,"endLine":44\}/);
  assert.match(prompt.message, /raw <b>marker<\/b> & quote/);
  assert.ok(!prompt.message.includes(secondaryChunkText), "question contains the selected quote only");
  assert.ok(!prompt.message.includes("autoResearch") && !prompt.message.includes("exam"), "question does not invoke automatic research or exam mode");
  assert.equal(await chat.locator("textarea").count(), 1, "the original ChatWindow composer remains mounted");
  evidence.prompt = { payload: prompt, originalChatWindow: true, providerCalls: 0 };

  state.sourceHashChanged = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.locator('pre[data-selection-source-hash="sha256:selection-changed"]').first().waitFor({ state: "visible" });
  await selectionPanel.waitFor({ state: "hidden" });
  evidence.hashInvalidation = { changedFrom: originalHash, changedTo: changedHash, selectionCleared: true, readingLocationPreserved: true };

  await page.locator("#sources article").nth(1).getByRole("button").click();
  await page.locator('pre[data-selection-source-id="source-secondary"]').first().waitFor({ state: "visible" });
  await selectionPanel.waitFor({ state: "hidden" });
  evidence.sourceSwitchInvalidation = { sourceId: "source-secondary", selectionCleared: true };

  const notePager = page.getByRole("navigation", { name: "笔记分页", exact: true });
  assert.equal(await page.locator("#notes ul").first().locator("li").count(), 12);
  await notePager.getByRole("button", { name: "下一页", exact: true }).click();
  await notePager.getByText("第 2 / 3 页", { exact: false }).waitFor();
  assert.match(await page.locator("#notes ul").first().innerText(), /Note 13/);
  const graph = page.locator("#notes details").filter({ hasText: "知识图谱摘要" });
  await graph.locator("summary").click();
  const nodePager = graph.getByRole("navigation", { name: "节点分页", exact: true });
  assert.equal(await graph.locator("ul").first().locator("li").count(), 12);
  await nodePager.getByRole("button", { name: "下一页", exact: true }).click();
  await nodePager.getByText("第 2 / 3 页", { exact: false }).waitFor();
  assert.match(await graph.locator("ul").first().innerText(), /Node 13/);
  evidence.pagination = { notesPage: "2 / 3", nodesPage: "2 / 3", notePageSize: 12, nodePageSize: 12 };

  const disallowedProviderRequests = requestUrls.filter((url) => /\/v1\/|openai|anthropic|gemini/i.test(url));
  assert.deepEqual(disallowedProviderRequests, [], "browser used local API interception only");
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads, []);
  evidence.finishedAt = new Date().toISOString();
  evidence.errors = errors;
  evidence.downloads = downloads;
  evidence.apiRequests = requestUrls.filter((url) => url.includes("/api/")).length;
  await page.screenshot({ path: join(directory, "selection-browser.png"), fullPage: false });
  await writeFile(join(directory, "selection-browser-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ selection: true, prompt: true, note: true, hashInvalidation: true, pagination: true, errors }));
} catch (error) {
  await writeFile(join(directory, "selection-browser-failure.json"), JSON.stringify({ ...evidence, error: String(error), errors }, null, 2));
  await activePage.screenshot({ path: join(directory, "selection-browser-failure.png"), fullPage: true });
  await writeFile(join(directory, "selection-browser-failure.txt"), await activePage.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
