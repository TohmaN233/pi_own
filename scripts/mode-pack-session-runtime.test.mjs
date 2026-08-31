import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BUILTIN_MODE_PACKS,
	resolveModePack,
} from "../packages/profile-resource-host/src/mode-packs.ts";
import {
	activeModePackBinding,
	appendModePackBinding,
	createModePackSessionBinding,
	ModePackSessionStore,
	parseModePackSessionBinding,
	readModePackBindingLineage,
} from "../apps/pi-web/lib/mode-pack-session-store.ts";

class FakeSessionManager {
	constructor(sessionId, entries = []) {
		this.sessionId = sessionId;
		this.entries = structuredClone(entries);
	}

	getSessionId() {
		return this.sessionId;
	}

	getEntries() {
		return structuredClone(this.entries);
	}

	appendCustomEntry(customType, data) {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ type: "custom", id, customType, data: structuredClone(data) });
		return id;
	}
}

function resolved(definition) {
	return resolveModePack(definition, {
		skills: new Set([...definition.skills.required, ...definition.skills.optional]),
		plugins: new Set([...definition.plugins.required, ...definition.plugins.optional]),
		packages: new Set([...definition.packages.required, ...definition.packages.optional]),
		tools: new Set(definition.allowedTools),
		workflows: new Set(definition.workflows),
	});
}

function receipt(definition, verifiedAt) {
	const mode = resolved(definition);
	return {
		modePackId: definition.id,
		revision: definition.revision,
		contentHash: mode.contentHash,
		effectivePromptHash: mode.effectivePromptHash,
		loaded: structuredClone(mode.loaded),
		verifiedAt,
	};
}

test("Mode Pack JSONL binding is authoritative across warm commits and SQLite recovery", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-own-mode-binding-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new ModePackSessionStore(join(root, "mode-packs.sqlite"));
	t.after(() => store.close());
	const manager = new FakeSessionManager("session-a");
	const tutorDefinition = BUILTIN_MODE_PACKS["education-tutor"];
	const practiceDefinition = BUILTIN_MODE_PACKS["education-practice"];
	assert.ok(tutorDefinition && practiceDefinition);

	const tutor = createModePackSessionBinding({
		sessionId: manager.getSessionId(),
		definition: tutorDefinition,
		contextBinding: "course-v1",
		receipt: receipt(tutorDefinition, "2026-08-31T20:00:00.000Z"),
		activatedAt: "2026-08-31T20:00:00.000Z",
	});
	store.stage(tutor, null);
	appendModePackBinding(manager, tutor);
	store.commitStaged(tutor.sessionId, tutor.revision);
	assert.deepEqual(activeModePackBinding(manager), tutor);
	assert.deepEqual(store.latest(tutor.sessionId), tutor);

	const practice = createModePackSessionBinding({
		sessionId: manager.getSessionId(),
		current: tutor,
		definition: practiceDefinition,
		contextBinding: "course-v1",
		receipt: receipt(practiceDefinition, "2026-08-31T20:00:01.000Z"),
		activatedAt: "2026-08-31T20:00:01.000Z",
	});
	store.stage(practice, tutor.revision);
	appendModePackBinding(manager, practice);
	store.commitStaged(practice.sessionId, practice.revision);
	assert.deepEqual(store.history(manager.getSessionId()), [tutor, practice]);

	const stagedOnly = createModePackSessionBinding({
		sessionId: manager.getSessionId(),
		current: practice,
		definition: tutorDefinition,
		contextBinding: "course-v1",
		receipt: receipt(tutorDefinition, "2026-08-31T20:00:02.000Z"),
		activatedAt: "2026-08-31T20:00:02.000Z",
	});
	store.stage(stagedOnly, practice.revision);
	assert.equal(store.latest(manager.getSessionId(), true)?.revision, 3);
	assert.deepEqual(store.reconcile(manager), practice);
	assert.equal(store.latest(manager.getSessionId(), true)?.revision, 2);

	appendModePackBinding(manager, stagedOnly);
	assert.deepEqual(store.reconcile(manager), stagedOnly);
	assert.deepEqual(store.history(manager.getSessionId()), [tutor, practice, stagedOnly]);
});

test("A hard transition starts a child binding and preserves parent lineage", () => {
	const tutorDefinition = BUILTIN_MODE_PACKS["education-tutor"];
	const codingDefinition = BUILTIN_MODE_PACKS.coding;
	assert.ok(tutorDefinition && codingDefinition);
	const parent = new FakeSessionManager("session-parent");
	const tutor = createModePackSessionBinding({
		sessionId: parent.getSessionId(),
		definition: tutorDefinition,
		contextBinding: "course-v1",
		receipt: receipt(tutorDefinition, "2026-08-31T20:10:00.000Z"),
		activatedAt: "2026-08-31T20:10:00.000Z",
	});
	appendModePackBinding(parent, tutor);

	const child = new FakeSessionManager("session-child", parent.getEntries());
	const coding = createModePackSessionBinding({
		sessionId: child.getSessionId(),
		parentSessionId: parent.getSessionId(),
		definition: codingDefinition,
		contextBinding: "/workspace/project",
		receipt: receipt(codingDefinition, "2026-08-31T20:10:01.000Z"),
		activatedAt: "2026-08-31T20:10:01.000Z",
	});
	appendModePackBinding(child, coding);
	assert.deepEqual(readModePackBindingLineage(child), [tutor, coding]);
	assert.deepEqual(activeModePackBinding(child), coding);
	assert.equal(coding.revision, 1);
	assert.equal(coding.parentSessionId, parent.getSessionId());
});

test("Binding parsing rejects a forged activation receipt", () => {
	const definition = BUILTIN_MODE_PACKS.general;
	assert.ok(definition);
	const binding = createModePackSessionBinding({
		sessionId: "session-forged",
		definition,
		contextBinding: null,
		receipt: receipt(definition, "2026-08-31T20:20:00.000Z"),
		activatedAt: "2026-08-31T20:20:00.000Z",
	});
	assert.throws(
		() => parseModePackSessionBinding({
			...binding,
			receipt: { ...binding.receipt, contentHash: `sha256:${"0".repeat(64)}` },
		}),
		/BINDING_RECEIPT_MISMATCH|different Mode Packs/,
	);
});
