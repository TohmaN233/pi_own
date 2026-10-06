import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { courseLessonTasks, teacherNotesTask } = await createJiti(import.meta.url).import("./course-builder-lesson-tasks.ts");
const project = { revision: 2, planningRevision: 1, weeks: 3, sessionsPerWeek: 2, goals: ["Understand"] };
const semester = { semesterPlanId: "semester", revision: 3, projectRevision: 2, projectPlanningRevision: 1, status: "approved", sessions: Array.from({ length: 6 }, (_, index) => ({ week: Math.floor(index / 2) + 1, session: index % 2 + 1, title: index === 5 ? "Newton's method" : "First lesson", courseGoalsCovered: ["Understand"] })) };
const lesson = { week: 3, session: 2, semesterPlanId: "semester", semesterPlanRevision: 3, lessonPlanId: "newton", revision: 4, status: "approved" };
test("teacher-notes prompt prioritizes teacher understanding, not a teaching script", () => {
  const prompts = [teacherNotesTask(), teacherNotesTask({ deckId: "deck", revision: 9, lessonPlanId: "lesson" })];
  assert.match(prompts[0], /final saved revision of the selected Beamer deck/);
  assert.match(prompts[1], /existing deckId=deck, deckRevision=9, lessonPlanId=lesson/);
  for (const prompt of prompts) {
    assert.match(prompt, /exclusively to help the teacher deeply understand the slide intent/);
    assert.match(prompt, /missing context, the logic connecting claims, motivations, derivations/);
    assert.match(prompt, /examples, and assumptions or prerequisites/);
    assert.match(prompt, /Identify ambiguities and distinguish source claims from teacher-derived explanations/);
    assert.match(prompt, /check factual and mathematical accuracy/);
    assert.match(prompt, /Flag unresolved uncertainty/);
    assert.match(prompt, /do not retell the deck slide by slide/);
    assert.match(prompt, /Do not include hypothetical dialogue, expected learner reactions or answers, scripted questions, activities, timing, pacing, speaking lines, or board-work cues/);
    assert.doesNotMatch(prompt, /allocations must add to the session length|common wrong answers and a focused repair|natural, speakable sentences/);
    assert.match(prompt, /read_teacher_notes and patch_teacher_notes/);
    assert.match(prompt, /compile_teacher_notes/);
    assert.match(prompt, /teacher-notes-pdf/);
  }
});
test("selected lesson tasks identify the actual slot and saved lesson, never default to lesson one", () => {
  const tasks = courseLessonTasks(semester, [lesson], 3, 2, project);
  assert.equal(tasks.plan.disabledReason, null);
  assert.equal(tasks.beamer.disabledReason, null);
  assert.match(tasks.plan.message, /week=3, session=2/);
  assert.match(tasks.plan.message, /newton, expectedRevision=4/);
  assert.match(tasks.beamer.message, /lessonPlanId=newton, lesson revision=4/);
  assert.doesNotMatch(tasks.beamer.message, /First lesson/);
  const first = courseLessonTasks(semester, [lesson], 1, 1, project);
  assert.equal(first.plan.disabledReason, null);
  assert.match(first.plan.message, /expectedRevision=0/);
  assert.ok(first.beamer.disabledReason, "approval of a different lesson cannot unlock this deck");
});
test("empty, unapproved, and stale selections have actionable reasons instead of generating a wrong lesson", () => {
  for (const args of [
    [null, [], 1, 1, project], [semester, [], 9, 1, project],
    [{ ...semester, status: "draft" }, [], 1, 1, project], [semester, [], 1, 1, { ...project, planningRevision: 2 }],
  ]) {
    const tasks = courseLessonTasks(...args);
    assert.ok(tasks.plan.disabledReason);
    assert.ok(tasks.beamer.disabledReason);
  }
  for (const variant of [{ ...lesson, status: "draft" }, { ...lesson, semesterPlanRevision: 2 }]) {
    assert.ok(courseLessonTasks(semester, [variant], 3, 2, project).beamer.disabledReason);
  }
});

test("material revisions do not disable approved lesson or Beamer shortcuts", () => {
  const tasks = courseLessonTasks(semester, [lesson], 3, 2, { ...project, revision: 9 });
  assert.equal(tasks.plan.disabledReason, null);
  assert.equal(tasks.beamer.disabledReason, null);
});

test("later lesson prompts carry persisted coverage and distinguish intentional recaps from repetition", () => {
  const first = { ...lesson, lessonPlanId: "first", week: 1, session: 1 };
  const checkpoint = { lessonPlanId: "first", revision: 2, status: "confirmed", staleReasons: [], coverage: [{ materialId: "intro.R", unit: "lines", start: 1, end: 40 }], completed: ["Objects and indexing"], remaining: ["Functions from line 41"], nextLesson: "Start from functions, keep the objects recap brief." };
  const tasks = courseLessonTasks(semester, [first, lesson], 3, 2, project, [checkpoint]);
  for (const task of [tasks.plan, tasks.beamer]) {
    assert.match(task.message, /"end":40/);
    assert.match(task.message, /Functions from line 41/);
    assert.match(task.message, /read_checkpoints/);
    assert.match(task.message, /save_checkpoint/);
    assert.match(task.message, /intentional recap/);
    assert.match(task.message, /untrusted reference data/);
  }
  assert.match(tasks.checkpoint.message, /Only save_checkpoint: preserve the existing lesson and slide contents/);
});
