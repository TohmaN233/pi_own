import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

function removeSessionFile(session) {
	const file = session?.sessionFile;
	if (file && existsSync(file)) rmSync(file, { force: true });
}

test("real Pi AgentSession activates, restores, and warm-switches Mode Packs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-own-live-mode-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd, { recursive: true });
	process.env.PI_LEARNING_HARNESS_DIR = join(root, "harness-data");

	const { startRpcSession, getRpcSession } = await jiti.import("./rpc-manager.ts");
	const {
		activatePiModePack,
		ensurePiModePackRuntime,
		getPiModePackStatus,
	} = await jiti.import("./mode-pack-pi-runtime.ts");
	const { publishModePackDefinition } = await jiti.import("./mode-pack-service.ts");
	const { BUILTIN_MODE_PACKS } = await jiti.import(
		"../../../packages/profile-resource-host/src/mode-packs.ts",
	);

	const opened = await startRpcSession(`mode-test-${crypto.randomUUID()}`, "", cwd, {
		toolNames: [],
		deferRegister: false,
	});
	const wrappers = [opened.session];
	t.after(async () => {
		for (const wrapper of wrappers.reverse()) {
			try {
				await wrapper.shutdown();
			} catch {}
			removeSessionFile(wrapper);
		}
		rmSync(root, { recursive: true, force: true });
	});

	const general = await activatePiModePack({
		sessionId: opened.realSessionId,
		modePackId: "general",
		verifiedAt: "2026-08-31T21:00:00.000Z",
	});
	assert.equal(general.transition, "hard");
	assert.notEqual(general.targetSessionId, opened.realSessionId);
	const generalWrapper = getRpcSession(general.targetSessionId);
	assert.ok(generalWrapper?.isAlive());
	wrappers.push(generalWrapper);
	let status = await getPiModePackStatus(general.targetSessionId);
	assert.equal(status.active?.modePackId, "general");
	assert.equal(status.runtime.verified, true);
	assert.deepEqual(status.runtime.activeTools, []);

	await generalWrapper.shutdown();
	globalThis.__piOwnModeRuntimeStates = new Map();
	const restored = await ensurePiModePackRuntime(general.targetSessionId);
	wrappers.push(restored);
	status = await getPiModePackStatus(general.targetSessionId);
	assert.equal(status.runtime.verified, true);
	assert.equal(status.active?.receipt.effectivePromptHash, status.runtime.effectivePromptHash);

	const coding = await activatePiModePack({
		sessionId: general.targetSessionId,
		modePackId: "coding",
		expectedCurrentModeHash: status.active?.modePackContentHash,
		verifiedAt: "2026-08-31T21:00:01.000Z",
	});
	assert.equal(coding.transition, "hard");
	assert.notEqual(coding.targetSessionId, general.targetSessionId);
	const codingWrapper = getRpcSession(coding.targetSessionId);
	assert.ok(codingWrapper?.isAlive());
	wrappers.push(codingWrapper);
	status = await getPiModePackStatus(coding.targetSessionId);
	assert.equal(status.active?.modePackId, "coding");
	assert.equal(status.runtime.verified, true);
	assert.deepEqual(status.runtime.activeTools, ["bash", "read", "write"]);

	const customDefinition = {
		...structuredClone(BUILTIN_MODE_PACKS.coding),
		id: "custom-code-review",
		title: "Custom Code Review",
		description: "A user-owned code review Mode Pack used by the live runtime test.",
		prompt: {
			...structuredClone(BUILTIN_MODE_PACKS.coding.prompt),
			mode: "Review the bound workspace and prefer a minimal, tested patch.",
		},
		provenance: {
			source: "user",
			createdAt: "2026-08-31T21:00:02.000Z",
		},
	};
	publishModePackDefinition(customDefinition, null);
	const custom = await activatePiModePack({
		sessionId: coding.targetSessionId,
		modePackId: customDefinition.id,
		expectedCurrentModeHash: status.active?.modePackContentHash,
		verifiedAt: "2026-08-31T21:00:03.000Z",
	});
	assert.equal(custom.transition, "warm");
	assert.equal(custom.targetSessionId, coding.targetSessionId);
	const customWrapper = getRpcSession(custom.targetSessionId);
	assert.ok(customWrapper?.isAlive());
	wrappers.push(customWrapper);
	status = await getPiModePackStatus(custom.targetSessionId);
	assert.equal(status.active?.modePackId, customDefinition.id);
	assert.equal(status.active?.revision, 2);
	assert.equal(status.runtime.verified, true);
	assert.deepEqual(status.active?.receipt.loaded.skills, ["coding-workflow"]);
});
