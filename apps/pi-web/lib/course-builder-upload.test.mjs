import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { prepareCourseBuilderUpload } = await jiti.import("./course-builder-upload.ts");

function folderFile(contents, name, relativePath) {
	const file = new File([contents], name);
	Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
	return file;
}

test("file upload does not reject materials by extension", () => {
	const result = prepareCourseBuilderUpload([
		folderFile("# 第一课", "lesson.md", "资料/week-01/lesson.md"),
		folderFile("binary", "notes.docx", "资料/week-01/notes.docx"),
		folderFile("binary", "archive.custom", "资料/archive.custom"),
	]);
	assert.equal(result.items.length, 3);
	assert.equal(result.items[0].uploadName, "week-01 — lesson.md");
	assert.equal(result.items[1].uploadName, "week-01 — notes.docx");
	assert.equal(result.items[2].uploadName, "archive.custom");
	assert.equal(result.skippedCount, 0);
});

test("folder selection enforces the Host file-count budget before upload", () => {
	const files = Array.from({ length: 101 }, (_, index) => new File(["x"], `lesson-${index}.txt`));
	assert.throws(() => prepareCourseBuilderUpload(files), /最多一次导入 100 个/u);
});
