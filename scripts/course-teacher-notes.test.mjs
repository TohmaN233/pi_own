import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CourseBuilderHost, courseBuilderView, runCourseBuilderCommand } from "../packages/course-builder-host/src/index.ts";
import { CourseTeacherNotesLedger } from "../packages/course-builder-host/src/teacher-notes.ts";

const BEAMER_SOURCE = String.raw`\documentclass[aspectratio=169]{beamer}
\begin{document}
\begin{frame}{A lesson}
Deck source.
\end{frame}
\end{document}
`;

const NOTES_SOURCE = String.raw`\documentclass{article}
\title{Teacher notes}
\begin{document}
Explain the identity $e^{i\pi}+1=0$.
Use \texttt{literal backslashes} while speaking.
\end{document}
`;

function createFixture(database, suffix = "one") {
  const host = new CourseBuilderHost(database);
  const sessionId = `teacher-notes-${suffix}`;
  const project = host.createProject({
    courseId: `teacher-notes-${suffix}`,
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
  });
  host.bindSession(sessionId, project.projectId);
  const semester = host.saveSemesterPlan(
    sessionId,
    {
      title: "Identity",
      rationale: "Build a one lesson fixture",
      sessions: [
        {
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
        },
      ],
    },
    0,
  );
  host.reviewSemesterPlan(sessionId, semester.semesterPlanId, 1, "approve", "");
  const lesson = host.saveLessonPlan(
    sessionId,
    {
      week: 1,
      session: 1,
      title: "Euler's identity",
      objectives: ["Explain the identity"],
      prerequisites: [],
      misconceptions: [],
      segments: [
        {
          minutes: 20,
          title: "Identity",
          teacherAction: "Explain",
          learnerAction: "Predict",
          checkForUnderstanding: null,
        },
      ],
      examples: [],
      exercises: [],
      materialIds: [],
      visualRequests: [],
      notes: [],
    },
    0,
    1,
  );
  host.reviewLessonPlan(sessionId, lesson.lessonPlanId, 1, "approve", "");
  const deck = host.saveBeamerDeck(
    sessionId,
    {
      lessonPlanId: lesson.lessonPlanId,
      title: "Euler's identity",
      source: BEAMER_SOURCE,
      frameOutline: ["Identity"],
      assetMaterialIds: [],
    },
    0,
    1,
  );
  return {
    database,
    host,
    project,
    sessionId,
    deck,
    snapshot: host.getSnapshot(project.projectId),
  };
}

test("teacher-note commands persist and read exact TeX without changing their deck", async () => {
  const database=new DatabaseSync(":memory:");
  try {
    const f=createFixture(database),original=structuredClone(f.deck);
    const notes=await runCourseBuilderCommand(f.host,f.sessionId,{action:"save_teacher_notes",expectedRevision:0,draft:{deckId:f.deck.deckId,deckRevision:1,title:"Spoken lecture",source:NOTES_SOURCE}});
    const read=await runCourseBuilderCommand(f.host,f.sessionId,{action:"read_teacher_notes",id:notes.notesId});
    assert.equal(read.text,NOTES_SOURCE);
    assert.equal(courseBuilderView(f.host,f.sessionId).teacherNotes[0].source,undefined,"overview does not eagerly send full scripts");
    const patched=await runCourseBuilderCommand(f.host,f.sessionId,{action:"patch_teacher_notes",id:notes.notesId,expectedRevision:1,parentRevision:1,draft:{edits:[{oldText:"Explain the identity",newText:"First explain the identity"}]}});
    assert.equal(patched.source,NOTES_SOURCE.replace("Explain the identity","First explain the identity"));
    assert.deepEqual(f.host.getSnapshotForSession(f.sessionId).decks[0],original);
  } finally {database.close();}
});

test("asset cleanup preserves references in old deck revisions and independent lecture scripts", () => {
  const database=new DatabaseSync(":memory:");
  try {
    const f=createFixture(database);
    const [historical,scriptAsset,orphan]=f.host.importMaterials(f.sessionId,["historical","script","orphan"].map(name=>({name:`${name}.png`,kind:"asset",sourceBytes:Buffer.from(name),extractedText:"",metadata:{storage:"generated"}})),1);
    const deckDraft={lessonPlanId:f.deck.lessonPlanId,title:f.deck.title,source:BEAMER_SOURCE.replace("Deck source.",`Deck source. % ${historical.materialId}`),frameOutline:["Identity"],assetMaterialIds:[]};
    f.host.saveBeamerDeck(f.sessionId,deckDraft,1,1);
    f.host.saveBeamerDeck(f.sessionId,{...deckDraft,source:BEAMER_SOURCE},2,1);
    f.host.saveTeacherNotes(f.sessionId,{deckId:f.deck.deckId,deckRevision:3,title:"With figure",source:NOTES_SOURCE.replace("Explain the identity",`% ${scriptAsset.materialId}\nExplain the identity`)},0);
    const before=f.host.getSnapshotForSession(f.sessionId);
    const cleaned=f.host.cleanupStoredCourseAssets(f.sessionId);
    assert.deepEqual(cleaned.removedMaterialIds,[orphan.materialId]);
    assert.deepEqual(new Set(cleaned.retainedMaterialIds),new Set([historical.materialId,scriptAsset.materialId]));
    assert.deepEqual(f.host.getSnapshotForSession(f.sessionId).decks,before.decks);
    assert.deepEqual(f.host.getSnapshotForSession(f.sessionId).teacherNotes,before.teacherNotes);
  } finally {database.close();}
});

test("teacher notes preserve exact TeX, append revisions, and patch exactly once", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const fixture = createFixture(database);
    const ledger = new CourseTeacherNotesLedger(database);
    const first = ledger.save(
      () => fixture.snapshot,
      { deckId: fixture.deck.deckId, deckRevision: fixture.deck.revision, title: "Speaking notes", source: NOTES_SOURCE },
      0,
    );
    assert.equal(first.source, NOTES_SOURCE);
    assert.equal(ledger.get(fixture.snapshot, first.notesId).source, NOTES_SOURCE);
    assert.deepEqual(ledger.list(fixture.snapshot)[0].staleReasons, []);

    const replacement = "Explain Euler's identity with a unit circle.";
    const second = ledger.patch(
      () => fixture.snapshot,
      first.notesId,
      [{ oldText: "Explain the identity", newText: replacement }],
      1,
      fixture.deck.revision,
    );
    assert.equal(second.revision, 2);
    assert.equal(second.source, NOTES_SOURCE.replace("Explain the identity", replacement));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM course_builder_teacher_notes").get().count, 2);
    const third = ledger.patch(
      () => fixture.snapshot,
      first.notesId,
      [{ oldText: "unit circle", newText: "unit circle and the complex plane" }],
      2,
      fixture.deck.revision,
    );
    assert.equal(third.revision, 3);
    assert.match(third.source, /unit circle and the complex plane/);
    assert.throws(
      () => ledger.patch(() => fixture.snapshot, first.notesId, [{ oldText: "\n", newText: "x" }], 3, 1),
      /exactly once/,
    );
  } finally {
    database.close();
  }
});

test("notes survive a file restart and remain isolated by course", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-teacher-notes-"));
  const path = join(directory, "course.sqlite");
  let database = new DatabaseSync(path);
  try {
    const firstFixture = createFixture(database, "first");
    const secondFixture = createFixture(database, "second");
    const ledger = new CourseTeacherNotesLedger(database);
    const saved = ledger.save(
      () => firstFixture.snapshot,
      { deckId: firstFixture.deck.deckId, deckRevision: 1, title: "First", source: NOTES_SOURCE },
      0,
    );
    assert.equal(ledger.list(secondFixture.snapshot).length, 0);
    assert.throws(() => ledger.get(secondFixture.snapshot, saved.notesId), /another project|belong/);
    database.close();
    database = new DatabaseSync(path);
    const restoredHost = new CourseBuilderHost(database);
    const restoredSnapshot = restoredHost.getSnapshot(firstFixture.project.projectId);
    const restored = new CourseTeacherNotesLedger(database).get(restoredSnapshot, saved.notesId);
    assert.equal(restored.source, NOTES_SOURCE);
    assert.equal(restored.revision, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true });
  }
});

test("revision conflicts, changed decks, accepted decks, and corruption fail visibly", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const fixture = createFixture(database);
    const ledger = new CourseTeacherNotesLedger(database);
    const saved = ledger.save(
      () => fixture.snapshot,
      { deckId: fixture.deck.deckId, deckRevision: 1, title: "Speaking notes", source: NOTES_SOURCE },
      0,
    );
    assert.throws(
      () =>
        ledger.save(
          () => fixture.snapshot,
          { deckId: fixture.deck.deckId, deckRevision: 1, title: "Speaking notes", source: NOTES_SOURCE },
          0,
        ),
      /revision conflict/,
    );

    const changedDeck = fixture.host.saveBeamerDeck(
      fixture.sessionId,
      {
        lessonPlanId: fixture.deck.lessonPlanId,
        title: fixture.deck.title,
        source: BEAMER_SOURCE.replace("Deck source.", "Deck source v2."),
        frameOutline: ["Identity"],
        assetMaterialIds: [],
      },
      fixture.deck.revision,
      1,
    );
    const changedSnapshot = fixture.host.getSnapshot(fixture.project.projectId);
    assert.equal(changedDeck.revision, 2);
    assert.deepEqual(ledger.list(changedSnapshot)[0].staleReasons, ["课件版本已变化"]);
    const patched = ledger.patch(
      () => changedSnapshot,
      saved.notesId,
      [{ oldText: "Explain the identity", newText: "Explain the identity from the updated deck." }],
      1,
      changedDeck.revision,
    );
    assert.equal(patched.revision, 2);
    assert.equal(patched.deckRevision, changedDeck.revision);
    assert.equal(patched.deckSourceHash, changedDeck.sourceHash);
    assert.match(patched.source, /\\pi/);
    assert.match(patched.source, /\\texttt\{literal backslashes\}/);
    assert.deepEqual(ledger.list(changedSnapshot)[0].staleReasons, []);
    const acceptedSnapshot = {
      ...changedSnapshot,
      decks: changedSnapshot.decks.map((deck) => ({ ...deck, status: "accepted" })),
    };
    assert.deepEqual(ledger.list(acceptedSnapshot)[0].staleReasons, []);

    database
      .prepare("UPDATE course_builder_teacher_notes SET payload=? WHERE notes_id=? AND revision=?")
      .run(JSON.stringify({ ...patched, source: "tampered" }), patched.notesId, patched.revision);
    assert.throws(() => ledger.list(changedSnapshot), /Corrupt/);
  } finally {
    database.close();
  }
});

test("draft validation requires standalone non-Beamer LaTeX and rejects unknown keys", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const fixture = createFixture(database);
    const ledger = new CourseTeacherNotesLedger(database);
    const base = { deckId: fixture.deck.deckId, deckRevision: 1, title: "Notes", source: NOTES_SOURCE };
    for (const source of [
      "\\documentclass{beamer}\\begin{document}x\\end{document}",
      "\\documentclass{article}\\begin{document}x",
      "\\documentclass{article}\\begin{document}\\\\texttt{leak}\\end{document}",
    ]) {
      assert.throws(() => ledger.save(() => fixture.snapshot, { ...base, source }, 0));
    }
    assert.throws(() => ledger.save(() => fixture.snapshot, { ...base, notesId: "caller-id" }, 0), /not allowed/);
    assert.equal(ledger.list(fixture.snapshot).length, 0);
  } finally {
    database.close();
  }
});
