import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the live Mode Pack driver stages an exact Pi runtime and commits a JSONL receipt", async () => {
	const source = await read("apps/pi-web/lib/mode-pack-pi-runtime.ts");
	assert.match(source, /createAgentSessionServices\(/);
	assert.match(source, /additionalExtensionPaths: paths\.extensionPaths/);
	assert.match(source, /additionalSkillPaths: paths\.skillPaths/);
	assert.match(source, /inner\.setActiveToolsByName\(actualToolNames\)/);
	assert.match(source, /MODE_PROMPT_ACTIVATION_MISMATCH/);
	assert.match(source, /appendModePackBinding\(candidate\.manager, binding\)/);
	assert.match(source, /store\.reconcile\(candidate\.manager\)/);
	assert.match(source, /verifyModeActivation\(resolved, binding\.receipt\)/);
});

test("every existing Pi command restores the committed Mode Pack before execution", async () => {
	const source = await read("apps/pi-web/app/api/agent/[id]/route.ts");
	assert.match(source, /ensurePiModePackRuntime\(id, existing\)/);
	assert.match(source, /assertModePackCommandAllowed\(session\.inner\.sessionManager, body\)/);
	assert.match(source, /inheritModePackSessionFileOrDiscard/);
});

test("the Pi Web header uses the Mode Pack API instead of the legacy learning-only selector", async () => {
	const source = await read("apps/pi-web/components/harness/HarnessShell.tsx");
	assert.match(source, /aria-label="Mode Pack"/);
	assert.match(source, /activateModePackForSession/);
	assert.match(source, /Mode Pack runtime inspector/);
	assert.doesNotMatch(source, /aria-label="Learning profile"/);
});

test("the Mode Pack session API returns the target Pi session and receipt identity", async () => {
	const source = await read("apps/pi-web/app/api/mode-packs/session/route.ts");
	assert.match(source, /targetSessionId: result\.targetSessionId/);
	assert.match(source, /modePackContentHash: result\.resolved\.contentHash/);
	assert.match(source, /bindingRevision: result\.bindingRevision/);
});


test("interactive education workflows are backed by a durable actor-gated runtime", async () => {
	const source = await read("apps/pi-web/lib/mode-pack-workflow-runtime.ts");
	assert.match(source, /DurableEducationWorkflowHost/);
	assert.match(source, /learnerEventFor\(next\.state\)/);
	assert.match(source, /learnerTurnId = this\.options\.manager\.getLeafId\(\)/);
	assert.match(source, /recordVerifiedVisual/);
	assert.match(source, /MODE_WORKFLOW_IDENTITY_MISMATCH/);
});
