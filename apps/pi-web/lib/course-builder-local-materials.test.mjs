import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { scanCourseBuilderDirectory, readLinkedCourseBuilderMaterial } = await jiti.import("./course-builder-local-materials.ts");
const { CourseBuilderHost, courseBuilderView, runCourseBuilderCommand } = await jiti.import("../../../packages/course-builder-host/src/index.ts");

const projectInput = {
	courseId: "linked-course",
	title: "Linked course",
	weeks: 1,
	sessionsPerWeek: 1,
	minutesPerSession: 50,
	audience: "Students",
	language: "Chinese",
	goals: ["Understand the material"],
	beamerProfile: { aspectRatio: "169", fontSize: 11, theme: "default", author: "Teacher", institute: "", language: "Chinese", overlayPolicy: "allow", referencesPolicy: "optional", backupSlides: 0, speakerNotes: false, preamble: null },
};

test("local folder binding indexes every file but reads content only on demand", async () => {
	const root = join(tmpdir(), `pi-course-materials-${crypto.randomUUID()}`);
	try {
		await mkdir(join(root, "week-01"), { recursive: true });
		await writeFile(join(root, "week-01", "lesson.md"), "# 第一课");
		await writeFile(join(root, "week-01", "notes.docx"), Uint8Array.of(0, 1, 2, 3));
		const materials = await scanCourseBuilderDirectory(root);
		assert.deepEqual(materials.map((item) => item.name), ["week-01/lesson.md", "week-01/notes.docx"]);
		assert.ok(materials.every((item) => item.extractedText === ""));
		assert.ok(materials.every((item) => item.sourceBytes.byteLength < 1024));
		assert.equal(materials[1].kind, "asset");
		const text = await readLinkedCourseBuilderMaterial(materials[0]);
		assert.equal(text, "# 第一课");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("linked binary material stays addressable when no text adapter exists", async () => {
	const root = join(tmpdir(), `pi-course-materials-${crypto.randomUUID()}`);
	try {
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "source.weird"), Uint8Array.of(0, 255, 0, 255));
		const [material] = await scanCourseBuilderDirectory(root);
		assert.match(await readLinkedCourseBuilderMaterial(material), /no text adapter/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("adding reference questions to a linked folder preserves an approved semester and permits lesson planning", async () => {
  const root = join(tmpdir(), `pi-course-planning-${crypto.randomUUID()}`);
  const database = new DatabaseSync(":memory:");
  try {
    await mkdir(root);
    await writeFile(join(root, "notes.md"), "Course notes");
    const host = new CourseBuilderHost(database);
    const project = host.createProject(projectInput);
    host.bindSession("teacher", project.projectId);
    const [material] = host.syncLocalMaterials("teacher", root, await scanCourseBuilderDirectory(root), 1);
    const plan = host.saveSemesterPlan("teacher", { title: "Existing outline", rationale: "Teach then practise", sessions: [{ week: 1, session: 1, title: "First class", objectives: projectInput.goals, prerequisites: [], topics: ["Basics"], materialIds: [material.materialId], activities: ["Practise"], understandingEvidence: ["Explain"], assessment: null, homework: null, courseGoalsCovered: projectInput.goals, revisits: [], visualOpportunities: [] }] }, 0);
    const approved = host.reviewSemesterPlan("teacher", plan.semesterPlanId, 1, "approve", "Teacher approved this outline");
    await writeFile(join(root, "extra-questions.md"), "Additional reference questions");
    host.syncLocalMaterials("teacher", root, await scanCourseBuilderDirectory(root), 2);
    const reopened = new CourseBuilderHost(database);
    assert.deepEqual(reopened.getSnapshotForSession("teacher").semesterPlan, approved);
    const question = reopened.getSnapshotForSession("teacher").materials.find((item) => item.name === "extra-questions.md");
    assert.equal(await readLinkedCourseBuilderMaterial(question), "Additional reference questions");
    const lesson = reopened.saveLessonPlan("teacher", { week: 1, session: 1, title: "Use the extra question", objectives: projectInput.goals, prerequisites: [], misconceptions: [], segments: [{ minutes: 40, title: "Practice", teacherAction: "Guide", learnerAction: "Solve", checkForUnderstanding: "Explain" }], examples: [], exercises: ["Extra question"], materialIds: [question.materialId], visualRequests: [], notes: [] }, 0, 1);
    assert.equal(lesson.revision, 1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Assignment scans carry an explicit material scope in the persisted link marker", async () => {
	const root = join(tmpdir(), `pi-assignment-materials-${crypto.randomUUID()}`);
	try {
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "questions.md"), "Solve the problem");
		const [material] = await scanCourseBuilderDirectory(root, {
			kind: "assignment",
			assignmentId: "assignment-1",
			assignmentTitle: "Homework 1",
		});
		assert.equal(material.metadata.materialScope, "assignment");
		assert.equal(material.metadata.assignmentId, "assignment-1");
		assert.equal(material.metadata.assignmentTitle, "Homework 1");
		assert.match(Buffer.from(material.sourceBytes).toString("utf8"), /"materialScope":"assignment"/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Course Builder persists only the local link record and resolves text through bounded read_material", async () => {
	const root = join(tmpdir(), `pi-course-materials-${crypto.randomUUID()}`);
	const database = new DatabaseSync(":memory:");
	try {
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "lesson.md"), "local-only lesson body");
		const host = new CourseBuilderHost(database);
		const project = host.createProject(projectInput);
		host.bindSession("teacher", project.projectId);
		const [material] = host.importMaterials("teacher", await scanCourseBuilderDirectory(root), 1);
		const stored = database.prepare("SELECT bytes FROM course_builder_source WHERE material_id = ?").get(material.materialId);
		assert.doesNotMatch(Buffer.from(stored.bytes).toString("utf8"), /local-only lesson body/u);
		const result = await runCourseBuilderCommand(host, "teacher", { action: "read_material", id: material.materialId, limit: 10 }, { readLinkedMaterial: readLinkedCourseBuilderMaterial });
		assert.equal(result.text, "local-only");
		assert.equal(result.nextOffset, 10);
		await writeFile(join(root, "lesson.md"), "changed body");
		await assert.rejects(readLinkedCourseBuilderMaterial(material), /changed on disk/u);
		const [refreshed] = host.syncLocalMaterials("teacher", root, await scanCourseBuilderDirectory(root), 2);
		assert.equal(refreshed.materialId, material.materialId, "same-path material identity remains stable across reindexing");
		assert.equal(await readLinkedCourseBuilderMaterial(refreshed), "changed body");
		assert.equal(host.getProject(project.projectId).revision, 3);
	} finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Assignment workflows isolate folders, reads, revisions, drafts and teacher review", async () => {
	const root = join(tmpdir(), `pi-course-scope-${crypto.randomUUID()}`);
	const assignmentRoot = join(tmpdir(), `pi-assignment-a-${crypto.randomUUID()}`);
	const otherRoot = join(tmpdir(), `pi-assignment-b-${crypto.randomUUID()}`);
	const database = new DatabaseSync(":memory:");
	try {
		await Promise.all([
			mkdir(root, { recursive: true }),
			mkdir(assignmentRoot, { recursive: true }),
			mkdir(otherRoot, { recursive: true }),
		]);
		await Promise.all([
			writeFile(join(root, "course.md"), "course source"),
			writeFile(join(assignmentRoot, "assignment-a.md"), "assignment A source"),
			writeFile(join(otherRoot, "assignment-b.md"), "assignment B source"),
		]);
		const host = new CourseBuilderHost(database);
		const project = host.createProject(projectInput);
		host.bindSession("teacher", project.projectId);
		const [courseMaterial] = host.syncLocalMaterials(
			"teacher",
			root,
			await scanCourseBuilderDirectory(root),
			1,
		);
		const assignment = host.createAssignment("teacher", { title: "Homework A", brief: "Use only A sources" });
		const other = host.createAssignment("teacher", { title: "Homework B", brief: "Use only B sources" });
		const [assignmentMaterial] = host.syncAssignmentMaterials(
			"teacher",
			assignment.assignmentId,
			assignmentRoot,
			await scanCourseBuilderDirectory(assignmentRoot, {
				kind: "assignment",
				assignmentId: assignment.assignmentId,
				assignmentTitle: assignment.title,
			}),
			1,
		);
		const [otherMaterial] = host.syncAssignmentMaterials(
			"teacher",
			other.assignmentId,
			otherRoot,
			await scanCourseBuilderDirectory(otherRoot, {
				kind: "assignment",
				assignmentId: other.assignmentId,
				assignmentTitle: other.title,
			}),
			1,
		);

		assert.equal(host.getProject(project.projectId).revision, 2, "Assignment changes do not invalidate course plans");
		const state = await runCourseBuilderCommand(host, "teacher", { action: "state" });
		assert.deepEqual(state.materials.map((material) => material.materialId), [courseMaterial.materialId]);
		assert.equal(state.assignmentSummary.count, 2);
		assert.equal("assignments" in state, false, "course Agent state does not expose Assignment identities or sources");
		assert.equal(courseBuilderView(host, "teacher").assignments.length, 2, "teacher workspace retains every Assignment");
		await assert.rejects(
			runCourseBuilderCommand(host, "teacher", { action: "read_material", id: assignmentMaterial.materialId }),
			/MATERIAL_SCOPE_MISMATCH|owning assignmentId/u,
		);
		host.setAgentAssignmentScope("teacher", assignment.assignmentId);
		const assignmentState = await runCourseBuilderCommand(host, "teacher", {
			action: "assignment_state",
			assignmentId: assignment.assignmentId,
		});
		assert.deepEqual(
			assignmentState.assignment.materials.map((material) => material.materialId),
			[assignmentMaterial.materialId],
		);
		const read = await runCourseBuilderCommand(
			host,
			"teacher",
			{ action: "read_assignment_material", assignmentId: assignment.assignmentId, id: assignmentMaterial.materialId },
			{ readLinkedMaterial: readLinkedCourseBuilderMaterial },
		);
		assert.equal(read.text, "assignment A source");
		await assert.rejects(
			runCourseBuilderCommand(
				host,
				"teacher",
				{ action: "read_assignment_material", assignmentId: assignment.assignmentId, id: otherMaterial.materialId },
				{ readLinkedMaterial: readLinkedCourseBuilderMaterial },
			),
			/does not belong/u,
		);
		await assert.rejects(
			runCourseBuilderCommand(host, "teacher", { action: "assignment_state", assignmentId: other.assignmentId }),
			/scoped to Assignment/u,
		);
		const draft = {
			overview: "Practice the stated concept",
			tasks: ["Solve and explain"],
			deliverables: ["Written response"],
			rubric: ["Correct reasoning"],
			solutionNotes: ["Check the definition"],
			materialIds: [assignmentMaterial.materialId],
		};
		await assert.rejects(
			runCourseBuilderCommand(host, "teacher", {
				action: "save_assignment",
				assignmentId: assignment.assignmentId,
				expectedRevision: 2,
				draft: { ...draft, materialIds: [courseMaterial.materialId] },
			}),
			/own linked folder/u,
		);
		await assert.rejects(
			runCourseBuilderCommand(host, "teacher", {
				action: "save_assignment",
				assignmentId: assignment.assignmentId,
				expectedRevision: 2,
				draft: { ...draft, materialIds: [otherMaterial.materialId] },
			}),
			/own linked folder/u,
		);
		const saved = await runCourseBuilderCommand(host, "teacher", {
			action: "save_assignment",
			assignmentId: assignment.assignmentId,
			expectedRevision: 2,
			draft,
		});
		assert.equal(saved.status, "draft");
		const reviewed = host.reviewAssignment("teacher", assignment.assignmentId, 3, "approve", "Approved");
		assert.equal(reviewed.status, "approved");
		host.setAgentAssignmentScope("teacher", null);
		await assert.rejects(
			runCourseBuilderCommand(host, "teacher", {
				action: "assignment_state",
				assignmentId: assignment.assignmentId,
			}),
			/scoped to the course planning chain/u,
		);
		assert.equal((await runCourseBuilderCommand(host, "teacher", { action: "state" })).project.projectId, project.projectId);
		assert.deepEqual(new CourseBuilderHost(database).getAssignment("teacher", assignment.assignmentId), reviewed);
	} finally {
		database.close();
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(assignmentRoot, { recursive: true, force: true }),
			rm(otherRoot, { recursive: true, force: true }),
		]);
	}
});
