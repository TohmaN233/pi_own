import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { courseLessonTasks } = await createJiti(import.meta.url).import("./course-builder-lesson-tasks.ts");
const project = { revision: 2, planningRevision: 1, weeks: 3, sessionsPerWeek: 2, goals: ["Understand"] };
const semester = { semesterPlanId: "semester", revision: 3, projectRevision: 2, projectPlanningRevision: 1, status: "approved", sessions: Array.from({ length: 6 }, (_, index) => ({ week: Math.floor(index / 2) + 1, session: index % 2 + 1, title: index === 5 ? "Newton's method" : "First lesson", courseGoalsCovered: ["Understand"] })) };
const lesson = { week: 3, session: 2, semesterPlanId: "semester", semesterPlanRevision: 3, lessonPlanId: "newton", revision: 4, status: "approved" };
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
