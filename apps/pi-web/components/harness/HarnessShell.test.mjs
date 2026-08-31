import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Timeline citations open the existing Source Inspector panel", async () => {
	const source = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
	assert.match(source, /const openTimelineSource = async \(spanId: string\)/);
	assert.match(source, /setSource\(await readHarnessSpan\(sessionId, spanId\)\);\s*setPanel\("sources"\)/);
	assert.match(source, /onClick=\{\(\) => void openTimelineSource\(spanId\)\}/);
});

test("Practice is mounted only for a current course-bound Harness session", async () => {
	const source = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
	assert.match(source, /setPanel\(panel === "practice" \? null : "practice"\)/);
	assert.match(source, /panel === "practice" && status\?\.session && sessionId && <PracticePanel key=\{sessionId\}/);
});

test("Mode Pack selector activates the pinned catalog revision and navigates hard transitions", async () => {
	const source = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
	assert.match(source, /aria-label="Mode Pack"/);
	assert.match(source, /activateModePackForSession\(\{/);
	assert.match(source, /revision: target\.revision/);
	assert.match(source, /expectedCurrentModeHash: modeStatus\.active\.modePackContentHash/);
	assert.match(source, /result\.transition === "hard" && result\.targetSessionId !== sessionId/);
	assert.match(source, /next\.set\("session", result\.targetSessionId\)/);
	assert.match(source, /aria-label="Mode Pack runtime inspector"/);
	assert.match(source, /receipt\.loaded\.skills/);
});

test("Course Mode Packs are disabled when the selected Pi session has no course binding", async () => {
	const source = await readFile(new URL("./HarnessShell.tsx", import.meta.url), "utf8");
	assert.match(source, /modePack\.contextKind === "course" && !status\?\.session/);
	assert.match(source, /course required/);
});
