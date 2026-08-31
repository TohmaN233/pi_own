import assert from "node:assert/strict";
import test from "node:test";
import {
	compileModePackDraft,
	createBuiltinModePacks,
	createDefaultResourceCatalog,
	inspectModePackAvailability,
	resolveModePackSnapshot,
} from "../packages/profile-resource-host/src/index.ts";

function customDraft(overrides = {}) {
	return {
		version: 1,
		modePackId: "custom.statistics",
		revision: 1,
		title: "Statistics tutor",
		description: "A custom learner Mode Pack.",
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
		],
		systemPrompt: "Use concrete statistical examples and require the learner to explain assumptions.",
		instructions: ["Prefer notation already used by the course."],
		...overrides,
	};
}

test("built-in Mode Packs pin prompt, skill, plugin, and workflow identities", () => {
	const catalog = createDefaultResourceCatalog();
	const packs = createBuiltinModePacks(catalog);
	const tutor = packs["student-learn"];
	assert.equal(tutor.modePackId, "student-learn");
	assert.equal(tutor.runtimeMode, "student-learn");
	assert.ok(tutor.components.some((item) => item.type === "plugin" && item.id === "learning-harness"));
	assert.ok(tutor.components.some((item) => item.type === "skill" && item.id === "education.lesson-blueprint"));
	assert.ok(tutor.components.some((item) => item.type === "workflow" && item.id === "tutor"));
	assert.match(tutor.contentHash, /^sha256:[0-9a-f]{64}$/u);

	const snapshot = resolveModePackSnapshot({
		pack: tutor,
		courseVersionId: "course-version-1",
		catalog,
		createdAt: "2026-08-31T12:00:00.000Z",
	});
	assert.equal(snapshot.profileId, "student-learn");
	assert.equal(snapshot.mode, "student-learn");
	assert.ok(snapshot.resources.some((item) => item.kind === "prompt" && item.id === "workflow:tutor"));
	assert.ok(snapshot.instructions.some((item) => /Mode Pack: Tutor/u.test(item)));
	assert.ok(snapshot.instructions.some((item) => /plan backward/iu.test(item)));
});

test("custom Mode Packs are strictly parsed, content-addressed, and resolved into immutable snapshots", () => {
	const catalog = createDefaultResourceCatalog();
	const pack = compileModePackDraft(customDraft(), catalog);
	assert.equal(pack.modePackId, "custom.statistics");
	assert.match(pack.contentHash, /^sha256:[0-9a-f]{64}$/u);
	assert.equal(Object.isFrozen(pack), true);
	assert.ok(pack.components.every((item) => item.version === "1" && item.contentHash.startsWith("sha256:")));

	const snapshot = resolveModePackSnapshot({
		pack,
		courseVersionId: "course-version-1",
		catalog,
		createdAt: "2026-08-31T12:00:01.000Z",
	});
	assert.equal(snapshot.profileId, "custom.statistics");
	assert.equal(snapshot.mode, "student-learn");
	assert.ok(snapshot.instructions.some((item) => /concrete statistical examples/iu.test(item)));
	assert.ok(snapshot.resources.some((item) => item.kind === "prompt" && item.id === "workflow:teach-back"));
});

test("Mode Pack compilation and profile safety fail closed", () => {
	const catalog = createDefaultResourceCatalog();
	assert.throws(
		() => compileModePackDraft(customDraft({
			components: [{ type: "skill", id: "missing.skill", required: true, enabled: true }],
		}), catalog),
		/Required Mode Pack component|not installed/iu,
	);
	assert.throws(
		() => compileModePackDraft({ ...customDraft(), unexpected: true }, catalog),
		/unknown field/iu,
	);
	const unsafe = compileModePackDraft(customDraft({ tools: ["write"] }), catalog);
	assert.throws(
		() => resolveModePackSnapshot({
			pack: unsafe,
			courseVersionId: "course-version-1",
			catalog,
			createdAt: "2026-08-31T12:00:02.000Z",
		}),
		/forbidden tools/iu,
	);
});

test("missing optional custom components degrade without blocking compilation", () => {
	const catalog = createDefaultResourceCatalog();
	const pack = compileModePackDraft(customDraft({
		components: [
			{ type: "plugin", id: "learning-harness", required: true, enabled: true },
			{ type: "workflow", id: "teach-back", required: true, enabled: true },
			{ type: "skill", id: "missing.optional", required: false, enabled: true },
		],
	}), catalog);
	assert.equal(pack.components.some((item) => item.id === "missing.optional"), false);
	assert.equal(inspectModePackAvailability(pack, catalog).selectable, true);
});

test("uninstalled Visual Lab runtime tools remain an explicit availability failure", () => {
	const catalog = createDefaultResourceCatalog();
	const visual = createBuiltinModePacks(catalog)["visual-lab"];
	const availability = inspectModePackAvailability(visual, catalog);
	assert.equal(availability.selectable, false);
	assert.ok(availability.missingRequiredResources.includes("tool:create_visual_spec"));
});
