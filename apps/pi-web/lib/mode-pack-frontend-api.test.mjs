import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { modePackFrontendApiTarget } = await createJiti(import.meta.url).import("./mode-pack-frontend-api.ts");

test("package API requests bind to the active module and session", () => {
  const options = { sessionId: "session-1", runtimeId: "study-research", method: "POST" };
  assert.equal(modePackFrontendApiTarget({ ...options, url: "/api/study-research/research?plan=1" }), "/api/mode-packs/runtime/session-1/study-research/research?plan=1&sessionId=session-1");
  assert.equal(modePackFrontendApiTarget({ ...options, url: "/api/agent/session-1" }), "/api/agent/session-1");
  assert.throws(() => modePackFrontendApiTarget({ ...options, url: "/api/study-research?sessionId=session-2" }), /another session/u);
  assert.throws(() => modePackFrontendApiTarget({ ...options, url: "/api/agent/session-2" }), /not granted/u);
  assert.throws(() => modePackFrontendApiTarget({ ...options, url: "/api/projects" }), /not granted/u);
  assert.throws(() => modePackFrontendApiTarget({ ...options, url: "/api/cwd/browse" }), /not granted/u);
  assert.equal(modePackFrontendApiTarget({ ...options, method: "GET", projectCapabilities: ["host-api:cwd-browse@1"], url: "/api/cwd/browse?path=G%3A%5Ctmp" }), "/api/cwd/browse?path=G%3A%5Ctmp");
  assert.throws(() => modePackFrontendApiTarget({ ...options, projectCapabilities: ["host-api:cwd-browse@1"], url: "/api/cwd/browse" }), /not granted/u);
  assert.equal(modePackFrontendApiTarget({ ...options, method: "GET", projectCapabilities: ["host-api:pdf-preview@1"], url: "/api/pdf-content?file=%2Fapi%2Fstudy-research%2Fsource%3FsourceId%3Ds1" }), "/api/pdf-content?file=%2Fapi%2Fmode-packs%2Fruntime%2Fsession-1%2Fstudy-research%2Fsource%3FsourceId%3Ds1%26sessionId%3Dsession-1");
  assert.throws(() => modePackFrontendApiTarget({ ...options, method: "GET", projectCapabilities: ["host-api:pdf-preview@1"], url: "/api/pdf-content?file=%2Fapi%2Fcourse-builder%2Fexport" }), /outside the active package/u);
  assert.throws(() => modePackFrontendApiTarget({ ...options, url: "//evil.test/api/study-research" }), /local API/u);
});
