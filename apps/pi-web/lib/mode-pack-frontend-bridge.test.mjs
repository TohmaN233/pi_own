import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const bridge = await jiti.import("./mode-pack-frontend-bridge.ts");

const context = {
  sessionId: "session/a",
  snapshotId: "snapshot-1",
  packageContentHash: "sha256:abc",
  nonce: "nonce-1",
  entry: "ui/panels/code.html",
  parentOrigin: "https://pi.local",
};

test("portable frontend URL keeps nested entry and supplies one opaque context", () => {
  const url = new URL(bridge.modePackFrontendUrl(context), "https://pi.local");
  assert.equal(url.pathname, "/api/mode-packs/frontend/session%2Fa/snapshot-1/nonce-1/ui/panels/code.html");
  assert.deepEqual(Object.fromEntries(url.searchParams), { sessionId: "session/a", snapshotId: "snapshot-1", nonce: "nonce-1", parentOrigin: "https://pi.local" });
  assert.throws(() => bridge.modePackFrontendUrl({ ...context, entry: "../escape.html" }), /canonical relative slash path/);
});

test("opaque bridge accepts only the exact frame source and snapshot nonce", () => {
  const source = {};
  const valid = { origin: "null", source, data: { channel: bridge.MODE_PACK_FRONTEND_CHANNEL, type: "ready", sessionId: context.sessionId, snapshotId: context.snapshotId, nonce: context.nonce } };
  assert.equal(bridge.isOpaqueModePackMessage(valid, source, context), true);
  assert.equal(bridge.isOpaqueModePackMessage({ ...valid, origin: "https://other.example" }, source, context), false);
  assert.equal(bridge.isOpaqueModePackMessage({ ...valid, source: {} }, source, context), false);
  assert.equal(bridge.isOpaqueModePackMessage({ ...valid, data: { ...valid.data, nonce: "old" } }, source, context), false);
  assert.equal(bridge.isOpaqueModePackMessage({ ...valid, data: { ...valid.data, snapshotId: "old" } }, source, context), false);
});

test("Spec Kit presentation never advertises initialization for a partial install", () => {
  assert.deepEqual(bridge.specKitFrontendPresentation({ state: "ready", initialized: true, missingCommands: [] }), { message: "Spec Kit is ready", canInitialize: false });
  assert.deepEqual(bridge.specKitFrontendPresentation({ state: "uninitialized", initialized: false, missingCommands: ["speckit.plan"] }), { message: "Spec Kit is not initialized", canInitialize: true });
  const partial = bridge.specKitFrontendPresentation({ state: "partial", initialized: false, missingCommands: ["speckit.plan", "speckit.tasks"] });
  assert.equal(partial.canInitialize, false);
  assert.match(partial.message, /partial/);
});
