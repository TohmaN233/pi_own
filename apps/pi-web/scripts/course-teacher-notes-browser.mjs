// Focused mocked browser regression for the teacher lecture-script workflow.
// Every API request is intercepted; no model, paid service, or user data is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PI_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.PI_SMOKE_URL || "http://127.0.0.1:30141";
const sessionId = "teacher-notes-ui-session";
const project = {
	projectId: "teacher-notes-ui-project",
	courseId: "MATH-101",
	title: "Teacher notes fixture",
	weeks: 1,
	sessionsPerWeek: 1,
	minutesPerSession: 50,
	audience: "大学一年级",
	language: "中文",
	goals: ["理解极限"],
	beamerProfile: { aspectRatio: "169", fontSize: 11, theme: "default", author: "Fixture Teacher", institute: "Fixture University", language: "zh", overlayPolicy: "allow", referencesPolicy: "optional", backupSlides: 0, speakerNotes: false, preamble: null },
	planningRevision: 1,
	revision: 1,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	contentHash: "sha256:project",
};
const semesterPlan = {
	semesterPlanId: "semester-fixture",
	projectId: project.projectId,
	projectPlanningRevision: 1,
	revision: 1,
	status: "approved",
	title: "Fixture semester",
	rationale: "Fixture",
	review: null,
	createdAt: project.createdAt,
	updatedAt: project.updatedAt,
	contentHash: "sha256:semester",
	sessions: [{ week: 1, session: 1, title: "极限", objectives: [], prerequisites: [], topics: ["极限"], materialIds: [], activities: [], understandingEvidence: [], assessment: null, homework: null, courseGoalsCovered: ["理解极限"], revisits: [], visualOpportunities: [] }],
};
const lessonPlan = {
	lessonPlanId: "lesson-fixture",
	projectId: project.projectId,
	semesterPlanId: semesterPlan.semesterPlanId,
	semesterPlanRevision: semesterPlan.revision,
	week: 1,
	session: 1,
	title: "极限",
	objectives: [],
	prerequisites: [],
	misconceptions: [],
	segments: [],
	examples: [],
	exercises: [],
	materialIds: [],
	visualRequests: [],
	notes: [],
	revision: 1,
	status: "approved",
	review: null,
	createdAt: project.createdAt,
	updatedAt: project.updatedAt,
	contentHash: "sha256:lesson",
};
const deck = {
	deckId: "deck-fixture",
	projectId: project.projectId,
	lessonPlanId: lessonPlan.lessonPlanId,
	lessonPlanRevision: lessonPlan.revision,
	title: "极限 Beamer",
	revision: 3,
	status: "draft",
	sourceHash: "sha256:deck",
	frameOutline: ["极限"],
	assetMaterialIds: [],
	createdAt: project.createdAt,
	updatedAt: project.updatedAt,
	acceptedAt: null,
	acceptedReceiptId: null,
	contentHash: "sha256:deck-content",
	source: String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{极限}A fixture frame.\end{frame}
\end{document}
`,
};
const source = String.raw`\documentclass{article}
\begin{document}
Original teacher script with \textbf{TeX}.
\end{document}
`;
let notes = {
	notesId: "notes-fixture",
	projectId: project.projectId,
	deckId: deck.deckId,
	deckRevision: deck.revision,
	lessonPlanId: lessonPlan.lessonPlanId,
	revision: 1,
	title: "极限教师讲稿",
	source,
	sourceHash: "sha256:notes",
	deckSourceHash: deck.sourceHash,
	createdAt: project.createdAt,
	updatedAt: project.updatedAt,
	contentHash: "sha256:notes-content",
};
notes.deckRevision = deck.revision - 1;
const writes = [];
let notesCompileReceipt = null;
function createPdfFixture() {
 const stream="BT /F1 18 Tf 50 740 Td (Teacher lecture script - PDF preview) Tj ET";
 const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let text="%PDF-1.4\n", offsets=[0];
 for(let index=0;index<objects.length;index++){offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;}
 const xref=Buffer.byteLength(text);text+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,"0")+" 00000 n ").join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(text,"ascii");
}
const pdfFixture = createPdfFixture();
const snapshot = () => ({
	project,
	materials: [],
	assignments: [],
	semesterPlan,
	materialAnalysis: null,
	lessonPlans: [lessonPlan],
	coverageCheckpoints: [],
	decks: [deck],
	compileReceipts: [],
	teacherNotesCompileReceipts: notesCompileReceipt ? [{ ...notesCompileReceipt }] : [],
	deckReviews: [],
	visuals: [],
	teacherNotes: [{ ...notes, source: undefined, staleReasons: notes.deckRevision === deck.revision ? [] : ["课件版本已变化"] }],
});
const state = () => ({ projects: [project], snapshot: snapshot(), projectSessions: { [project.projectId]: [sessionId] }, revisionTasks: [], deliveryTask: null, compilerEnabled: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
	const page = await browser.newPage();
	const requestUrls = [];
	let downloadCount = 0;
	page.on("request", (request) => requestUrls.push(request.url()));
	page.on("download", () => { downloadCount += 1; });
	let captureOldPoll;
	await page.addInitScript((key) => { if (window.top === window && localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ notesId: "notes-fixture", title: "", source: "", revision: 1, deckRevision: 2 })); }, `pi-teacher-notes-edit:${sessionId}:${notes.notesId}`);
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/course-builder" && request.method() === "GET") return route.fulfill({ json: state() });
		if (url.pathname === "/api/course-builder" && request.method() === "POST") {
			const body = request.postDataJSON();
			writes.push(body);
			if (body.action === "edit_teacher_notes") {
				notes = { ...notes, title: body.title, source: body.source, deckRevision: body.deckRevision, revision: notes.revision + 1 };
				notesCompileReceipt = null;
				return route.fulfill({ json: { ...state(), notes, currentDeckRevision: deck.revision } });
			}
			if (body.action === "compile_teacher_notes") {
				notesCompileReceipt = { receiptId: "notes-compile-1", projectId: project.projectId, notesId: notes.notesId, notesRevision: notes.revision, sourceHash: notes.sourceHash, deckId: notes.deckId, deckRevision: notes.deckRevision, deckSourceHash: notes.deckSourceHash, compiler: "fixture", arguments: [], succeeded: true, exitCode: 0, pageCount: 1, pdfHash: "sha256:fixture-pdf", logHash: "sha256:fixture-log", diagnostics: [], createdAt: "2026-01-01T00:01:00.000Z", contentHash: "sha256:fixture-receipt" };
				return route.fulfill({ json: { receipt: notesCompileReceipt, sourceSyncAvailable: true, ...state() } });
			}
			return route.fulfill({ json: state() });
		}
		if (url.pathname === "/api/course-builder/teacher-notes" && request.method() === "GET") {
			if(captureOldPoll) { const capture=captureOldPoll; captureOldPoll=undefined; capture({route,body:structuredClone({notes,currentDeckRevision:deck.revision})}); return; }
			return route.fulfill({ json: { notes, currentDeckRevision: deck.revision, compilerEnabled: true, sourceSyncAvailable: !!notesCompileReceipt, compileReceipt: notesCompileReceipt ? { ...notesCompileReceipt } : null } });
		}
		if (url.pathname === "/api/course-builder/teacher-notes/sync") {
			const body = request.postDataJSON();
			assert.equal(body.receiptId, notesCompileReceipt.receiptId);
			return route.fulfill({ json: { receiptId: body.receiptId, ...(body.line ? { page: 1, x: 40, y: 60, width: 150, height: 14 } : { line: 3, column: 0 }) } });
		}
		if (url.pathname === "/api/course-builder/deck" && request.method() === "GET") return route.fulfill({ json: { deck, compilerEnabled: true, sourceSyncAvailable: true, compileReceipt: {receiptId:"beamer-compiled-fixture",deckId:deck.deckId,deckRevision:deck.revision,sourceHash:deck.sourceHash,succeeded:true,diagnostics:[]} } });
		if (url.pathname.startsWith("/api/pdfjs/")) return route.continue();
		if (url.pathname === "/api/pdf-content") return route.fulfill({ json: { data: pdfFixture.toString("base64"), byteLength: pdfFixture.byteLength } });
		if (url.pathname === "/api/course-builder/session" && request.method() === "POST") return route.fulfill({ json: { sessionId, verified: true } });
		if (url.pathname === `/api/sessions/${sessionId}`) return route.fulfill({ json: { info: { id: sessionId, cwd: process.cwd(), name: "Teacher notes fixture", messageCount: 0, created: project.createdAt, modified: project.updatedAt, firstMessage: "", projectRoot: process.cwd() }, sessionId, filePath: "", totalActiveMs: 0, tree: [], leafId: null, toolNames: [], context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null } } });
		if (url.pathname === "/api/projects") return route.fulfill({ json: { projects: [], conversations: [] } });
		return route.fulfill({ status: 200, json: {} });
	});

	await page.goto(`${base}/course-builder?sessionId=${encodeURIComponent(sessionId)}#agent`);
	const slot = page.locator("label").filter({ hasText: "选择备课课次" }).locator("select");
	await slot.selectOption({ label: "第 1 周 · 第 1 次 · 极限" });
	const checkbox = page.getByRole("checkbox", { name: "同时生成教师讲稿（TeX）", exact: true });
	await checkbox.check();
	const beamerButton = page.locator("button").filter({ hasText: "生成所选课次 Beamer" }).first();
	const beamerResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/course-builder");
	await beamerButton.click();
	await beamerResponse;
	const beamerWrite = writes.find((item) => item.action === "lesson_task" && item.task === "beamer");
	assert.ok(beamerWrite, "checking the teacher-notes option must submit the Beamer task");
	assert.equal(beamerWrite.teacherNotes, true);
	assert.equal(beamerWrite.additionalRequirements, "");

	const standaloneResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/course-builder");
	await page.locator("button").filter({ hasText: "生成教师讲稿（TeX）" }).first().click();
	await standaloneResponse;
	const standaloneWrite = writes.find((item) => item.action === "teacher_notes_task");
	assert.deepEqual(standaloneWrite, { sessionId, action: "teacher_notes_task", deckId: deck.deckId, additionalRequirements: "" });

	await page.getByRole("link", { name: "打开 / 编辑教师讲稿 .tex", exact: true }).click();
	const editor = page.getByLabel("编辑教师讲稿 TeX", { exact: true });
	await editor.waitFor();
	assert.equal(await editor.inputValue(), "", "an empty local draft must be loaded without being rejected");
	await page.getByRole("button", { name: "放弃本机草稿，读取服务器版本", exact: true }).click();
	assert.match(await editor.inputValue(), /\\documentclass\{article\}/, "discard must recover the non-empty saved TeX");
	const acknowledgeCurrentDeck = page.getByRole("button", { name: "已核对当前课件 r3，以此版本保存讲稿", exact: true });
	await acknowledgeCurrentDeck.click();
	assert.match(await editor.inputValue(), /\\documentclass\{article\}/, "reviewing a newer deck must preserve the current TeX text");
	const exactText = String.raw`\documentclass{article}
\begin{document}
Edited \textbackslash{}TeX\\line with $x^2$.
\end{document}
`;
	const longLine = `% ${"LongUnbrokenSourceToken".repeat(50)}`;
	await editor.fill(longLine);
	const wrap = await editor.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, whiteSpace: getComputedStyle(element).whiteSpace }));
	assert.equal(wrap.whiteSpace, "pre-wrap");
	assert.ok(wrap.scroll <= wrap.width + 1, "long TeX lines must wrap without horizontal scrolling");
	assert.equal(await editor.inputValue(), longLine, "soft wrapping must not insert source newlines");
	await editor.fill(exactText);
	const oldPollPromise=new Promise(resolve=>{captureOldPoll=resolve;});
	const oldPoll=await oldPollPromise;
	await page.getByRole("button", { name: "保存教师讲稿", exact: true }).click();
	await page.getByRole("status").filter({hasText:"已保存教师讲稿 revision 2"}).waitFor();
	await oldPoll.route.fulfill({json:oldPoll.body});
	await page.waitForTimeout(250);
	assert.equal(await editor.inputValue(),exactText,"a delayed pre-save poll must not overwrite a newer saved revision");
	const editWrite = writes.find((item) => item.action === "edit_teacher_notes");
	assert.ok(editWrite, "saving the teacher notes must submit the edit action");
	assert.equal(editWrite.id, notes.notesId);
	assert.equal(editWrite.expectedRevision, 1);
	assert.equal(editWrite.deckRevision, deck.revision, "saving after explicit deck review must use the observed current deck revision");
	assert.equal(editWrite.source, exactText, "saving must preserve every TeX backslash and newline");

	const compileButton = page.getByRole("button", { name: "编译已保存源码", exact: true });
	assert.equal(await compileButton.isEnabled(), true, "a clean saved source must enable explicit compile");
	const compileResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/course-builder" && response.request().postDataJSON()?.action === "compile_teacher_notes");
	const pdfContentRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/pdf-content");
	await compileButton.click();
	await compileResponse;
	await pdfContentRequest;
	await page.getByRole("status").filter({ hasText: "教师讲稿编译成功" }).waitFor();
	const compileWrite = writes.find((item) => item.action === "compile_teacher_notes");
	assert.ok(compileWrite, "compile must submit the explicit teacher-notes action");
	assert.equal(compileWrite.id, notes.notesId);
	assert.equal(compileWrite.expectedRevision, notes.revision, "compile must carry the saved notes revision");
	const pdfFrame = page.getByTitle("教师讲稿 PDF");
	await pdfFrame.waitFor();
	const pdfFrameSource = await pdfFrame.getAttribute("src");
	assert.match(decodeURIComponent(pdfFrameSource ?? ""), /pdf-viewer\.html\?file=.*kind=teacher-notes-pdf/, "a successful compile must use the bundled PdfPreview viewer");
	await page.frameLocator("iframe[title=\"教师讲稿 PDF\"]").locator("canvas").waitFor();
	assert.equal(await page.getByRole("button", { name: "定位光标到 PDF", exact: true }).count(), 0, "the source pane must not lose height to a redundant navigation button");
	await editor.evaluate(element => element.setSelectionRange(50, 50));
	await editor.dblclick();
	await page.frameLocator('iframe[title="教师讲稿 PDF"]').locator('.source-location').waitFor();
	await page.frameLocator('iframe[title="教师讲稿 PDF"]').locator('canvas').dblclick({ position: { x: 60, y: 70 } });
	await page.getByRole("status").filter({ hasText: "已定位并选中源码第 3 行" }).waitFor();
	assert.equal(await editor.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), exactText.split("\n")[2]);
	await page.screenshot({path:"../../.artifacts/teacher-notes-pdf-ui.png"});
	const sourceBox = await page.getByTestId("teacher-notes-source-pane").boundingBox();
	const pdfBox = await page.getByTestId("teacher-notes-pdf-pane").boundingBox();
	assert.ok(sourceBox && pdfBox && sourceBox.width > 0 && pdfBox.width > 0 && sourceBox.x < pdfBox.x && Math.abs(sourceBox.y - pdfBox.y) < 24, "desktop layout must keep editable TeX to the left of the PDF");

	await page.getByRole("button", { name: "关闭文件预览", exact: true }).click();
	await page.locator("iframe[title='教师讲稿 PDF']").waitFor({ state: "detached" });
	await page.getByRole("link", { name: "编辑 .tex", exact: true }).first().click();
	await page.getByLabel("编辑 TeX 源码", { exact: true }).waitFor();
	const beamerSourceBox = await page.getByTestId("beamer-source-pane").boundingBox();
	await page.frameLocator('iframe[title="编译后的 PDF"]').locator('canvas').waitFor();
	const beamerPdfBox = await page.getByTestId("beamer-pdf-pane").boundingBox();
	assert.ok(beamerSourceBox && beamerPdfBox && beamerSourceBox.width > 0 && beamerPdfBox.width > 0 && beamerSourceBox.x < beamerPdfBox.x && Math.abs(beamerSourceBox.y - beamerPdfBox.y) < 24, "desktop Beamer layout must keep editable TeX to the left of the PDF");
	await page.getByRole("button", { name: "关闭文件预览", exact: true }).click();
	await page.getByRole("link", { name: "打开 / 编辑教师讲稿 .tex", exact: true }).click();
	const reopenedEditor = page.getByLabel("编辑教师讲稿 TeX", { exact: true });
	await reopenedEditor.waitFor();
	await page.getByTitle("教师讲稿 PDF").waitFor();
	assert.equal(await reopenedEditor.inputValue(), exactText, "reopening must restore the saved exact TeX");
	const shortcutText = `${exactText}% local change`;
	await reopenedEditor.fill(shortcutText);
	assert.equal(await page.getByTitle("教师讲稿 PDF").count(), 1, "editing notes must keep the last successful PDF visible until the new revision is compiled");
	await page.getByRole("status").filter({ hasText: "PDF 显示上一次成功编译的版本" }).waitFor();
	const shortcutWritesStart = writes.length;
	const shortcutCompileResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/course-builder" && response.request().postDataJSON()?.action === "compile_teacher_notes");
	await reopenedEditor.press("Control+S");
	await shortcutCompileResponse;
	await page.getByRole("status").filter({ hasText: "教师讲稿编译成功" }).waitFor();
	assert.deepEqual(writes.slice(shortcutWritesStart).map((item) => item.action), ["edit_teacher_notes", "compile_teacher_notes"], "Ctrl+S must save the dirty source and then compile that saved revision");
	assert.equal(await reopenedEditor.inputValue(), shortcutText, "Ctrl+S must preserve the exact edited source");
	assert.equal(await page.getByTitle("教师讲稿 PDF").count(), 1, "successful Ctrl+S compile must refresh without dropping the PDF preview");
	await page.getByRole("button", { name: "关闭文件预览", exact: true }).click();

	await page.evaluate((key) => localStorage.setItem(key, "{corrupt local draft"), `pi-teacher-notes-edit:${sessionId}:${notes.notesId}`);
	await page.getByRole("link", { name: "打开 / 编辑教师讲稿 .tex", exact: true }).click();
	const recoveredEditor = page.getByLabel("编辑教师讲稿 TeX", { exact: true });
	await recoveredEditor.waitFor();
	assert.equal(await recoveredEditor.inputValue(), shortcutText, "a corrupt local draft must recover the saved server text");
	assert.match((await page.getByRole("alert").allTextContents()).join("\n"), /本机暂存的教师讲稿格式损坏/, "corrupt draft must show a visible recovery error");
	await page.getByRole("button", { name: "放弃本机草稿，读取服务器版本", exact: true }).click();
	assert.equal(await recoveredEditor.inputValue(), shortcutText);
	await page.getByTitle("教师讲稿 PDF").waitFor();
	assert.equal(await page.getByTitle("教师讲稿 PDF").count(), 1, "reopening a clean saved revision must restore its matching PDF");

	const directPdfRequests = requestUrls.filter((requestUrl) => {
		const url = new URL(requestUrl);
		return url.pathname === "/api/course-builder/export" && url.searchParams.get("kind") === "teacher-notes-pdf";
	});
	assert.equal(directPdfRequests.length, 0, "PDF preview must not navigate directly to the binary export");
	assert.equal(downloadCount, 0, "opening the preview must not trigger a native download");
	console.log("PASS: Beamer checkbox payload, standalone existing-deck teacher-notes request, empty/corrupt draft recovery, exact-text save, Ctrl+S save-and-compile, persistent PDF preview, left-TeX/right-PDF layout, source soft wrap and bidirectional navigation");
} finally {
	await browser.close();
}
