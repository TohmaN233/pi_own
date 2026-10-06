import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./[id]/route.ts");

const id = "historical-subagent-route-test";
const context = { params: Promise.resolve({ id }) };

function request(body) {
  return new Request(`http://localhost/api/subagents/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("historical subagent runs cannot be steered or aborted through the retired Pi Web controls", async () => {
  for (const body of [
    { action: "steer", message: "focus on tests" },
    { action: "abort" },
  ]) {
    const response = await POST(request(body), context);
    assert.notEqual(response.status, 200);
    assert.equal(
      (await response.json()).error,
      `Historical run ${id} is read-only. Manage current runs through /subagents-fleet.`,
    );
  }
});

test("historical subagent mutation requests still validate their payloads", async () => {
  let response = await POST(request({ action: "steer", message: "  " }), context);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "message required" });

  response = await POST(request({ action: "unknown" }), context);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "action must be steer or abort" });
});

test("subagent GET returns 404 for an unknown historical session", async () => {
  const missingId = `missing-subagent-${Date.now()}`;
  const response = await GET(
    new Request(`http://localhost/api/subagents/${missingId}`),
    { params: Promise.resolve({ id: missingId }) },
  );
  assert.equal(response.status, 404);
});
