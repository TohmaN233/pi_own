import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Harness shell exposes exactly one selector for generic or learner Mode Packs", async () => {
  const wrapper = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
  const overlay = await readFile(new URL("../mode-packs/ModePackOverlay.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("./HarnessShellModePack.module.css", import.meta.url), "utf8");
  const learner = await readFile(new URL("./HarnessShellBase.tsx", import.meta.url), "utf8");
  assert.match(wrapper, /kind === "generic"/);
  assert.match(wrapper, /onStatusKind=\{setKind\}/);
  assert.match(overlay, /status\.kind !== "generic"/);
  assert.match(css, /> :nth-child\(2\) > header/);
  assert.match(learner, /aria-label="Mode Pack"/);
  assert.match(learner, /aria-label="Snapshot inspector"/);
  assert.match(learner, /PracticePanel/);
  assert.match(learner, /openTimelineSource/);
});
