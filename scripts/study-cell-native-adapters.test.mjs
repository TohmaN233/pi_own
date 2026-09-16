import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableStringify } from "../packages/harness-core/src/index.ts";
import {
	createNativeWindowsCellAdapters,
	describeNativeCellOutputArtifacts,
	readNativeCellOutputArtifact,
} from "../packages/study-execution-host/src/cell-native-adapters.ts";
import {
	createProjectPythonEnvironment,
	discoverRGlobalLibraryEnvironment,
	PYTHON_PROJECT_VENV_ADAPTER,
	R_GLOBAL_LIBRARY_ADAPTER,
} from "../packages/study-execution-host/src/environments.ts";
import { executionSha256 } from "../packages/study-execution-host/src/execution-payloads.ts";

const terminal = new Set(["succeeded", "failed", "cancelled", "limit-reached"]);

function payload({ language, environment, code, parameters = {}, inputs = [] }) {
	const canonicalJson = stableStringify(parameters);
	const frozenInputs = inputs.map(({ name, bytes }) => ({
		name,
		bytesBase64: Buffer.from(bytes).toString("base64"),
		sha256: executionSha256(bytes),
	}));
	return {
		version: 1,
		taskId: `task-${language}`,
		projectId: "cell-native-fixture",
		sessionId: "session-cell-native-fixture",
		manifest: {
			codeHash: executionSha256(code),
			parameterHash: executionSha256(canonicalJson),
			inputHashes: Object.fromEntries(frozenInputs.map((item) => [item.name, item.sha256])),
			environmentHash: environment.descriptorHash,
		},
		language,
		program: { fileName: language === "python" ? "raw.py" : "raw.R", content: code, sha256: executionSha256(code) },
		parameters: { canonicalJson, sha256: executionSha256(canonicalJson) },
		inputs: frozenInputs,
		environment,
		outputLimitBytes: 128 * 1024,
	};
}

function preparation(queueJobId, frozenPayload) {
	return {
		job: {
			queueJobId,
			resources: {
				cpuMilliCores: cpus().length * 1_000,
				memoryMiB: 512,
				wallTimeMs: 30_000,
				diskBytes: 128 * 1024,
			},
		},
		payload: frozenPayload,
		payloadHash: executionSha256(stableStringify(frozenPayload)),
		artifactDirectory: "C:\\cell-native-artifacts",
	};
}

async function complete(adapter, handle) {
	let receipt = await adapter.launch(handle);
	for (let attempt = 0; attempt < 180 && !terminal.has(receipt.status); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		receipt = await adapter.poll(handle);
	}
	if (!terminal.has(receipt.status)) throw new Error("native cell run did not reach a terminal receipt");
	return receipt;
}

async function prepareWithDurableIntent(adapter, input) {
	const intent = adapter.createPreparationIntent(input);
	assert.match(intent.privateHandle.preparationIdentity.runId, /^[0-9a-f-]{36}$/iu);
	assert.match(intent.privateHandle.preparationIdentity.cancelToken, /^[0-9a-f-]{36}$/iu);
	const prepared = await adapter.prepare(input, intent);
	assert.equal(prepared.privateHandle.runner.runId, intent.privateHandle.preparationIdentity.runId);
	assert.equal(prepared.privateHandle.runner.cancelToken, intent.privateHandle.preparationIdentity.cancelToken);
	return prepared;
}

async function privateStagingFiles(directory, root = directory) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await privateStagingFiles(path, root)));
		} else {
			files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
		}
	}
	return files.sort();
}

async function assertNoPrivateStagingFiles(runRoot) {
	assert.deepEqual(await privateStagingFiles(join(runRoot, "private-cell-payloads")), []);
}

function privateStagingDirectory(runRoot, input, intent) {
	return join(
		runRoot,
		"private-cell-payloads",
		input.job.queueJobId,
		input.payloadHash.slice("sha256:".length),
		`run-${intent.privateHandle.preparationIdentity.runId}`,
	);
}

async function assertSucceededReceipt(label, receipt, handle) {
	if (receipt.status === "succeeded") return;
	const directory = join(process.cwd(), ".artifacts", "study-research", "cell-native");
	await mkdir(directory, { recursive: true });
	const runner = handle.privateHandle.runner;
	const configPath = join(runner.controlDirectory, "config.json");
	const statusPath = join(runner.controlDirectory, "status.json");
	await writeFile(
		join(directory, `${label}-failure-evidence.json`),
		`${JSON.stringify(
			{
				receipt,
				config: JSON.parse(await readFile(configPath, "utf8")),
				status: JSON.parse(await readFile(statusPath, "utf8")),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
}

test("frozen Python/R cells run with parameter and input mappings, emit artifacts, reject tampered environments, and preserve error/cancel receipts", async () => {
	if (process.platform !== "win32") return;
	const root = await mkdtemp(join(tmpdir(), "study-cell-native-"));
	let completed = false;
	try {
		const projectDirectory = join(root, "project");
		await mkdir(projectDirectory, { recursive: true });
		const outsideInput = join(root, "outside-frozen-input.txt");
		await writeFile(outsideInput, "private-cell-outside", "utf8");
		const python = await createProjectPythonEnvironment({ projectDirectory, venvDirectory: ".fixture-venv" });
		const r = await discoverRGlobalLibraryEnvironment();
		const adapters = createNativeWindowsCellAdapters({ runRootDirectory: join(root, "runs"), cpuRatePercent: 25 });
		const tamperingAdapters = createNativeWindowsCellAdapters({
			runRootDirectory: join(root, "runs"),
			cpuRatePercent: 25,
			afterMaterializeForTesting: async ({ stagingDirectory, inputFileNames }) => {
				await writeFile(join(stagingDirectory, inputFileNames[0]), "staging-mutation", "utf8");
			},
			beforeStagingCleanupForTesting: async ({ stagingDirectory }) => {
				await rm(stagingDirectory, { recursive: true, force: true });
				await writeFile(stagingDirectory, "staging cleanup replacement", "utf8");
			},
		});
		const callbackRejectingAdapters = createNativeWindowsCellAdapters({
			runRootDirectory: join(root, "runs"),
			cpuRatePercent: 25,
			afterMaterializeForTesting: async () => {
				throw new Error("test materialization callback rejection");
			},
		});
		const pythonAdapter = adapters.find((adapter) => adapter.kind === PYTHON_PROJECT_VENV_ADAPTER);
		const rAdapter = adapters.find((adapter) => adapter.kind === R_GLOBAL_LIBRARY_ADAPTER);
		const tamperingPythonAdapter = tamperingAdapters.find((adapter) => adapter.kind === PYTHON_PROJECT_VENV_ADAPTER);
		const callbackRejectingPythonAdapter = callbackRejectingAdapters.find(
			(adapter) => adapter.kind === PYTHON_PROJECT_VENV_ADAPTER,
		);
		assert.ok(pythonAdapter);
		assert.ok(rAdapter);
		assert.ok(tamperingPythonAdapter);
		assert.ok(callbackRejectingPythonAdapter);
		const neverPrepared = pythonAdapter.createPreparationIntent(
			preparation("python-cancel-before-prepare", payload({ language: "python", environment: python.environment, code: "pass" })),
		);
		const neverPreparedCancelled = await pythonAdapter.abandonPreparation(neverPrepared);
		assert.deepEqual(neverPreparedCancelled, {
			status: "cancelled",
			usage: { wallTimeMs: 0, diskBytes: 0 },
			processEvidence: null,
			logs: { stdout: null, stderr: null, error: null },
		});

		const pythonPayload = payload({
			language: "python",
			environment: python.environment,
			parameters: { offset: 3 },
			inputs: [{ name: "values.csv", bytes: "4\n" }],
			code: [
				"from pathlib import Path",
				"answer = int(Path(inputs['values.csv']).read_text().strip()) + parameters['offset']",
				"Path(output_directory, 'python-answer.txt').write_text(str(answer), encoding='utf-8')",
				"Path(output_directory, 'unsafe.html').write_text('<script>unsafe</script>', encoding='utf-8')",
				"print(f'python-answer={answer}')",
			].join("\n"),
		});
		const pythonHandle = await prepareWithDurableIntent(pythonAdapter, preparation("python-success", pythonPayload));
		await assertNoPrivateStagingFiles(join(root, "runs"));
		const pythonReceipt = await complete(pythonAdapter, pythonHandle);
		await assertSucceededReceipt("python", pythonReceipt, pythonHandle);
		assert.match(pythonReceipt.logs.stdout, /python-answer=7/);
		const pythonArtifacts = await describeNativeCellOutputArtifacts(pythonHandle);
		const pythonAnswer = pythonArtifacts.find((artifact) => artifact.path === "python-answer.txt");
		assert.ok(pythonAnswer);
		assert.equal(Buffer.from((await readNativeCellOutputArtifact(pythonHandle, pythonAnswer)).bytes).toString("utf8"), "7");
		assert.deepEqual(pythonArtifacts.find((artifact) => artifact.path === "unsafe.html"), {
			path: "unsafe.html",
			bytes: 23,
			sha256: executionSha256("<script>unsafe</script>"),
			mediaType: "text/html",
			contentDisposition: "attachment",
		});
		await assert.rejects(
			() => readNativeCellOutputArtifact(pythonHandle, { ...pythonAnswer, path: "../stdout.log" }),
			(error) => error?.code === "ARTIFACT_DESCRIPTOR_REJECTED",
		);

		const rPayload = payload({
			language: "rscript",
			environment: r.environment,
			parameters: { offset: 5 },
			inputs: [{ name: "values.csv", bytes: "8\n" }],
			code: [
				"answer <- as.integer(readLines(inputs[['values.csv']])) + parameters$offset",
				"writeLines(as.character(answer), file.path(output_directory, 'r-answer.txt'))",
				"plot(c(1, answer), c(answer, 1))",
				"cat(sprintf('r-answer=%d\\n', answer))",
			].join("\n"),
		});
		const rHandle = await prepareWithDurableIntent(rAdapter, preparation("r-success", rPayload));
		await assertNoPrivateStagingFiles(join(root, "runs"));
		const rReceipt = await complete(rAdapter, rHandle);
		await assertSucceededReceipt("r", rReceipt, rHandle);
		assert.match(rReceipt.logs.stdout, /r-answer=13/);
		const rArtifacts = await describeNativeCellOutputArtifacts(rHandle);
		const rAnswer = rArtifacts.find((artifact) => artifact.path === "r-answer.txt");
		assert.ok(rAnswer);
		assert.equal(Buffer.from((await readNativeCellOutputArtifact(rHandle, rAnswer)).bytes).toString("utf8").trim(), "13");
		assert.ok(rArtifacts.some((artifact) => artifact.path.startsWith("plot-") && artifact.mediaType === "image/png"));

		const tampered = payload({
			language: "python",
			environment: { ...python.environment, files: [{ ...python.environment.files[0], sha256: executionSha256("tampered") }] },
			code: "print('not reached')",
		});
		await assert.rejects(
			() => prepareWithDurableIntent(pythonAdapter, preparation("python-tampered", tampered)),
			(error) => error?.code === "ENVIRONMENT_DESCRIPTOR_HASH_MISMATCH",
		);
		const stagingTampered = payload({
			language: "python",
			environment: python.environment,
			inputs: [{ name: "unextended", bytes: "4\n" }],
			code: "print('not reached')",
		});
		const callbackRejected = preparation("python-callback-rejected", stagingTampered);
		await assert.rejects(
			() => prepareWithDurableIntent(callbackRejectingPythonAdapter, callbackRejected),
			/test materialization callback rejection/u,
		);
		await assertNoPrivateStagingFiles(join(root, "runs"));

		const tamperedPreparation = preparation("python-staging-tampered", stagingTampered);
		const tamperedIntent = tamperingPythonAdapter.createPreparationIntent(tamperedPreparation);
		const tamperedStagingDirectory = privateStagingDirectory(join(root, "runs"), tamperedPreparation, tamperedIntent);
		await assert.rejects(
			() => tamperingPythonAdapter.prepare(tamperedPreparation, tamperedIntent),
			(error) =>
				error?.code === "CELL_STAGING_CLEANUP_FAILED" &&
				/CELL_SNAPSHOT_INPUT_HASH_MISMATCH/iu.test(error.message),
		);
		assert.equal(await readFile(tamperedStagingDirectory, "utf8"), "staging cleanup replacement");
		const tamperedStatus = JSON.parse(
			await readFile(
				join(
					root,
					"runs",
					`run-${tamperedIntent.privateHandle.preparationIdentity.runId}`,
					"control",
					"status.json",
				),
				"utf8",
			),
		);
		assert.equal(tamperedStatus.Status, "cancelled");
		await rm(tamperedStagingDirectory, { force: true });
		await assertNoPrivateStagingFiles(join(root, "runs"));

		const failed = payload({
			language: "python",
			environment: python.environment,
			code: `from pathlib import Path\nprint(Path(${JSON.stringify(outsideInput)}).read_text(encoding="utf-8"))`,
		});
		const failedHandle = await prepareWithDurableIntent(pythonAdapter, preparation("python-failed", failed));
		const failedReceipt = await complete(pythonAdapter, failedHandle);
		assert.equal(failedReceipt.status, "failed");
		assert.doesNotMatch(
			[failedReceipt.logs.stdout, failedReceipt.logs.stderr, failedReceipt.logs.error].filter(Boolean).join("\n"),
			/private-cell-outside/,
		);

		const cancellable = payload({
			language: "python",
			environment: python.environment,
			code: "import time\ntime.sleep(25)",
		});
		const cancelledHandle = await prepareWithDurableIntent(pythonAdapter, preparation("python-cancelled", cancellable));
		await assertNoPrivateStagingFiles(join(root, "runs"));
		await pythonAdapter.launch(cancelledHandle);
		const cancelledReceipt = await pythonAdapter.cancel(cancelledHandle);
		assert.equal(cancelledReceipt.status, "cancelled");

		await mkdir(join(process.cwd(), ".artifacts", "study-research", "cell-native"), { recursive: true });
		await writeFile(
			join(process.cwd(), ".artifacts", "study-research", "cell-native", "r-python-evidence.json"),
			`${JSON.stringify(
				{
					python: { status: pythonReceipt.status, artifacts: pythonArtifacts },
					r: { status: rReceipt.status, artifacts: rArtifacts },
					failed: { status: failedReceipt.status },
					cancelled: { status: cancelledReceipt.status },
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		completed = true;
	} finally {
		if (!completed) {
			process.stderr.write(`cell-native fixture retained after failure: ${root}\n`);
		} else {
			try {
				await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
			} catch (cleanupError) {
				throw cleanupError;
			}
		}
	}
});
