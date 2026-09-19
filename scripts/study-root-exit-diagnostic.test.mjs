import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";

import {
	getIsolatedWindowsRunStatus,
	prepareIsolatedWindowsRun,
	startIsolatedWindowsRun,
} from "../packages/study-execution-host/src/windows-runner.ts";
import { detectStudyPlatform } from "../packages/study-execution-host/src/platform.ts";

const artifactRoot = resolve(".artifacts/study-research/root-exit-diagnostic");
const runRoot = join(artifactRoot, "runs");
const sourceRoot = join(runRoot, "source");
const pythonExecutable = process.platform === "win32" ? detectStudyPlatform(resolve(".")).executables.python.executablePath : null;
if (process.platform === "win32") assert.ok(pythonExecutable, "Python is required for the Windows runner diagnostic");
const cscExecutable = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

async function terminal(handle, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let latest = null;
	while (Date.now() < deadline) {
		latest = await getIsolatedWindowsRunStatus(handle);
		if (!['launching', 'running'].includes(latest.status)) return latest;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`runner did not publish a terminal receipt: ${JSON.stringify(latest)}`);
}

async function receipt(handle) {
	return JSON.parse(await readFile(join(handle.controlDirectory, "status.json"), "utf8"));
}

test("native root exit distinguishes a signaled root accounting lag from a live Job descendant", { skip: process.platform !== "win32" }, async () => {
	await rm(runRoot, { recursive: true, force: true });
	await mkdir(sourceRoot, { recursive: true });

	const normalProgram = join(sourceRoot, "normal-root-exit.py");
	await writeFile(
		normalProgram,
		"import time\ntime.sleep(0.2)\nprint('root-exit-result:', sum([2, 4, 6]))\n",
		"utf8",
	);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const run = await startIsolatedWindowsRun({
			runRootDirectory: runRoot,
			language: "python",
			executablePath: pythonExecutable,
			programPath: normalProgram,
			limits: { memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 16 * 1024 },
		});
		const status = await terminal(run);
		const completedReceipt = await receipt(run);
		await writeFile(join(artifactRoot, "last-normal-receipt.json"), `${JSON.stringify(completedReceipt, null, 2)}\n`, "utf8");
		assert.ok(Array.isArray(completedReceipt.RootExitDiagnostics));
		assert.ok(completedReceipt.RootExitDiagnostics.length > 0);
		assert.ok(status.rootExitDiagnostics.length > 0);
		assert.equal(status.status, "succeeded", completedReceipt.Error);
		assert.equal(completedReceipt.ExitCode, 0);
		assert.match(await readFile(join(run.outputDirectory, "stdout.log"), "utf8"), /root-exit-result: 12/u);
		assert.ok(completedReceipt.RootExitDiagnostics.every((sample) => Array.isArray(sample.ToolhelpCandidates)));
		assert.ok(status.rootExitDiagnostics.every((sample) => Array.isArray(sample.toolhelpCandidates)));
		assert.ok(
			status.rootExitDiagnostics.some((sample) =>
				sample.toolhelpCandidates.some((candidate) =>
					candidate.isRoot &&
					typeof candidate.processId === "number" &&
					typeof candidate.parentProcessId === "number" &&
					typeof candidate.acceptedAsDescendant === "boolean",
				),
			),
			JSON.stringify(completedReceipt),
		);
	}

	const transientProgram = join(sourceRoot, "transient-child-root-exit.py");
	await writeFile(
		transientProgram,
		[
			"import subprocess, sys",
			"child = subprocess.Popen([sys.executable, '-S', '-c', 'import time; time.sleep(0.25)'])",
			"print('transient-child-pid:', child.pid, flush=True)",
		].join("\n") + "\n",
		"utf8",
	);
	const transientRun = await startIsolatedWindowsRun({
		runRootDirectory: runRoot,
		language: "python",
		executablePath: pythonExecutable,
		programPath: transientProgram,
		limits: { memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 16 * 1024 },
	});
	const transientStatus = await terminal(transientRun);
	const transientReceipt = await receipt(transientRun);
	await writeFile(join(artifactRoot, "last-transient-receipt.json"), JSON.stringify(transientReceipt, null, 2) + "\n", "utf8");
	const transientStdout = await readFile(join(transientRun.outputDirectory, "stdout.log"), "utf8");
	const transientChildPid = Number(/transient-child-pid:\s*(\d+)/u.exec(transientStdout)?.[1]);
	assert.equal(transientStatus.status, "succeeded", JSON.stringify(transientReceipt));
	assert.ok(transientStatus.rootExitDiagnostics.length > 0);
	assert.ok(Number.isSafeInteger(transientChildPid) && transientChildPid > 0, transientStdout);
	assert.ok(
		transientReceipt.RootExitDiagnostics.some((sample) =>
			sample.JobMembers.some((member) => !member.IsRoot && member.Liveness === "alive"),
		),
		JSON.stringify(transientReceipt),
	);
	assert.throws(() => process.kill(transientChildPid, 0));

	const orphanProgram = join(sourceRoot, "orphan-root-exit.py");
	await writeFile(
		orphanProgram,
		[
			"import subprocess, sys, time",
			"child = subprocess.Popen([sys.executable, '-S', '-c', 'import time; time.sleep(30)'])",
			"print('orphan-child-pid:', child.pid, flush=True)",
			"time.sleep(0.2)",
		].join("\n") + "\n",
		"utf8",
	);
	const orphanRun = await startIsolatedWindowsRun({
		runRootDirectory: runRoot,
		language: "python",
		executablePath: pythonExecutable,
		programPath: orphanProgram,
		limits: { memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 16 * 1024 },
	});
	const orphanStatus = await terminal(orphanRun);
	const orphanReceipt = await receipt(orphanRun);
	await writeFile(join(artifactRoot, "last-orphan-receipt.json"), JSON.stringify(orphanReceipt, null, 2) + "\n", "utf8");
	const orphanStdout = await readFile(join(orphanRun.outputDirectory, "stdout.log"), "utf8");
	const childPid = Number(/orphan-child-pid:\s*(\d+)/u.exec(orphanStdout)?.[1]);
	assert.equal(orphanStatus.status, "failed", JSON.stringify(orphanReceipt));
	assert.ok(
		orphanReceipt.RootExitDiagnostics.some((sample) =>
			sample.JobMembers.some((member) => !member.IsRoot && member.Liveness === "alive"),
		),
		JSON.stringify(orphanReceipt),
	);
	assert.ok(Number.isSafeInteger(childPid) && childPid > 0, orphanStdout);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.throws(() => process.kill(childPid, 0));

	const staleFixtureDirectory = join(artifactRoot, "native-stale-parent-fixture");
	await rm(staleFixtureDirectory, { recursive: true, force: true });
	await mkdir(staleFixtureDirectory, { recursive: true });
	const fixtureSource = join(staleFixtureDirectory, "RootExitCandidateFixture.cs");
	const fixtureExecutable = join(staleFixtureDirectory, "RootExitCandidateFixture.exe");
	await writeFile(
		fixtureSource,
		[
			"using System;",
			"using System.Reflection;",
			"public static class RootExitCandidateFixture {",
			"  public static int Main() {",
			"    Type runner = typeof(StudyWindowsRunner);",
			"    Type candidateType = runner.GetNestedType(\"RootExitToolhelpCandidate\", BindingFlags.NonPublic);",
			"    MethodInfo newerThanRoot = runner.GetMethod(\"IsNewerThanRoot\", BindingFlags.NonPublic | BindingFlags.Static);",
			"    object candidate = Activator.CreateInstance(candidateType, true);",
			"    PropertyInfo creation = candidateType.GetProperty(\"CreationFileTime\");",
			"    creation.SetValue(candidate, \"100\", null);",
			"    bool olderAccepted = (bool)newerThanRoot.Invoke(null, new object[] { candidate, \"200\" });",
			"    creation.SetValue(candidate, \"300\", null);",
			"    bool newerAccepted = (bool)newerThanRoot.Invoke(null, new object[] { candidate, \"200\" });",
			"    Console.WriteLine(\"{\\\"olderAccepted\\\":\" + olderAccepted.ToString().ToLowerInvariant() + \",\\\"newerAccepted\\\":\" + newerAccepted.ToString().ToLowerInvariant() + \"}\");",
			"    return !olderAccepted && newerAccepted ? 0 : 1;",
			"  }",
			"}",
		].join("\n") + "\n",
		"utf8",
	);
	execFileSync(
		cscExecutable,
		[
			"/nologo",
			"/target:exe",
			"/platform:x64",
			`/out:${fixtureExecutable}`,
			"/main:RootExitCandidateFixture",
			"/r:System.Web.Extensions.dll",
			resolve("packages/study-execution-host/src/windows-runner.cs"),
			fixtureSource,
		],
		{ cwd: resolve("."), encoding: "utf8", stdio: "pipe" },
	);
	const staleFixtureEvidence = JSON.parse(execFileSync(fixtureExecutable, [], { encoding: "utf8", stdio: "pipe" }));
	assert.deepEqual(staleFixtureEvidence, { olderAccepted: false, newerAccepted: true });
	await writeFile(
		join(artifactRoot, "native-stale-parent-fixture.json"),
		`${JSON.stringify(staleFixtureEvidence, null, 2)}\n`,
		"utf8",
	);

	const longPathRoot = join(
		artifactRoot,
		"long-path-artifact-root",
		"segment-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"segment-bbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"runs",
	);
	assert.ok(longPathRoot.length < 248, longPathRoot);
	await rm(longPathRoot, { recursive: true, force: true });
	const longPathRed = await prepareIsolatedWindowsRun({
		runRootDirectory: longPathRoot,
		language: "python",
		executablePath: pythonExecutable,
		programPath: normalProgram,
		preparationIdentity: { runId: "long-path-red", cancelToken: "long-path-red-cancellation-token" },
		limits: { memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 16 * 1024 },
	});
	const legacyHelper = join(artifactRoot, "native-long-path-red", "study-windows-runner-without-long-path-awareness.exe");
	await mkdir(join(artifactRoot, "native-long-path-red"), { recursive: true });
	// Launch claims are part of the immutable native preflight. This invokes the
	// legacy native helper against a real prepared snapshot, not a fabricated
	// receipt, so the observed red result remains a genuine pre-spawn failure.
	await writeFile(
		join(longPathRed.controlDirectory, "launch.claim"),
		`${JSON.stringify({
			runId: longPathRed.runId,
			configBindingHash: longPathRed.configBindingHash,
			disposition: "launch",
		})}\n`,
		"utf8",
	);
	execFileSync(
		cscExecutable,
		[
			"/nologo",
			"/target:exe",
			"/platform:x64",
			`/out:${legacyHelper}`,
			"/r:System.Web.Extensions.dll",
			resolve("packages/study-execution-host/src/windows-runner.cs"),
		],
		{ cwd: resolve("."), encoding: "utf8", stdio: "pipe" },
	);
	const redExecution = spawnSync(legacyHelper, ["--supervise", join(longPathRed.controlDirectory, "config.json")], {
		encoding: "utf8",
		stdio: "pipe",
		windowsHide: true,
		timeout: 120_000,
	});
	assert.equal(redExecution.status, 1, `${redExecution.stdout}\n${redExecution.stderr}`);
	const redReceipt = await receipt(longPathRed);
	assert.equal(redReceipt.Status, "failed", JSON.stringify(redReceipt));
	assert.equal(redReceipt.ProcessId, 0, JSON.stringify(redReceipt));
	assert.match(redReceipt.Error ?? "", /PathTooLongException/u, JSON.stringify(redReceipt));
	await writeFile(join(artifactRoot, "long-path-red-receipt.json"), `${JSON.stringify(redReceipt, null, 2)}\n`, "utf8");

	const longPathGreen = await startIsolatedWindowsRun({
		runRootDirectory: longPathRoot,
		language: "python",
		executablePath: pythonExecutable,
		programPath: normalProgram,
		preparationIdentity: { runId: "long-path-green", cancelToken: "long-path-green-cancellation-token" },
		limits: { memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 16 * 1024 },
	});
	const greenStatus = await terminal(longPathGreen);
	const greenReceipt = await receipt(longPathGreen);
	assert.equal(greenStatus.status, "succeeded", JSON.stringify(greenReceipt));
	assert.equal(greenReceipt.ExitCode, 0, JSON.stringify(greenReceipt));
	assert.match(await readFile(join(longPathGreen.outputDirectory, "stdout.log"), "utf8"), /root-exit-result: 12/u);
	await writeFile(join(artifactRoot, "long-path-green-receipt.json"), `${JSON.stringify(greenReceipt, null, 2)}\n`, "utf8");
});
