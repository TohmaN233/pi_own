import type { CourseBuilderHost } from "../../../packages/course-builder-host/src/index.ts";
import type { DeliverySnapshot, DeliveryTarget } from "./course-builder-delivery-target";

export type RequirementVerification = "content" | "compile-review" | "checkpoint" | "materials";
type CheckpointView = ReturnType<CourseBuilderHost["listCoverageCheckpoints"]>[number];
type RecordValue = Record<string, string | number>;
type Input = {
	snapshot: DeliverySnapshot;
	target: DeliveryTarget;
	verification: RequirementVerification;
	checkpoints?: readonly CheckpointView[];
	importedMaterialIds?: readonly string[];
};
type Output = {
	ready: boolean;
	kind: RequirementVerification;
	nextAction: string | null;
	records: RecordValue[];
};

const answer = (kind: RequirementVerification, ready: boolean, nextAction: string | null, records: RecordValue[] = []): Output => ({
	ready,
	kind,
	nextAction,
	records,
});
const blocked = (kind: RequirementVerification, nextAction: string): Output => answer(kind, false, nextAction);

function deckFor(snapshot: DeliverySnapshot, target: DeliveryTarget) {
	if (target.kind !== "deck" || typeof target.id !== "string" || !target.id.trim()) return undefined;
	const deck = snapshot.decks.find((item) => item.deckId === target.id);
	return deck?.projectId === snapshot.project.projectId ? deck : undefined;
}

function compileReview(input: Input): Output {
	const { snapshot, target, verification } = input;
	const deck = deckFor(snapshot, target);
	if (!deck) return blocked(verification, "Save or select a Host-bound deck before compiling and reviewing the current deck revision.");
	const receipt = snapshot.compileReceipts.filter((item) =>
		item.projectId === snapshot.project.projectId && item.deckId === deck.deckId &&
		item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash,
	).at(-1);
	if (!receipt) return blocked(verification, "Compile the current deck revision successfully; stale or mismatched receipts cannot qualify.");
	if (!receipt.succeeded) return blocked(verification, "Read the latest compile diagnostics, repair the current deck revision, and compile it successfully.");
	const review = snapshot.deckReviews.filter((item) =>
		item.projectId === snapshot.project.projectId && item.deckId === deck.deckId &&
		item.deckRevision === deck.revision && item.sourceHash === deck.sourceHash &&
		item.compileReceiptId === receipt.receiptId,
	).at(-1);
	if (!review) return blocked(verification, "Review the current deck using its successful compile receipt; a pass tied to that receipt is required.");
	if (review.status !== "pass") return blocked(verification, "Repair the current deck review issues, then compile and review the current revision again.");
	return answer(verification, true, null, [{
		deckId: deck.deckId,
		deckRevision: deck.revision,
		sourceHash: deck.sourceHash,
		receiptId: receipt.receiptId,
		reviewId: review.reviewId,
	}]);
}

function lessonFor(snapshot: DeliverySnapshot, target: DeliveryTarget) {
	if (target.kind === "lesson") {
		const id = target.id ?? target.lessonPlanId;
		if (typeof id !== "string" || !id.trim() || target.id && target.lessonPlanId && target.id !== target.lessonPlanId) return undefined;
		return snapshot.lessonPlans.find((item) => item.projectId === snapshot.project.projectId && item.lessonPlanId === id);
	}
	const deck = deckFor(snapshot, target);
	if (!deck || target.lessonPlanId && target.lessonPlanId !== deck.lessonPlanId) return undefined;
	return snapshot.lessonPlans.find((item) => item.projectId === snapshot.project.projectId && item.lessonPlanId === deck.lessonPlanId);
}

function checkpoint(input: Input): Output {
	const { snapshot, target, verification } = input;
	if (target.kind !== "lesson" && target.kind !== "deck") return blocked(verification, "Checkpoint evidence requires a lesson or deck delivery target.");
	const lesson = lessonFor(snapshot, target);
	if (!lesson) return blocked(verification, "Select a saved lesson or a Host-bound deck with a current lesson.");
	const saved = (input.checkpoints ?? []).filter((item) =>
		item.projectId === snapshot.project.projectId && item.lessonPlanId === lesson.lessonPlanId &&
		item.lessonRevision === lesson.revision,
	).at(-1);
	if (!saved || !Array.isArray(saved.staleReasons) || saved.staleReasons.length) {
		return blocked(verification, "Save a new preparation checkpoint for the current lesson revision; stale checkpoint evidence cannot qualify.");
	}
	let deck: DeliverySnapshot["decks"][number] | undefined;
	if (target.kind === "deck") {
		deck = deckFor(snapshot, target);
		if (!deck || saved.deckId !== deck.deckId || saved.deckRevision !== deck.revision) {
			return blocked(verification, "Save a new preparation checkpoint tied to the current deck revision; stale checkpoint evidence cannot qualify.");
		}
	} else if (saved.deckId !== null) {
		deck = snapshot.decks.find((item) =>
			item.projectId === snapshot.project.projectId && item.deckId === saved.deckId &&
			item.lessonPlanId === lesson.lessonPlanId && item.revision === saved.deckRevision,
		);
		if (!deck) return blocked(verification, "Refresh the current lesson/deck and save a checkpoint tied to those revisions.");
	}
	const record: RecordValue = {
		projectId: saved.projectId,
		lessonPlanId: saved.lessonPlanId,
		revision: saved.revision,
		lessonRevision: lesson.revision,
	};
	if (deck) Object.assign(record, { deckId: deck.deckId, deckRevision: deck.revision });
	return answer(verification, true, null, [record]);
}

function materials(input: Input): Output {
	const { snapshot, verification } = input;
	const ids = input.importedMaterialIds;
	if (!Array.isArray(ids) || !ids.length) return blocked(verification, "Import at least one course-scoped material through the Host before finishing delivery.");
	const byId = new Map(snapshot.materials.filter((item) => item.metadata.materialScope !== "assignment").map((item) => [item.materialId, item]));
	const records: RecordValue[] = [];
	for (const id of ids) {
		const material = typeof id === "string" ? byId.get(id) : undefined;
		if (!material) return blocked(verification, "Verify every imported material is present in the current course material library; assignment-scoped materials do not qualify.");
		records.push({ materialId: material.materialId, sourceHash: material.sourceHash });
	}
	return answer(verification, true, null, records);
}

export function resolveOperationalEvidence(input: Input): Output {
	const { verification, target } = input;
	if (verification === "content") return blocked(verification, "Content evidence is checked against the saved artifact; this resolver only handles compile-review, checkpoint, and materials.");
	if (target === null || typeof target !== "object" || !["semester", "lesson", "deck", "assignment", "visual", "materials", "teacher-notes"].includes(target.kind)) {
		return blocked(verification, "Use a valid Host delivery target before requesting operational evidence.");
	}
	if (verification === "compile-review") return target.kind === "deck" ? compileReview(input) : blocked(verification, "Compile-review evidence requires a deck delivery target.");
	if (verification === "checkpoint") return checkpoint(input);
	if (verification === "materials") return materials(input);
	return blocked(verification, "Unknown operational verification kind; choose compile-review, checkpoint, or materials.");
}
