import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("teacher TeX edits save new shared drafts without a runtime; PDF previews are inline and downloads explicit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-tex-edit-")); const cwd = join(root, "course"); mkdirSync(cwd);
  const env = { PI_LEARNING_HARNESS_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent") };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined; for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const rpc = await jiti.import("./rpc-manager.ts");
  const { getCourseBuilderHost } = await jiti.import("./course-builder-service.ts");
  const { createDefaultCourseBuilderProject } = await jiti.import("./course-builder-defaults.ts");
  const workspace = await jiti.import("../app/api/course-builder/route.ts");
  const exports = await jiti.import("../app/api/course-builder/export/route.ts");
  const deckRoute = await jiti.import("../app/api/course-builder/deck/route.ts");
  const pdfContent = await jiti.import("../app/api/pdf-content/route.ts");
  const { encodeFilePathForApi } = await jiti.import("./file-paths.ts");
  const host = getCourseBuilderHost();
  const sid = rpc.createPersistedGenericSession(cwd, "Teacher");
  const second = rpc.createPersistedGenericSession(cwd, "Second course conversation");
  const input = { ...createDefaultCourseBuilderProject(), weeks: 1, sessionsPerWeek: 1 };
  const project = host.createProject(input); host.bindSession(sid, project.projectId); host.bindSession(second, project.projectId);
  const semester = host.saveSemesterPlan(sid, { title: "Semester", rationale: "Test", sessions: [{ week: 1, session: 1, title: "Lesson", objectives: ["Explain"], prerequisites: [], topics: ["Inference"], materialIds: [], activities: ["Explain"], understandingEvidence: ["Transfer"], assessment: null, homework: null, courseGoalsCovered: input.goals, revisits: [], visualOpportunities: [] }] }, 0);
  host.reviewSemesterPlan(sid, semester.semesterPlanId, 1, "approve", "Fixture");
  const lesson = host.saveLessonPlan(sid, { week: 1, session: 1, title: "Lesson", objectives: ["Explain"], prerequisites: [], misconceptions: [], segments: [{ minutes: 15, title: "Practice", teacherAction: "Ask", learnerAction: "Explain", checkForUnderstanding: "Reason" }], examples: [], exercises: [], materialIds: [], visualRequests: [], notes: [] }, 0, 1);
  host.reviewLessonPlan(sid, lesson.lessonPlanId, 1, "approve", "Fixture");
  const source = "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Prediction}Predict first.\\end{frame}\n\\end{document}";
  const deck = host.saveBeamerDeck(sid, { lessonPlanId: lesson.lessonPlanId, title: "Deck", source, frameOutline: ["Prediction"], assetMaterialIds: [] }, 0, 1);
  const overview = await workspace.GET(new Request(`http://127.0.0.1:30141/api/course-builder?sessionId=${sid}`, { headers: { host: "127.0.0.1:30141" } }));
  assert.equal((await overview.json()).snapshot.decks[0].source, undefined, "overview intentionally omits source; it cannot feed an editor");
  const editable = await deckRoute.GET(new Request(`http://127.0.0.1:30141/api/course-builder/deck?sessionId=${second}&id=${deck.deckId}`, { headers: { host: "127.0.0.1:30141" } }));
  const loaded = await editable.json(); assert.equal(editable.status, 200); assert.equal(loaded.deck.source, source); assert.equal(loaded.deck.revision, 1);
  const body = { sessionId: second, action: "edit_deck", id: deck.deckId, expectedRevision: 1, parentRevision: 1, source: source.replace("Predict first.", "Predict then explain."), frameOutline: ["Revised prediction"] };
  const req = (value, teacher = true) => new Request("http://127.0.0.1:30141/api/course-builder", { method: "POST", headers: { host: "127.0.0.1:30141", "content-type": "application/json", ...(teacher ? { "x-course-builder-teacher": "1" } : {}) }, body: JSON.stringify(value) });
  assert.equal((await workspace.POST(req(body, false))).status, 403);
  const response = await workspace.POST(req(body)); const edited = await response.json(); assert.equal(response.status, 200, JSON.stringify(edited));
  assert.equal(edited.snapshot.decks[0].revision, 2); assert.equal(edited.snapshot.decks[0].status, "draft"); assert.equal(edited.snapshot.decks[0].acceptedReceiptId, null);
  assert.equal(edited.deck.source, body.source, "save returns the complete persisted deck for the editor"); assert.equal(edited.deck.revision, 2);
  assert.equal(host.getSnapshotForSession(sid).decks[0].source, body.source, "other conversation sees the same edited deck");
  assert.equal((await workspace.POST(req(body))).status, 400, "stale source revisions cannot overwrite another editor");
  assert.equal(rpc.getRpcSession(second), undefined);
  const unbound = rpc.createPersistedGenericSession(cwd, "Outside");
  const deniedDeck = await deckRoute.GET(new Request(`http://127.0.0.1:30141/api/course-builder/deck?sessionId=${unbound}&id=${deck.deckId}`, { headers: { host: "127.0.0.1:30141" } }));
  assert.equal(deniedDeck.status, 404);
  assert.equal((await workspace.POST(req({ ...body, sessionId: unbound, expectedRevision: 2 }))).status, 400);
  // Checkpoint writes use the same dormant teacher workspace, with independent revisions.
  const [reference] = host.importMaterials(sid, [{ name: "example.R", kind: "text", sourceBytes: Buffer.from("x <- 1\nx + 1\n"), extractedText: "x <- 1\nx + 1\n" }], 1);
  const coverageBody = { sessionId: second, action: "save_checkpoint", expectedRevision: 0, draft: { lessonPlanId: lesson.lessonPlanId, lessonRevision: 1, deckId: deck.deckId, deckRevision: 2, coverage: [{ materialId: reference.materialId, sourceHash: reference.sourceHash, unit: "lines", start: 1, end: 2, summary: "Assignment and arithmetic" }], completed: ["Predict R output"], remaining: ["Functions"], nextLesson: "Begin with functions after a brief recall question." } };
  assert.equal((await workspace.POST(req(coverageBody, false))).status, 403);
  assert.equal((await workspace.POST(req({ ...coverageBody, sessionId: unbound }))).status, 400);
  const coverageResponse = await workspace.POST(req(coverageBody)); const coverageSaved = await coverageResponse.json();
  assert.equal(coverageResponse.status, 200, JSON.stringify(coverageSaved));
  assert.equal(coverageSaved.checkpoint.status, "planned");
  assert.equal(coverageSaved.snapshot.coverageCheckpoints[0].coverage[0].end, 2);
  assert.equal(host.listCoverageCheckpoints(sid)[0].revision, 1);
  assert.equal(host.getSnapshotForSession(sid).lessonPlans[0].status, "approved");
  const confirmation = { sessionId: sid, action: "confirm_checkpoint", id: lesson.lessonPlanId, expectedRevision: 1 };
  assert.equal((await workspace.POST(req(confirmation, false))).status, 403);
  assert.equal((await workspace.POST(req(confirmation))).status, 200);
  assert.equal(host.listCoverageCheckpoints(second)[0].status, "confirmed");
  assert.equal((await workspace.POST(req(coverageBody))).status, 400);
  assert.equal(rpc.getRpcSession(second), undefined, "saving and confirming coverage must not start a model");
  // Verify the delivery contract independently of running an external TeX process.
  const original = host.getCompiledPdf;
  host.getCompiledPdf = (session, receipt) => { assert.equal(session, second); assert.equal(receipt, "fixture-receipt"); return new TextEncoder().encode("%PDF-1.4\n%%EOF"); };
  try {
    for (const download of [false, true]) {
      const output = await exports.GET(new Request(`http://127.0.0.1:30141/api/course-builder/export?sessionId=${second}&kind=pdf&id=fixture-receipt${download ? "&download=1" : ""}`, { headers: { host: "127.0.0.1:30141" } }));
      assert.equal(output.status, 200); assert.equal(output.headers.get("content-type"), "application/pdf");
      assert.match(output.headers.get("content-disposition"), download ? /^attachment;/ : /^inline;/);
    }
    const coursePdf = `/api/course-builder/export?sessionId=${second}&kind=pdf&id=fixture-receipt`;
    const localPdf = join(cwd, "fixture.pdf"); writeFileSync(localPdf, "%PDF-1.4\n%%EOF");
    const filePdf = `/api/files/${encodeFilePathForApi(localPdf)}?type=read&sessionId=${second}`;
    for (const file of [coursePdf, filePdf]) {
      const output = await pdfContent.GET(new Request(`http://127.0.0.1:30141/api/pdf-content?file=${encodeURIComponent(file)}`, { headers: { host: "127.0.0.1:30141" } }));
      assert.equal(output.status, 200); assert.match(output.headers.get("content-type"), /^application\/json/);
      assert.equal(output.headers.get("content-disposition"), null, "preview must not expose PDF/download response headers to native download managers");
      const payload = await output.json(); const bytes = Buffer.from(payload.data, "base64");
      assert.equal(bytes.toString(), "%PDF-1.4\n%%EOF"); assert.equal(payload.byteLength, bytes.length);
    }
    const remote = await pdfContent.GET(new Request("http://127.0.0.1:30141/api/pdf-content?file=https%3A%2F%2Fexample.com%2Fa.pdf", { headers: { host: "127.0.0.1:30141" } }));
    assert.equal(remote.status, 400, "preview never proxies arbitrary network URLs");
  } finally { host.getCompiledPdf = original; }
});
