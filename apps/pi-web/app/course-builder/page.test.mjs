import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./CourseBuilder.module.css", import.meta.url), "utf8");
const linkRoute = readFileSync(new URL("../api/course-builder/link/route.ts", import.meta.url), "utf8");
const exportRoute = readFileSync(new URL("../api/course-builder/export/route.ts", import.meta.url), "utf8");

// Recovery and activation are exercised through real routes in
// lib/course-builder-workspace.test.mjs; folder mounting through scripts/course-builder-browser-smoke.mjs.

test("Course Builder onboarding uses named fields instead of raw project JSON", () => {
	for (const label of ["教师姓名", "学校 / 院系", "课程名称", "学生阶段与已有基础", "课程目标", "课件偏好"]) {
		assert.match(page, new RegExp(label, "u"));
	}
	assert.doesNotMatch(page, /aria-label=["']课程项目配置["']/u);
});

test("Course Builder links a local folder for on-demand reads and keeps file copies as a fallback", () => {
	assert.match(page, /链接本地资料文件夹/u);
	assert.match(page, /DirectoryPicker/u);
	assert.match(page, /\/api\/course-builder\/link/u);
	assert.match(page, /prepareCourseBuilderUpload/u);
	assert.match(linkRoute, /scanCourseBuilderDirectory/u);
	assert.match(linkRoute, /syncLocalMaterials/u);
	assert.doesNotMatch(page, /webkitdirectory/u);
});

test("Course Builder exposes a separately scoped Assignment workflow", () => {
	assert.match(page, /Assignment 独立工作链/u);
	assert.match(page, /create_assignment/u);
	assert.match(page, /assignment_state/u);
	assert.match(page, /read_assignment_material/u);
	assert.match(page, /save_assignment/u);
	assert.match(page, /review_assignment/u);
	assert.match(linkRoute, /syncAssignmentMaterials/u);
	assert.match(linkRoute, /scope: assignment \? "assignment" : "course"/u);
	assert.match(page, /预览学生版 \.md/u);
	assert.match(page, /预览教师版 \.md/u);
	assert.match(exportRoute, /assignmentMarkdown/u);
	assert.match(exportRoute, /assignment-student/u);
	assert.match(exportRoute, /assignment-teacher/u);
});

test("Course Builder owns scrolling and keeps an explicit Pi return control", () => {
	assert.match(page, /aria-label=["']返回 Pi 对话["']/u);
	assert.match(styles, /\.page\s*\{[\s\S]*?height:\s*100%;[\s\S]*?overflow-y:\s*auto;/u);
	assert.match(styles, /\.header\s*\{[\s\S]*?position:\s*sticky;/u);
});
