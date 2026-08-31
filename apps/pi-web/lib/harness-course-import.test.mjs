import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import JSZip from "jszip";

const { CourseImportLimitError, expandCourseUploads } = await createJiti(import.meta.url).import("./harness-course-import.ts");

test("course uploads expand ZIP entries into typed course materials", async () => {
  const zip = new JSZip();
  zip.file("notes/lecture.md", "# Lecture\n\nA grounded note.");
  zip.file("notes/slides.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  zip.file("notes/ignore.bin", new Uint8Array([1, 2, 3]));
  const archive = await zip.generateAsync({ type: "uint8array" });

  const materials = await expandCourseUploads([
    new File([archive], "course.zip"),
    new File(["print('hello')"], "example.py"),
  ]);

  assert.deepEqual(
    materials.map(({ name, kind, mediaType }) => ({ name, kind, mediaType })),
    [
      { name: "notes/lecture.md", kind: "markdown", mediaType: "text/markdown" },
      { name: "notes/slides.pdf", kind: "pdf", mediaType: "application/pdf" },
      { name: "example.py", kind: "code", mediaType: "text/plain" },
    ],
  );
});

test("course uploads reject selections without supported material", async () => {
  await assert.rejects(
    expandCourseUploads([new File(["binary"], "archive.bin")]),
    /No supported course materials/,
  );
});

test("course uploads stop direct files and ZIP inflation at the configured byte limit", async () => {
  await assert.rejects(
    expandCourseUploads([new File(["too large"], "notes.md")], { maxFiles: 4, maxBytes: 4 }),
    CourseImportLimitError,
  );

  const zip = new JSZip();
  zip.file("notes.md", "decompressed content exceeds the small test limit");
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await assert.rejects(
    expandCourseUploads([new File([archive], "course.zip")], { maxFiles: 4, maxBytes: 8 }),
    CourseImportLimitError,
  );
});
