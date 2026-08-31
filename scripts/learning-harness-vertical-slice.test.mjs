import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import test from "node:test";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { RuntimeSessionHost } from "../packages/pi-runtime-host/src/index.ts";

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

function setStateWriteFailure(databasePath, enabled) {
	const database = new DatabaseSync(databasePath);
	try {
		if (enabled) {
			database.exec(`
				CREATE TRIGGER fail_learning_harness_state_write
				BEFORE UPDATE ON learning_harness_state
				BEGIN
					SELECT RAISE(ABORT, 'injected persistence failure');
				END;
			`);
		} else {
			database.exec("DROP TRIGGER fail_learning_harness_state_write");
		}
	} finally {
		database.close();
	}
}

if (process.env.LEARNING_HARNESS_RECOVERY_CHECK === "1") {
	const harness = new LearningHarness({ databasePath: process.env.LEARNING_HARNESS_DATABASE_PATH ?? "" });
	assert.equal(harness.getCurrentCourse("algebra-session").courseId, "algebra");
	assert.equal(harness.getCurrentCourse("biology-session").courseId, "biology");
	assert.equal(harness.getLearningProgress("algebra-session").concepts.variables.exposures, 1);
	assert.match(harness.searchCurrentCourse("algebra-session", "unknown variable", "2026-08-30T12:00:00.000Z").spans[0].text, /variable/iu);
	harness.close();
} else test("LearningHarness persists isolated current-course sessions and rejects forged citations", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-vertical-slice-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const databasePath = join(root, "learning-harness.sqlite");
	const firstSessionStore = new FakeSessionStore("algebra-session");
	const secondSessionStore = new FakeSessionStore("biology-session");
	const now = "2026-08-30T12:00:00.000Z";

	const harness = new LearningHarness({ databasePath });
	const algebra = await harness.publishCourseVersion(
		"algebra",
		[{ name: "algebra.md", kind: "markdown", mediaType: "text/markdown", content: "# Algebra\n\nA variable represents an unknown value." }],
		{ createdAt: now },
	);
	const biology = await harness.publishCourseVersion(
		"biology",
		[{ name: "biology.md", kind: "markdown", mediaType: "text/markdown", content: "# Biology\n\nCells are the basic unit of life." }],
		{ createdAt: now },
	);

	const algebraSession = harness.openStudentSession({ sessionStore: firstSessionStore, courseVersionId: algebra.courseVersionId, createdAt: now });
	const biologySession = harness.openStudentSession({ sessionStore: secondSessionStore, courseVersionId: biology.courseVersionId, createdAt: now });
	assert.equal(harness.getCurrentCourse(algebraSession.sessionId).courseId, "algebra");
	assert.equal(harness.getCurrentCourse(biologySession.sessionId).courseId, "biology");

	const algebraPacket = harness.searchCurrentCourse(algebraSession.sessionId, "unknown variable", now);
	const biologyPacket = harness.searchCurrentCourse(biologySession.sessionId, "cells life", now);
	assert.equal(algebraPacket.courseVersionId, algebra.courseVersionId);
	assert.equal(biologyPacket.courseVersionId, biology.courseVersionId);
	assert.match(harness.readCurrentCourseSpan(algebraSession.sessionId, algebraPacket.spans[0].spanId).text, /variable/iu);
	assert.throws(() => harness.readCurrentCourseSpan(algebraSession.sessionId, biologyPacket.spans[0].spanId), /not in course version/i);

	const forged = harness.validateCurrentDraft(
		algebraSession.sessionId,
		{
			version: 1,
			draftId: "forged-cross-course-citation",
			packetId: algebraPacket.packetId,
			courseVersionId: algebra.courseVersionId,
			claims: [{ claimId: "claim-1", text: "Cells are the basic unit of life.", scope: "direct", citationSpanIds: [biologyPacket.spans[0].spanId], reason: null }],
			createdAt: now,
			revision: 1,
		},
		now,
	);
	assert.equal(forged.status, "fail");
	assert.ok(forged.issues.some((issue) => issue.code === "FORGED_CITATION"));

	harness.recordLearningEvent(algebraSession.sessionId, {
		conceptId: "variables",
		kind: "introduced",
		payload: { source: "vertical-slice" },
		idempotencyKey: "algebra:variables:introduced",
		createdAt: now,
	});
	assert.equal(harness.getLearningProgress(algebraSession.sessionId).concepts.variables.exposures, 1);
	const storedSource = harness.readCourseSource(algebra.courseVersionId, algebra.materials[0].materialId);
	assert.equal(new TextDecoder().decode(storedSource.bytes), "# Algebra\n\nA variable represents an unknown value.");
	harness.close();
	execFileSync(process.execPath, [process.argv[1]], {
		cwd: new URL("..", import.meta.url),
		env: {
			...process.env,
			LEARNING_HARNESS_DATABASE_PATH: databasePath,
			LEARNING_HARNESS_RECOVERY_CHECK: "1",
		},
		stdio: "pipe",
	});

	const reopened = new LearningHarness({ databasePath });
	assert.equal(reopened.getCurrentCourse("algebra-session").courseVersionId, algebra.courseVersionId);
	assert.equal(reopened.getCurrentCourse("biology-session").courseVersionId, biology.courseVersionId);
	assert.equal(reopened.getLearningProgress("algebra-session").concepts.variables.exposures, 1);
	assert.match(reopened.searchCurrentCourse("algebra-session", "unknown variable", now).spans[0].text, /variable/iu);
	assert.equal(reopened.reconcileRuntimeSession(firstSessionStore)?.binding.bindingId, algebraSession.binding.bindingId);
	assert.throws(
		() => reopened.reconcileRuntimeSession(new FakeSessionStore("algebra-session")),
		/RUNTIME_BINDING_MISMATCH|expected Harness binding|no inherited Harness binding/,
	);
	const injectedAncestor = new FakeSessionStore("algebra-session");
	injectedAncestor.entries = structuredClone(firstSessionStore.entries);
	injectedAncestor.entries[1].data.entry.data = {
		...algebraSession.binding,
		bindingId: "injected-ancestor-binding",
		sessionId: "unknown-ancestor-session",
	};
	assert.throws(
		() => reopened.reconcileRuntimeSession(injectedAncestor),
		/known durable Harness ancestor binding/,
	);
	assert.throws(
		() => reopened.inheritStudentSession({
			parentSessionStore: firstSessionStore,
			childSessionStore: new FakeSessionStore("missing-ancestor-child"),
			createdAt: now,
		}),
		/no inherited Harness ancestor binding/,
	);
	assert.equal(reopened.openStudentSession({ sessionStore: firstSessionStore, courseVersionId: algebra.courseVersionId, createdAt: now }).binding.bindingId, algebraSession.binding.bindingId);
	assert.equal(firstSessionStore.entries.length, 2);
	reopened.close();

	const missingDatabase = new LearningHarness({ databasePath: join(root, "missing-state.sqlite") });
	assert.throws(
		() => missingDatabase.reconcileRuntimeSession(firstSessionStore),
		/PERSISTED_SESSION_MISSING|no durable Harness state/,
	);
	missingDatabase.close();
});

if (process.env.LEARNING_HARNESS_RECOVERY_CHECK !== "1") {
	test("LearningHarness keeps one Pi session while warm-switching student and practice profiles", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-profile-switch-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const databasePath = join(root, "learning-harness.sqlite");
		const store = new FakeSessionStore("profile-session");
		const harness = new LearningHarness({ databasePath });
		const course = await harness.publishCourseVersion(
			"profile-course",
			[{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Course\n\nEvidence." }],
			{ createdAt: "2026-08-30T16:00:00.000Z" },
		);
		const opened = harness.openStudentSession({
			sessionStore: store,
			courseVersionId: course.courseVersionId,
			createdAt: "2026-08-30T16:00:00.000Z",
		});
		const practice = harness.prepareProfileTransition({
			sessionId: opened.sessionId,
			targetProfileId: "practice",
			expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "switch-to-practice",
			createdAt: "2026-08-30T16:00:01.000Z",
		});
		assert.notEqual(practice.snapshot.resourceSnapshotId, opened.snapshot.resourceSnapshotId);
		assert.equal(harness.prepareProfileTransition({
			sessionId: opened.sessionId,
			targetProfileId: "practice",
			expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "switch-to-practice",
		}).snapshot.resourceSnapshotId, practice.snapshot.resourceSnapshotId);
		const inPractice = harness.commitPreparedProfileTransition(store, opened.sessionId, "switch-to-practice");
		assert.equal(inPractice.sessionId, opened.sessionId);
		assert.equal(inPractice.snapshot.profileId, "practice");
		assert.equal(inPractice.binding.revision, 2);
		assert.equal(harness.prepareProfileTransition({
			sessionId: opened.sessionId,
			targetProfileId: "practice",
			expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "switch-to-practice",
		}).snapshot.resourceSnapshotId, practice.snapshot.resourceSnapshotId);
		const learn = harness.prepareProfileTransition({
			sessionId: opened.sessionId,
			targetProfileId: "student-learn",
			expectedSnapshotId: inPractice.snapshot.resourceSnapshotId,
			idempotencyKey: "switch-to-learn",
			createdAt: "2026-08-30T16:00:02.000Z",
		});
		const restored = harness.commitPreparedProfileTransition(store, opened.sessionId, "switch-to-learn");
		assert.equal(restored.snapshot.profileId, "student-learn");
		assert.notEqual(restored.snapshot.resourceSnapshotId, opened.snapshot.resourceSnapshotId);
		assert.notEqual(restored.snapshot.resourceSnapshotId, practice.snapshot.resourceSnapshotId);
		assert.equal(restored.binding.revision, 3);
		assert.equal(store.entries.length, 6);
		assert.throws(() => harness.prepareProfileTransition({
			sessionId: opened.sessionId,
			targetProfileId: "practice",
			expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "stale-switch",
		}), /active resource snapshot changed/i);
		assert.equal(harness.availableProfiles(opened.sessionId).find((item) => item.profileId === "visual-lab")?.selectable, false);
		harness.close();

		const reopened = new LearningHarness({ databasePath });
		const recovered = reopened.reconcileRuntimeSession(store);
		assert.equal(recovered?.sessionId, opened.sessionId);
		assert.equal(recovered?.snapshot.resourceSnapshotId, restored.snapshot.resourceSnapshotId);
		assert.equal(recovered?.binding.revision, 3);
		reopened.close();
	});

	test("profile recovery aborts an uncommitted pending snapshot and finishes a journal-ahead snapshot", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-profile-recovery-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const databasePath = join(root, "learning-harness.sqlite");
		const store = new FakeSessionStore("profile-recovery-session");
		let harness = new LearningHarness({ databasePath });
		const course = await harness.publishCourseVersion("recovery-course", [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Recovery" }], { createdAt: "2026-08-30T17:00:00.000Z" });
		const opened = harness.openStudentSession({ sessionStore: store, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T17:00:00.000Z" });
		const abandoned = harness.prepareProfileTransition({
			sessionId: opened.sessionId, targetProfileId: "practice", expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "abandoned", createdAt: "2026-08-30T17:00:01.000Z",
		});
		harness.close();
		harness = new LearningHarness({ databasePath });
		assert.equal(harness.reconcileRuntimeSession(store)?.pendingProfileTransition, null);
		assert.equal(harness.findCurrentSession(opened.sessionId)?.snapshot.resourceSnapshotId, opened.snapshot.resourceSnapshotId);
		assert.equal(harness.prepareProfileTransition({
			sessionId: opened.sessionId, targetProfileId: "practice", expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "retry-after-abort", createdAt: "2026-08-30T17:00:02.000Z",
		}).targetProfileId, "practice");
		harness.abortPreparedProfileTransition(opened.sessionId, "retry-after-abort", opened.snapshot.resourceSnapshotId);

		const ahead = harness.prepareProfileTransition({
			sessionId: opened.sessionId, targetProfileId: "practice", expectedSnapshotId: opened.snapshot.resourceSnapshotId,
			idempotencyKey: "journal-ahead", createdAt: "2026-08-30T17:00:03.000Z",
		});
		const runtime = new RuntimeSessionHost(store);
		runtime.recordResourceSnapshot({
			version: ahead.snapshot.version, resourceSnapshotId: ahead.snapshot.resourceSnapshotId,
			profileId: ahead.snapshot.profileId, profileRevision: ahead.snapshot.profileRevision,
			courseVersionId: ahead.snapshot.courseVersionId, contentHash: ahead.snapshot.contentHash, createdAt: ahead.snapshot.createdAt,
		}, `resource-snapshot:${ahead.snapshot.resourceSnapshotId}`);
		runtime.recordSessionBinding({
			...opened.binding, resourceSnapshotId: ahead.snapshot.resourceSnapshotId, revision: opened.binding.revision + 1,
		}, `session-binding:${opened.binding.bindingId}:revision:${opened.binding.revision + 1}`);
		harness.close();
		harness = new LearningHarness({ databasePath });
		const recovered = harness.reconcileRuntimeSession(store);
		assert.equal(recovered?.snapshot.resourceSnapshotId, ahead.snapshot.resourceSnapshotId);
		assert.equal(recovered?.binding.revision, 2);
		assert.equal(recovered?.pendingProfileTransition, null);
		harness.close();
	});

	test("LearningHarness rejects all live work after a rolled-back persistence failure", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-persistence-failure-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const databasePath = join(root, "learning-harness.sqlite");
		const now = "2026-08-30T15:00:00.000Z";
		const harness = new LearningHarness({ databasePath });
		const durable = await harness.publishCourseVersion(
			"durable-course",
			[{ name: "durable.md", kind: "markdown", mediaType: "text/markdown", content: "# Durable\n\nCommitted source." }],
			{ createdAt: now },
		);
		setStateWriteFailure(databasePath, true);
		await assert.rejects(
			() => harness.publishCourseVersion(
				"rolled-back-course",
				[{ name: "rolled-back.md", kind: "markdown", mediaType: "text/markdown", content: "# Rolled back" }],
				{ createdAt: now },
			),
			/injected persistence failure/i,
		);
		assert.throws(() => harness.listCourses(), /unavailable after a persistence failure/i);
		harness.close();

		setStateWriteFailure(databasePath, false);
		const reopened = new LearningHarness({ databasePath });
		assert.deepEqual(reopened.listCourses().map((course) => course.courseId), ["durable-course"]);
		assert.equal(
			new TextDecoder().decode(reopened.readCourseSource(durable.courseVersionId, durable.materials[0].materialId).bytes),
			"# Durable\n\nCommitted source.",
		);
		reopened.close();
	});

	test("LearningHarness fails closed when Pi journal binding succeeds but session persistence rolls back", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-session-failure-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const databasePath = join(root, "learning-harness.sqlite");
		const now = "2026-08-30T15:10:00.000Z";
		const harness = new LearningHarness({ databasePath });
		const course = await harness.publishCourseVersion(
			"session-course",
			[{ name: "session.md", kind: "markdown", mediaType: "text/markdown", content: "# Session" }],
			{ createdAt: now },
		);
		const sessionStore = new FakeSessionStore("failed-session");
		setStateWriteFailure(databasePath, true);
		assert.throws(
			() => harness.openStudentSession({ sessionStore, courseVersionId: course.courseVersionId, createdAt: now }),
			/injected persistence failure/i,
		);
		assert.equal(sessionStore.entries.length, 2);
		assert.throws(() => harness.findCurrentSession("failed-session"), /unavailable after a persistence failure/i);
		harness.close();

		setStateWriteFailure(databasePath, false);
		const reopened = new LearningHarness({ databasePath });
		assert.throws(
			() => reopened.reconcileRuntimeSession(sessionStore),
			/PERSISTED_SESSION_MISSING|no durable Harness state/,
		);
		reopened.close();
	});

	test("LearningHarness poisons live state when BEGIN IMMEDIATE loses a write lock", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pi-learning-harness-lock-contention-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const databasePath = join(root, "learning-harness.sqlite");
		const now = "2026-08-30T15:20:00.000Z";
		const harness = new LearningHarness({ databasePath });
		const course = await harness.publishCourseVersion(
			"locked-course",
			[{ name: "locked.md", kind: "markdown", mediaType: "text/markdown", content: "# Locked\n\nState must not commit." }],
			{ createdAt: now },
		);
		const sessionStore = new FakeSessionStore("locked-session");
		harness.openStudentSession({ sessionStore, courseVersionId: course.courseVersionId, createdAt: now });
		const locker = new DatabaseSync(databasePath);
		locker.exec("PRAGMA busy_timeout = 0");
		locker.exec("BEGIN IMMEDIATE");
		try {
			assert.throws(() => harness.searchCurrentCourse("locked-session", "state", now), /database is locked/i);
		} finally {
			locker.exec("ROLLBACK");
			locker.close();
		}
		assert.throws(() => harness.reconcileRuntimeSession(sessionStore), /unavailable after a persistence failure/i);
		harness.close();

		const reopened = new LearningHarness({ databasePath });
		assert.equal(reopened.knowledgeHost.exportState().packets.length, 0);
		assert.equal(reopened.reconcileRuntimeSession(sessionStore)?.binding.sessionId, "locked-session");
		reopened.close();
	});
}
