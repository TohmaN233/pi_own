import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ordinary RPC contracts remain owned by the base implementation while the Mode Pack overlay delegates", async () => {
  const base = await readFile(new URL("./rpc-manager-base.ts", import.meta.url), "utf8");
  const overlay = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(base, /export async function startRpcSession\(/);
  assert.match(base, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(overlay, /import \* as Base from "\.\/rpc-manager-base"/);
  assert.match(overlay, /export \* from "\.\/rpc-manager-base"/);
  assert.match(overlay, /return Base\.startRpcSession\(sessionId, sessionFile, cwd, options\)/);
  assert.match(overlay, /startPersistedModePackSession\(sessionId, sessionFile\)/);
});
