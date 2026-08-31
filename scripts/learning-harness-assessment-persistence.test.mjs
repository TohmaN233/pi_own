import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AssessmentHost,
  createExercisePrivate,
  InMemorySolutionVault,
} from "../packages/assessment-host/src/index.ts";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";

class FakeSessionStore {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.entries = [];
  }

  getSessionId() { return this.sessionId; }
  getBranch() { return [...this.entries]; }
  appendCustomEntry(customType, data) {
    const id = `entry-${this.entries.length + 1}`;
    this.entries.push({ type: "custom", id, customType, data });
    return id;
  }
}

async function setup(databasePath) {
  const harness = new LearningHarness({ databasePath });
  const course = await harness.publishCourseVersion(
    "assessment-course",
    [{ name: "lesson.md", kind: "markdown", mediaType: "text/markdown", content: "# Practice\n\nA variable represents an unknown quantity." }],
    { createdAt: "2026-08-30T22:00:00.000Z" },
  );
  const secondCourse = await harness.publishCourseVersion(
    "other-course",
    [{ name: "other.md", kind: "markdown", mediaType: "text/markdown", content: "# Other\n\nA cell is the basic unit of life." }],
    { createdAt: "2026-08-30T22:00:00.000Z" },
  );
  const store = new FakeSessionStore("assessment-session");
  const sameCourseStore = new FakeSessionStore("same-course-session");
  const otherStore = new FakeSessionStore("other-course-session");
  const session = harness.openStudentSession({ sessionStore: store, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T22:00:00.000Z" });
  harness.openStudentSession({ sessionStore: sameCourseStore, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T22:00:00.000Z" });
  harness.openStudentSession({ sessionStore: otherStore, courseVersionId: secondCourse.courseVersionId, createdAt: "2026-08-30T22:00:00.000Z" });
  return { harness, course, store, session };
}

test("Assessment persists public state separately from immutable private solutions and consumes a solution once", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-assessment-persistence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "learning-harness.sqlite");
  const { harness, course, store, session } = await setup(databasePath);
  const secret = "M5_PRIVATE_SOLUTION_SENTINEL_9d7e";
  const privateExercise = createExercisePrivate("variable-demo", secret, ["variable"], "Explain the unknown quantity.");
  harness.registerCurrentExercise(session.sessionId, {
    exerciseId: "variable-demo",
    courseVersionId: course.courseVersionId,
    conceptIds: ["variables"],
    prompt: "What does a variable represent? Give a short reason.",
    hints: ["Look for the term describing an unknown quantity."],
    unlockPolicy: "after-meaningful-attempt",
    revision: 1,
  }, privateExercise);

  const listed = harness.listCurrentExercises(session.sessionId);
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal(JSON.stringify(store.entries).includes(secret), false);
  const firstInstance = harness.startCurrentExercise(session.sessionId, "variable-demo", "issue-key", "2026-08-30T22:01:00.000Z");
  const retriedInstance = harness.startCurrentExercise(session.sessionId, "variable-demo", "issue-key", "2026-08-30T23:01:00.000Z");
  assert.equal(retriedInstance.instanceId, firstInstance.instanceId);
  assert.equal(retriedInstance.issuedAt, firstInstance.issuedAt);
  assert.equal(harness.requestCurrentPracticeHint(session.sessionId, firstInstance.instanceId, 1), "Look for the term describing an unknown quantity.");
  const submitted = harness.submitCurrentPracticeAttempt(
    session.sessionId,
    firstInstance.instanceId,
    "A variable is an unknown quantity in an expression.",
    "attempt-key",
    "2026-08-30T22:02:00.000Z",
  );
  assert.equal(submitted.attempt.meaningful, true);
  assert.equal(submitted.evaluation.correct, false);
  assert.ok(submitted.capability);
  const retried = harness.submitCurrentPracticeAttempt(
    session.sessionId,
    firstInstance.instanceId,
    "A variable is an unknown quantity in an expression.",
    "attempt-key",
    "2026-08-30T23:02:00.000Z",
  );
  assert.equal(retried.attempt.attemptId, submitted.attempt.attemptId);
  assert.equal(retried.evaluation.evaluationId, submitted.evaluation.evaluationId);
  assert.equal(harness.getCurrentTimeline(session.sessionId).filter((event) => event.payload?.type === "practice-attempt").length, 1);
  const duplicateUnlock = harness.requestCurrentPracticeSolutionUnlock(
    session.sessionId,
    submitted.attempt.attemptId,
    "different-unlock-key",
    "2026-08-30T23:03:00.000Z",
  );
  assert.equal(duplicateUnlock.capabilityId, submitted.capability.capabilityId);
  assert.throws(
    () => harness.consumeCurrentPracticeSolution("same-course-session", submitted.attempt.attemptId),
    /another session|scope/i,
  );
  assert.throws(
    () => harness.consumeCurrentPracticeSolution("other-course-session", submitted.attempt.attemptId),
    /another session|scope/i,
  );

  const database = new DatabaseSync(databasePath);
  const stateRows = database.prepare("SELECT value FROM learning_harness_state").all();
  assert.equal(JSON.stringify(stateRows).includes(secret), false);
  const privateRows = database.prepare("SELECT payload_json AS payloadJson FROM learning_harness_private_solution").all();
  assert.equal(JSON.stringify(privateRows).includes(secret), true);
  database.close();

  assert.equal(harness.consumeCurrentPracticeSolution(session.sessionId, submitted.attempt.attemptId, "2026-08-30T22:03:00.000Z"), secret);
  harness.close();
  const reopened = new LearningHarness({ databasePath });
  assert.throws(
    () => reopened.consumeCurrentPracticeSolution(session.sessionId, submitted.attempt.attemptId, "2026-08-30T22:04:00.000Z"),
    /consumed/i,
  );
  reopened.close();
});

test("solution persistence failure returns no private text and leaves the committed capability usable after reopen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-assessment-solution-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "learning-harness.sqlite");
  const { harness, course, session } = await setup(databasePath);
  const secret = "M5_PRIVATE_ROLLBACK_SENTINEL_ef29";
  harness.registerCurrentExercise(session.sessionId, {
    exerciseId: "rollback-demo",
    courseVersionId: course.courseVersionId,
    conceptIds: ["variables"],
    prompt: "State a variable meaning.",
    hints: [],
    unlockPolicy: "after-meaningful-attempt",
    revision: 1,
  }, createExercisePrivate("rollback-demo", secret, ["variable"], "Use the definition."));
  const instance = harness.startCurrentExercise(session.sessionId, "rollback-demo", "issue");
  const submitted = harness.submitCurrentPracticeAttempt(session.sessionId, instance.instanceId, "A variable represents an unknown quantity.", "attempt");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TRIGGER fail_solution_consume BEFORE UPDATE ON learning_harness_state BEGIN SELECT RAISE(ABORT, 'injected solution persistence failure'); END;");
  database.close();
  assert.throws(
    () => harness.consumeCurrentPracticeSolution(session.sessionId, submitted.attempt.attemptId),
    /injected solution persistence failure/i,
  );
  harness.close();
  const cleanup = new DatabaseSync(databasePath);
  cleanup.exec("DROP TRIGGER fail_solution_consume");
  cleanup.close();
  const reopened = new LearningHarness({ databasePath });
  assert.equal(reopened.consumeCurrentPracticeSolution(session.sessionId, submitted.attempt.attemptId), secret);
  reopened.close();
});

test("a legacy state row set is upgraded with an empty Assessment state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-assessment-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "learning-harness.sqlite");
  const { harness } = await setup(databasePath);
  harness.close();
  const database = new DatabaseSync(databasePath);
  database.prepare("DELETE FROM learning_harness_state WHERE key = ?").run("assessment-host");
  database.close();
  const reopened = new LearningHarness({ databasePath });
  assert.deepEqual(reopened.listCurrentExercises("assessment-session"), []);
  reopened.close();
  const verified = new DatabaseSync(databasePath);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM learning_harness_state WHERE key = 'assessment-host'").get().count, 1);
  verified.close();
});

test("assessment restore rejects forged canonical evaluations after restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-assessment-canonical-restore-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, mutate] of [
    ["correct", (evaluation) => { evaluation.correct = true; }],
    ["evaluationId", (evaluation) => { evaluation.evaluationId = "forged-evaluation"; }],
    ["feedback", (evaluation) => { evaluation.feedback = "forged feedback"; }],
  ]) {
    const databasePath = join(directory, `${name}.sqlite`);
    const { harness, course, session } = await setup(databasePath);
    harness.registerCurrentExercise(session.sessionId, {
      exerciseId: `canonical-${name}`,
      courseVersionId: course.courseVersionId,
      conceptIds: ["variables"],
      prompt: "What does a variable represent?",
      hints: [],
      unlockPolicy: "after-correct-attempt",
      revision: 1,
    }, createExercisePrivate(`canonical-${name}`, "private answer", ["variable"], "Use the course definition."));
    const instance = harness.startCurrentExercise(session.sessionId, `canonical-${name}`, `issue-${name}`, "2026-08-30T22:01:00.000Z");
    const submitted = harness.submitCurrentPracticeAttempt(
      session.sessionId,
      instance.instanceId,
      "A variable represents an unknown quantity.",
      `attempt-${name}`,
      "2026-08-30T22:02:00.000Z",
    );
    assert.equal(submitted.evaluation.correct, false);
    assert.equal(submitted.capability, null);
    harness.close();
    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT value FROM learning_harness_state WHERE key = 'assessment-host'").get();
    const state = JSON.parse(row.value);
    mutate(state.evaluations[0]);
    database.prepare("UPDATE learning_harness_state SET value = ? WHERE key = 'assessment-host'").run(JSON.stringify(state));
    database.close();
    assert.throws(
      () => new LearningHarness({ databasePath }),
      (error) => error && error.code === "CORRUPT_EVALUATION",
    );
  }
});

test("assessment and private-vault replacement are atomic when a later persisted entry is corrupt", () => {
  const firstPrivate = createExercisePrivate("atomic-one", "private one", ["one"], "Use one.");
  const secondPrivate = createExercisePrivate("atomic-two", "private two", ["two"], "Use two.");
  const vault = new InMemorySolutionVault();
  vault.put(firstPrivate);
  const privateBefore = vault.exportState();
  assert.throws(
    () => vault.replaceState([firstPrivate, { ...secondPrivate, contentHash: "sha256:forged" }]),
    (error) => error && error.code === "PRIVATE_HASH_MISMATCH",
  );
  assert.deepEqual(vault.exportState(), privateBefore);

  const exercise = {
    exerciseId: "atomic-one",
    courseVersionId: "course-atomic",
    conceptIds: ["atomic"],
    prompt: "State one.",
    hints: [],
    unlockPolicy: "after-meaningful-attempt",
    revision: 1,
  };
  const host = new AssessmentHost(vault);
  host.registerExercise(exercise, firstPrivate);
  const publicBefore = host.exportPublicState();
  const corruptState = structuredClone(publicBefore);
  corruptState.publicExercises.push({ ...exercise, exerciseId: "missing-private" });

  const emptyHost = new AssessmentHost(vault);
  assert.throws(
    () => emptyHost.restorePublicState(corruptState),
    (error) => error && error.code === "PRIVATE_ASSET_UNAVAILABLE",
  );
  assert.deepEqual(emptyHost.exportPublicState(), {
    version: 1,
    publicExercises: [],
    instances: [],
    attempts: [],
    evaluations: [],
    capabilities: [],
    idempotency: [],
  });
  assert.throws(
    () => host.replacePublicState(corruptState),
    (error) => error && error.code === "PRIVATE_ASSET_UNAVAILABLE",
  );
  assert.deepEqual(host.exportPublicState(), publicBefore);
});
