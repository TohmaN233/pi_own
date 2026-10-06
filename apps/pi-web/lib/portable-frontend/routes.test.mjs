import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { portableFrontendApiUrl } = await createJiti(import.meta.url).import("./routes.ts");

test("native navigation resolves only the active package route", () => {
  const prior = globalThis.window;
  globalThis.window = { location: {
    href: "http://127.0.0.1:30141/api/mode-packs/frontend/session-1/snapshot-1/nonce/frontend/study.html?sessionId=session-1&runtimeId=study-research",
    search: "?sessionId=session-1&runtimeId=study-research",
  } };
  try {
    assert.equal(portableFrontendApiUrl("/api/study-research/export?format=graph"), "/api/mode-packs/runtime/session-1/study-research/export?format=graph&sessionId=session-1");
    assert.equal(portableFrontendApiUrl("/api/course-builder/export"), "/api/course-builder/export");
    assert.equal(portableFrontendApiUrl("https://elsewhere.example/api/study-research/export"), "https://elsewhere.example/api/study-research/export");
  } finally { globalThis.window = prior; }
});
