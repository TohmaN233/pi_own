import assert from "node:assert/strict";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { join, resolve } from "node:path";
import { startIsolatedWindowsRun, getIsolatedWindowsRunStatus, cancelIsolatedWindowsRun } from "../packages/study-execution-host/src/windows-runner.ts";

const root = resolve(".artifacts/study-research/execution-progress/native-progress-test");

test("native runner publishes increasing observed usage while the worker is running", async () => {
	if (process.platform !== "win32") throw new Error("native progress evidence requires Windows");
	await rm(root, { recursive: true, force: true });
	const source = join(root, "source");
	await mkdir(source, { recursive: true });
	const program = join(source, "progress.mjs");
	await writeFile(program, [
		"process.stdout.write('x'.repeat(2048));",
		"setTimeout(() => {}, 6000);",
	].join("\n") + "\n", "utf8");

	let handle = null;
	let terminal = null;
	const runningObservations = [];
	let firstRunningHostTime = null;
	try {
		handle = await startIsolatedWindowsRun({
			runRootDirectory: root,
			language: "node",
			executablePath: process.execPath,
			programPath: program,
			limits: { memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 12_000, outputLimitBytes: 4096 },
		});
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const status = await getIsolatedWindowsRunStatus(handle);
			if (status.status === "running") {
				if (firstRunningHostTime === null) firstRunningHostTime = Date.now();
				runningObservations.push({
					observedAt: new Date().toISOString(),
					wallTimeMs: status.wallTimeMs,
					outputBytes: status.outputBytes,
				});
			} else if (status.status !== "launching") {
				terminal = status;
				break;
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
		}
		assert.ok(terminal, JSON.stringify({ runningObservations }));
		assert.equal(terminal.status, "succeeded", terminal.error);
		const observed = runningObservations.filter((item) => item.wallTimeMs > 0 && item.outputBytes > 0);
		assert.ok(observed.length >= 2, JSON.stringify({ runningObservations, terminal }));
		assert.ok(observed.some((item, index) => index > 0 && item.wallTimeMs > observed[index - 1].wallTimeMs), JSON.stringify({ observed }));
		assert.ok(firstRunningHostTime !== null);
		const processWallTime = Date.now() - firstRunningHostTime;
		assert.ok(Math.abs(terminal.wallTimeMs - processWallTime) < 2_500, JSON.stringify({ processWallTime, terminal }));
		assert.ok(terminal.wallTimeMs >= 5_000, JSON.stringify(terminal));
		const terminalAgain = await getIsolatedWindowsRunStatus(handle);
		assert.deepEqual(
			{ status: terminalAgain.status, wallTimeMs: terminalAgain.wallTimeMs, outputBytes: terminalAgain.outputBytes },
			{ status: terminal.status, wallTimeMs: terminal.wallTimeMs, outputBytes: terminal.outputBytes },
		);
		await writeFile(join(root, "latest-test-evidence.json"), JSON.stringify({ runningObservations, terminal, processWallTime }, null, 2) + "\n", "utf8");
	} finally {
		if (handle && (!terminal || terminal.status === "launching" || terminal.status === "running")) {
			await cancelIsolatedWindowsRun(handle).catch(() => undefined);
		}
	}
	const evidence = JSON.parse(await readFile(join(root, "latest-test-evidence.json"), "utf8"));
	assert.equal(evidence.terminal.status, "succeeded");
});
