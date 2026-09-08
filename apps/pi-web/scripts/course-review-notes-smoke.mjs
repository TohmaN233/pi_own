// Intercept every API request: no real course edits or model calls.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDefaultCourseBuilderProject } = await jiti.import("../lib/course-builder-defaults.ts");
const project = { ...createDefaultCourseBuilderProject(), projectId: "notes-fixture", revision: 1 };
const lessons = [1, 2].map(session => ({ lessonPlanId: `lesson-${session}`, week: 1, session, title: `Lesson ${session}`, revision: 1, status: "draft" }));
const snapshot = { project, materials: [], assignments: [{ assignmentId: "assignment-1", title: "Homework", brief: "Practice", revision: 1, status: "draft", materials: [] }], lessonPlans: lessons, decks: [], visuals: [], compileReceipts: [], deckReviews: [], semesterPlan: null, materialAnalysis: null, coverageCheckpoints: [] };
const writes = [];
let fail = false;
let responseGate = null;
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/course-builder") {
      if (req.method() === "POST") {
        writes.push(req.postDataJSON());
        if (responseGate) await responseGate;
        if (fail) return route.fulfill({ status: 409, json: { error: "Fixture revision conflict" } });
      }
      return route.fulfill({ json: { projects: [project], snapshot, projectSessions: {}, revisionTasks: [], compilerEnabled: false } });
    }
    if (path === "/api/course-builder/session") return route.fulfill({ json: { sessionId: "notes-session", verified: true } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [], conversations: [] } });
    return route.fulfill({ status: 503, json: { error: "Fixture Agent offline" } });
  });
  await page.goto(`${process.env.PI_SMOKE_URL || "http://127.0.0.1:30141"}/course-builder?sessionId=notes-session#lessons`);
  const notes = page.locator("#lessons textarea");
  const assignment = page.getByLabel(/^本次 Assignment 审查意见/);
  await notes.nth(0).fill("Only lesson one");
  assert.equal(await notes.nth(1).inputValue(), "", "typing in lesson one must not change lesson two");
  assert.equal(await assignment.inputValue(), "", "lesson notes must not leak into Assignment");
  await notes.nth(1).fill("Only lesson two");
  await assignment.fill("Only homework");
  const first = page.locator("#lessons article").nth(0);
  fail = true;
  await first.getByRole("button", { name: "要求修改", exact: true }).click();
  await page.getByText("Fixture revision conflict", { exact: true }).waitFor();
  assert.equal(await notes.nth(0).inputValue(), "Only lesson one", "failed submission preserves draft");
  fail = false;
  await first.getByRole("button", { name: "要求修改", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("#lessons textarea")[0].value === "");
  assert.equal(writes.at(-1).id, "lesson-1");
  assert.equal(writes.at(-1).note, "Only lesson one");
  assert.equal(await notes.nth(1).inputValue(), "Only lesson two");
  assert.equal(await assignment.inputValue(), "Only homework");
  let releaseResponse;
  responseGate = new Promise(resolve => { releaseResponse = resolve; });
  await notes.nth(0).fill("Submitted draft");
  const posted = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/course-builder");
  await first.getByRole("button", { name: "要求修改", exact: true }).click();
  await posted;
  await notes.nth(0).fill("New unsent draft");
  releaseResponse();
  responseGate = null;
  await page.waitForFunction(() => !document.querySelector("#lessons article button").disabled);
  assert.equal(await notes.nth(0).inputValue(), "New unsent draft", "successful response must not erase newer input");
  snapshot.lessonPlans.reverse();
  await page.waitForFunction(() => document.querySelector("#lessons article h4").textContent.includes("Lesson 2"));
  assert.equal(await notes.nth(0).inputValue(), "Only lesson two", "polling/reordering preserves identity");
  lessons[0].revision = 2;
  await page.waitForFunction(() => document.querySelector("#lessons article h4").textContent.includes("r2"));
  assert.equal(await notes.nth(0).inputValue(), "", "a new revision must not inherit an older review draft");
  console.log("PASS: independent lesson/Assignment notes, correct request payload, scoped clearing, failure recovery and polling reorder");
} finally { await browser.close(); }
