import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { resolveOperationalEvidence } = await createJiti(import.meta.url).import("./course-builder-delivery-evidence.ts");

function fixture() {
	const project = { projectId: "course-1" };
	const lesson = { projectId: "course-1", lessonPlanId: "lesson-1", revision: 3 };
	const deck = {
		projectId: "course-1",
		deckId: "deck-1",
		lessonPlanId: "lesson-1",
		revision: 4,
		sourceHash: "sha256:deck-current",
	};
	const material = { materialId: "material-1", sourceHash: "sha256:material-1", metadata: { materialScope: "course" } };
	return {
		snapshot: {
			project,
			materials: [material],
			assignments: [],
			semesterPlan: null,
			lessonPlans: [lesson],
			decks: [deck],
			compileReceipts: [],
			deckReviews: [],
			visuals: [],
		},
		lesson,
		deck,
		material,
	};
}

test("compile-review accepts only current Host compile and matching passing review evidence", () => {
	const f = fixture();
	f.snapshot.compileReceipts.push(
		{ projectId: "course-1", receiptId: "stale", deckId: "deck-1", deckRevision: 3, sourceHash: "sha256:deck-current", succeeded: true },
		{ projectId: "other-course", receiptId: "cross-course", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", succeeded: true },
		{ projectId: "course-1", receiptId: "current", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", succeeded: true },
	);
	f.snapshot.deckReviews.push(
		{ projectId: "course-1", reviewId: "wrong-receipt", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", compileReceiptId: "stale", status: "pass" },
		{ projectId: "course-1", reviewId: "current-review", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", compileReceiptId: "current", status: "pass" },
	);
	assert.deepEqual(
		resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "deck", id: "deck-1" }, verification: "compile-review" }),
		{
			ready: true,
			kind: "compile-review",
			nextAction: null,
			records: [{ deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", receiptId: "current", reviewId: "current-review" }],
		},
	);
});

test("compile-review rejects stale, wrong-hash, failed, and wrong-receipt proof", () => {
	const f = fixture();
	f.snapshot.compileReceipts.push(
		{ projectId: "course-1", receiptId: "wrong-revision", deckId: "deck-1", deckRevision: 3, sourceHash: "sha256:deck-current", succeeded: true },
		{ projectId: "course-1", receiptId: "wrong-hash", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:old", succeeded: true },
		{ projectId: "course-1", receiptId: "failed", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", succeeded: false },
	);
	const result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "deck", id: "deck-1" }, verification: "compile-review" });
	assert.equal(result.ready, false);
	assert.match(result.nextAction, /current deck revision/);

	f.snapshot.compileReceipts.push({ projectId: "course-1", receiptId: "current", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", succeeded: true });
	f.snapshot.deckReviews.push({ projectId: "course-1", reviewId: "wrong", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", compileReceiptId: "failed", status: "pass" });
	const withoutReview = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "deck", id: "deck-1" }, verification: "compile-review" });
	assert.equal(withoutReview.ready, false);
	assert.match(withoutReview.nextAction, /Review the current deck/);
});

test("a latest failed current compile blocks an older passing receipt", () => {
	const f = fixture();
	f.snapshot.compileReceipts.push(
		{ projectId: "course-1", receiptId: "passing", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", succeeded: true },
		{ projectId: "course-1", receiptId: "latest-failed", deckId: "deck-1", deckRevision: 4, sourceHash: "sha256:deck-current", succeeded: false },
	);
	const result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "deck", id: "deck-1" }, verification: "compile-review" });
	assert.equal(result.ready, false);
	assert.match(result.nextAction, /latest compile diagnostics/);
});

test("checkpoint evidence accepts planned current records and does not require teacher confirmation", () => {
	const f = fixture();
	const checkpoint = {
		projectId: "course-1",
		lessonPlanId: "lesson-1",
		lessonRevision: 3,
		deckId: null,
		deckRevision: null,
		revision: 2,
		status: "planned",
		staleReasons: [],
	};
	const result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "lesson", id: "lesson-1" }, verification: "checkpoint", checkpoints: [checkpoint] });
	assert.deepEqual(result.records, [{ projectId: "course-1", lessonPlanId: "lesson-1", revision: 2, lessonRevision: 3 }]);
});

test("checkpoint evidence rejects stale and cross-revision records, and matches deck identity for deck targets", () => {
	const f = fixture();
	const stale = {
		projectId: "course-1",
		lessonPlanId: "lesson-1",
		lessonRevision: 2,
		deckId: "deck-1",
		deckRevision: 4,
		revision: 1,
		status: "confirmed",
		staleReasons: ["lesson changed"],
	};
	let result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "lesson", id: "lesson-1" }, verification: "checkpoint", checkpoints: [stale] });
	assert.equal(result.ready, false);

	const wrongDeck = { ...stale, lessonRevision: 3, staleReasons: [], deckId: "other-deck" };
	result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "deck", id: "deck-1" }, verification: "checkpoint", checkpoints: [wrongDeck] });
	assert.equal(result.ready, false);
	assert.match(result.nextAction, /current deck revision/);

	const current = { ...wrongDeck, deckId: "deck-1", deckRevision: 4 };
	result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "deck", id: "deck-1" }, verification: "checkpoint", checkpoints: [current] });
	assert.equal(result.ready, true);
	assert.deepEqual(result.records[0], { projectId: "course-1", lessonPlanId: "lesson-1", revision: 1, lessonRevision: 3, deckId: "deck-1", deckRevision: 4 });
});

test("materials evidence validates every imported course material and excludes assignment scope", () => {
	const f = fixture();
	f.snapshot.materials.push({ materialId: "assignment-only", sourceHash: "sha256:assignment", metadata: { materialScope: "assignment" } });
	let result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "materials" }, verification: "materials", importedMaterialIds: ["material-1"] });
	assert.equal(result.ready, true);
	assert.deepEqual(result.records, [{ materialId: "material-1", sourceHash: "sha256:material-1" }]);

	result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "materials" }, verification: "materials", importedMaterialIds: ["material-1", "assignment-only"] });
	assert.equal(result.ready, false);
	assert.match(result.nextAction, /assignment-scoped/);
	result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "materials" }, verification: "materials", importedMaterialIds: [] });
	assert.equal(result.ready, false);
});

test("content and invalid target kinds remain non-operational and fail closed", () => {
	const f = fixture();
	let result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "deck", id: "deck-1" }, verification: "content" });
	assert.equal(result.ready, false);
	assert.match(result.nextAction, /Content evidence/);
	result = resolveOperationalEvidence({ snapshot: f.snapshot, target: { kind: "assignment", id: "assignment-1" }, verification: "checkpoint" });
	assert.equal(result.ready, false);
	assert.match(result.nextAction, /lesson or deck/);
});
