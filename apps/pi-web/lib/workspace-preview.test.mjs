import assert from "node:assert/strict";
import test from "node:test";
import { resolveCourseArtifactPreview } from "./workspace-preview.ts";
import { resolveLocalFileHref } from "./file-links.ts";

test("preview uses only this session's same-origin Course Builder artifacts", () => {
  const link = "/api/course-builder/export?sessionId=teacher&kind=assignment-student&id=assignment-1";
  assert.equal(resolveCourseArtifactPreview(link, "teacher", "http://localhost:30141").format, "markdown");
  assert.equal(resolveCourseArtifactPreview(link, "another-session", "http://localhost:30141"), null);
  assert.equal(resolveCourseArtifactPreview(`https://other.example${link}`, "teacher", "http://localhost:30141"), null);
  assert.equal(resolveCourseArtifactPreview(link.replace("assignment-student", "unknown"), "teacher", "http://localhost:30141"), null);
});

test("inert Windows hrefs round trip without turning paths into protocols", () => {
  assert.equal(resolveLocalFileHref("/G:/课程/教案.md:12"), "G:/课程/教案.md");
  assert.equal(resolveLocalFileHref("/__pi_file__/G%3A%2F%E8%AF%BE%E7%A8%8B%2Fa%23b.md"), "G:/课程/a#b.md");
  assert.equal(resolveLocalFileHref("/__pi_file__/javascript%3Aalert(1)"), null);
});
