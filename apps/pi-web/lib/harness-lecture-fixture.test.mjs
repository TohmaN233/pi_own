import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const fixturePath = process.env.LEARNING_HARNESS_LECTURE_ZIP;
const jiti = createJiti(import.meta.url);
const { expandCourseUploads } = await jiti.import("./harness-course-import.ts");
const { LearningHarness } = await jiti.import("../../../packages/learning-harness/src/index.ts");
const { PdftotextExtractor } = await jiti.import("../../../packages/course-host/src/index.ts");

test("supplied S4CI3 lecture archive imports as a searchable durable course", { skip: !fixturePath }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-learning-lecture-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const materials = await expandCourseUploads([
    new File([readFileSync(fixturePath)], basename(fixturePath)),
  ]);
  assert.equal(materials.length, 9);
  assert.ok(materials.every((material) => material.kind === "pdf"));

  const harness = new LearningHarness({ databasePath: join(root, "harness.sqlite") });
  const version = await harness.publishCourseVersion("s4ci3-f2022", materials, {
    pdfTextExtractor: new PdftotextExtractor(process.env.PI_PDFTOTEXT_PATH || "pdftotext"),
  });
  assert.equal(version.materials.length, 9);
  assert.ok(version.spans.length > 100);
  assert.ok(version.materials.some((material) => /Computational Methods for Inference/i.test(material.normalizedText)));
  harness.close();
});
