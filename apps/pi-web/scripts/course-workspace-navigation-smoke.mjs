// All API traffic stays in this fixture; no teacher records or model calls are made.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDefaultCourseBuilderProject } = await jiti.import("../lib/course-builder-defaults.ts");
const { parseCoverageDraft } = await jiti.import("../../../packages/course-builder-host/src/coverage.ts");
const project = { ...createDefaultCourseBuilderProject(), projectId: "fixture-course", title: "Navigation fixture", revision: 1 };
const deck = { deckId: "fixture-deck", title: "Current lecture", revision: 2, status: "compiled", sourceHash: "source-2", frameOutline: [], assetMaterialIds: [] };
const receipt = { receiptId: "receipt-2", deckId: deck.deckId, deckRevision: 2, sourceHash: deck.sourceHash, succeeded: true, pdfHash: "pdf-2", diagnostics: [] };
const snapshot = { project, materials: [], assignments: [], lessonPlans: [], decks: [deck], visuals: [], compileReceipts: [receipt], deckReviews: [], semesterPlan: null, materialAnalysis: null };
snapshot.lessonPlans.push({ lessonPlanId: "fixture-lesson", week: 1, session: 1, title: "R objects", revision: 1, status: "approved" });
snapshot.materials.push({ materialId: "fixture-source", sourceHash: "source-R", name: "intro.R", kind: "text", source: { storage: "copied" } });
snapshot.coverageCheckpoints = [];
const writes = [];
const deliveryTask = { id: "delivery-fixture", status: "active", rounds: 2, requirements: [{ id: "source", text: "Restore every requested source section" }] };
let runtimeStarts = 0;
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/course-builder") {
      if (request.method() === "POST") {
        const input = request.postDataJSON(); writes.push(input);
        if (input.action === "command" && input.command.action === "review_deck") {
          snapshot.deckReviews.push({ reviewId: "review-2", deckId: deck.deckId, deckRevision: deck.revision, sourceHash: deck.sourceHash, compileReceiptId: receipt.receiptId, status: "pass", score: 98, issues: [] });
        } else if (input.action === "accept") {
          assert.equal(input.expectedRevision, 2);
          assert.equal(input.compileReceiptId, receipt.receiptId);
          assert.equal(input.reviewId, "review-2");
          assert.equal(input.visualChecked, true);
          deck.status = "accepted"; deck.acceptedReceiptId = receipt.receiptId;
        } else if (input.action === "revoke_acceptance") {
          assert.equal(request.headers()["x-course-builder-teacher"], "1");
          assert.equal(input.expectedRevision, 2);
          deck.status = "draft"; deck.acceptedReceiptId = null;
        } else if (input.action === "save_checkpoint") {
          assert.equal(request.headers()["x-course-builder-teacher"], "1");
          if (input.expectedRevision !== (snapshot.coverageCheckpoints[0]?.revision ?? 0)) return route.fulfill({ status: 409, json: { error: "Checkpoint revision conflict" } });
          const draft = parseCoverageDraft(input.draft);
          assert.equal(draft.lessonPlanId, "fixture-lesson");
          snapshot.coverageCheckpoints = [{ ...draft, revision: input.expectedRevision + 1, status: "planned", staleReasons: [] }];
        } else if (input.action === "confirm_checkpoint") {
          assert.equal(input.expectedRevision, snapshot.coverageCheckpoints[0].revision);
          snapshot.coverageCheckpoints[0].revision++;
          snapshot.coverageCheckpoints[0].status = "confirmed";
        } else if (input.action === "lesson_task") {
          assert.equal(input.task, "checkpoint"); assert.equal(input.week, 1); assert.equal(input.session, 1);
        } else throw new Error(`Unexpected fixture write: ${JSON.stringify(input)}`);
      }
      return route.fulfill({ json: { projects: [project], snapshot, projectSessions: { [project.projectId]: ["fixture-session"] }, revisionTasks: [], deliveryTask, compilerEnabled: true } });
    }
    // Deliberately unavailable Agent: saved teacher controls must still work.
    if (url.pathname === "/api/course-builder/session") {
      runtimeStarts++;
      return runtimeStarts === 1 ? route.fulfill({ status: 503, json: { error: "Fixture Agent offline" } }) : route.fulfill({ json: { sessionId: "fixture-session", verified: true } });
    }
    if (url.pathname === "/api/projects") return route.fulfill({ json: { projects: [], conversations: [] } });
    if (url.pathname === "/api/sessions/fixture-session") return route.fulfill({ status: 503, json: { error: "Fixture conversation unavailable" } });
    throw new Error(`Unexpected fixture API: ${request.method()} ${url.pathname}`);
  });
  await page.goto(`${process.env.PI_SMOKE_URL || "http://127.0.0.1:30141"}/course-builder?sessionId=fixture-session#outputs`);
  const acceptance = page.getByRole("button", { name: "接受当前有据版本", exact: true });
  await acceptance.waitFor();
  await page.getByRole("heading", { name: "交付进度：持续处理中" }).waitFor();
  assert.match(await page.getByLabel("当前交付任务").innerText(), /Restore every requested source section/);
  deliveryTask.status = "blocked"; deliveryTask.reason = "Fixture missing source";
  await page.getByText("交付进度：未完成，需要处理阻碍", { exact: true }).waitFor();
  assert.match(await page.getByLabel("当前交付任务").innerText(), /Fixture missing source/);
  deliveryTask.status = "active"; delete deliveryTask.reason;
  await page.getByRole("checkbox", { name: /我已打开当前 PDF/ }).check();
  assert.equal(await acceptance.isDisabled(), true);
  // Red on the reported checked-but-disabled state with no explanation.
  await page.getByText("当前版本尚未检查源码和日志，请点击“检查源码和日志”。", { exact: true }).waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: "检查源码和日志", exact: true }).click();
  await page.getByText("检查已完成，可以接受当前版本。", { exact: true }).waitFor();
  assert.equal(await acceptance.isEnabled(), true);
  await acceptance.click();
  await page.getByRole("button", { name: "当前版本已验收", exact: true }).waitFor();
  assert.equal(writes.filter((item) => item.action === "accept").length, 1);
  await page.getByRole("button", { name: "取消验收", exact: true }).click();
  await acceptance.waitFor();
  assert.equal(writes.filter((item) => item.action === "revoke_acceptance").length, 1);
  assert.equal(deck.status, "draft");
  await acceptance.click();
  await page.getByRole("button", { name: "取消验收", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "当前版本已验收", exact: true }).isDisabled(), true);

  // A different PDF receipt invalidates both the passing review and the local visual check.
  const newerReceipt = { ...receipt, receiptId: "receipt-3", pdfHash: "pdf-3" };
  snapshot.compileReceipts.push(newerReceipt);
  await page.getByText("当前版本尚未检查源码和日志，请点击“检查源码和日志”。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /我已打开当前 PDF/ }).isChecked(), false);
  assert.equal(await acceptance.isDisabled(), true);
  snapshot.deckReviews.push({ ...snapshot.deckReviews[0], reviewId: "review-fail", compileReceiptId: newerReceipt.receiptId, status: "fail", score: 70, issues: [{ location: "frame-2", message: "Overflow fixture", severity: "major" }] });
  await page.getByText("源码与日志检查未通过（70 分），请处理下方问题后重新检查。", { exact: true }).waitFor();
  await page.getByText("frame-2：Overflow fixture", { exact: true }).waitFor();
  assert.equal(await acceptance.isDisabled(), true);
  snapshot.compileReceipts.push({ ...newerReceipt, receiptId: "receipt-failed", succeeded: false, pdfHash: null });
  await page.getByText("当前版本编译失败，请查看编译日志，修正源码后重新编译。", { exact: true }).waitFor();
  // Keep old evidence but advance the deck: it must not qualify as a current compile.
  deck.revision++;
  await page.getByText("当前版本尚未编译，请先点击“编译当前源码”。", { exact: true }).waitFor();

  const nav = page.getByRole("navigation", { name: "备课工作区目录", exact: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["课程资料", "Assignment", "Agent 备课", "学期计划", "单课教案", "覆盖进度", "课件与验收", "教学可视化", "课程概览"]) {
      const link = nav.getByRole("link", { name, exact: true });
      const id = (await link.getAttribute("href")).slice(1);
      await link.click();
      const geometry = await page.locator(`[id="${id}"]`).evaluate((element) => {
        const nav = document.querySelector('[aria-label="备课工作区目录"]');
        const scroll = document.querySelector('[data-course-scroll]');
        return { targetTop: element.getBoundingClientRect().top, navBottom: nav.getBoundingClientRect().bottom, navTop: nav.getBoundingClientRect().top, scrollTop: scroll.getBoundingClientRect().top, focused: document.activeElement === element };
      });
      assert.ok(geometry.focused, `${width}: ${name} receives keyboard focus`);
      assert.ok(geometry.targetTop >= geometry.navBottom - 1, `${width}: ${name} is hidden by navigation: ${JSON.stringify(geometry)}`);
      assert.ok(Math.abs(geometry.navTop - geometry.scrollTop) < 2, `${width}: navigation must stay pinned to its own scroll pane`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await nav.getByRole("link", { name: "课件与验收", exact: true }).click();
  await page.reload();
  await acceptance.waitFor();
  assert.equal(await page.locator("#outputs").evaluate((element) => document.activeElement === element), true, "deep links survive delayed workspace loading");
  await nav.getByRole("link", { name: "覆盖进度", exact: true }).click();
  await page.getByRole("button", { name: "填写 Checkpoint", exact: true }).click();
  await page.getByRole("button", { name: "添加文件 Checkpoint", exact: true }).click();
  await page.getByLabel(/^参考文件/).selectOption("fixture-source");
  await page.getByLabel("讲到哪里（可选定位）", { exact: true }).fill("R objects, line 40");
  await page.getByLabel("这个文件下次从哪里继续", { exact: true }).fill("Functions after objects");
  await page.getByLabel("本课使用了哪些内容", { exact: true }).fill("R objects and indexing");
  await page.getByLabel("本课覆盖内容（每行一项）", { exact: true }).fill("Objects\nIndexing");
  await page.getByLabel("尚未覆盖 / 待核对（每行一项）", { exact: true }).fill("Functions after line 40");
  await page.getByLabel("下一课从哪里接续", { exact: true }).fill("Start with functions; briefly retrieve indexing.");
  await page.getByRole("button", { name: "保存 Checkpoint 草稿", exact: true }).click();
  await page.getByRole("heading", { name: "计划覆盖 · Checkpoint r1", exact: true }).waitFor();
  assert.equal(snapshot.coverageCheckpoints[0].coverage[0].position, "R objects, line 40");
  await page.getByRole("button", { name: "确认当前覆盖记录", exact: true }).click();
  await page.getByRole("heading", { name: "已确认覆盖 · Checkpoint r2", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "已确认覆盖 · Checkpoint r2", exact: true }).waitFor();
  await page.getByRole("button", { name: "编辑 Checkpoint", exact: true }).click();
  snapshot.coverageCheckpoints[0].revision = 3;
  await page.getByText("Checkpoint 已被其他操作更新。请取消编辑后重新读取，旧草稿不会覆盖新记录。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "保存 Checkpoint 草稿", exact: true }).click();
  await page.getByText("Checkpoint revision conflict", { exact: true }).waitFor();
  assert.equal(await page.getByLabel(/^下一课从哪里接续/).inputValue(), "Start with functions; briefly retrieve indexing.");
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await page.getByRole("button", { name: "让 Agent 整理本课 Checkpoint", exact: true }).click();
  await page.getByText("已让 Agent 整理本课 Checkpoint；已有教案和课件保留，结果在覆盖进度中等待你核对。", { exact: true }).waitFor();
  assert.ok(writes.some((input) => input.action === "lesson_task" && input.task === "checkpoint"));
  if (process.env.PI_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SMOKE_SCREENSHOT, fullPage: true });
  console.log("PASS: acceptance and evidence invalidation; sticky navigation at 1440/768/390px; checkpoint ranges, save/confirm, refresh, conflicts and Agent handoff");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
