import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { CourseHostError } = await createJiti(import.meta.url).import("../../../../../../packages/course-host/src/index.ts");
const { LearningHarnessError } = await createJiti(import.meta.url).import("../../../../../../packages/learning-harness/src/index.ts");
const { harnessHttpStatus } = await createJiti(import.meta.url).import("../../../../lib/harness-http.ts");

test("course import and session routes classify client and operational Harness failures consistently", () => {
  assert.equal(harnessHttpStatus(new CourseHostError("PDF_SUBPROCESS_OUTPUT_TOO_LARGE", "stderr budget exhausted")), 500);
  assert.equal(harnessHttpStatus(new CourseHostError("PDF_EXTRACTION_TIMEOUT", "timed out")), 500);
  assert.equal(harnessHttpStatus(new CourseHostError("PDF_OUTPUT_TOO_LARGE", "stdout budget exhausted")), 413);
  assert.equal(harnessHttpStatus(new CourseHostError("INVALID_COURSE_ID", "invalid input")), 400);
  assert.equal(harnessHttpStatus(new LearningHarnessError("UNKNOWN_SESSION", "invalid session")), 404);
  assert.equal(harnessHttpStatus(new LearningHarnessError("PERSISTENCE_FAILURE", "disk unavailable")), 500);
});

test("course-list GET logs and returns a 5xx independently when Harness persistence is poisoned", async () => {
  const { GET } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./route.ts");
  const previousHarness = globalThis.__piLearningHarness;
  const previousConsoleError = console.error;
  const logs = [];
  globalThis.__piLearningHarness = {
    listCourses() {
      throw new LearningHarnessError("PERSISTENCE_FAILURE", "database is unavailable");
    },
  };
  console.error = (...values) => logs.push(values);
  try {
    const response = await GET();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "database is unavailable" });
    assert.equal(logs.length, 1);
    assert.match(String(logs[0][0]), /course list failed/);
  } finally {
    console.error = previousConsoleError;
    if (previousHarness === undefined) delete globalThis.__piLearningHarness;
    else globalThis.__piLearningHarness = previousHarness;
  }
});

test("Harness routes use the composition root and shared operational error boundary", async () => {
  const [courses, activeCourse, search, span, status] = await Promise.all([
    readFile(new URL("./route.ts", import.meta.url), "utf8"),
    readFile(new URL("../active-course/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../search/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../spans/[spanId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../status/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [courses, activeCourse, search, span, status]) {
    assert.match(source, /harnessHttpStatus/);
    assert.match(source, /logHarnessOperationalError/);
  }
  assert.match(courses, /export async function GET\(\) \{[\s\S]*logHarnessOperationalError\("course list", error\)/);
  assert.match(activeCourse, /getLearningHarness\(\)\.getCourseVersion\(body\.courseVersionId\)/);
  assert.doesNotMatch(activeCourse, /courseHost\./);
});
