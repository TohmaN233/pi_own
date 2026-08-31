import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Practice operations have a synchronous in-flight guard", async () => {
  const source = await readFile(new URL("./PracticePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /useRef/);
  assert.match(source, /const inFlight = useRef\(false\)/);
  assert.match(source, /if \(inFlight\.current\) return false;/);
  assert.equal((source.match(/if \(!beginOperation\(\)\) return;/g) ?? []).length, 4);
});
