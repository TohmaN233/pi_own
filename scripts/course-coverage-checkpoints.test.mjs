import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CourseBuilderHost, runCourseBuilderCommand } from "../packages/course-builder-host/src/index.ts";
import { contentHash } from "../packages/harness-core/src/index.ts";

function setup(database = new DatabaseSync(":memory:")) {
  const host = new CourseBuilderHost(database);
  const project = host.createProject({ courseId: "checkpoints", title: "R foundations", weeks: 2, sessionsPerWeek: 1, minutesPerSession: 50, audience: "Undergraduate", language: "English", goals: ["Use R"], beamerProfile: { aspectRatio: "169", fontSize: 11, theme: "default", author: "", institute: "", language: "English", overlayPolicy: "allow", referencesPolicy: "optional", backupSlides: 0, speakerNotes: false, preamble: null } });
  host.bindSession("first-chat", project.projectId);
  host.bindSession("second-chat", project.projectId);
  const [material] = host.importMaterials("first-chat", [{ name: "intro.R", kind: "text", sourceBytes: Buffer.from("a <- 1\nb <- 2\na + b\n"), extractedText: "a <- 1\nb <- 2\na + b\n" }], project.revision);
  const semester = host.saveSemesterPlan("first-chat", { title: "R", rationale: "Progress from objects to functions", sessions: [1, 2].map((week) => ({ week, session: 1, title: `R ${week}`, objectives: ["Use R"], prerequisites: [], topics: ["R"], materialIds: [material.materialId], activities: ["Predict"], understandingEvidence: ["Explain output"], assessment: null, homework: null, courseGoalsCovered: ["Use R"], revisits: [], visualOpportunities: [] })) }, 0);
  host.reviewSemesterPlan("first-chat", semester.semesterPlanId, 1, "approve", "");
  const lesson = host.saveLessonPlan("first-chat", { week: 1, session: 1, title: "R objects", objectives: ["Use R"], prerequisites: [], misconceptions: [], segments: [{ minutes: 30, title: "Objects", teacherAction: "Explain", learnerAction: "Predict", checkForUnderstanding: null }], examples: [], exercises: [], materialIds: [material.materialId], visualRequests: [], notes: [] }, 0, 1);
  host.reviewLessonPlan("first-chat", lesson.lessonPlanId, 1, "approve", "");
  const draft = { lessonPlanId: lesson.lessonPlanId, lessonRevision: 1, deckId: null, deckRevision: null, coverage: [{ materialId: material.materialId, sourceHash: material.sourceHash, unit: "lines", start: 1, end: 2, summary: "Assignment and objects" }], completed: ["R objects and assignment"], remaining: ["Line 3: arithmetic"], nextLesson: "Start at intro.R line 3; recap objects briefly, then introduce functions." };
  return { database, host, project, material, lesson, draft };
}

test("checkpoint survives new conversations and a new SQLite connection without changing approved lessons", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-coverage-"));
  const path = join(directory, "harness.sqlite");
  let database = new DatabaseSync(path);
  try {
    const f = setup(database);
    const original = f.host.exportState();
    const saved = await runCourseBuilderCommand(f.host, "first-chat", { action: "save_checkpoint", draft: f.draft, expectedRevision: 0 });
    assert.equal(saved.status, "planned");
    assert.deepEqual(f.host.exportState(), original, "checkpoint revisions are independent of lesson approvals");
    assert.match(f.host.listCoverageCheckpoints("second-chat")[0].coverage[0].position, /1–2/);
    const state = await runCourseBuilderCommand(f.host, "second-chat", { action: "state" });
    assert.equal(state.coverageCheckpoints[0].nextLesson, f.draft.nextLesson);
    const read = await runCourseBuilderCommand(f.host, "second-chat", { action: "read_checkpoints", offset: 0, limit: 25 });
    assert.equal(read.text.length, 25); assert.equal(read.nextOffset, 25);
    f.host.confirmCoverageCheckpoint("second-chat", f.lesson.lessonPlanId, 1);
    database.close(); database = new DatabaseSync(path);
    const restored = new CourseBuilderHost(database);
    const checkpoint = restored.listCoverageCheckpoints("first-chat")[0];
    assert.equal(checkpoint.status, "confirmed"); assert.equal(checkpoint.revision, 2);
    assert.deepEqual(checkpoint.staleReasons, []);
    assert.deepEqual(restored.exportState(), original);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM course_builder_checkpoint").get().count, 2);
    assert.throws(() => restored.saveCoverageCheckpoint("first-chat", f.draft, 1), /revision conflict/);
    assert.equal(restored.saveCoverageCheckpoint("first-chat", f.draft, 2).status, "planned", "editing does not inherit confirmation");
  } finally { database.close(); rmSync(directory, { recursive: true }); }
});

test("range, source, target and approval validation reject bad checkpoints and roll back writes", async () => {
  const f = setup();
  try {
    for (const draft of [
      { ...f.draft, status: "confirmed" },
      { ...f.draft, lessonRevision: 99 },
      { ...f.draft, deckId: "unrelated", deckRevision: 1 },
      { ...f.draft, coverage: [{ ...f.draft.coverage[0], start: 0 }] },
      { ...f.draft, coverage: [{ ...f.draft.coverage[0], start: 3, end: 2 }] },
      { ...f.draft, coverage: [{ ...f.draft.coverage[0], materialId: "another-course-source" }] },
      { ...f.draft, coverage: [{ ...f.draft.coverage[0], sourceHash: "stale-source" }] },
      { ...f.draft, coverage: [{ ...f.draft.coverage[0], unit: "whole-file" }] },
    ]) assert.throws(() => f.host.saveCoverageCheckpoint("first-chat", draft, 0));
    assert.deepEqual(f.host.listCoverageCheckpoints("first-chat"), []);
    await assert.rejects(runCourseBuilderCommand(f.host, "first-chat", { action: "confirm_checkpoint", id: f.lesson.lessonPlanId, expectedRevision: 0 }), /not available to the agent/);
    f.host.saveCoverageCheckpoint("first-chat", { ...f.draft, coverage: [{ ...f.draft.coverage[0], unit: "whole-file", start: null, end: null }] }, 0);
    const assignment = f.host.createAssignment("first-chat", { title: "Private assignment", brief: "Only its own sources" });
    f.host.setAgentAssignmentScope("first-chat", assignment.assignmentId);
    await assert.rejects(runCourseBuilderCommand(f.host, "first-chat", { action: "read_checkpoints" }), /course planning actions are unavailable/);
    await assert.rejects(runCourseBuilderCommand(f.host, "first-chat", { action: "save_checkpoint", draft: f.draft, expectedRevision: 1 }), /course planning actions are unavailable/);
  } finally { f.database.close(); }
});

test("lesson changes make earlier coverage stale and block confirmation", () => {
  const f = setup();
  try {
    f.host.saveCoverageCheckpoint("first-chat", f.draft, 0);
    const current = f.host.getSnapshotForSession("first-chat").lessonPlans[0];
    const { lessonPlanId, projectId, semesterPlanId, semesterPlanRevision, revision, status, review, createdAt, updatedAt, contentHash, ...draft } = current;
    f.host.saveLessonPlan("first-chat", { ...draft, notes: ["Now introduce functions"] }, 1, 1);
    assert.deepEqual(f.host.listCoverageCheckpoints("second-chat")[0].staleReasons, ["单课教案版本已变化"]);
    assert.throws(() => f.host.confirmCoverageCheckpoint("first-chat", lessonPlanId, 1), /needs reconciliation/);
    f.host.saveCoverageCheckpoint("first-chat", { ...f.draft, lessonRevision: 2 }, 1);
    assert.deepEqual(f.host.listCoverageCheckpoints("first-chat")[0].staleReasons, []);
  } finally { f.database.close(); }
});

test("reindexed source versions retain their ranges as stale history", () => {
  const f = setup();
  try {
    const input = (version) => ({ name: "linked-notes.pdf", kind: "pdf", sourceBytes: Buffer.from(version), extractedText: "", metadata: { storage: "local-link", sourceRoot: "fixture-root" } });
    const [material] = f.host.syncLocalMaterials("first-chat", "fixture-root", [input("v1")], 2);
    f.host.saveCoverageCheckpoint("first-chat", { ...f.draft, coverage: [{ materialId: material.materialId, sourceHash: material.sourceHash, unit: "pages", start: 1, end: 5, summary: "Opening concepts" }] }, 0);
    f.host.syncLocalMaterials("first-chat", "fixture-root", [input("v2")], 3);
    const checkpoint = f.host.listCoverageCheckpoints("second-chat")[0];
    assert.match(checkpoint.coverage[0].position, /1–5/);
    assert.deepEqual(checkpoint.staleReasons, ["参考文件已变化：linked-notes.pdf"]);
    assert.throws(() => f.host.confirmCoverageCheckpoint("first-chat", f.lesson.lessonPlanId, 1), /needs reconciliation/);
  } finally { f.database.close(); }
});

test("one file per lesson consolidates historical batches and rejects duplicate new file records", () => {
  const f = setup();
  try {
    const saved = f.host.saveCoverageCheckpoint("first-chat", f.draft, 0);
    const { contentHash: _hash, ...legacy } = saved;
    legacy.coverage = [f.draft.coverage[0], { ...f.draft.coverage[0], start: 52, end: 100, summary: "Functions" }];
    f.database.prepare("UPDATE course_builder_checkpoint SET payload=?").run(JSON.stringify({ ...legacy, contentHash: contentHash(legacy) }));
    const restored = new CourseBuilderHost(f.database).listCoverageCheckpoints("first-chat")[0];
    assert.equal(restored.coverage.length, 1);
    assert.match(restored.coverage[0].summary, /Functions/);
    const file = { materialId: f.material.materialId, sourceHash: f.material.sourceHash, summary: "Objects and functions used in this lesson", position: "Functions section", nextLesson: "Start with model objects" };
    assert.throws(() => f.host.saveCoverageCheckpoint("first-chat", { ...f.draft, coverage: [file, file] }, 1), /One checkpoint per lesson and file/);
    const next = f.host.saveCoverageCheckpoint("first-chat", { ...f.draft, coverage: [file] }, 1);
    assert.deepEqual(next.coverage, [file]);
  } finally { f.database.close(); }
});

test("stored checkpoint corruption fails visibly instead of disappearing", () => {
  const f = setup();
  try {
    f.host.saveCoverageCheckpoint("first-chat", f.draft, 0);
    const row = f.database.prepare("SELECT payload FROM course_builder_checkpoint").get();
    const payload = JSON.parse(row.payload); payload.coverage[0].position = "Tampered";
    f.database.prepare("UPDATE course_builder_checkpoint SET payload=?").run(JSON.stringify(payload));
    assert.throws(() => new CourseBuilderHost(f.database).listCoverageCheckpoints("first-chat"), /Corrupt/);
  } finally { f.database.close(); }
});
