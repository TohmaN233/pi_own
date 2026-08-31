import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Timeline citations open the existing Source Inspector panel", async () => {
  const source = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
  assert.match(source, /const openTimelineSource = async \(spanId: string\)/);
  assert.match(source, /setSource\(await readHarnessSpan\(sessionId, spanId\)\);\s*setPanel\("sources"\)/);
  assert.match(source, /onClick=\{\(\) => void openTimelineSource\(spanId\)\}/);
});

test("Practice is mounted only for a current bound Harness session", async () => {
  const source = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
  assert.match(source, /setPanel\(panel === "practice" \? null : "practice"\)/);
  assert.match(source, /disabled=\{!status\?\.session\}/);
  assert.match(source, /panel === "practice" && status\?\.session && sessionId && <PracticePanel key=\{sessionId\}/);
});

test("profile selector exposes disabled modes and the snapshot inspector", async () => {
  const source = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-label="Learning profile"/);
  assert.match(source, /!status\.session\.runtime\.verified/);
  assert.match(source, /switchHarnessProfile\(sessionId, targetProfileId, current\.resourceSnapshotId, idempotencyKey\)/);
  assert.match(source, /profile\.selectable \? "" :/);
  assert.match(source, /aria-label="Snapshot inspector"/);
  assert.match(source, /Profile switching stays disabled until this runtime is verified/);
});
