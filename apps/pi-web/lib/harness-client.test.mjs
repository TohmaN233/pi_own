import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  PracticeOperationKeys,
  startHarnessPractice,
  submitHarnessPracticeAttempt,
} = await createJiti(import.meta.url).import("./harness-client.ts");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("practice retries keep their caller-owned key and successful operations release it", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  const responses = [
    jsonResponse({ error: "response lost after commit" }, 503),
    jsonResponse({ instance: { instanceId: "instance-1" }, exercise: { exerciseId: "exercise-1" } }),
    jsonResponse({ instance: { instanceId: "instance-2" }, exercise: { exerciseId: "exercise-1" } }),
  ];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return responses.shift();
  };

  try {
    const keys = new PracticeOperationKeys(() => `key-${bodies.length + 1}`);
    const firstKey = keys.start("exercise-1");
    await assert.rejects(startHarnessPractice("session-1", "exercise-1", firstKey), /response lost/);

    const retryKey = keys.start("exercise-1");
    assert.equal(retryKey, firstKey);
    await startHarnessPractice("session-1", "exercise-1", retryKey);
    keys.completeStart("exercise-1");

    const nextOperationKey = keys.start("exercise-1");
    assert.notEqual(nextOperationKey, firstKey);
    await startHarnessPractice("session-1", "exercise-1", nextOperationKey);

    assert.deepEqual(bodies.map((body) => body.idempotencyKey), [firstKey, firstKey, nextOperationKey]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("practice attempt key is retained across failure and changes with canonical answer", async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  const responses = [
    jsonResponse({ error: "response lost after commit" }, 503),
    jsonResponse({ attempt: {}, evaluation: {}, solutionAvailable: false, event: {} }),
    jsonResponse({ attempt: {}, evaluation: {}, solutionAvailable: false, event: {} }),
  ];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return responses.shift();
  };

  try {
    const keys = new PracticeOperationKeys(() => `attempt-key-${bodies.length + 1}`);
    const firstKey = keys.attempt("instance-1", "  first answer  ");
    await assert.rejects(submitHarnessPracticeAttempt("session-1", "instance-1", "first answer", firstKey), /response lost/);

    const retryKey = keys.attempt("instance-1", "first answer");
    assert.equal(retryKey, firstKey);
    await submitHarnessPracticeAttempt("session-1", "instance-1", "first answer", retryKey);
    keys.completeAttempt("instance-1", "first answer");

    const changedAnswerKey = keys.attempt("instance-1", "changed answer");
    assert.notEqual(changedAnswerKey, firstKey);
    await submitHarnessPracticeAttempt("session-1", "instance-1", "changed answer", changedAnswerKey);

    assert.deepEqual(bodies.map((body) => body.idempotencyKey), [firstKey, firstKey, changedAnswerKey]);
    assert.deepEqual(bodies.map((body) => body.answer), ["first answer", "first answer", "changed answer"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
