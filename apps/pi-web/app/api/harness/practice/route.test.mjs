import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const secret = "PRACTICE_ROUTE_PRIVATE_SENTINEL_7aa1";
const exercise = {
  exerciseId: "exercise-1",
  courseVersionId: "course-1",
  conceptIds: ["variables"],
  prompt: "What is a variable?",
  hints: ["Use the lesson definition."],
  unlockPolicy: "after-meaningful-attempt",
  revision: 1,
};

function request(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("Practice routes allowlist ordinary DTOs and reserve private solution text for the solution endpoint", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const [practice, hint, attempt, solution] = await Promise.all([
    jiti.import("./route.ts"),
    jiti.import("./hint/route.ts"),
    jiti.import("./attempt/route.ts"),
    jiti.import("./solution/route.ts"),
  ]);
  const previous = globalThis.__piLearningHarness;
  globalThis.__piLearningHarness = {
    listCurrentExercises() { return [exercise]; },
    startCurrentExercise() { return { instanceId: "instance-1", exerciseId: "exercise-1", issuedAt: "2026-08-30T22:00:00.000Z" }; },
    getCurrentExercise() { return exercise; },
    requestCurrentPracticeHint() { return exercise.hints[0]; },
    submitCurrentPracticeAttempt() {
      return {
        attempt: { attemptId: "attempt-1", instanceId: "instance-1", exerciseId: "exercise-1", answer: secret, meaningful: true, submittedAt: "2026-08-30T22:01:00.000Z", revision: 1 },
        evaluation: { evaluationId: "evaluation-1", attemptId: "attempt-1", correct: false, feedback: "Keep reasoning.", createdAt: "2026-08-30T22:01:00.000Z" },
        capability: { capabilityId: "capability-1", contentHash: secret },
        event: { eventId: "event-1", kind: "answered-incorrect", createdAt: "2026-08-30T22:01:00.000Z" },
      };
    },
    consumeCurrentPracticeSolution() { return secret; },
  };
  try {
    const list = await practice.GET(new Request("http://localhost/api/harness/practice?sessionId=session-1"));
    const started = await practice.POST(request("http://localhost/api/harness/practice", { sessionId: "session-1", exerciseId: "exercise-1", idempotencyKey: "start" }));
    const hinted = await hint.POST(request("http://localhost/api/harness/practice/hint", { sessionId: "session-1", instanceId: "instance-1", level: 1 }));
    const submitted = await attempt.POST(request("http://localhost/api/harness/practice/attempt", { sessionId: "session-1", instanceId: "instance-1", answer: "attempt", idempotencyKey: "attempt" }));
    for (const response of [list, started, hinted, submitted]) {
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(JSON.stringify(await response.json()).includes(secret), false);
    }
    const revealed = await solution.POST(request("http://localhost/api/harness/practice/solution", { sessionId: "session-1", attemptId: "attempt-1" }));
    assert.equal(revealed.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await revealed.json(), { solution: secret });
  } finally {
    if (previous === undefined) delete globalThis.__piLearningHarness;
    else globalThis.__piLearningHarness = previous;
  }
});

test("Practice routes reject malformed request bodies as client errors", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { POST } = await jiti.import("./route.ts");
  const response = await POST(new Request("http://localhost/api/harness/practice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("Assessment errors have semantic HTTP statuses and 5xx responses hide private details", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const [{ AssessmentHostError }, { harnessHttpStatus }, solution] = await Promise.all([
    jiti.import("../../../../../../packages/assessment-host/src/index.ts"),
    jiti.import("../../../../lib/harness-http.ts"),
    jiti.import("./solution/route.ts"),
  ]);
  assert.equal(harnessHttpStatus(new AssessmentHostError("UNKNOWN_ATTEMPT", "missing")), 404);
  assert.equal(harnessHttpStatus(new AssessmentHostError("CAPABILITY_SCOPE_MISMATCH", "scope")), 403);
  assert.equal(harnessHttpStatus(new AssessmentHostError("CAPABILITY_CONSUMED", "used")), 409);
  assert.equal(harnessHttpStatus(new AssessmentHostError("CAPABILITY_EXPIRED", "expired")), 410);
  assert.equal(harnessHttpStatus(new AssessmentHostError("PRIVATE_ASSET_UNAVAILABLE", secret)), 500);
  assert.equal(harnessHttpStatus(new AssessmentHostError("PRIVATE_SOLUTION_CONFLICT", secret)), 500);
  const previous = globalThis.__piLearningHarness;
  const previousConsoleError = console.error;
  globalThis.__piLearningHarness = {
    consumeCurrentPracticeSolution() { throw new AssessmentHostError("PRIVATE_ASSET_UNAVAILABLE", secret); },
  };
  try {
    console.error = () => {};
    const response = await solution.POST(request("http://localhost/api/harness/practice/solution", { sessionId: "session-1", attemptId: "attempt-1" }));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Practice service unavailable" });
  } finally {
    console.error = previousConsoleError;
    if (previous === undefined) delete globalThis.__piLearningHarness;
    else globalThis.__piLearningHarness = previous;
  }
});

test("Practice route cannot reach AssessmentHost directly", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /assessmentHost/);
});
