import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import net from "node:net";
import test from "node:test";
import {
	createProjectPythonEnvironment,
	discoverRGlobalLibraryEnvironment,
	planDependencyChanges,
	verifyStudyExecutionEnvironment,
} from "../packages/study-execution-host/src/environments.ts";
import {
	cancelIsolatedWindowsRun,
	getIsolatedWindowsRunStatus,
	prepareIsolatedWindowsRun,
	startIsolatedWindowsRun,
} from "../packages/study-execution-host/src/windows-runner.ts";

const root = resolve(".artifacts/study-research/environments/test-runs");

async function terminal(handle, timeoutMs = 180_000) {
	const deadline = Date.now() + timeoutMs;
	let status;
	while (Date.now() < deadline) {
		status = await getIsolatedWindowsRunStatus(handle);
		if (!["launching", "running"].includes(status.status)) return status;
		await new Promise((resume) => setTimeout(resume, 50));
	}
	throw new Error(`Runner did not reach a terminal state: ${JSON.stringify(status)}`);
}

async function outputUsage(directory) {
	let bytes = 0;
	let files = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			const child = await outputUsage(path);
			bytes += child.bytes;
			files += child.files;
		} else if (entry.isFile()) {
			bytes += (await stat(path)).size;
			files += 1;
		}
	}
	return { bytes, files };
}

test("project Python and selected R packages execute from frozen AppContainer environments with bounded outputs", async () => {
	if (process.platform !== "win32") return;
	await rm(root, { recursive: true, force: true });
	const project = join(root, "project");
	const source = join(root, "source");
	await mkdir(project, { recursive: true });
	await mkdir(source, { recursive: true });

	const python = await createProjectPythonEnvironment({ projectDirectory: project, venvDirectory: ".venv" });
	assert.equal(python.environment.adapterKind, "native-windows-python-project-venv-v1");
	assert.ok(python.environment.files.length > 1);
	await verifyStudyExecutionEnvironment(python.environment);
	const dependencyPlan = planDependencyChanges(python.packages, [{ name: "pip" }, { name: "not-installed-fixture", version: "1" }]);
	assert.equal(dependencyPlan.resolver, "not-a-transitive-resolver");
	assert.equal(dependencyPlan.items.find((item) => item.name === "not-installed-fixture")?.status, "missing");

	const sentinel = join(source, "host-sentinel.txt");
	await writeFile(sentinel, "unchanged", "utf8");
	let acceptedConnections = 0;
	const server = net.createServer((socket) => { acceptedConnections += 1; socket.destroy(); });
	await new Promise((resume, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resume); });
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("network test server has no TCP port");
	try {
		const pythonProgram = join(source, "venv-boundary.py");
		await writeFile(pythonProgram, [
			"import os, socket, sys",
			"import pip",
			"assert sys.flags.no_site == 1",
			"assert 'site-packages' in pip.__file__.replace('\\\\', '/')",
			"def denied(action):",
			"    try:",
			"        action(); return False",
			"    except Exception: return True",
			`assert denied(lambda: open(${JSON.stringify(sentinel)}, 'rb').read())`,
			`assert denied(lambda: socket.create_connection(('127.0.0.1', ${address.port}), timeout=1))`,
			"open('python-owned-output.txt', 'w', encoding='utf8').write('owned')",
			"print('python-venv-package:' + pip.__version__)",
			"print('python-boundaries:ok')",
		].join("\n") + "\n", "utf8");
		const pythonRun = await startIsolatedWindowsRun({
			runRootDirectory: root,
			language: "python",
			executablePath: python.environment.executablePath,
			programPath: pythonProgram,
			environment: python.environment,
			limits: { memoryBytes: 512 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 30_000, outputLimitBytes: 64 * 1024 },
		});
		const pythonStatus = await terminal(pythonRun);
		assert.equal(pythonStatus.status, "succeeded", pythonStatus.error);
		assert.ok(pythonStatus.wallTimeMs > 0);
		assert.equal(await readFile(sentinel, "utf8"), "unchanged");
		assert.equal(acceptedConnections, 0);
		assert.match(await readFile(join(pythonRun.outputDirectory, "stdout.log"), "utf8"), /python-boundaries:ok/u);
		assert.equal(await readFile(join(pythonRun.outputDirectory, "python-owned-output.txt"), "utf8"), "owned");
		const pythonConfig = JSON.parse(await readFile(join(pythonRun.controlDirectory, "config.json"), "utf8"));
		assert.equal(pythonConfig.EnvironmentDescriptorHash, python.environment.descriptorHash);
		assert.equal(pythonConfig.EnvironmentAdapterKind, python.environment.adapterKind);
		assert.ok(pythonConfig.PythonSitePackagesDirectory);

		const pyvenvConfig = join(python.venvDirectory, "pyvenv.cfg");
		const originalConfig = await readFile(pyvenvConfig, "utf8");
		await writeFile(pyvenvConfig, `${originalConfig}\n# source-byte-change\n`, "utf8");
		await assert.rejects(
			() => prepareIsolatedWindowsRun({
				runRootDirectory: root,
				language: "python",
				executablePath: python.environment.executablePath,
				programPath: pythonProgram,
				environment: python.environment,
			}),
			(error) => error?.code === "ENVIRONMENT_SOURCE_CHANGED",
		);
		await writeFile(pyvenvConfig, originalConfig, "utf8");

		const r = await discoverRGlobalLibraryEnvironment({ packageNames: ["digest"] });
		assert.ok(r.selectedExternalPackages.includes("digest"));
		assert.ok(r.environment.files.length > 4_000);
		await verifyStudyExecutionEnvironment(r.environment);
		const rProgram = join(source, "r-selected-package.R");
		await writeFile(rProgram, [
			"library(stats)",
			"library(digest)",
			"stopifnot(mean(c(1, 2, 3)) == 2, digest('bound') == digest('bound'))",
			"writeLines('r-owned', 'r-owned-output.txt')",
			"cat('r-global-selected-package:ok\\n')",
		].join("\n") + "\n", "utf8");
		const rRun = await startIsolatedWindowsRun({
			runRootDirectory: root,
			language: "rscript",
			executablePath: r.environment.executablePath,
			programPath: rProgram,
			environment: r.environment,
			limits: { memoryBytes: 512 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 30_000, outputLimitBytes: 64 * 1024 },
		});
		const rStatus = await terminal(rRun, 240_000);
		assert.equal(rStatus.status, "succeeded", rStatus.error);
		assert.match(await readFile(join(rRun.outputDirectory, "stdout.log"), "utf8"), /r-global-selected-package:ok/u);
		assert.equal((await readFile(join(rRun.outputDirectory, "r-owned-output.txt"), "utf8")).trim(), "r-owned");

		const outputProgram = join(source, "shared-output-limit.mjs");
		await writeFile(outputProgram, [
			"import { writeFile } from 'node:fs/promises';",
			"process.stdout.write('s'.repeat(200));",
			"process.stderr.write('e'.repeat(200));",
			"await writeFile('artifact-a.txt', 'a'.repeat(500));",
			"await writeFile('artifact-b.txt', 'b'.repeat(500));",
		].join("\n") + "\n", "utf8");
		const outputRun = await startIsolatedWindowsRun({
			runRootDirectory: root,
			language: "node",
			executablePath: process.execPath,
			programPath: outputProgram,
			limits: { memoryBytes: 128 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 1_024 },
		});
		const outputStatus = await terminal(outputRun);
		assert.equal(outputStatus.status, "limit-reached", JSON.stringify(outputStatus));
		const retained = await outputUsage(outputRun.outputDirectory);
		assert.equal(outputStatus.outputBytes, retained.bytes);
		assert.equal(outputStatus.outputFiles, retained.files);
		assert.ok(retained.bytes <= 1_024, JSON.stringify({ outputStatus, retained }));
		assert.ok(await stat(join(outputRun.outputDirectory, "artifact-a.txt")));
		await assert.rejects(stat(join(outputRun.outputDirectory, "artifact-b.txt")));

		const childProgram = join(source, "parent-exits-child-writes.mjs");
		await writeFile(childProgram, [
			"import { spawn } from 'node:child_process';",
			"spawn(process.execPath, ['-e', \"setInterval(() => console.log('descendant-output'), 5)\"], { detached: true, stdio: 'inherit' });",
			"setTimeout(() => process.exit(0), 60);",
		].join("\n") + "\n", "utf8");
		const childRun = await startIsolatedWindowsRun({
			runRootDirectory: root,
			language: "node",
			executablePath: process.execPath,
			programPath: childProgram,
			limits: { memoryBytes: 128 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 16 * 1024 },
		});
		const childStatus = await terminal(childRun);
		assert.equal(childStatus.status, "failed", JSON.stringify(childStatus));
		assert.match(childStatus.error, /descendants remained/u);
		const evidence = {
			python: { descriptorHash: python.environment.descriptorHash, files: python.environment.files.length, status: pythonStatus },
			r: { descriptorHash: r.environment.descriptorHash, files: r.environment.files.length, selectedExternalPackages: r.selectedExternalPackages, status: rStatus },
			sharedOutput: { status: outputStatus, retained },
			rootExitDescendant: childStatus,
		};
		await writeFile(join(root, "latest-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
		assert.equal(createHash("sha256").update(JSON.stringify(evidence)).digest("hex").length, 64);
	} finally {
		await new Promise((resume, reject) => server.close((error) => error ? reject(error) : resume()));
	}
});

test("durable cancellation interrupts snapshot validation before any Windows worker starts", { concurrency: false }, async () => {
	if (process.platform !== "win32") return;
	const cancelRoot = resolve(".artifacts/study-research/environments/prelaunch-cancel-regression");
	const source = join(cancelRoot, "source");
	const delayVariable = "STUDY_WINDOWS_RUNNER_TEST_SNAPSHOT_VALIDATION_DELAY_MS";
	const previousDelay = process.env[delayVariable];
	async function waitForValidationDelay(path, timeoutMs = 15_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				await stat(path);
				return;
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			await new Promise((resume) => setTimeout(resume, 25));
		}
		throw new Error(`Native helper did not enter its validation-delay regression hook: ${path}`);
	}
	try {
		await rm(cancelRoot, { recursive: true, force: true });
		await mkdir(source, { recursive: true });
		const program = join(source, "must-not-run.mjs");
		await writeFile(program, "throw new Error('cancelled worker executed unexpectedly');\n", "utf8");
		process.env[delayVariable] = "30000";
		const handle = await startIsolatedWindowsRun({
			runRootDirectory: cancelRoot,
			language: "node",
			executablePath: process.execPath,
			programPath: program,
			limits: { wallTimeMs: 30_000, outputLimitBytes: 16 * 1024 },
		});
		await waitForValidationDelay(join(handle.controlDirectory, "test-snapshot-validation.started"));
		const cancellationStarted = Date.now();
		const receipt = await cancelIsolatedWindowsRun(handle);
		assert.equal(receipt.status, "cancelled", JSON.stringify(receipt));
		assert.equal(receipt.processId, 0, JSON.stringify(receipt));
		assert.equal(receipt.wallTimeMs, 0, JSON.stringify(receipt));
		assert.equal(receipt.appContainerCleanup, "not-started", JSON.stringify(receipt));
		assert.equal(receipt.outputBytes, 0, JSON.stringify(receipt));
		assert.equal(receipt.outputFiles, 0, JSON.stringify(receipt));
		assert.ok(Date.now() - cancellationStarted < 5_000, "Cancellation waited for the forced 30-second validation delay.");
		if (previousDelay === undefined) delete process.env[delayVariable];
		else process.env[delayVariable] = previousDelay;

		const runningProgram = join(source, "cancel-while-running.mjs");
		await writeFile(runningProgram, "setInterval(() => {}, 1_000);\n", "utf8");
		const runningHandle = await startIsolatedWindowsRun({
			runRootDirectory: cancelRoot,
			language: "node",
			executablePath: process.execPath,
			programPath: runningProgram,
			limits: { wallTimeMs: 30_000, outputLimitBytes: 16 * 1024 },
		});
		const runningDeadline = Date.now() + 15_000;
		let runningStatus;
		while (Date.now() < runningDeadline) {
			runningStatus = await getIsolatedWindowsRunStatus(runningHandle);
			if (runningStatus.status === "running") break;
			if (runningStatus.status !== "launching") throw new Error(`Worker stopped before it could receive a running cancellation: ${JSON.stringify(runningStatus)}`);
			await new Promise((resume) => setTimeout(resume, 25));
		}
		assert.equal(runningStatus?.status, "running", JSON.stringify(runningStatus));
		const runningCancellation = await cancelIsolatedWindowsRun(runningHandle);
		assert.equal(runningCancellation.status, "cancelled", JSON.stringify(runningCancellation));
		assert.ok(runningCancellation.processId > 0, JSON.stringify(runningCancellation));
		assert.ok(runningCancellation.wallTimeMs >= 0, JSON.stringify(runningCancellation));
	} finally {
		if (previousDelay === undefined) delete process.env[delayVariable];
		else process.env[delayVariable] = previousDelay;
		await rm(cancelRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
	}
});
