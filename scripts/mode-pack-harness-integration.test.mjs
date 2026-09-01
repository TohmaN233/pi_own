import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";

class FakeSessionStore {
	constructor(sessionId) {
		this.sessionId = sessionId;
		this.entries = [];
	}
	getSessionId() {
		return this.sessionId;
	}
	getBranch() {
		return [...this.entries];
	}
	appendCustomEntry(customType, data) {
		const id = `entry_${this.entries.length + 1}`;
		this.entries.push({ type: "custom", id, customType, data });
		return id;
	}
}

function customDraft() {
	return {
		version: 1,
		modePackId: "custom.stats-teach-back",
		revision: 1,
		title: "Stats teach-back",
		description: "Course-bound custom teach-back mode.",
		category: "education",
		role: "student",
		runtimeMode: "student-learn",
		provider: null,
		model: null,
		thinkingLevel: "high",
		externalKnowledgePolicy: "explain-and-label",
		courseRequired: true,
		tools: [],
		components: [
			{ type: "plugin", id: "learning-harness", required: true, enabled: true },
			{ type: "workflow", id: "teach-back", required: true, enabled: true },
			{ type: "skill", id: "education.feynman-teach-back", required: true, enabled: true },
			{ type: "skill", id: "education.learning-to-learn", required: false, enabled: true },
		],
		systemPrompt: "Make me explain each statistical assumption before accepting the result.",
		instructions: ["Use examples from the bound course before inventing a new one."],
	};
}

test("LearningHarness activates and recovers a custom course-bound Mode Pack", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mode-pack-harness-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const databasePath = join(directory, "learning-harness.sqlite");
	const store = new FakeSessionStore("mode-pack-session");
	let harness = new LearningHarness({ databasePath });
	const course = await harness.publishCourseVersion(
		"statistics",
		[{ name: "notes.md", kind: "markdown", mediaType: "text/markdown", content: "# Statistics\n\nState assumptions before interpreting a model." }],
		{ createdAt: "2026-08-31T13:00:00.000Z" },
	);
	const opened = harness.openStudentSession({
		sessionStore: store,
		courseVersionId: course.courseVersionId,
		createdAt: "2026-08-31T13:00:00.000Z",
	});
	assert.ok(opened.snapshot.resources.some((item) => item.kind === "skill" && item.id === "education.lesson-blueprint"));

	const availability = harness.availableProfiles(opened.sessionId);
	assert.equal(availability.find((item) => item.profileId === "teach-back")?.selectable, true);
	assert.equal(availability.find((item) => item.profileId === "visual-lab")?.selectable, false);
	assert.equal(availability.find((item) => item.profileId === "coding")?.selectable, false);

	const prepared = harness.prepareProfileTransition({
		sessionId: opened.sessionId,
		targetProfileId: "custom.stats-teach-back",
		expectedSnapshotId: opened.snapshot.resourceSnapshotId,
		idempotencyKey: "activate-custom",
		createdAt: "2026-08-31T13:00:01.000Z",
		modePackDraft: customDraft(),
	});
	assert.throws(
		() => harness.prepareProfileTransition({
			sessionId: opened.sessionId,
			targetProfileId: "custom.stats-teach-back",
			expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "activate-custom",
			createdAt: "2026-08-31T13:00:01.500Z",
			modePackDraft: {
				...customDraft(),
				systemPrompt: "Different content must not reuse the same transition key.",
			},
		}),
		/idempotency key was reused with different Mode Pack content/iu,
	);
	assert.equal(prepared.snapshot.profileId, "custom.stats-teach-back");
	assert.equal(prepared.snapshot.mode, "student-learn");
	assert.ok(prepared.snapshot.instructions.some((item) => /statistical assumption/iu.test(item)));
	assert.ok(prepared.snapshot.resources.some((item) => item.kind === "prompt" && item.id === "workflow:teach-back"));
	const custom = harness.commitPreparedProfileTransition(store, opened.sessionId, "activate-custom");
	assert.equal(custom.binding.revision, 2);
	assert.throws(
		() => harness.prepareProfileTransition({
			sessionId: opened.sessionId,
			targetProfileId: "custom.stats-teach-back",
			expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "activate-custom",
			createdAt: "2026-08-31T13:00:01.750Z",
			modePackDraft: {
				...customDraft(),
				systemPrompt: "Committed keys also bind the original Mode Pack content.",
			},
		}),
		/idempotency key was reused with different Mode Pack content/iu,
	);

	const practicePrepared = harness.prepareProfileTransition({
		sessionId: opened.sessionId,
		targetProfileId: "practice",
		expectedSnapshotId: custom.snapshot.resourceSnapshotId,
		idempotencyKey: "to-practice",
		createdAt: "2026-08-31T13:00:02.000Z",
	});
	const practice = harness.commitPreparedProfileTransition(store, opened.sessionId, "to-practice");
	assert.equal(practice.snapshot.profileId, "practice");

	const historical = harness.prepareProfileTransition({
		sessionId: opened.sessionId,
		targetProfileId: "custom.stats-teach-back",
		expectedSnapshotId: practice.snapshot.resourceSnapshotId,
		idempotencyKey: "restore-custom",
		createdAt: "2026-08-31T13:00:03.000Z",
	});
	assert.equal(historical.snapshot.resourceSnapshotId, custom.snapshot.resourceSnapshotId);
	const restored = harness.commitPreparedProfileTransition(store, opened.sessionId, "restore-custom");
	assert.equal(restored.snapshot.profileId, "custom.stats-teach-back");
	assert.equal(restored.binding.revision, 4);
	assert.equal(
		harness.availableProfiles(opened.sessionId).find((item) => item.profileId === "custom.stats-teach-back")?.title,
		"Stats teach-back",
	);
	harness.close();

	harness = new LearningHarness({ databasePath });
	const recovered = harness.reconcileRuntimeSession(store);
	assert.equal(recovered?.snapshot.profileId, "custom.stats-teach-back");
	assert.ok(recovered?.snapshot.instructions.some((item) => /statistical assumption/iu.test(item)));
	harness.close();
});
