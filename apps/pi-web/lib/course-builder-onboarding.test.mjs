import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
	classifyCourseBuilderEntry,
	createCourseBuilderSetup,
	isCourseBuilderSnapshotDrift,
	parseTeacherProfile,
	projectFromCourseSetup,
	setupFromCourseProject,
	parseCourseSetupDraft,
} = await jiti.import("./course-builder-onboarding.ts");

test("natural course codes and incomplete drafts can be resumed without losing fields", () => {
	const setup = createCourseBuilderSetup();
	setup.courseId = "MATH 101/201";
	assert.equal(projectFromCourseSetup(setup).courseId, "MATH-101-201");
	setup.goalsText = "";
	assert.deepEqual(parseCourseSetupDraft(JSON.stringify(setup)), setup);
	assert.throws(() => parseCourseSetupDraft(JSON.stringify({ ...setup, weeks: "12" })), /字段无效/u);
});

test("editing an existing course loads its stored fields instead of current teacher defaults", () => {
	const setup = createCourseBuilderSetup({ author: "Original teacher", institute: "Saved institute" });
	setup.title = "Existing course";
	setup.goalsText = "First goal\nSecond goal";
	setup.preamble = "\\usepackage{amsmath}";
	setup.backupSlides = 3;
	const project = projectFromCourseSetup(setup);
	assert.deepEqual(projectFromCourseSetup(setupFromCourseProject(project)), project);
});

test("a dormant ordinary session is recoverable instead of being labeled as a student session", () => {
	assert.equal(classifyCourseBuilderEntry({ kind: "generic", live: false }), "dormant");
	assert.equal(classifyCourseBuilderEntry({ kind: "learning", live: true }), "student");
	assert.equal(classifyCourseBuilderEntry({ kind: "generic", live: true }), "ready");
});

test("only an immutable Mode Pack identity change offers the upgrade-session path", () => {
	assert.equal(isCourseBuilderSnapshotDrift(new Error("Mode Pack resource identity changed: skill:teacher.course-planning-beamer")), true);
	assert.equal(isCourseBuilderSnapshotDrift(new Error("Session not found")), false);
});

test("teacher defaults survive malformed local browser data without hiding errors in course fields", () => {
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...values) => warnings.push(values.join(" "));
	try {
		assert.deepEqual(parseTeacherProfile("not-json"), {
			author: "",
			institute: "",
			language: "中文",
			aspectRatio: "169",
			fontSize: 11,
		});
	} finally {
		console.warn = originalWarn;
	}
	assert.match(warnings.join("\n"), /invalid local teacher profile/u);
	assert.deepEqual(parseTeacherProfile(JSON.stringify({
		author: "王老师",
		institute: "数学系",
		language: "中文",
		aspectRatio: "43",
		fontSize: 12,
	})), {
		author: "王老师",
		institute: "数学系",
		language: "中文",
		aspectRatio: "43",
		fontSize: 12,
	});
});

test("the guided setup produces the existing Course Builder project contract", () => {
	const setup = createCourseBuilderSetup({ author: "王老师", institute: "数学系" });
	setup.courseId = "linear-algebra";
	setup.title = "线性代数";
	setup.goalsText = "理解线性映射\n使用矩阵解决问题";
	const project = projectFromCourseSetup(setup);

	assert.equal(project.courseId, "linear-algebra");
	assert.deepEqual(project.goals, ["理解线性映射", "使用矩阵解决问题"]);
	assert.equal(project.beamerProfile.author, "王老师");
	assert.equal(project.beamerProfile.institute, "数学系");
});

test("the guided form enforces the same Beamer font-size boundary as the Host", () => {
	const setup = createCourseBuilderSetup();
	setup.fontSize = 15;
	assert.throws(() => projectFromCourseSetup(setup), /课件字号必须是 8–14 之间的整数/u);
});
