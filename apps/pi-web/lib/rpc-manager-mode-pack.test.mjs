import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("rpc manager rebuilds and verifies generic Mode Pack runtimes instead of mutating prompt only", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /createAgentSessionServices/);
  assert.match(source, /additionalSkillPaths: plan\.skillPaths/);
  assert.match(source, /additionalExtensionPaths: plan\.extensionPaths/);
  assert.match(source, /noExtensions: true/);
  assert.match(source, /verifyModePackRuntime/);
  assert.match(source, /appendModePackBinding/);
  assert.match(source, /recoverModePackBindingHistory/);
  assert.match(source, /An unpinned Mode Pack must not replace a persisted session.s saved model/);
  assert.match(source, /await existing\.shutdown\(\);\s*appendModePackBinding/);
  assert.match(source, /journalCommitted = true/);
  assert.match(source, /never resurrect the previous runtime/);
  assert.match(source, /Reopen the session to recover the committed snapshot/);
  assert.match(source, /Mode Pack sessions own their tool selection/);
});
