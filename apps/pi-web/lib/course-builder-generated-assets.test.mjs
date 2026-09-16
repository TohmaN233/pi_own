import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { importCourseGeneratedAsset } = await jiti.import("./course-builder-generated-assets.ts");
const { CourseBuilderHost } = await jiti.import("../../../packages/course-builder-host/src/index.ts");

const projectInput = {
	courseId: "generated-assets-course",
	title: "Generated assets fixture",
	weeks: 1,
	sessionsPerWeek: 2,
	minutesPerSession: 50,
	audience: "Students",
	language: "English",
	goals: ["Explain generated figures"],
	beamerProfile: {
		aspectRatio: "169",
		fontSize: 11,
		theme: "default",
		author: "Teacher",
		institute: "",
		language: "English",
		overlayPolicy: "allow",
		referencesPolicy: "optional",
		backupSlides: 0,
		speakerNotes: false,
		preamble: null,
	},
};

function hash(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture(t, name = "fixture") {
	const root = await mkdtemp(join(tmpdir(), `pi-course-generated-${name}-`));
	const cwd = join(root, "course");
	const database = new DatabaseSync(":memory:");
	await mkdir(join(cwd, ".pi", "course-builder"), { recursive: true });
	const host = new CourseBuilderHost(database);
	const project = host.createProject(projectInput);
	const sessionId = `teacher-${crypto.randomUUID()}`;
	host.bindSession(sessionId, project.projectId);
	const semester = host.saveSemesterPlan(sessionId, {
		title: "Generated asset semester",
		rationale: "A bounded fixture for generated assets",
		sessions: [{
			week: 1,
			session: 1,
			title: "Generated asset lesson",
			objectives: projectInput.goals,
			prerequisites: [],
			topics: ["Generated figures"],
			materialIds: [],
			activities: ["Inspect a generated figure"],
			understandingEvidence: ["Explain the figure"],
			assessment: null,
			homework: null,
			courseGoalsCovered: projectInput.goals,
			revisits: [],
			visualOpportunities: [],
		}, {
			week: 1,
			session: 2,
			title: "Generated asset follow-up",
			objectives: projectInput.goals,
			prerequisites: [],
			topics: ["Generated figures"],
			materialIds: [],
			activities: ["Compare generated figures"],
			understandingEvidence: ["Explain the comparison"],
			assessment: null,
			homework: null,
			courseGoalsCovered: projectInput.goals,
			revisits: [],
			visualOpportunities: [],
		}],
	}, 0);
	host.reviewSemesterPlan(sessionId, semester.semesterPlanId, 1, "approve", "Fixture approval");
	const lesson = host.saveLessonPlan(sessionId, {
		week: 1,
		session: 1,
		title: "Generated asset lesson",
		objectives: projectInput.goals,
		prerequisites: [],
		misconceptions: [],
		segments: [{ minutes: 20, title: "Figure", teacherAction: "Ask", learnerAction: "Explain", checkForUnderstanding: "Reason" }],
		examples: [],
		exercises: [],
		materialIds: [],
		visualRequests: [],
		notes: [],
	}, 0, 1);
	host.reviewLessonPlan(sessionId, lesson.lessonPlanId, 1, "approve", "Fixture approval");
	const otherLesson = host.saveLessonPlan(sessionId, {
		week: 1,
		session: 2,
		title: "Generated asset follow-up",
		objectives: projectInput.goals,
		prerequisites: [],
		misconceptions: [],
		segments: [{ minutes: 20, title: "Comparison", teacherAction: "Ask", learnerAction: "Explain", checkForUnderstanding: "Reason" }],
		examples: [],
		exercises: [],
		materialIds: [],
		visualRequests: [],
		notes: [],
	}, 0, 1);
	host.reviewLessonPlan(sessionId, otherLesson.lessonPlanId, 1, "approve", "Fixture approval");
	const outputDirectory = join(cwd, ".pi", "course-builder", project.projectId);
	await mkdir(outputDirectory, { recursive: true });
	t.after(async () => {
		database.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, cwd, host, project, lesson, otherLesson, sessionId, outputDirectory };
}

function pngBytes() {
	return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
}

test("imports PNG/JPEG/PDF bytes with byte fidelity and source provenance", async (t) => {
	const f = await fixture(t, "formats");
	const formats = [
		["plot-with-wrong-extension.txt", pngBytes(), "png"],
		["scatter.png", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]), "jpg"],
		["report.jpg", new TextEncoder().encode("%PDF-1.7\nfixture\n%%EOF\n"), "pdf"],
	];
	const sourcePath = join(f.outputDirectory, "analysis.Rmd");
	const sourceBytes = new TextEncoder().encode("# Generated figure\nplot(x, y)\n");
	await writeFile(sourcePath, sourceBytes);
	let expectedRevision = f.project.revision;
	for (const [fileName, bytes, extension] of formats) {
		const assetPath = join(f.outputDirectory, fileName);
		await writeFile(assetPath, bytes);
		const imported = await importCourseGeneratedAsset(
			f.host,
			f.sessionId,
			f.cwd,
			{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, sourcePath, purpose: "Show the simulated result" },
			expectedRevision,
		);
		assert.equal(imported.extension, extension);
		assert.match(imported.beamerPath, new RegExp(`^assets/${imported.materialId}\\.${extension}$`, "u"));
		assert.equal(imported.sourceHash, hash(bytes));
		assert.equal(imported.provenance.sourceHash, hash(sourceBytes));
		assert.equal(imported.provenance.sourcePath, await realpath(sourcePath));
		assert.equal(imported.provenance.sourceRelativePath, "analysis.Rmd");
		assert.equal(imported.replay, false);
		assert.equal(imported.projectRevision, expectedRevision + 1);
		assert.deepEqual([...f.host.getMaterialBytes(f.sessionId, imported.materialId)], [...bytes]);
		const material = f.host.getMaterial(f.sessionId, imported.materialId);
		assert.equal(material.kind, "asset");
		assert.equal(material.metadata.storage, "generated");
		assert.equal(material.metadata.materialScope, "course");
		assert.equal(material.metadata.lessonPlanId, f.lesson.lessonPlanId);
		assert.equal(material.metadata.purpose, "Show the simulated result");
		assert.equal(material.metadata.sourceHash, hash(sourceBytes));
		assert.equal(material.metadata.provenance.sourceHash, hash(sourceBytes));
		expectedRevision += 1;
	}
});

test("replays the same generated bytes for a lesson without a revision increment", async (t) => {
	const f = await fixture(t, "replay");
	const bytes = pngBytes();
	const assetPath = join(f.outputDirectory, "figure.any");
	await writeFile(assetPath, bytes);
	const first = await importCourseGeneratedAsset(
		f.host,
		f.sessionId,
		f.cwd,
		{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, purpose: "Explain replay" },
		f.project.revision,
	);
	const replay = await importCourseGeneratedAsset(
		f.host,
		f.sessionId,
		f.cwd,
		{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, purpose: "A changed purpose is ignored on replay" },
		f.project.revision,
	);
	assert.equal(replay.replay, true);
	assert.equal(replay.materialId, first.materialId);
	assert.equal(replay.beamerPath, first.beamerPath);
	assert.equal(replay.sourceHash, first.sourceHash);
	assert.equal(replay.projectRevision, first.projectRevision);
	assert.equal(f.host.getProject(f.project.projectId).revision, first.projectRevision);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 1);

	const secondLesson = await importCourseGeneratedAsset(
		f.host,
		f.sessionId,
		f.cwd,
		{ path: assetPath, lessonPlanId: f.otherLesson.lessonPlanId, purpose: "Reuse the bytes in a second lesson" },
		first.projectRevision,
	);
	assert.equal(secondLesson.replay, false);
	assert.notEqual(secondLesson.materialId, first.materialId);
	assert.equal(secondLesson.projectRevision, first.projectRevision + 1);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 2);
});

test("rejects traversal and cross-course generated paths before importing", async (t) => {
	const f = await fixture(t, "paths");
	const outsidePath = join(f.root, "outside.png");
	await writeFile(outsidePath, pngBytes());
	await assert.rejects(
		importCourseGeneratedAsset(
			f.host,
			f.sessionId,
			f.cwd,
			{ path: relative(f.cwd, outsidePath), lessonPlanId: f.lesson.lessonPlanId, purpose: "Path boundary" },
			f.project.revision,
		),
		/outside this course's owned generated output directory/u,
	);

	const otherProjectPath = join(f.cwd, ".pi", "course-builder", "other-project");
	await mkdir(otherProjectPath, { recursive: true });
	const crossCourseAsset = join(otherProjectPath, "foreign.png");
	await writeFile(crossCourseAsset, pngBytes());
	await assert.rejects(
		importCourseGeneratedAsset(
			f.host,
			f.sessionId,
			f.cwd,
			{ path: crossCourseAsset, lessonPlanId: f.lesson.lessonPlanId, purpose: "Path boundary" },
			f.project.revision,
		),
		/outside this course's owned generated output directory/u,
	);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 0);
});

test("rejects invalid image bytes, missing files, and directories clearly", async (t) => {
	const f = await fixture(t, "invalid");
	const invalidPath = join(f.outputDirectory, "not-really.png");
	await writeFile(invalidPath, new TextEncoder().encode("plain text"));
	const spec = (path) => ({ path, lessonPlanId: f.lesson.lessonPlanId, purpose: "Invalid input" });
	await assert.rejects(
		importCourseGeneratedAsset(f.host, f.sessionId, f.cwd, spec(invalidPath), f.project.revision),
		/unsupported.*PNG.*JPEG.*PDF/iu,
	);
	await assert.rejects(
		importCourseGeneratedAsset(f.host, f.sessionId, f.cwd, spec(join(f.outputDirectory, "missing.png")), f.project.revision),
		/Generated asset is unavailable/iu,
	);
	const directoryPath = join(f.outputDirectory, "directory");
	await mkdir(directoryPath);
	await assert.rejects(
		importCourseGeneratedAsset(f.host, f.sessionId, f.cwd, spec(directoryPath), f.project.revision),
		/Generated asset must be a file/iu,
	);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 0);
});

test("checks a stale project revision and the asynchronous runtime assertion before commit", async (t) => {
	const f = await fixture(t, "revision");
	const assetPath = join(f.outputDirectory, "figure.png");
	await writeFile(assetPath, pngBytes());
	const changed = f.host.updateProject(f.project.projectId, { ...projectInput, title: "Concurrent edit" }, f.project.revision);
	await assert.rejects(
		importCourseGeneratedAsset(
			f.host,
			f.sessionId,
			f.cwd,
			{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, purpose: "Concurrent edit" },
			f.project.revision,
		),
		/Expected project revision 1, actual 2/iu,
	);
	assert.equal(f.host.getProject(f.project.projectId).revision, changed.revision);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 0);

	let asserted = false;
	await assert.rejects(
		importCourseGeneratedAsset(
			f.host,
			f.sessionId,
			f.cwd,
			{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, purpose: "Runtime assertion" },
			changed.revision,
			async () => {
				asserted = true;
				await Promise.resolve();
				throw new Error("runtime is no longer active");
			},
		),
		/runtime is no longer active/iu,
	);
	assert.equal(asserted, true);
	assert.equal(f.host.getProject(f.project.projectId).revision, changed.revision);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 0);
});

test("rejects generated imports while an Assignment scope is active", async (t) => {
	const f = await fixture(t, "assignment");
	const assetPath = join(f.outputDirectory, "figure.png");
	await writeFile(assetPath, pngBytes());
	const assignment = f.host.createAssignment(f.sessionId, { title: "Homework", brief: "Use isolated evidence" });
	f.host.setAgentAssignmentScope(f.sessionId, assignment.assignmentId);
	await assert.rejects(
		importCourseGeneratedAsset(
			f.host,
			f.sessionId,
			f.cwd,
			{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, purpose: "Must be denied" },
			f.project.revision,
		),
		/Assignment/iu,
	);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 0);
});

test("requires bounded UTF-8 source provenance and never executes it", async (t) => {
	const f = await fixture(t, "source");
	const assetPath = join(f.outputDirectory, "figure.png");
	await writeFile(assetPath, pngBytes());
	const sourcePath = join(f.outputDirectory, "analysis.py");
	await writeFile(sourcePath, Uint8Array.from([0xff, 0xfe, 0x00]));
	await assert.rejects(
		importCourseGeneratedAsset(
			f.host,
			f.sessionId,
			f.cwd,
			{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, sourcePath, purpose: "Source provenance" },
			f.project.revision,
		),
		/valid UTF-8/iu,
	);
	assert.equal(f.host.getSnapshotForSession(f.sessionId).materials.length, 0);
	assert.deepEqual([...await readFile(assetPath)], [...pngBytes()]);

	const firstSource = new TextEncoder().encode("print('first source')\n");
	await writeFile(sourcePath, firstSource);
	const first = await importCourseGeneratedAsset(
		f.host,
		f.sessionId,
		f.cwd,
		{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, sourcePath, purpose: "Source provenance" },
		f.project.revision,
	);
	const changedSource = new TextEncoder().encode("print('changed source')\n");
	await writeFile(sourcePath, changedSource);
	const second = await importCourseGeneratedAsset(
		f.host,
		f.sessionId,
		f.cwd,
		{ path: assetPath, lessonPlanId: f.lesson.lessonPlanId, sourcePath, purpose: "Source provenance" },
		first.projectRevision,
	);
	assert.equal(second.replay, false);
	assert.notEqual(second.materialId, first.materialId);
	assert.equal(second.projectRevision, first.projectRevision + 1);
	assert.equal(f.host.getMaterial(f.sessionId, first.materialId).metadata.sourceHash, hash(firstSource));
	assert.equal(f.host.getMaterial(f.sessionId, second.materialId).metadata.sourceHash, hash(changedSource));
});
