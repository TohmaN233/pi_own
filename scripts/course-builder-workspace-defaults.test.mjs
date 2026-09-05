import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDefaultCourseBuilderProject } from "../apps/pi-web/lib/course-builder-defaults.ts";
import { CourseBuilderHost, parseCourseBuilderProjectInput } from "../packages/course-builder-host/src/index.ts";

test("workspace's actual default project can be saved without fabricated author/institution", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const input = createDefaultCourseBuilderProject();
    const host = new CourseBuilderHost(db);
    const project = host.createProject(input);
    assert.equal(project.beamerProfile.author, "");
    assert.equal(project.beamerProfile.institute, "");
    host.bindSession("default-workspace", project.projectId);
    const reopened = new CourseBuilderHost(db);
    assert.deepEqual(reopened.getSnapshotForSession("default-workspace").project, project);
  } finally { db.close(); }
});

test("optional attribution remains string-typed and bounded; mandatory course fields stay required", () => {
  for (const field of ["author", "institute"]) {
    for (const invalid of [null, undefined, 1, {}, "a".repeat(257)]) {
      const input = createDefaultCourseBuilderProject();
      input.beamerProfile[field] = invalid;
      assert.throws(() => parseCourseBuilderProjectInput(input));
    }
  }
  const blankTitle = createDefaultCourseBuilderProject();
  blankTitle.title = "   ";
  assert.throws(() => parseCourseBuilderProjectInput(blankTitle));
  const first = createDefaultCourseBuilderProject();
  first.goals.push("changed");
  assert.equal(createDefaultCourseBuilderProject().goals.length, 1);
});
