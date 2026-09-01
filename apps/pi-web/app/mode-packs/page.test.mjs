import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Mode Pack editor exposes immutable custom revisions and verified activation", async () => {
  const source = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(source, /Custom Mode Pack JSON/);
  assert.match(source, /expectedRevision: revision - 1/);
  assert.match(source, /activateModePack/);
  assert.match(source, /currentSnapshotId/);
  assert.match(source, /Discovered resources/);
  assert.doesNotMatch(source, /learning-harness.*plugin.*default/iu);
});
