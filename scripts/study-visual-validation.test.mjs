import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { compareVisualObservations, validateVisualSpecification } from "../packages/study-research-host/src/visual-validation.ts";

// Synthetic rectangle/line geometry checks the general protocol, not paper-specific academic correctness.
function fixture() {
  const cases = [
    { id: "inside", category: "ordinary", description: "A segment entirely inside a rectangle", inputs: { start: 0, end: 1, bandEnd: 2 }, coverage: 1 },
    { id: "boundary", category: "boundary", description: "A segment meets the rectangle boundary", inputs: { start: 0, end: 2, bandEnd: 1 }, coverage: 0.5 },
    { id: "zero", category: "degenerate", description: "A zero length segment has explicitly undefined coverage", inputs: { start: 1, end: 1, bandEnd: 2 }, coverage: null },
    { id: "control", category: "interaction", description: "Changing bandEnd changes the displayed endpoint and coverage", inputs: { start: 0, end: 4, bandEnd: 3 }, coverage: 0.75 },
  ];
  const specification = { version: 1, targetHash: contentHash("synthetic-visual-v1"), scope: "Four declared line/rectangle cases only", assumptions: ["Ordered segment endpoints", "Rectangle begins at zero"],
    oracle: { kind: "hand-calculation", description: "Exact overlap length divided by positive segment length; zero length remains undefined",
      material: "Lengths: 1/1, 1/2, undefined for 0/0, and 3/4. The marker's x-coordinate is the band endpoint.", sourceReferences: [] },
    cases: cases.map(({ coverage, ...entry }) => ({ ...entry, expected: [
      { path: ["metrics", "coverage"], value: coverage, absoluteTolerance: coverage === null ? 0 : 1e-9, relativeTolerance: 0 },
      { path: ["elements", 0, "attrs", "cx"], value: entry.inputs.bandEnd, absoluteTolerance: 0, relativeTolerance: 0 },
    ] })),
  };
  const observations = cases.map((entry) => ({ caseId: entry.id, inputHash: contentHash(entry.inputs), status: "returned", error: null,
    scene: { metrics: { coverage: entry.coverage }, elements: [{ tag: "circle", attrs: { cx: entry.inputs.bandEnd } }] } }));
  return { specification, observations };
}

test("independent expected values retain actual numerical and scene evidence with exact input and target identity", () => {
  const { specification, observations } = fixture();
  observations[0].scene.metrics.coverage += 5e-10;
  const report = compareVisualObservations(specification, observations);
  assert.equal(report.status, "passed");
  assert.equal(report.targetHash, specification.targetHash);
  assert.equal(report.specificationHash, contentHash(specification));
  assert.equal(report.comparisons[0].checks[0].expected, 1);
  assert.equal(report.comparisons[0].checks[0].actual, 1 + 5e-10);
  assert.match(report.qualification, /Browser control behavior and independent academic review remain separate/);
});

test("wrong geometry, stale control values and degenerate overclaims fail rather than certify a rendered scene", () => {
  for (const [index, mutate] of [
    [0, (scene) => { scene.metrics.coverage = 0.9; }],
    [2, (scene) => { scene.metrics.coverage = 1; }],
    [3, (scene) => { scene.elements[0].attrs.cx = 2; }],
  ]) {
    const { specification, observations } = fixture(); mutate(observations[index].scene);
    const report = compareVisualObservations(specification, observations);
    assert.equal(report.status, "failed");
    assert.equal(report.comparisons[index].status, "failed");
    assert.ok(report.comparisons[index].checks.some((check) => !check.passed));
  }
});

test("missing checks remain inconclusive and timeout is visible failure", () => {
  const { specification, observations } = fixture();
  assert.equal(compareVisualObservations(specification, observations.slice(1)).status, "inconclusive");
  const partial = structuredClone(specification); partial.cases = partial.cases.slice(0, 1);
  const report = compareVisualObservations(partial, observations.slice(0, 1));
  assert.equal(report.status, "inconclusive");
  assert.deepEqual(report.missingCategories, ["boundary", "degenerate", "interaction"]);
  observations[2] = { ...observations[2], status: "timed-out", scene: null, error: "Isolated process exceeded 3 seconds" };
  assert.equal(compareVisualObservations(specification, observations).comparisons[2].error, observations[2].error);
  assert.equal(compareVisualObservations(specification, observations).status, "failed");
});

test("changed input, duplicate results, nonfinite values and executable properties cannot fabricate a pass", () => {
  const { specification, observations } = fixture();
  assert.throws(() => compareVisualObservations(specification, [{ ...observations[0], inputHash: contentHash("changed") }]), /frozen case/);
  assert.throws(() => compareVisualObservations(specification, [observations[0], observations[0]]), /duplicate observation/);
  const nonfinite = structuredClone(observations); nonfinite[0].scene.metrics.coverage = Number.NaN;
  assert.throws(() => compareVisualObservations(specification, nonfinite), /finite plain JSON/);
  const unsafe = structuredClone(specification); let getterExecuted = false;
  Object.defineProperty(unsafe.cases[0].inputs, "secret", { enumerable: true, get() { getterExecuted = true; return 1; } });
  assert.throws(() => validateVisualSpecification(unsafe), /plain own properties/); assert.equal(getterExecuted, false);
  const inherited = structuredClone(specification); inherited.cases[0].expected[0].path = ["constructor"];
  assert.throws(() => validateVisualSpecification(inherited), /observed scene path/);
  const overflow = structuredClone(specification);
  Object.assign(overflow.cases[0].expected[0], { value: Number.MAX_VALUE, relativeTolerance: 2 });
  assert.throws(() => validateVisualSpecification(overflow), /tolerance must remain finite/);
});
