import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
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

function draft(packet, courseVersionId, draftId, spanId, claimId = "claim") {
  return {
    version: 1,
    draftId,
    packetId: packet.packetId,
    courseVersionId,
    claims: [{ claimId, text: "A variable represents an unknown value.", scope: "direct", citationSpanIds: [spanId], reason: null }],
    createdAt: "2026-08-30T19:00:00.000Z",
    revision: 1,
  };
}

test("grounded publication is durable, idempotent, and shared by course sessions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-grounded-timeline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "learning-harness.sqlite");
  const firstStore = new FakeSessionStore("first-session");
  const secondStore = new FakeSessionStore("second-session");
  const harness = new LearningHarness({ databasePath });
  const course = await harness.publishCourseVersion(
    "algebra",
    [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Algebra\n\nA variable represents an unknown value." }],
    { createdAt: "2026-08-30T19:00:00.000Z" },
  );
  harness.openStudentSession({ sessionStore: firstStore, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T19:00:00.000Z" });
  harness.openStudentSession({ sessionStore: secondStore, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T19:00:00.000Z" });
  assert.deepEqual(harness.getCurrentTimeline("first-session"), []);

  const packet = harness.searchCurrentCourse("first-session", "what is a variable", "2026-08-30T19:00:00.000Z");
  const valid = draft(packet, course.courseVersionId, "draft-1", packet.spans[0].spanId);
  const published = harness.publishCurrentGroundedAnswer("first-session", valid, "2026-08-30T19:00:00.000Z");
  const repeated = harness.publishCurrentGroundedAnswer("first-session", valid, "2026-08-30T19:01:00.000Z");
  assert.equal(repeated.receipt.receiptId, published.receipt.receiptId);
  assert.equal(harness.getCurrentTimeline("first-session").length, 1);
  assert.deepEqual(harness.getLearningProgress("first-session").concepts, {});
  assert.equal(harness.getCurrentTimeline("second-session")[0].receiptId, undefined);
  assert.equal(harness.getCurrentTimeline("second-session")[0].payload.receiptId, published.receipt.receiptId);

  const secondPacket = harness.searchCurrentCourse("second-session", "unknown value", "2026-08-30T19:02:00.000Z");
  const crossSession = draft(secondPacket, course.courseVersionId, "draft-2", secondPacket.spans[0].spanId, "claim-2");
  harness.publishCurrentGroundedAnswer("second-session", crossSession, "2026-08-30T19:02:00.000Z");
  assert.equal(harness.getCurrentTimeline("first-session").length, 2);
  assert.deepEqual(harness.getLearningProgress("second-session").concepts, {});

  const invalid = { ...valid, draftId: "invalid", courseVersionId: "course-version-forged" };
  assert.throws(() => harness.publishCurrentGroundedAnswer("first-session", invalid), /another course version|targets another course/i);
  harness.close();

  const reopened = new LearningHarness({ databasePath });
  assert.equal(reopened.getCurrentTimeline("first-session").length, 2);
  assert.equal(reopened.getCurrentTimeline("second-session").length, 2);
  reopened.close();
});

test("a failed grounded publication restores in-memory Hosts before the poisoned root closes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-grounded-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "learning-harness.sqlite");
  const store = new FakeSessionStore("rollback-session");
  const harness = new LearningHarness({ databasePath });
  const course = await harness.publishCourseVersion(
    "rollback-course",
    [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Algebra\n\nA variable represents an unknown value." }],
    { createdAt: "2026-08-30T21:00:00.000Z" },
  );
  harness.openStudentSession({ sessionStore: store, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T21:00:00.000Z" });
  const packet = harness.searchCurrentCourse("rollback-session", "variable", "2026-08-30T21:00:00.000Z");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TRIGGER fail_grounded_publication BEFORE UPDATE ON learning_harness_state BEGIN SELECT RAISE(ABORT, 'publication failure'); END;");
  database.close();
  assert.throws(
    () => harness.publishCurrentGroundedAnswer("rollback-session", draft(packet, course.courseVersionId, "rollback-draft", packet.spans[0].spanId)),
    /publication failure/i,
  );
  assert.equal(harness.knowledgeHost.exportState().publications.length, 0);
  assert.equal(harness.learningHost.exportState().events.length, 0);
  harness.close();
  const cleanup = new DatabaseSync(databasePath);
  cleanup.exec("DROP TRIGGER fail_grounded_publication");
  cleanup.close();
  const reopened = new LearningHarness({ databasePath });
  assert.equal(reopened.knowledgeHost.exportState().publications.length, 0);
  assert.deepEqual(reopened.getCurrentTimeline("rollback-session"), []);
  reopened.close();
});

test("publication keeps immutable drafts for two revisions with the same draft id after restart", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-grounded-revisions-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "learning-harness.sqlite");
  const store = new FakeSessionStore("revision-session");
  const harness = new LearningHarness({ databasePath });
  const course = await harness.publishCourseVersion(
    "revision-course",
    [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Algebra\n\nA variable represents an unknown value." }],
    { createdAt: "2026-08-30T22:00:00.000Z" },
  );
  harness.openStudentSession({ sessionStore: store, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T22:00:00.000Z" });
  const packet = harness.searchCurrentCourse("revision-session", "variable", "2026-08-30T22:00:00.000Z");
  const first = draft(packet, course.courseVersionId, "revised-draft", packet.spans[0].spanId);
  const second = { ...first, revision: 2, createdAt: "2026-08-30T22:01:00.000Z" };
  const receiptOne = harness.publishCurrentGroundedAnswer("revision-session", first, "2026-08-30T22:00:00.000Z");
  const receiptTwo = harness.publishCurrentGroundedAnswer("revision-session", second, "2026-08-30T22:01:00.000Z");
  assert.notEqual(receiptOne.receipt.receiptId, receiptTwo.receipt.receiptId);
  assert.deepEqual(harness.knowledgeHost.exportState().publications.map((item) => item.draft.revision).sort(), [1, 2]);
  harness.close();

  const reopened = new LearningHarness({ databasePath });
  const publications = reopened.knowledgeHost.exportState().publications;
  assert.deepEqual(publications.map((item) => item.draft.revision).sort(), [1, 2]);
  assert.deepEqual(publications.map((item) => item.receipt.draftRevision).sort(), [1, 2]);
  reopened.close();
});

test("restoring conflicting immutable draft revisions rejects atomically", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-grounded-restore-conflict-"));
  const material = [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Algebra\n\nA variable represents an unknown value." }];
  const publishedAt = "2026-08-30T22:30:00.000Z";
  const createSource = async (name, claimText) => {
    const harness = new LearningHarness({ databasePath: join(directory, `${name}.sqlite`) });
    const course = await harness.publishCourseVersion("restore-conflict-course", material, { createdAt: publishedAt });
    harness.openStudentSession({ sessionStore: new FakeSessionStore(`${name}-session`), courseVersionId: course.courseVersionId, createdAt: publishedAt });
    const packet = harness.searchCurrentCourse(`${name}-session`, "variable", publishedAt);
    const value = draft(packet, course.courseVersionId, "restore-conflict-draft", packet.spans[0].spanId);
    harness.publishCurrentGroundedAnswer(name + "-session", { ...value, claims: [{ ...value.claims[0], text: claimText }] }, publishedAt);
    return { harness, course };
  };
  const first = await createSource("first", "A variable represents an unknown value.");
  const second = await createSource("second", "A variable is a named placeholder.");
  t.after(() => first.harness.close());
  t.after(() => second.harness.close());
  const target = new LearningHarness({ databasePath: join(directory, "target.sqlite") });
  t.after(() => target.close());
  const targetCourse = await target.publishCourseVersion("restore-conflict-course", material, { createdAt: publishedAt });
  assert.equal(targetCourse.courseVersionId, first.course.courseVersionId);
  assert.equal(targetCourse.courseVersionId, second.course.courseVersionId);
  const firstState = first.harness.knowledgeHost.exportState();
  const secondState = second.harness.knowledgeHost.exportState();

  assert.throws(
    () => target.knowledgeHost.restoreState({
      version: 1,
      packets: [...firstState.packets, ...secondState.packets],
      publications: [...firstState.publications, ...secondState.publications],
    }),
    (error) => error?.code === "DRAFT_REVISION_REUSE",
  );
  assert.deepEqual(target.knowledgeHost.exportState(), { version: 1, packets: [], publications: [] });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
});

test("publication rejects conflicting reuse of an immutable draft revision", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-grounded-revision-reuse-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "learning-harness.sqlite");
  const store = new FakeSessionStore("revision-reuse-session");
  const harness = new LearningHarness({ databasePath });
  const course = await harness.publishCourseVersion(
    "revision-reuse-course",
    [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Algebra\n\nA variable represents an unknown value." }],
    { createdAt: "2026-08-30T23:00:00.000Z" },
  );
  harness.openStudentSession({ sessionStore: store, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T23:00:00.000Z" });
  const packet = harness.searchCurrentCourse("revision-reuse-session", "variable", "2026-08-30T23:00:00.000Z");
  const first = draft(packet, course.courseVersionId, "immutable-draft", packet.spans[0].spanId);
  harness.publishCurrentGroundedAnswer("revision-reuse-session", first, "2026-08-30T23:00:00.000Z");
  const conflicting = {
    ...first,
    claims: [{ ...first.claims[0], text: "A variable can have a different name." }],
  };
  assert.throws(
    () => harness.publishCurrentGroundedAnswer("revision-reuse-session", conflicting, "2026-08-30T23:01:00.000Z"),
    (error) => error?.code === "DRAFT_REVISION_REUSE",
  );
  const exported = harness.knowledgeHost.exportState();
  assert.equal(exported.publications.length, 1);
  assert.equal(exported.publications[0].draft.claims[0].text, first.claims[0].text);
  harness.close();

  const reopened = new LearningHarness({ databasePath });
  const publications = reopened.knowledgeHost.exportState().publications;
  assert.equal(publications.length, 1);
  assert.equal(publications[0].draft.claims[0].text, first.claims[0].text);
  reopened.close();
});
