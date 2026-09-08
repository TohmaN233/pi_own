import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { CourseDeliveryLoop } = await createJiti(import.meta.url).import("./course-builder-delivery.ts");
function fixture() {
  let saved;
  const snapshot = { semesterPlan: null, lessonPlans: [], assignments: [], visuals: [], decks: [{ deckId: "deck", revision: 17, sourceHash: "old", source: "The R Workspace" }], compileReceipts: [], deckReviews: [] };
  const io = { snapshot: () => structuredClone(snapshot), load: () => structuredClone(saved), save: (task) => { saved = structuredClone(task); } };
  const loop = new CourseDeliveryLoop(io);
  loop.start("Restore all source sections including workspace AND getting help, not a partial patch.");
  const requirements = [{ id: "workspace", text: "Restore R Workspace" }, { id: "help", text: "Restore Getting Help" }];
  return { loop, io, snapshot, requirements, task: () => saved };
}
test("an acknowledgement or a successful compile cannot end a delivery; every requirement needs new artifact evidence", () => {
  const f = fixture();
  assert.equal(f.loop.end("stop").continue, true, "no routing must continue");
  f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  assert.equal(f.loop.end("stop").continue, true, "a promise without an artifact must continue");
  f.snapshot.decks[0] = { deckId: "deck", revision: 18, sourceHash: "new", source: "The R Workspace\nGetting Help in R" };
  f.loop.observe({ action: "patch_deck" }, { revision: 18 });
  const checks = [{ requirementId: "workspace", quote: "The R Workspace" }, { requirementId: "help", quote: "Getting Help in R" }];
  assert.throws(() => f.loop.finish({ id: "deck", checks }), /compile/);
  f.snapshot.compileReceipts.push({ receiptId: "compile", deckId: "deck", deckRevision: 18, sourceHash: "new", succeeded: true });
  f.snapshot.deckReviews.push({ reviewId: "review", deckId: "deck", deckRevision: 18, sourceHash: "new", compileReceiptId: "compile", status: "pass" });
  assert.throws(() => f.loop.finish({ id: "deck", checks: checks.slice(0, 1) }), /Incomplete/);
  assert.throws(() => f.loop.finish({ id: "deck", checks: [checks[0], { requirementId: "help", quote: "Invented evidence" }] }), /no matching/);
  assert.equal(f.loop.end("stop").continue, true, "passing compile and review is insufficient until ALL checks complete");
  const restored = new CourseDeliveryLoop(f.io);
  assert.equal(restored.finish({ id: "deck", checks }).status, "completed");
  assert.equal(restored.end("stop"), null);
});
test("follow-up instructions retain original requirements and baseline; a status question does not drop active work", () => {
  const f = fixture(); f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  f.loop.start("Finish before stopping");
  f.loop.route({ kind: "question", reason: "The user reiterates the instruction" });
  assert.equal(f.task().status, "active");
  assert.equal(f.task().baseline.deck, 17);
  assert.deepEqual(f.task().requirements, f.requirements);
  assert.throws(() => f.loop.route({ kind: "deck", id: "deck", requirements: [{ id: "help", text: "Only fix Workspace" }] }), /replace/);
});
test("questions need no production loop; errors and user abort are explicit unfinished states", () => {
  const f = fixture(); f.loop.route({ kind: "question", reason: "No artifact requested" });
  assert.equal(f.loop.end("stop"), null);
  assert.throws(() => f.loop.assertProductionAction("patch_deck"), /Route/);
  f.loop.start("Now edit the deck"); f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  assert.equal(f.loop.end("aborted").continue, false); assert.equal(f.task().status, "cancelled");
  f.loop.start("Resume"); assert.equal(f.loop.end("error"), null); assert.equal(f.task().status, "routing", "native provider retries retain the task");
  assert.match(f.loop.settled(), /原生重试已结束/); assert.equal(f.task().status, "blocked");
});
test("recoverable errors loop, repeated zero-progress cannot silently masquerade as delivery", () => {
  const f = fixture(); f.loop.route({ kind: "deck", id: "deck", requirements: f.requirements });
  f.loop.observe({ action: "compile" }, null, "TeX overflow, line 42");
  assert.equal(f.loop.end("stop").continue, true);
  assert.equal(f.loop.end("stop").continue, true);
  const stopped = f.loop.end("stop");
  assert.equal(stopped.continue, false); assert.match(stopped.message, /TeX overflow/);
  assert.equal(f.task().status, "blocked"); assert.equal(f.task().delivered, undefined);
});
