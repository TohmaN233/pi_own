// Run against a production build. All application API calls are intercepted;
// this isolated browser never changes the user's sessions or course projects.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
function fixturePdf() {
  const stream = "0.1 0.3 0.7 rg 20 20 180 80 re f";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>"];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDefaultCourseBuilderProject } = await jiti.import("../lib/course-builder-defaults.ts");
const { createCourseBuilderSetup } = await jiti.import("../lib/course-builder-onboarding.ts");
const project = { ...createDefaultCourseBuilderProject(), title: "Browser regression course", sessionsPerWeek: 3, projectId: "fixture-course", revision: 1 };
const snapshot = { project, materials: [], assignments: [], lessonPlans: [], decks: [], visuals: [], compileReceipts: [], deckReviews: [], semesterPlan: null, materialAnalysis: null };
const info = { id: "fixture-session", path: "G:/fixture/session.jsonl", cwd: "G:/fixture", name: "Teacher fixture", created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 0, firstMessage: "" };
const messages = [];
const revisionTasks = [];
const lessonTaskRequests = [];
const promptTaskRequests = [];
const skillInstalls = [];
const librarySkills = [];
const skillUpdates = [];
let toolNames = [];
let failToolChange = false;
const ordinaryInfo = { ...info, id: "fixture-ordinary", name: "", messageCount: 0, firstMessage: "", path: "G:/fixture/new.jsonl" };
const projectDirectory = { projects: [{ id: project.projectId, title: project.title, cwd: info.cwd, courseProjectId: project.projectId, defaults: null, revision: 0 }], conversations: [
  { id: info.id, title: info.name, cwd: info.cwd, projectId: project.projectId, modified: info.modified, messageCount: 3, student: false, href: `/course-builder?sessionId=${info.id}` },
  { id: ordinaryInfo.id, title: "Independent fixture", cwd: info.cwd, projectId: null, modified: info.modified, messageCount: 0, student: false, href: `/?session=${ordinaryInfo.id}` },
] };
const projectRequests = [];
let selectedModel = { provider: "fixture", modelId: "fixture-model" };
const modeSettings = { sessionId: info.id, cwd: info.cwd, kind: "generic", modePackId: "course-builder", snapshotId: "fixture-snapshot", systemPrompt: "Prepare a course using the saved teacher identity.", verified: true, live: true, busy: false, skillDirectory: "G:/pi_own/skills", skills: Array.from({ length: 10 }, (_, index) => ({ id: `skill.${index}`, name: `Teaching skill ${index}`, filePath: `G:/pi_own/skills/skill-${index}/SKILL.md`, content: `Complete instructions ${index}\n`.repeat(90), required: index === 0, enabled: index < 2, loaded: index < 2, contentHash: "fixture-hash" })) };
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const downloads = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const calls = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/pdfjs/")) return route.continue();
    if (url.pathname === "/api/pdf-content") { const bytes = fixturePdf(); return route.fulfill({ json: { data: bytes.toString("base64"), byteLength: bytes.length } }); }
    calls.push(`${req.method()} ${url.pathname}`);
    if (url.pathname === `/api/agent/${info.id}/events`) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"connected","isStreaming":false}\n\n' });
    if (url.pathname === "/api/chat-attachments") {
      assert.match(req.postDataBuffer().toString(), /attachment payload/);
      assert.match(req.postDataBuffer().toString(), /fixture-session/);
      return route.fulfill({ json: { attachments: [{ id: "fixture-attachment", name: "notes.custom", path: "G:/fixture/.pi/chat-attachments/fixture-attachment/original/notes.custom", textPath: "G:/fixture/.pi/chat-attachments/fixture-attachment/extracted.txt", extractionError: null }] } });
    }
    let body;
    let status = 200;
    if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: librarySkills, diagnostics: [], projectResourcesLoaded: true, installDirectory: "G:/pi_own/skills" } });
    if (url.pathname === "/api/projects") {
      if (req.method() === "GET") return route.fulfill({ json: projectDirectory });
      const input = req.postDataJSON(); projectRequests.push(input);
      if (input.action === "create") { const folder = { id: `project_${input.requestId}`, title: input.title, cwd: input.cwd, courseProjectId: null, defaults: null, revision: 1 }; projectDirectory.projects.push(folder); return route.fulfill({ json: folder }); }
      if (input.action === "move") { projectDirectory.conversations.find((item) => item.id === input.sessionId).projectId = input.projectId; return route.fulfill({ json: { success: true } }); }
      if (input.action === "save_defaults") { const folder = projectDirectory.projects.find((item) => item.id === input.projectId); folder.revision++; return route.fulfill({ json: { revision: folder.revision } }); }
      if (input.action === "new_conversation") {
        info.id = "fixture-second-course-chat"; info.name = input.title; messages.length = 0;
        const href = `/course-builder?sessionId=${info.id}`;
        projectDirectory.conversations.push({ id: info.id, title: input.title, cwd: info.cwd, projectId: input.projectId, modified: info.modified, messageCount: 0, student: false, href });
        return route.fulfill({ json: { sessionId: info.id, href } });
      }
      throw new Error(`Unexpected project request: ${input.action}`);
    }
    if (url.pathname === "/api/skills/search") {
      assert.equal(req.postDataJSON().query, "visual fixture");
      return route.fulfill({ json: { results: [{ package: "fixture/repo@market-fixture", installs: "10", url: "https://skills.sh/fixture/repo/market-fixture" }] } });
    }
    if (url.pathname === "/api/skills/install") {
      const input = req.postDataJSON();
      skillInstalls.push(input);
      assert.equal(input.scope, "project");
      const name = input.package.split("@").at(-1);
      librarySkills.push({ name, description: "Complete fixture", filePath: `G:/pi_own/skills/${name}/SKILL.md`, sourceInfo: { source: "pi-own-local-skills", scope: "path" }, disableModelInvocation: false, install: { scope: "project", directory: "G:/pi_own/skills", package: input.package, source: "fixture/repo", sourceType: "github", canCheckForUpdates: true, versionHash: "v1" } });
      modeSettings.skills.push({ id: `local.skill.${name}`, name, filePath: librarySkills.at(-1).filePath, content: "Complete fixture", required: false, enabled: false, loaded: false, contentHash: "fixture" });
      return route.fulfill({ json: { success: true, skills: [name], directory: "G:/pi_own/skills" } });
    }
    if (url.pathname === "/api/skills/check") return route.fulfill({ json: { updates: [{ scope: "project", package: req.postDataJSON().package, state: "update-available", currentVersion: "v1", latestVersion: "v2" }] } });
    if (url.pathname === "/api/skills/update") {
      const input = req.postDataJSON();
      skillUpdates.push(input);
      const skill = librarySkills.find((item) => item.install.package === input.package);
      assert.equal(input.scope, "project");
      skill.install.versionHash = "v2";
      return route.fulfill({ json: { success: true, skill, directory: "G:/pi_own/skills" } });
    }
    if (url.pathname.startsWith("/api/files/")) {
      if (url.searchParams.get("type") === "list") return route.fulfill({ json: { entries: [] } });
      assert.equal(url.searchParams.get("sessionId"), info.id);
      if (url.searchParams.get("type") === "watch") return route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
      const denied = decodeURIComponent(url.pathname).endsWith("/denied.md");
      return route.fulfill({ status: denied ? 403 : 200, json: denied ? { error: "Fixture file access denied" } : { content: "# Lesson preview\n\n[Denied file](denied.md)\n\n" + "Preview paragraph.\n\n".repeat(100), language: "markdown", size: 2400 } });
    }
    if (url.pathname === "/api/git/diff") return route.fulfill({ json: { supported: false } });
    if (url.pathname === "/api/git/status") return route.fulfill({ json: { isGitRepo: false, files: [] } });
    if (url.pathname === `/api/sessions/${ordinaryInfo.id}`) return route.fulfill({ json: { sessionId: ordinaryInfo.id, info: ordinaryInfo, filePath: ordinaryInfo.path, tree: [], leafId: null, totalActiveMs: 0, context: { messages: [], entryIds: [], hasMore: false, thinkingLevel: "high", model: selectedModel } } });
    if (url.pathname === `/api/sessions/${ordinaryInfo.id}/state`) return route.fulfill({ json: { running: false } });
    if (url.pathname === `/api/agent/${ordinaryInfo.id}`) return route.fulfill({ json: { success: true, data: req.postDataJSON()?.type === "get_tools" ? [] : { commands: [] } } });
    if (url.pathname === "/api/sessions") return route.fulfill({ json: { sessions: [info, ordinaryInfo], runningSessionIds: [], completionNotificationSuppressedSessionIds: [] } });
    if (url.pathname === "/api/agent/running") return route.fulfill({ json: { runningSessionIds: [], completionNotificationSuppressedSessionIds: [] } });
    if (url.pathname === "/api/home") return route.fulfill({ json: { home: "G:/fixture" } });
    if (url.pathname === "/api/cwd/validate") return route.fulfill({ json: { cwd: "G:/fixture", projectRoot: "G:/fixture", projectKey: "G:/fixture" } });
    if (url.pathname === "/api/worktrees") return route.fulfill({ json: { worktrees: [] } });
    if (url.pathname === "/api/project-trust") return route.fulfill({ json: { status: "trusted", trusted: true } });
    if (url.pathname === "/api/harness/status") return route.fulfill({ json: { ready: true, session: null, courses: [], activeCourseVersionId: null, availableProfiles: [], modePackComponents: [] } });
    if (url.pathname === "/api/course-builder/export") {
      if (url.searchParams.get("kind") === "pdf") throw new Error("Preview must not request a native PDF response: download managers can hijack it");
      return route.fulfill({ contentType: "text/markdown", body: "# Assignment preview\n\nA real exported assignment." });
    }
    if (url.pathname === "/api/course-builder/deck") return route.fulfill({ json: { deck: snapshot.decks.find((deck) => deck.deckId === url.searchParams.get("id")), compilerEnabled: false } });
    if (url.pathname === "/api/mode-packs/status") {
      const ordinary = url.searchParams.get("sessionId") === ordinaryInfo.id;
      body = { sessionId: ordinary ? ordinaryInfo.id : info.id, kind: "generic", live: !ordinary, busy: false, verified: true, currentModePackId: ordinary ? null : "course-builder", currentSnapshotId: ordinary ? null : "fixture-snapshot", packs: [], resources: [], diagnostics: [], activeTools: [], expectedTools: [], diagnostic: null };
    }
    else if (url.pathname === "/api/course-builder/session") body = { sessionId: info.id, verified: true };
    else if (url.pathname === `/api/sessions/${info.id}`) body = { sessionId: info.id, info, filePath: info.path, tree: [], leafId: null, totalActiveMs: 0, context: { messages, entryIds: messages.map((_, index) => `message-${index}`), oldestEntryId: null, hasMore: false, thinkingLevel: "high", model: selectedModel } };
    else if (url.pathname === `/api/sessions/${info.id}/state`) body = { running: true, state: { isStreaming: false, isPromptRunning: false, systemPrompt: modeSettings.systemPrompt, thinkingLevel: "high" } };
    else if (url.pathname === `/api/agent/${info.id}`) {
      if (req.method() === "GET") return route.fulfill({ json: { running: true, state: { isStreaming: false, isPromptRunning: false } } });
      const command = req.postDataJSON();
      if (command.type === "set_model") selectedModel = { provider: command.provider, modelId: command.modelId };
      if (command.type === "set_tools") {
        if (failToolChange) return route.fulfill({ status: 500, json: { error: "Fixture tool selection failed" } });
        toolNames = command.toolNames;
      }
      body = { success: true, data: command.type === "get_tools" ? [...toolNames, "course_builder"].map((name) => ({ name, description: name, active: true })) : command.type === "set_tools" ? { sessionId: info.id, recreated: true } : command.type === "get_commands" ? { commands: [] } : command.type === "get_state" ? { systemPrompt: modeSettings.systemPrompt, thinkingLevel: "high" } : null };
    }
    else if (url.pathname === "/api/models") body = { models: { "fixture/fixture-model": "Fixture Alpha", "fixture/fixture-other": "Fixture Beta" }, modelList: [{ provider: "fixture", id: "fixture-model", name: "Fixture Alpha" }, { provider: "fixture", id: "fixture-other", name: "Fixture Beta" }], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {} };
    else if (url.pathname === "/api/app-update") body = { currentVersion: "0.8.11", latestVersion: "0.8.11", updateAvailable: false };
    else if (url.pathname === "/api/mode-packs/settings") {
      if (req.method() === "POST") {
        const value = req.postDataJSON();
        assert.equal(value.expectedSnapshotId, modeSettings.snapshotId);
        modeSettings.systemPrompt = value.settingsPatch.systemPrompt ?? modeSettings.systemPrompt;
        for (const selection of value.settingsPatch.skills ?? []) Object.assign(modeSettings.skills.find((skill) => skill.id === selection.id), { enabled: selection.enabled, loaded: selection.enabled });
        modeSettings.snapshotId += "-next";
      }
      body = modeSettings;
    }
    else if (url.pathname === "/api/course-builder") {
      const input = req.method() === "POST" ? req.postDataJSON() : null;
      if (input?.action === "lesson_task") lessonTaskRequests.push(input);
      if (input?.action === "edit_lesson") {
        const lesson = snapshot.lessonPlans.find((item) => item.lessonPlanId === input.id);
        assert.equal(input.expectedRevision, lesson.revision);
        assert.equal(input.parentRevision, lesson.semesterPlanRevision);
        Object.assign(lesson, input.draft, { revision: lesson.revision + 1, status: "draft", review: null });
      }
      if (input?.action === "edit_deck") {
        const deck = snapshot.decks.find((item) => item.deckId === input.id);
        assert.equal(input.expectedRevision, deck.revision); assert.equal(input.parentRevision, deck.lessonPlanRevision);
        assert.equal(req.headers()["x-course-builder-teacher"], "1");
        Object.assign(deck, { source: input.source, frameOutline: input.frameOutline, revision: deck.revision + 1, status: "draft" });
      }
      if (input?.action === "review_lesson") {
        const lesson = snapshot.lessonPlans.find((item) => item.lessonPlanId === input.id);
        assert.equal(input.expectedRevision, lesson.revision);
        lesson.status = input.decision === "approve" ? "approved" : "changes-requested";
        lesson.review = { note: input.note };
      }
      if (input?.action === "prompt") promptTaskRequests.push(input);
      if (input?.action === "update_project") {
        assert.equal(input.expectedRevision, project.revision);
        Object.assign(project, input.project, { revision: project.revision + 1 });
      }
      if (input?.action === "create") {
        assert.ok(input.createdAt);
        assert.equal(input.project.courseId, "MATH-101-201");
        Object.assign(project, input.project, { revision: 1 });
      }
      if (input?.action === "review_semester") {
        assert.equal(input.id, "fixture-semester");
        assert.equal(input.expectedRevision, 1);
        assert.equal(input.decision, "request-changes");
        assert.equal(input.note, "Revise week 2 prerequisites.");
        assert.equal(typeof input.requestId, "string");
        snapshot.semesterPlan.status = "changes-requested";
        snapshot.semesterPlan.review = { note: input.note };
        revisionTasks.push({ requestId: input.requestId, action: input.action, targetId: input.id, baseRevision: 1, note: input.note, status: "sent", running: false });
      }
      if (input?.action === "prompt") messages.push(
        { role: "assistant", content: [{ type: "toolCall", toolCallId: "fixture-save", toolName: "course_builder", input: { action: "save_semester" } }], timestamp: Date.now() },
        { role: "toolResult", toolCallId: "fixture-save", toolName: "course_builder", content: [{ type: "text", text: JSON.stringify({ semesterPlanId: "fixture-semester", revision: 1 }) }] },
        { role: "assistant", content: [{ type: "text", text: "Fixture analysis is ready in this conversation.\n\n[打开教案](G:/fixture/lesson.md)\n\n[打开作业](/api/course-builder/export?sessionId=fixture-session&kind=assignment-student&id=fixture-assignment)" }], timestamp: Date.now(), stopReason: "stop" }
      );
      body = { projects: [project], projectSessions: { "fixture-course": ["fixture-session"] }, snapshot: url.searchParams.get("sessionId") || input?.sessionId ? { ...snapshot, decks: snapshot.decks.map((deck) => { const view = { ...deck }; delete view.source; return view; }) } : null, revisionTasks, compilerEnabled: false };
      if (input?.action === "edit_deck") body.deck = snapshot.decks.find((deck) => deck.deckId === input.id);
      if (input?.action === "create") body.sessionId = "fixture-session";
    } else if (url.pathname === "/api/cwd/browse") {
      const path = url.searchParams.get("path");
      if (!path) body = { path: "", parentPath: null, drives: [{ name: "G:\\", path: "G:\\" }], directories: [] };
      else if (path === "G:\\") body = { path, parentPath: null, directories: [] };
      else { status = 404; body = { error: "Fixture directory does not exist" }; }
    } else if (url.pathname === "/api/course-builder/link") {
      status = 400;
      body = { error: "Fixture material revision conflict" };
    }
    else throw new Error(`Unexpected application request: ${req.method()} ${url.pathname}`);
    await route.fulfill({ json: body, status });
  });
  await page.goto(`${process.env.PI_SMOKE_URL || "http://127.0.0.1:30141"}/course-builder?sessionId=fixture-session`);
  await page.locator('.model-selector>button').click();
  await page.getByRole("option", { name: "Fixture Beta", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.model-selector>button')?.textContent?.includes("Fixture Beta") && !document.querySelector('.model-selector>button')?.hasAttribute("aria-busy"));
  assert.equal(selectedModel.modelId, "fixture-other");
  await page.reload();
  await page.locator('.model-selector>button').filter({ hasText: "Fixture Beta" }).waitFor();
  const toolSelector = page.getByRole("button", { name: /^(Change tool preset|更改工具预设)$/ });
  await toolSelector.click();
  await page.getByRole("button", { name: /^default\s/ }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Change tool preset"], [aria-label="更改工具预设"]')?.textContent?.includes("default"));
  assert.deepEqual(toolNames, ["read", "bash", "edit", "write"]);
  failToolChange = true;
  await toolSelector.click();
  await page.getByRole("button", { name: /^read-only\s/ }).click();
  await page.getByText("Failed to change tools: Fixture tool selection failed", { exact: true }).waitFor();
  assert.match(await toolSelector.innerText(), /default/);
  failToolChange = false;
  await page.getByLabel("添加聊天附件", { exact: true }).setInputFiles({ name: "notes.custom", mimeType: "application/octet-stream", buffer: Buffer.from("attachment payload") });
  const composer = page.locator(".teacher-agent-chat textarea").last();
  await page.waitForFunction(() => [...document.querySelectorAll(".teacher-agent-chat textarea")].some((input) => input.value.includes("附件：notes.custom")));
  assert.match(await composer.inputValue(), /文本内容/);
  assert.doesNotMatch(await composer.inputValue(), /attachment payload/, "attachment bodies stay out of the prompt until read");
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll(".teacher-agent-chat textarea")].some((input) => input.value.includes("附件：notes.custom")));
  const sentAttachment = page.waitForRequest((request) => request.url().endsWith(`/api/agent/${info.id}`) && request.method() === "POST" && request.postDataJSON()?.type === "prompt");
  await composer.press("Enter");
  const attachmentMessage = (await sentAttachment).postDataJSON();
  assert.match(attachmentMessage.message, /附件：notes.custom/);
  await page.reload();
  await page.getByRole("button", { name: "链接本地资料文件夹", exact: true }).click();
  await page.waitForTimeout(400);
  assert.deepEqual(errors, [], "opening the folder picker must not crash the page");
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "G:\\", exact: true }).waitFor();
  await page.getByRole("button", { name: "G:\\", exact: true }).click();
  const pathField = page.locator("#directory-path");
  await pathField.fill("G:\\missing");
  await pathField.press("Enter");
  await page.getByRole("dialog").getByText("Fixture directory does not exist", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Select this folder|选择此文件夹/ }).isEnabled(), false);
  await pathField.fill("G:\\");
  await pathField.press("Enter");
  await page.getByRole("button", { name: /Select this folder|选择此文件夹/ }).click();
  await page.getByRole("dialog").getByText("Fixture material revision conflict", { exact: true }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: /Close|关闭/ }).click();
  assert.ok(calls.includes("GET /api/cwd/browse"));
  if (process.env.PI_SMOKE_FOLDER_ONLY !== "1") {
    await page.getByRole("button", { name: "编辑课程设置", exact: true }).click();
    await page.getByLabel("课程名称", { exact: true }).fill("Edited existing course");
    await page.getByRole("button", { name: "保存课程设置", exact: true }).click();
    await page.getByRole("heading", { name: "Edited existing course", exact: true }).waitFor();
    assert.equal(project.revision, 2);
    await page.goto(`${process.env.PI_SMOKE_URL || "http://127.0.0.1:30141"}/course-builder`);
    await page.getByRole("button", { name: /Edited existing course/ }).click();
    await page.waitForURL("**/course-builder?sessionId=fixture-session");
    await page.getByRole("heading", { name: "Edited existing course", exact: true }).waitFor();
    assert.ok(!calls.some((call) => /POST \/api\/agent\/(new|ensure)/.test(call)), "entering a workspace must activate the original session without creating a blank chat");
    await page.getByRole("tab", { name: "Skills 与提示词", exact: true }).click();
    await page.getByRole("textbox", { name: "此模式的系统提示词", exact: true }).fill("Teacher prompt edited in the workspace.");
    await page.getByRole("checkbox", { name: /Teaching skill 2/ }).check();
    await page.getByRole("button", { name: "保存并应用", exact: true }).click();
    await page.getByText(/已生效，当前会话的模式设置已保存/).waitFor();
    assert.equal(modeSettings.systemPrompt, "Teacher prompt edited in the workspace.");
    assert.equal(modeSettings.skills[2].loaded, true);
    assert.equal(await page.getByRole("checkbox", { name: /Teaching skill 0/ }).isDisabled(), true);
    const settingsPanel = page.getByRole("region", { name: "模式设置", exact: true });
    assert.ok(await settingsPanel.evaluate((element) => element.scrollHeight > element.clientHeight), "settings must have a working scroll container");
    await settingsPanel.hover();
    await page.mouse.wheel(0, 550);
    await page.waitForTimeout(200);
    assert.ok(await settingsPanel.evaluate((element) => element.scrollTop > 0), "mouse wheel must move the settings panel");
    await page.getByRole("textbox", { name: "此模式的系统提示词", exact: true }).fill("Unsaved prompt survives skill installation.");
    await page.getByRole("tab", { name: "技能库 · 添加与市场", exact: true }).click();
    await page.getByRole("button", { name: /^(Add skill|添加技能)$/i }).click();
    await page.locator(".config-panel-root").getByText("G:/pi_own/skills", { exact: true }).waitFor();
    const searchInput = page.getByLabel("搜索技能市场", { exact: true });
    await searchInput.fill("visual fixture");
    await searchInput.press("Enter");
    await page.getByRole("button", { name: /^(Install|安装)$/ }).click();
    await page.getByRole("status").filter({ hasText: "已安装：market-fixture" }).waitFor();
    await page.getByLabel("仓库地址或技能标识", { exact: true }).fill("fixture/repo@manual-fixture");
    await page.getByRole("button", { name: "从地址添加", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "已安装：manual-fixture" }).waitFor();
    assert.deepEqual(skillInstalls.map((item) => item.package), ["fixture/repo@market-fixture", "fixture/repo@manual-fixture"]);
    if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-skill-market.png") });
    await page.locator(".config-sidebar").getByRole("button", { name: "manual-fixture", exact: true }).click();
    await page.getByRole("button", { name: /^(Check|检查)$/ }).click();
    await page.getByRole("button", { name: /^(Update|更新)$/ }).click();
    await page.locator(".skill-update-status.is-success").waitFor();
    assert.deepEqual(skillUpdates.map((item) => item.package), ["fixture/repo@manual-fixture"]);
    await page.getByRole("tab", { name: "当前模式组合", exact: true }).click();
    await page.getByRole("checkbox", { name: /market-fixture/ }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: /market-fixture/ }).isChecked(), false, "installation must not silently enable a skill");
    await page.getByRole("checkbox", { name: /manual-fixture/ }).check();
    await page.getByRole("button", { name: "保存并应用", exact: true }).click();
    await page.getByText(/已生效，当前会话的模式设置已保存/).waitFor();
    assert.equal(modeSettings.systemPrompt, "Unsaved prompt survives skill installation.");
    assert.equal(modeSettings.skills.find((skill) => skill.name === "manual-fixture").loaded, true, "newly installed selections must save alongside existing unsaved prompt edits");
    await page.getByRole("tab", { name: "对话", exact: true }).click();
    await page.getByLabel("额外要求", { exact: false }).fill("Focus on relevant examples.");
    await page.getByRole("button", { name: /分析全部资料/ }).click();
    await page.getByText("Fixture analysis is ready in this conversation.", { exact: true }).waitFor();
    assert.equal(promptTaskRequests.at(-1).additionalRequirements, "Focus on relevant examples.");
    await page.getByRole("link", { name: "打开课程计划与教师审阅 →", exact: true }).waitFor();
    const restoredPage = await page.context().newPage();
    await restoredPage.goto(page.url());
    await restoredPage.getByText("Fixture analysis is ready in this conversation.", { exact: true }).waitFor();
    assert.equal(await restoredPage.getByRole("link", { name: "打开课程计划与教师审阅 →", exact: true }).count(), 0, "restoring the conversation must not repeat an already displayed prompt, even without dismissal");
    await restoredPage.reload();
    await restoredPage.getByText("Fixture analysis is ready in this conversation.", { exact: true }).waitFor();
    assert.equal(await restoredPage.getByRole("link", { name: "打开课程计划与教师审阅 →", exact: true }).count(), 0, "refresh must not repeat an undismissed prompt");
    await restoredPage.close();
    await page.getByRole("button", { name: "关闭计划审阅提示", exact: true }).click();
    assert.equal(await page.getByRole("link", { name: "打开课程计划与教师审阅 →", exact: true }).count(), 0);
    snapshot.semesterPlan = { semesterPlanId: "fixture-semester", title: "Semester review fixture", rationale: "Build concepts before transfer tasks.", revision: 1, projectRevision: project.revision, status: "draft", review: null, sessions: Array.from({ length: 36 }, (_, index) => ({ week: Math.floor(index / 3) + 1, session: index % 3 + 1, title: `Review slot ${index + 1}`, objectives: ["Explain the method"], prerequisites: ["Probability"], topics: ["Inference"], activities: ["Predict then compare"], understandingEvidence: ["A justified prediction"], materialIds: [], assessment: null, homework: null, courseGoalsCovered: project.goals, revisits: [], visualOpportunities: [] })) };
    await page.getByRole("link", { name: "审阅学期计划 · r1", exact: true }).click();
    await page.getByRole("heading", { name: "Semester review fixture", exact: true }).waitFor();
    await page.locator(".semester-review").getByText("第 12 周 · 第 3 次", { exact: true }).waitFor();
    assert.equal(await page.locator('#semester-plan').getByRole("button", { name: "批准当前学期计划", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "展开全部课次", exact: true }).click();
    assert.equal(await page.locator('.semester-review details[open]').count(), 36);
    await page.getByRole("button", { name: "收起全部课次", exact: true }).click();
    await page.reload();
    await page.getByRole("heading", { name: "Semester review fixture", exact: true }).waitFor();
    assert.ok(await page.locator('#semester-plan').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= 0 && bounds.top < window.innerHeight;
    }), "a direct review link must reveal asynchronously loaded content");
    assert.equal(await page.getByRole("link", { name: "打开课程计划与教师审阅 →", exact: true }).count(), 0, "dismissal survives reload of the same plan revision");
    if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-semester-review.png") });
    await page.getByLabel("学期计划审查意见", { exact: false }).fill("Revise week 2 prerequisites.");
    await page.locator('#semester-plan').getByRole("button", { name: "要求修改", exact: true }).click();
    await page.getByText("上次审查意见：Revise week 2 prerequisites.", { exact: true }).waitFor();
    await page.getByText("学期计划 · 修改尚未完成", { exact: true }).waitFor();
    Object.assign(snapshot.semesterPlan, { revision: 2, status: "draft", review: null });
    Object.assign(revisionTasks[0], { status: "completed", completedRevision: 2 });
    messages.push({ role: "toolResult", toolCallId: "fixture-save-2", toolName: "course_builder", content: [{ type: "text", text: JSON.stringify({ semesterPlanId: "fixture-semester", revision: 2 }) }] });
    await page.reload();
    await page.getByText("学期计划 · 已完成修改 · r2", { exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "打开课程计划与教师审阅 →", exact: true }).count(), 0, "later revisions must not reopen the one-time prompt");
    await page.getByRole("link", { name: "打开教案", exact: true }).click();
    const preview = page.getByRole("complementary", { name: "文件预览", exact: true });
    await preview.getByRole("heading", { name: "Lesson preview", exact: true }).waitFor();
    const documentScroll = preview.locator('[style*="overflow: auto"]').last();
    await documentScroll.hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(200);
    assert.ok(await documentScroll.evaluate((element) => element.scrollTop > 0), "the preview must scroll with the mouse wheel");
    assert.equal(page.context().pages().length, 1, "file links must stay in the workspace");
    assert.ok(page.url().split("#")[0].endsWith("course-builder?sessionId=fixture-session"));
    if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-file-preview.png") });
    await page.setViewportSize({ width: 600, height: 720 });
    assert.ok(await preview.evaluate((element) => element.getBoundingClientRect().width <= window.innerWidth), "preview must fit a narrow screen");
    await preview.getByRole("button", { name: "关闭文件预览", exact: true }).waitFor();
    await page.setViewportSize({ width: 1280, height: 720 });
    await preview.getByRole("button", { name: "展开", exact: true }).click();
    await preview.getByRole("button", { name: "收起宽度", exact: true }).waitFor();
    await preview.getByRole("link", { name: "Denied file", exact: true }).click();
    await preview.getByText("Fixture file access denied", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "detached" });
    await page.getByRole("link", { name: "打开作业", exact: true }).click();
    await preview.getByRole("heading", { name: "Assignment preview", exact: true }).waitFor();
    await preview.getByRole("button", { name: "查看源码", exact: true }).click();
    assert.match(await preview.locator("pre").innerText(), /^# Assignment preview/);
    await preview.getByRole("button", { name: "关闭文件预览", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await page.getByLabel("选择备课课次", { exact: false }).selectOption("3:2");
    assert.equal(await page.getByRole("button", { name: /生成所选课次计划/ }).isDisabled(), true);
    snapshot.semesterPlan.status = "approved";
    project.revision += 1; // An additional material batch must not disable the existing plan.
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.includes('生成所选课次计划') && !button.disabled));
    await page.getByLabel("额外要求", { exact: false }).fill("Use an extra practice question for this lesson.");
    await page.getByRole("button", { name: /生成所选课次计划/ }).click();
    await page.getByText(/Review slot 8：单课计划生成任务已发送到 Pi/).waitFor();
    assert.equal(lessonTaskRequests.at(-1).week, 3);
    assert.equal(lessonTaskRequests.at(-1).session, 2);
    assert.equal(lessonTaskRequests.at(-1).additionalRequirements, "Use an extra practice question for this lesson.");
    assert.equal(await page.getByRole("button", { name: /生成所选课次 Beamer/ }).isDisabled(), true);
    snapshot.lessonPlans.push({ week: 3, session: 2, title: "Review slot 8", lessonPlanId: "fixture-lesson-8", semesterPlanId: "fixture-semester", semesterPlanRevision: 2, revision: 1, status: "approved", objectives: ["Understand Newton's method"], prerequisites: ["Differentiation"], misconceptions: ["Every starting point converges"], segments: [{ minutes: 30, title: "Predict and compare", teacherAction: "Draw the tangent", learnerAction: "Predict the next iterate", checkForUnderstanding: "Explain the update" }], examples: ["A quadratic function"], exercises: ["Try a different initial value"], visualRequests: ["Move the tangent"], notes: ["Keep the transfer check"], materialIds: [], review: null });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.includes('生成所选课次 Beamer') && !button.disabled));
    await page.getByLabel("额外要求", { exact: false }).fill("Show the geometry in the slides.");
    await page.getByRole("button", { name: /生成所选课次 Beamer/ }).click();
    await page.getByText(/Review slot 8：Beamer 课件生成任务已发送到 Pi/).waitFor();
    assert.equal(lessonTaskRequests.at(-1).additionalRequirements, "Show the geometry in the slides.");
    assert.deepEqual(lessonTaskRequests.map(({ task, week, session }) => ({ task, week, session })), [{ task: "plan", week: 3, session: 2 }, { task: "beamer", week: 3, session: 2 }]);
    if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-lesson-selection.png") });
    await page.getByLabel("额外要求", { exact: false }).fill("Only this standalone instruction.");
    await page.getByRole("button", { name: "发送给 Agent", exact: true }).click();
    await page.getByText("输入内容已单独发送给 Agent。", { exact: true }).waitFor();
    assert.equal(promptTaskRequests.at(-1).message, "Only this standalone instruction.");
    assert.equal(promptTaskRequests.at(-1).additionalRequirements, undefined);
    const lessonLink = page.getByRole("link", { name: "打开教案 · 阅读、编辑与审批 →", exact: true });
    assert.equal(await lessonLink.getAttribute("target"), "_blank");
    await page.goto(new URL(await lessonLink.getAttribute("href"), page.url()).href);
    await page.getByRole("heading", { name: "Review slot 8", exact: true }).waitFor();
    await page.getByRole("heading", { name: "教学流程", exact: false }).waitFor();
    await page.getByRole("button", { name: "编辑教案", exact: true }).click();
    await page.getByLabel("教案标题", { exact: true }).fill("Readable lesson saved by the teacher");
    await page.reload();
    await page.getByText("已恢复上次未保存的编辑。保存后会写入课程工作区。", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("教案标题", { exact: true }).inputValue(), "Readable lesson saved by the teacher");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await page.getByText("修改已保存为新版本，请阅读后批准。", { exact: true }).waitFor();
    assert.equal(snapshot.lessonPlans[0].revision, 2);
    await page.getByRole("button", { name: "同意并批准当前教案", exact: true }).click();
    await page.getByText("已批准当前教案，下次打开仍会保留。", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Readable lesson saved by the teacher", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "同意并批准当前教案", exact: true }).isDisabled(), true);
    if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-lesson-review.png") });
    await page.getByRole("link", { name: "← 返回备课工作区", exact: true }).click();
    await page.getByRole("link", { name: "返回 Pi 对话", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /新对话/ }).count(), 0, "the teacher workspace must not host global new-conversation controls");
    await page.getByRole("link", { name: "返回 Pi 对话", exact: true }).click();
    await page.waitForURL("**/?session=fixture-session");
    const newConversation = page.getByRole("button", { name: /^(New|新建)$/ });
    await newConversation.waitFor();
    assert.ok(await newConversation.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return box.top >= 44 && box.top < 110 && button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }), "Pi's original top New button must not be covered by the Mode Pack bar");
    await page.getByRole("button", { name: /^(Hide sidebar|隐藏侧边栏)$/ }).click();
    await page.getByRole("button", { name: /^(Show sidebar|显示侧边栏)$/ }).click();
    await page.setViewportSize({ width: 600, height: 720 });
    const showSidebar = page.getByRole("button", { name: /^(Show sidebar|显示侧边栏)$/ });
    if (await showSidebar.count()) await showSidebar.click();
    await newConversation.waitFor({ state: "visible" });
    await newConversation.click({ trial: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await newConversation.click();
    await page.waitForURL((url) => url.pathname === "/" && !url.searchParams.has("session"));
    await page.locator("textarea").waitFor();
    assert.equal(await page.locator("textarea").inputValue(), "");
    assert.equal(await page.getByRole("combobox", { name: "Active Mode Pack", exact: true }).count(), 0);
    if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-pi-new-conversation.png") });
    assert.equal(await page.getByRole("complementary", { name: "备课 Agent 对话" }).count(), 0);
    assert.equal(await page.getByText("Fixture analysis is ready in this conversation.", { exact: true }).count(), 0);
    await page.goto(`${process.env.PI_SMOKE_URL || "http://127.0.0.1:30141"}/course-builder`);
    await page.getByLabel("课程名称", { exact: true }).fill("Created without opening a chat");
    await page.getByLabel("课程 ID", { exact: false }).fill("MATH 101/201");
    assert.equal(await page.locator("form").evaluate((form) => form.checkValidity()), true);
    assert.equal(await page.getByRole("button", { name: "创建课程并进入工作区", exact: true }).isEnabled(), true, "a complete course form must be submittable without a preselected Pi session");
    const draft = { ...createCourseBuilderSetup(), title: "Created without opening a chat", courseId: "MATH 101/201", author: "Draft teacher", sessionsPerWeek: 3 };
    await page.getByLabel("载入草稿文件", { exact: true }).setInputFiles({ name: "recovered.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(draft)) });
    await page.getByText("已载入填写内容，尚未创建课程。请核对后点击创建。", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("教师姓名", { exact: false }).inputValue(), "Draft teacher");
    await page.reload();
    await page.getByRole("button", { name: "创建课程并进入工作区", exact: true }).waitFor();
    assert.equal(await page.getByLabel("课程名称", { exact: true }).inputValue(), "Created without opening a chat");
    await page.getByRole("button", { name: "创建课程并进入工作区", exact: true }).click();
    await page.waitForURL("**/course-builder?sessionId=fixture-session");
    await page.getByRole("heading", { name: "Created without opening a chat", exact: true }).waitFor();
  }
  // Shared folder navigation and editable course artifacts use the same fixtures,
  // with every API intercepted so no user course or transcript is modified.
  snapshot.decks.push({ deckId: "fixture-deck", title: "Editable Beamer", lessonPlanId: "fixture-lesson-8", lessonPlanRevision: 2, revision: 1, status: "draft", source: "\\documentclass{beamer}\n\\begin{document}\nOriginal TeX\n\\end{document}", frameOutline: ["First frame"], assetMaterialIds: [] });
  await page.reload();
  await page.getByRole("link", { name: "编辑 .tex", exact: true }).click();
  await page.getByLabel("编辑 TeX 源码", { exact: true }).waitFor();
  assert.match(await page.getByLabel("编辑 TeX 源码", { exact: true }).inputValue(), /Original TeX/, "editor must load the saved source, which the real summary endpoint deliberately omits");
  await page.getByLabel("编辑 TeX 源码", { exact: true }).fill("\\documentclass{beamer}\n\\begin{document}\nTeacher edited TeX\n\\end{document}");
  await page.getByRole("button", { name: "关闭文件预览", exact: true }).click();
  await page.getByRole("link", { name: "编辑 .tex", exact: true }).click();
  await page.getByLabel("编辑 TeX 源码", { exact: true }).waitFor();
  assert.match(await page.getByLabel("编辑 TeX 源码", { exact: true }).inputValue(), /Teacher edited TeX/);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByText("已保存 TeX revision 2，请重新编译。", { exact: true }).waitFor();
  assert.match(await page.getByLabel("编辑 TeX 源码", { exact: true }).inputValue(), /Teacher edited TeX/, "saving must not replace source with the summary's missing field");
  if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-tex-editor.png") });
  await page.getByRole("button", { name: "关闭文件预览", exact: true }).click();
  snapshot.compileReceipts.push({ receiptId: "fixture-pdf", deckId: "fixture-deck", deckRevision: 2, succeeded: true, pdfHash: "fixture", diagnostics: [] });
  await page.reload();
  await page.getByRole("link", { name: "打开 PDF", exact: true }).click();
  const pdfFrame = page.getByRole("complementary", { name: "文件预览", exact: true }).locator('iframe');
  await pdfFrame.waitFor();
  const renderedPdf = pdfFrame.contentFrame();
  await renderedPdf.locator('.page[data-page="1"][data-rendered="true"] canvas').waitFor();
  assert.ok(await renderedPdf.locator('.page[data-page="1"] canvas').evaluate((canvas) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] && pixels[index] < 200) return true;
    return false;
  }), "a real PDF page must contain painted pixels, not just an empty frame");
  assert.equal(await renderedPdf.locator("#page-count").textContent(), "/ 2");
  await renderedPdf.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await renderedPdf.locator("#page-number").inputValue(), "2");
  assert.deepEqual(downloads, [], "opening a PDF must not trigger a browser download even when its response is attachment");
  if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-pdf-preview.png") });
  await page.getByRole("button", { name: "关闭文件预览", exact: true }).click();
  const courseChats = page.getByRole("navigation", { name: "项目内对话", exact: true });
  await courseChats.getByRole("button", { name: "新建对话", exact: true }).click();
  await page.getByLabel("新对话名称", { exact: true }).fill("Lesson 2 separate conversation");
  await courseChats.getByRole("button", { name: "创建", exact: true }).click();
  await page.waitForURL("**/course-builder?sessionId=fixture-second-course-chat");
  await page.getByRole("heading", { name: /Editable Beamer/ }).waitFor();
  assert.equal(await page.getByLabel("切换项目内对话", { exact: true }).inputValue(), info.id);
  assert.equal(projectRequests.at(-1).projectId, project.projectId);
  assert.equal(await page.getByRole("link", { name: "打开课程计划与教师审阅 →", exact: true }).count(), 0);
  await page.goto(`${process.env.PI_SMOKE_URL || "http://127.0.0.1:30141"}/projects?project=${project.projectId}`);
  await page.getByRole("link", { name: "Lesson 2 separate conversation", exact: true }).waitFor();
  if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT.replace(/\.png$/, "-project-folder.png") });
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Writing folder");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "Writing folder", exact: true }).waitFor();
  await page.getByRole("button", { name: /^独立对话/ }).click();
  await page.getByLabel("整理对话：Independent fixture", { exact: true }).selectOption({ label: "Writing folder" });
  await page.getByRole("button", { name: /^▸ Writing folder/ }).click();
  await page.getByRole("link", { name: "Independent fixture", exact: true }).waitFor();
  await page.setViewportSize({ width: 600, height: 720 });
  assert.ok(await page.locator("main").evaluate((element) => element.scrollWidth <= window.innerWidth), "project folders fit mobile width");
  const outsideNew = page.getByRole("link", { name: "新建独立对话", exact: true });
  assert.match(await outsideNew.getAttribute("href"), /^\/\?cwd=/, "outside creation must use the explicit blank composer, not restore the previous workspace chat");
  await outsideNew.click();
  await page.locator("textarea").waitFor();
  assert.equal(await page.locator("textarea").inputValue(), "");
  assert.equal(new URL(page.url()).searchParams.has("session"), false);
  assert.deepEqual(errors, []);
  if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT, fullPage: true });
  console.log("PASS: one-time review survives refresh without dismissal; project conversations, independent new chat, TeX editing and draft recovery, embedded PDF, selected lesson tasks, model reload, tools, skills and file previews");
} finally {
  await browser.close();
}
