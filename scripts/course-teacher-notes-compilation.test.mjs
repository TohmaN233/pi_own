import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sha256Hex } from "../packages/harness-core/src/index.ts";
import { CourseBuilderHost, compileBeamer } from "../packages/course-builder-host/src/index.ts";
import { CourseTeacherNotesCompiler } from "../packages/course-builder-host/src/teacher-notes-compilation.ts";

const XELATEX = process.env.PI_XELATEX_PATH || "C:/texlive/2020/bin/win32/xelatex.exe";
const NOTES_SOURCE = String.raw`\documentclass{article}
\title{Teacher notes}
\begin{document}
Explain Euler's identity $e^{i\pi}+1=0$.
Use \texttt{literal backslashes} while speaking.
\end{document}
`;
const BROKEN_SOURCE = String.raw`\documentclass{article}
\begin{document}
\textbf{An unclosed command
\end{document}
`;

function projectInput(suffix) {
  return {
    courseId: `teacher-notes-compile-${suffix}`,
    title: `Teacher notes ${suffix}`,
    weeks: 1,
    sessionsPerWeek: 1,
    minutesPerSession: 50,
    audience: "Undergraduate",
    language: "English",
    goals: ["Explain the identity"],
    beamerProfile: {
      aspectRatio: "169",
      fontSize: 11,
      theme: "default",
      author: "",
      institute: "",
      language: "English",
      overlayPolicy: "allow",
      referencesPolicy: "optional",
      backupSlides: 0,
      speakerNotes: false,
      preamble: null,
    },
  };
}

function fixture(database, suffix) {
  const host = new CourseBuilderHost(database);
  const sessionId = `teacher-notes-compile-${suffix}`;
  const project = host.createProject(projectInput(suffix));
  host.bindSession(sessionId, project.projectId);
  const semester = host.saveSemesterPlan(sessionId, {
    title: "Identity",
    rationale: "A one lesson fixture",
    sessions: [{
      week: 1,
      session: 1,
      title: "Euler's identity",
      objectives: ["Explain the identity"],
      prerequisites: [],
      topics: ["complex numbers"],
      materialIds: [],
      activities: ["Explain"],
      understandingEvidence: ["State the identity"],
      assessment: null,
      homework: null,
      courseGoalsCovered: ["Explain the identity"],
      revisits: [],
      visualOpportunities: [],
    }],
  }, 0);
  host.reviewSemesterPlan(sessionId, semester.semesterPlanId, 1, "approve", "");
  const lesson = host.saveLessonPlan(sessionId, {
    week: 1,
    session: 1,
    title: "Euler's identity",
    objectives: ["Explain the identity"],
    prerequisites: [],
    misconceptions: [],
    segments: [{ minutes: 20, title: "Identity", teacherAction: "Explain", learnerAction: "Predict", checkForUnderstanding: null }],
    examples: [],
    exercises: [],
    materialIds: [],
    visualRequests: [],
    notes: [],
  }, 0, 1);
  host.reviewLessonPlan(sessionId, lesson.lessonPlanId, 1, "approve", "");
  const deck = host.saveBeamerDeck(sessionId, {
    lessonPlanId: lesson.lessonPlanId,
    title: "Euler's identity",
    source: String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}{Identity}Deck source.\end{frame}
\end{document}
`,
    frameOutline: ["Identity"],
    assetMaterialIds: [],
  }, 0, 1);
  return { host, sessionId, project, deck };
}

function saveNotes(fixtureValue, source = NOTES_SOURCE, expectedRevision = 0) {
  return fixtureValue.host.saveTeacherNotes(fixtureValue.sessionId, {
    deckId: fixtureValue.deck.deckId,
    deckRevision: fixtureValue.deck.revision,
    title: "Speaking notes",
    source,
  }, expectedRevision);
}

function compilerOptions(extra = {}) {
  return { trustedTex: true, compiler: XELATEX, ...extra };
}

test("teacher notes compile to a real PDF with TeX math and durable receipt", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "success");
    const notes = saveNotes(f);
    const compiler = new CourseTeacherNotesCompiler(database);
    const receipt = await compiler.compile(() => f.host.getSnapshot(f.project.projectId), notes.notesId, notes.revision, compilerOptions());
    assert.equal(receipt.succeeded, true, JSON.stringify(receipt.diagnostics));
    assert.equal(receipt.exitCode, 0);
    assert.ok(receipt.pageCount >= 1);
    assert.match(receipt.pdfHash, /^sha256:/);
    assert.match(receipt.logHash, /^sha256:/);
    assert.ok(compiler.getPdf(f.host.getSnapshot(f.project.projectId), receipt.receiptId).byteLength > 100);
    assert.equal(compiler.getLog(f.host.getSnapshot(f.project.projectId), receipt.receiptId).length > 0, true);
    const restarted = new CourseTeacherNotesCompiler(database);
    const snapshot = f.host.getSnapshot(f.project.projectId);
    assert.deepEqual(restarted.list(snapshot), [receipt]);
    assert.deepEqual(restarted.getReceipt(snapshot, receipt.receiptId), receipt);
  } finally {
    database.close();
  }
});

test("SyncTeX navigates math and prose in both directions and survives restart", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "synctex");
    const notes = saveNotes(f, NOTES_SOURCE.replace("Use \\texttt{literal backslashes} while speaking.", "\\par\nUse \\texttt{literal backslashes} while speaking."));
    const compiler = new CourseTeacherNotesCompiler(database);
    const snapshot = () => f.host.getSnapshot(f.project.projectId);
    const receipt = await compiler.compile(snapshot, notes.notesId, notes.revision, compilerOptions());
    assert.equal(receipt.succeeded, true, JSON.stringify(receipt.diagnostics));
    assert.equal(receipt.arguments.includes("-synctex=1"), true);
    assert.equal(compiler.hasSyncTex(snapshot(), receipt.receiptId), true);

    const math = await compiler.locate(snapshot(), receipt.receiptId, { line: 4 });
    assert.equal(math.line, undefined);
    assert.equal(math.page, 1);
    assert.ok(math.x >= 0 && math.y >= 0 && math.width > 0 && math.height > 0);
    const prose = await compiler.locate(snapshot(), receipt.receiptId, { line: 6 });
    assert.equal(prose.line, undefined);
    assert.equal(prose.page, 1);
    assert.ok(prose.x >= 0 && prose.y >= 0 && prose.width > 0 && prose.height > 0);

    const reverseMath = await compiler.locate(snapshot(), receipt.receiptId, {
      page: math.page,
      x: math.x + Math.min(math.width / 2, 1),
      y: math.y + Math.min(math.height / 2, 1),
    });
    assert.equal(reverseMath.line, 4);
    const reverseProse = await compiler.locate(snapshot(), receipt.receiptId, {
      page: prose.page,
      x: prose.x + Math.min(prose.width / 2, 1),
      y: prose.y + Math.min(prose.height / 2, 1),
    });
    assert.equal(reverseProse.line, 6);

    const restarted = new CourseTeacherNotesCompiler(database);
    assert.equal(restarted.hasSyncTex(snapshot(), receipt.receiptId), true);
    assert.deepEqual(await restarted.locate(snapshot(), receipt.receiptId, { line: 4 }), math);
  } finally {
    database.close();
  }
});

test("Beamer SyncTeX is receipt-bound in both directions and does not rewrite saved source", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "beamer-synctex");
    const before = f.host.getSnapshot(f.project.projectId).decks.find((item) => item.deckId === f.deck.deckId)?.source;
    const result = await compileBeamer({ ...f.host.getDeckForCompile(f.sessionId, f.deck.deckId), compiler: XELATEX });
    assert.equal(result.receipt.succeeded, true, result.log);
    assert.equal(result.receipt.arguments.includes("-synctex=1"), true);
    f.host.recordCompile(f.sessionId, result.receipt, result.artifact, result.log);
    assert.equal(f.host.hasBeamerSyncTex(f.sessionId, result.receipt.receiptId), true);

    const forward = await f.host.locateBeamer(f.sessionId, result.receipt.receiptId, { line: 3 });
    assert.equal(forward.line, undefined);
    assert.equal(forward.page, 1);
    assert.ok(forward.x >= 0 && forward.y >= 0 && forward.width >= 0 && forward.height >= 0);
    const backward = await f.host.locateBeamer(f.sessionId, result.receipt.receiptId, {
      page: forward.page,
      x: forward.x + Math.min(forward.width / 2, 1),
      y: forward.y + Math.min(forward.height / 2, 1),
    });
    assert.equal(backward.line, 3);
    assert.equal(f.host.getSnapshot(f.project.projectId).decks.find((item) => item.deckId === f.deck.deckId)?.source, before);

    const restarted = new CourseBuilderHost(database);
    assert.equal(restarted.hasBeamerSyncTex(f.sessionId, result.receipt.receiptId), true);
    assert.deepEqual(await restarted.locateBeamer(f.sessionId, result.receipt.receiptId, { line: 3 }), forward);
  } finally {
    database.close();
  }
});

test("SyncTeX rejects stale, cross-project, corrupt and legacy receipts", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "synctex-errors");
    const other = fixture(database, "synctex-other");
    const notes = saveNotes(f);
    const compiler = new CourseTeacherNotesCompiler(database);
    const snapshot = () => f.host.getSnapshot(f.project.projectId);
    const receipt = await compiler.compile(snapshot, notes.notesId, notes.revision, compilerOptions());
    assert.equal(compiler.hasSyncTex(snapshot(), receipt.receiptId), true);

    f.host.patchTeacherNotes(f.sessionId, notes.notesId, [{ oldText: "Explain Euler's identity", newText: "Explain Euler's identity slowly" }], notes.revision, notes.deckRevision);
    const staleSnapshot = snapshot();
    assert.equal(compiler.hasSyncTex(staleSnapshot, receipt.receiptId), false);
    await assert.rejects(compiler.locate(staleSnapshot, receipt.receiptId, { line: 4 }), /revision|source hash|changed/iu);

    assert.equal(compiler.hasSyncTex(other.host.getSnapshot(other.project.projectId), receipt.receiptId), false);
    await assert.rejects(compiler.locate(other.host.getSnapshot(other.project.projectId), receipt.receiptId, { line: 4 }), /unavailable/iu);

    const current = f.host.getSnapshot(f.project.projectId);
    const currentNotes = current.teacherNotes.find((item) => item.notesId === notes.notesId);
    const freshReceipt = await compiler.compile(() => f.host.getSnapshot(f.project.projectId), notes.notesId, currentNotes.revision, compilerOptions());
    database.prepare("UPDATE course_builder_teacher_notes_compile_synctex SET sync_tex=? WHERE receipt_id=?").run(Buffer.from("not gzip"), freshReceipt.receiptId);
    await assert.rejects(compiler.locate(snapshot(), freshReceipt.receiptId, { line: 4 }), /gzip|hash|mapping/iu);

    database.prepare("DELETE FROM course_builder_teacher_notes_compile_synctex WHERE receipt_id=?").run(freshReceipt.receiptId);
    assert.equal(compiler.hasSyncTex(snapshot(), freshReceipt.receiptId), false);
    await assert.rejects(compiler.locate(snapshot(), freshReceipt.receiptId, { line: 4 }), /recompile|SyncTeX/iu);
  } finally {
    database.close();
  }
});

test("a script saved for an older deck remains compilable and records its origin", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "stale-deck");
    const notes = saveNotes(f);
    f.host.saveBeamerDeck(f.sessionId, {
      lessonPlanId: f.deck.lessonPlanId,
      title: f.deck.title,
      source: f.deck.source.replace("Deck source.", "Deck source v2."),
      frameOutline: f.deck.frameOutline,
      assetMaterialIds: [],
    }, f.deck.revision, 1);
    const compiler = new CourseTeacherNotesCompiler(database);
    const receipt = await compiler.compile(() => f.host.getSnapshot(f.project.projectId), notes.notesId, notes.revision, compilerOptions());
    assert.equal(receipt.succeeded, true, JSON.stringify(receipt.diagnostics));
    assert.equal(receipt.deckRevision, notes.deckRevision);
    assert.equal(receipt.deckSourceHash, notes.deckSourceHash);
  } finally {
    database.close();
  }
});

test("failed teacher notes compilation retains actionable diagnostics and no PDF", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "failure");
    const notes = saveNotes(f, BROKEN_SOURCE);
    const compiler = new CourseTeacherNotesCompiler(database);
    const snapshot = () => f.host.getSnapshot(f.project.projectId);
    const receipt = await compiler.compile(snapshot, notes.notesId, notes.revision, compilerOptions());
    assert.equal(receipt.succeeded, false);
    assert.equal(receipt.pdfHash, null);
    assert.ok(receipt.diagnostics.some((item) => item.code === "TEX_ERROR" && /Runaway|ended while scanning|Emergency stop|unclosed/iu.test(item.message)));
    assert.match(compiler.getLog(snapshot(), receipt.receiptId), /Runaway|ended while scanning|Emergency stop|unclosed/iu);
    assert.throws(() => compiler.getPdf(snapshot(), receipt.receiptId), /no PDF/);
  } finally {
    database.close();
  }
});

test("notes compilation enforces project, revision and source hash ownership", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "ownership");
    const other = fixture(database, "other");
    const notes = saveNotes(f);
    const compiler = new CourseTeacherNotesCompiler(database);
    await assert.rejects(compiler.compile(() => f.host.getSnapshot(f.project.projectId), notes.notesId, 0, compilerOptions()), /revision conflict|positive integer/iu);
    const tampered = f.host.getSnapshot(f.project.projectId);
    tampered.teacherNotes = tampered.teacherNotes.map((item) => ({ ...item, sourceHash: `sha256:${"0".repeat(64)}` }));
    await assert.rejects(compiler.compile(() => tampered, notes.notesId, notes.revision, compilerOptions()), /source does not match its hash/iu);
    assert.throws(() => compiler.getReceipt(other.host.getSnapshot(other.project.projectId), "missing"), /unavailable/iu);
  } finally {
    database.close();
  }
});

test("changed notes are rejected before delayed compilation persistence", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const f = fixture(database, "race");
    const notes = saveNotes(f);
    const compiler = new CourseTeacherNotesCompiler(database);
    let activeCalls = 0;
    let reached;
    let release;
    const entered = new Promise((resolve) => { reached = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = compiler.compile(() => f.host.getSnapshot(f.project.projectId), notes.notesId, notes.revision, compilerOptions({
      assertActive: async () => {
        activeCalls += 1;
        if (activeCalls === 2) {
          reached();
          await gate;
        }
      },
    }));
    await entered;
    f.host.patchTeacherNotes(f.sessionId, notes.notesId, [{ oldText: "Explain Euler's identity", newText: "Explain Euler's identity slowly" }], notes.revision, notes.deckRevision);
    release();
    await assert.rejects(pending, /changed|conflict/iu);
    assert.equal(new CourseTeacherNotesCompiler(database).list(f.host.getSnapshot(f.project.projectId)).length, 0);
  } finally {
    database.close();
  }
});

test("source hash helper used by the fixture is canonical", () => {
  assert.equal(`sha256:${sha256Hex(NOTES_SOURCE)}`.length, 71);
});
