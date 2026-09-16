import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { join, resolve } from "node:path";
import { cpus, tmpdir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { stableStringify } from "../packages/harness-core/src/index.ts";
import {
	createNativeWindowsNodeAdapter,
	executionSha256,
	frozenEnvironmentDescriptorHash,
	StudyExecutionCoordinator,
	StudyExecutionCoordinatorError,
	StudyExecutionQueue,
	ensureDetachedStudyExecutionCoordinator,
	validateFrozenExecutionPayload,
} from "../packages/study-execution-host/src/index.ts";
import { StudyResearchHost } from "../packages/study-research-host/src/index.ts";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const execFileAsync = promisify(execFile);
const nodeStagingEvidenceDirectory = join(process.cwd(), ".artifacts", "study-research", "node-staging");

function setup() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
	`);
	database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run("project-a", JSON.stringify({ id: "project-a" }));
	database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("session-a", "project-a");
	const now = { value: Date.parse("2026-09-12T12:00:00.000Z") };
	const host = new StudyResearchHost(database, { clock: () => new Date(now.value) });
	host.bindSession("project-a", "session-a");
	const queue = new StudyExecutionQueue(database, host, { clock: () => new Date(now.value) });
	queue.configureTrustedPolicy(
		{ maxConcurrentRuns: 1, maxCpuMilliCores: 1_000_000, maxMemoryMiB: 1_024, leaseDurationMs: 1_000 },
		0,
	);
	const scope = () => {
		const phase = host.currentPhase("project-a", "session-a");
		if (!phase) throw new Error("fixture phase disappeared");
		return { projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: phase.revision };
	};
	const context = host.registerTrustedRunnerContext(scope(), "coordinator-test-runner");
	return { database, now, host, queue, scope, context };
}

function payloadParts() {
	const code = "console.log('coordinator fixture')\n";
	const parameters = stableStringify({ alpha: 3, label: "fixture" });
	const input = Buffer.from("frozen source bytes", "utf8");
	const environment = {
		adapterKind: "fake-v1",
		executablePath: "C:\\trusted\\node.exe",
		files: [{ absolutePath: "C:\\trusted\\node.exe", sha256: hash("trusted-node") }],
	};
	return {
		code,
		parameters,
		input,
		environment: { ...environment, descriptorHash: frozenEnvironmentDescriptorHash(environment) },
	};
}

function enqueue(f, dispatchKey) {
	const parts = payloadParts();
	const manifest = {
		codeHash: hash(parts.code),
		parameterHash: hash(parts.parameters),
		inputHashes: { "paper.txt": hash(parts.input) },
		environmentHash: parts.environment.descriptorHash,
	};
	const job = f.queue.enqueueStudy(f.scope(), {
		dispatchKey,
		kind: "execution",
		manifest,
		admission: {
			purpose: "Run a short fixture calculation using frozen code and source bytes.",
			language: "python",
			maxWallSeconds: 30,
			maxMemoryMiB: 256,
		},
		producerContextId: f.context.contextId,
		resources: { cpuMilliCores: 100, memoryMiB: 128, wallTimeMs: 500, diskBytes: 4_096 },
		quota: { maxRuns: 5, maxCumulativeWallTimeMs: 5_000, maxCumulativeDiskBytes: 50_000, expiresAt: null },
	}).job;
	return {
		job,
		payload: {
			version: 1,
			taskId: job.taskId,
			projectId: job.projectId,
			sessionId: job.sessionId,
			manifest,
			language: "node",
			program: { fileName: "cell.mjs", content: parts.code, sha256: hash(parts.code) },
			parameters: { canonicalJson: parts.parameters, sha256: hash(parts.parameters) },
			inputs: [{ name: "paper.txt", bytesBase64: parts.input.toString("base64"), sha256: hash(parts.input) }],
			environment: parts.environment,
			outputLimitBytes: 8_192,
		},
	};
}

function observation(status, { evidence = "fake process=42 creation=stable config=bound", logs = {} } = {}) {
	return {
		status,
		usage: { wallTimeMs: 7, diskBytes: 11 },
		processEvidence: evidence,
		logs: { stdout: logs.stdout ?? null, stderr: logs.stderr ?? null, error: logs.error ?? null },
	};
}

function fakeAdapter({ launch = observation("succeeded"), poll = observation("succeeded"), abandon = observation("cancelled", { evidence: null }) } = {}) {
	const calls = { prepare: 0, launch: 0, poll: 0, cancel: 0, abandon: 0 };
	return {
		kind: "fake-v1",
		calls,
		async prepare(input) {
			calls.prepare += 1;
			assert.equal(input.payload.program.content, "console.log('coordinator fixture')\n");
			return {
				kind: "fake-v1",
				version: 1,
				privateHandle: { opaque: "secret-owned-by-coordinator" },
				publicSummary: { adapter: "fake", payloadHash: input.payloadHash },
			};
		},
		async launch() {
			calls.launch += 1;
			return structuredClone(launch);
		},
		async poll() {
			calls.poll += 1;
			return structuredClone(poll);
		},
		async cancel() {
			calls.cancel += 1;
			return observation("cancelled", { evidence: null });
		},
		async abandonPrepared() {
			calls.abandon += 1;
			return structuredClone(abandon);
		},
	};
}

function coordinator(f, adapter) {
	return new StudyExecutionCoordinator({
		database: f.database,
		queue: f.queue,
		coordinatorId: "fixture-coordinator",
		adapters: [adapter],
		artifactDirectory: "C:\\coordinator-fixtures",
	});
}

async function nativeNodePreparationInput(f, directory, dispatchKey) {
	const { job, payload } = enqueue(f, dispatchKey);
	job.resources = {
		cpuMilliCores: cpus().length * 1_000,
		memoryMiB: 256,
		wallTimeMs: 5_000,
		diskBytes: 1_048_576,
	};
	const environment = {
		adapterKind: "native-windows-node-v1",
		executablePath: process.execPath,
		files: [{ absolutePath: process.execPath, sha256: executionSha256(await readFile(process.execPath)) }],
	};
	const nativePayload = validateFrozenExecutionPayload({
		...payload,
		manifest: { ...payload.manifest, environmentHash: frozenEnvironmentDescriptorHash(environment) },
		environment: { ...environment, descriptorHash: frozenEnvironmentDescriptorHash(environment) },
	});
	return {
		job,
		payload: nativePayload,
		payloadHash: hash(stableStringify(nativePayload)),
		artifactDirectory: directory,
	};
}

async function privateNodeStagingFiles(directory, root = directory) {
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
		if (entry.isDirectory()) files.push(...(await privateNodeStagingFiles(path, root)));
		else files.push(path.slice(root.length + 1).replaceAll("\\", "/"));
	}
	return files.sort();
}

async function assertNoPrivateNodeStagingFiles(runRoot) {
	assert.deepEqual(await privateNodeStagingFiles(join(runRoot, "private-node-payloads")), []);
}

function privateNodeStagingDirectory(runRoot, input, intent) {
	return join(
		runRoot,
		"private-node-payloads",
		input.job.queueJobId,
		input.payloadHash.slice("sha256:".length),
		`run-${intent.privateHandle.locator.preparationIdentity.runId}`,
	);
}

async function waitForDetachedWorker(databasePath, launchKey) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		let database;
		try {
			database = new DatabaseSync(databasePath);
			const row = database
				.prepare("SELECT payload FROM pi_study_execution_detached_worker WHERE launch_key = ?")
				.get(launchKey);
			const worker = row ? JSON.parse(row.payload) : null;
			if (worker?.status === "active") return worker;
		} finally {
			database?.close();
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("detached worker did not activate before its launch evidence timeout");
}

test("coordinator persists exact frozen bytes, supplies real process evidence for a first-poll terminal, and redacts public logs", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "terminal-first-poll");
		const adapter = fakeAdapter({ launch: observation("succeeded", { logs: { stdout: "token=do-not-publish\nvalue=4" } }) });
		const worker = coordinator(f, adapter);
		worker.persistPayload(job.queueJobId, payload);
		await worker.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "succeeded");
		assert.equal(adapter.calls.launch, 1);
		assert.deepEqual(
			f.host.listTaskEvents(f.scope(), job.taskId).map((event) => event.status),
			["queued", "admitted", "launching", "running", "succeeded"],
		);
		assert.match(worker.getPublicResult(job.queueJobId).logs.stdout, /token=\[redacted\]/);
		assert.equal("privateHandle" in f.queue.getJob(job.queueJobId).preparedHandle, false);
	} finally {
		f.database.close();
	}
});

test("a terminal success without correlated process evidence remains launching and cannot invent running", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "no-process-evidence");
		const worker = coordinator(f, fakeAdapter({ launch: observation("succeeded", { evidence: null }) }));
		worker.persistPayload(job.queueJobId, payload);
		await assert.rejects(() => worker.tick(), (error) => error instanceof StudyExecutionCoordinatorError && error.code === "POSITIVE_PROCESS_EVIDENCE_REQUIRED");
		assert.equal(f.queue.getJob(job.queueJobId).status, "launching");
		assert.equal(f.host.listTaskEvents(f.scope(), job.taskId).some((event) => event.status === "running"), false);
		assert.equal(worker.getPublicResult(job.queueJobId), null, "rejected evidence cannot publish a successful public result");
	} finally {
		f.database.close();
	}
});

test("a restarted coordinator reconciles an uncertain launch without launching the private handle twice", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "recover-on-restart");
		const adapter = fakeAdapter({ launch: observation("launching", { evidence: null }), poll: observation("succeeded") });
		const first = coordinator(f, adapter);
		first.persistPayload(job.queueJobId, payload);
		await first.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "launching");
		f.now.value += 1_001;
		const restarted = coordinator(f, adapter);
		await restarted.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "succeeded");
		assert.equal(adapter.calls.launch, 1);
		assert.equal(adapter.calls.poll, 1);
	} finally {
		f.database.close();
	}
});

test("prepared cancellation exposes the private cleanup handle to the claimant and records its true terminal receipt", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "prepared-cleanup");
		const adapter = fakeAdapter();
		const worker = coordinator(f, adapter);
		worker.persistPayload(job.queueJobId, payload);
		const claim = f.queue.claimNext("fixture-coordinator");
		f.queue.persistPreparedHandle(job.queueJobId, "fixture-coordinator", claim.job.claimRevision, {
			kind: "fake-v1",
			version: 1,
			privateHandle: { cleanup: "secret" },
			publicSummary: { adapter: "fake" },
		});
		f.queue.requestCancellation(job.queueJobId);
		f.now.value += 1_001;
		await worker.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "cancelled");
		assert.equal(adapter.calls.abandon, 1);
	} finally {
		f.database.close();
	}
});

test("a cancellation from a separate service instance reaches the active worker on its next tick", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "external-cancel");
		const adapter = fakeAdapter({ launch: observation("running"), poll: observation("running") });
		const worker = coordinator(f, adapter);
		worker.persistPayload(job.queueJobId, payload);
		await worker.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "running");
		f.queue.requestCancellation(job.queueJobId);
		await worker.tick();
		assert.equal(adapter.calls.cancel, 1); assert.equal(adapter.calls.poll, 0);
		assert.equal(f.queue.getJob(job.queueJobId).status, "cancelled");
		assert.equal(worker.getPublicResult(job.queueJobId).status, "cancelled");
	} finally { f.database.close(); }
});

test("late cancellation wins over a completed launch receipt without inventing a running transition", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "cancel-during-launch");
		const adapter = fakeAdapter();
		adapter.launch = async () => { f.queue.requestCancellation(job.queueJobId); return observation("succeeded"); };
		const worker = coordinator(f, adapter); worker.persistPayload(job.queueJobId, payload);
		await worker.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "cancelled");
		assert.equal(worker.getPublicResult(job.queueJobId).status, "cancelled");
		assert.equal(f.host.listTaskEvents(f.scope(), job.taskId).some((event) => event.status === "running"), false);
	} finally { f.database.close(); }
});

test("a deterministic prelaunch failure releases capacity and publishes a failure for that job", async () => {
	const f = setup();
	try {
		const first = enqueue(f, "invalid-environment"), second = enqueue(f, "following-valid-job");
		const adapter = fakeAdapter();
		const prepare = adapter.prepare;
		adapter.prepare = async (input) => { if (input.job.queueJobId === first.job.queueJobId) throw new Error("Environment hash changed"); return prepare(input); };
		const worker = coordinator(f, adapter);
		worker.persistPayload(first.job.queueJobId, first.payload); worker.persistPayload(second.job.queueJobId, second.payload);
		await worker.tick();
		assert.equal(f.queue.getJob(first.job.queueJobId).status, "failed");
		assert.match(worker.getPublicResult(first.job.queueJobId).logs.error, /Environment hash changed/);
		await worker.tick(); assert.equal(f.queue.getJob(second.job.queueJobId).status, "succeeded");
	} finally { f.database.close(); }
});

test("durable preparation identity survives a worker replacement and cancellation retains capacity until cleanup", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "durable-prepare");
		const adapter = fakeAdapter();
		let created = 0, attempts = 0;
		adapter.createPreparationIntent = () => { created++; return { kind: adapter.kind, version: 1, privateHandle: { runId: "fixed-run" }, publicSummary: { stage: "preparation" } }; };
		adapter.abandonPreparation = async () => observation("cancelled");
		const prepare = adapter.prepare;
		adapter.prepare = async (input, intent) => {
			assert.equal(intent.privateHandle.runId, "fixed-run");
			assert.equal(f.queue.getJob(job.queueJobId).preparedHandle.publicSummary.stage, "preparation");
			if (++attempts === 1) throw new StudyExecutionCoordinatorError("PREPARATION_BUSY", "Prior preparer still owns its journal");
			f.queue.requestCancellation(job.queueJobId);
			assert.equal(f.queue.getJob(job.queueJobId).status, "admitted", "cancellation cannot release an in-progress preparation");
			return prepare(input);
		};
		const first = coordinator(f, adapter); first.persistPayload(job.queueJobId, payload);
		await first.tick(); assert.equal(f.queue.getJob(job.queueJobId).status, "admitted");
		f.now.value += 1001;
		await coordinator(f, adapter).tick();
		assert.equal(created, 1); assert.equal(adapter.calls.launch, 0); assert.equal(adapter.calls.abandon, 1);
		assert.equal(f.queue.getJob(job.queueJobId).status, "cancelled");
	} finally { f.database.close(); }
});

test("settled overages control the public result and common JSON secrets are redacted", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "overage-public");
		const receipt = observation("succeeded", { logs: { stdout: '{"token":"do-not-publish","result":3}' } });
		receipt.usage.diskBytes = 5000;
		const worker = coordinator(f, fakeAdapter({ launch: receipt })); worker.persistPayload(job.queueJobId, payload);
		await worker.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "limit-reached");
		assert.equal(worker.getPublicResult(job.queueJobId).status, "limit-reached");
		assert.match(worker.getPublicResult(job.queueJobId).logs.stdout, /"token":"\[redacted\]"/);
	} finally { f.database.close(); }
});

test("payload validation rejects changed source bytes and environment descriptors before a queue claim", () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "reject-mutation");
		const worker = coordinator(f, fakeAdapter());
		assert.throws(
			() => worker.persistPayload(job.queueJobId, { ...payload, inputs: [{ ...payload.inputs[0], bytesBase64: Buffer.from("changed").toString("base64") }] }),
			(error) => error?.code === "PAYLOAD_INPUT_HASH_MISMATCH",
		);
		assert.throws(
			() => worker.persistPayload(job.queueJobId, { ...payload, environment: { ...payload.environment, descriptorHash: executionSha256("changed") } }),
			(error) => error?.code === "PAYLOAD_ENVIRONMENT_HASH_MISMATCH",
		);
	} finally {
		f.database.close();
	}
});

test("payload validation preserves a zero-byte frozen source as canonical empty base64", () => {
	const f = setup();
	try {
		const { payload } = enqueue(f, "empty-source-bytes");
		const emptyHash = hash(Buffer.alloc(0));
		const manifest = { ...payload.manifest, inputHashes: { "empty.csv": emptyHash } };
		const valid = validateFrozenExecutionPayload({
			...payload,
			manifest,
			inputs: [{ name: "empty.csv", bytesBase64: "", sha256: emptyHash }],
		});
		assert.equal(valid.inputs[0].bytesBase64, "");
	} finally {
		f.database.close();
	}
});

test("payload persistence joins an outer admission transaction and leaves no claimable orphan after rollback", () => {
	const f = setup();
	try {
		const worker = coordinator(f, fakeAdapter());
		assert.throws(() => {
			f.database.exec("BEGIN IMMEDIATE");
			try {
				const { job, payload } = enqueue(f, "outer-admission-rollback");
				worker.persistPayload(job.queueJobId, payload);
				throw new Error("force admission rollback");
			} catch (error) {
				f.database.exec("ROLLBACK");
				throw error;
			}
		}, /force admission rollback/);
		assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_execution_job").get().count, 0);
		assert.equal(
			f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_execution_frozen_payload").get().count,
			0,
		);
	} finally {
		f.database.close();
	}
});

test("a frozen learning task remains executable after the interactive phase changes", async () => {
	const f = setup();
	try {
		const { job, payload } = enqueue(f, "phase-switch-after-admission");
		const worker = coordinator(f, fakeAdapter());
		worker.persistPayload(job.queueJobId, payload);
		f.host.setPhase(f.scope(), "research");
		await worker.tick();
		assert.equal(f.queue.getJob(job.queueJobId).status, "succeeded");
		assert.equal(f.host.readTaskForCoordinator(job.taskId).authorization.phase, "study");
	} finally {
		f.database.close();
	}
});

test("native adapter has no fallback for an unverified Python or R environment", async () => {
	const adapter = createNativeWindowsNodeAdapter({ runRootDirectory: "C:\\coordinator-fixtures", cpuRatePercent: 25 });
	await assert.rejects(
		() =>
			adapter.prepare({
				job: {},
				payload: { language: "python" },
				payloadHash: hash("unused"),
				artifactDirectory: "C:\\coordinator-fixtures",
			}),
		(error) => error instanceof StudyExecutionCoordinatorError && error.code === "ENVIRONMENT_VERIFIER_UNAVAILABLE",
	);
});

test("payload output bounds support the frontend default and reject amounts beyond the runner ceiling", () => {
	const f = setup();
	try {
		const { payload } = enqueue(f, "output-bound");
		assert.equal(validateFrozenExecutionPayload({ ...payload, outputLimitBytes: 16 * 1024 * 1024 }).outputLimitBytes, 16 * 1024 * 1024);
		assert.throws(() => validateFrozenExecutionPayload({ ...payload, outputLimitBytes: 64 * 1024 * 1024 + 1 }), /outputLimitBytes/);
	} finally { f.database.close(); }
});

test("native Node preparation reopens one durable identity after prepare-before-persist interruption", async () => {
	if (process.platform !== "win32") return;
	const f = setup();
	const directory = await mkdtemp(join(tmpdir(), "study-node-preparation-"));
	try {
		const { job, payload } = enqueue(f, "durable-native-prepare");
		job.resources = { cpuMilliCores: cpus().length * 1000, memoryMiB: 256, wallTimeMs: 5000, diskBytes: 1048576 };
		const environment = { adapterKind: "native-windows-node-v1", executablePath: process.execPath,
			files: [{ absolutePath: process.execPath, sha256: hash(await readFile(process.execPath)) }] };
		payload.environment = { ...environment, descriptorHash: frozenEnvironmentDescriptorHash(environment) };
		payload.manifest.environmentHash = payload.environment.descriptorHash;
		const input = { job, payload: validateFrozenExecutionPayload(payload), payloadHash: hash(stableStringify(payload)), artifactDirectory: directory };
		const adapter = createNativeWindowsNodeAdapter({ runRootDirectory: directory, cpuRatePercent: 25 });
		const unused = adapter.createPreparationIntent(input);
		assert.equal((await adapter.abandonPreparation(unused)).status, "cancelled");
		const intent = adapter.createPreparationIntent(input);
		const prepared = await adapter.prepare(input, intent);
		// Only the durable intent survived the coordinator interruption, not its returned handle.
		const replacement = createNativeWindowsNodeAdapter({ runRootDirectory: directory, cpuRatePercent: 25 });
		const recovered = await replacement.prepare(input, structuredClone(intent));
		assert.equal(recovered.privateHandle.runner.runId, prepared.privateHandle.runner.runId);
		assert.equal(recovered.privateHandle.runner.configBindingHash, prepared.privateHandle.runner.configBindingHash);
		assert.equal((await replacement.abandonPreparation(intent)).status, "cancelled");
	} finally { f.database.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("native Node staging is unique per durable run and is cleaned or fails closed after snapshot preparation", async () => {
	if (process.platform !== "win32") return;
	const f = setup();
	const directory = await mkdtemp(join(tmpdir(), "study-node-staging-"));
	try {
		const input = await nativeNodePreparationInput(f, directory, "native-node-staging");
		const adapter = createNativeWindowsNodeAdapter({ runRootDirectory: directory, cpuRatePercent: 25 });
		const firstIntent = adapter.createPreparationIntent(input);
		const secondIntent = adapter.createPreparationIntent(input);
		assert.notEqual(
			firstIntent.privateHandle.locator.preparationIdentity.runId,
			secondIntent.privateHandle.locator.preparationIdentity.runId,
		);
		const [first, second] = await Promise.all([adapter.prepare(input, firstIntent), adapter.prepare(input, secondIntent)]);
		await assertNoPrivateNodeStagingFiles(directory);
		await Promise.all([adapter.abandonPrepared(first), adapter.abandonPrepared(second)]);

		const runnerFailureAdapter = createNativeWindowsNodeAdapter({
			runRootDirectory: directory,
			cpuRatePercent: 25,
			afterMaterializeForTesting: async ({ stagingDirectory, programFileName }) => {
				await rm(join(stagingDirectory, programFileName));
			},
		});
		const runnerFailureIntent = runnerFailureAdapter.createPreparationIntent(input);
		await assert.rejects(
			() => runnerFailureAdapter.prepare(input, runnerFailureIntent),
			(error) => error?.code === "ENOENT",
		);
		await assertNoPrivateNodeStagingFiles(directory);
		assert.equal((await runnerFailureAdapter.abandonPreparation(runnerFailureIntent)).status, "cancelled");

		const cleanupFailureAdapter = createNativeWindowsNodeAdapter({
			runRootDirectory: directory,
			cpuRatePercent: 25,
			afterMaterializeForTesting: async ({ stagingDirectory, inputFileNames }) => {
				await writeFile(join(stagingDirectory, inputFileNames[0]), "staging mutation", "utf8");
			},
			beforeStagingCleanupForTesting: async ({ stagingDirectory }) => {
				await rm(stagingDirectory, { recursive: true, force: true });
				await writeFile(stagingDirectory, "staging cleanup replacement", "utf8");
			},
		});
		const cleanupFailureIntent = cleanupFailureAdapter.createPreparationIntent(input);
		const cleanupFailureStagingDirectory = privateNodeStagingDirectory(directory, input, cleanupFailureIntent);
		await assert.rejects(
			() => cleanupFailureAdapter.prepare(input, cleanupFailureIntent),
			(error) =>
				error?.code === "NODE_STAGING_CLEANUP_FAILED" &&
				/Runner program or input bytes differ/iu.test(error.message) &&
				/prepared runner was abandoned/iu.test(error.message),
		);
		assert.equal(await readFile(cleanupFailureStagingDirectory, "utf8"), "staging cleanup replacement");
		const cleanupFailureStatus = JSON.parse(
			await readFile(
				join(
					directory,
					`run-${cleanupFailureIntent.privateHandle.locator.preparationIdentity.runId}`,
					"control",
					"status.json",
				),
				"utf8",
			),
		);
		assert.equal(cleanupFailureStatus.Status, "cancelled");
		await rm(cleanupFailureStagingDirectory, { force: true });
		await assertNoPrivateNodeStagingFiles(directory);
	} finally {
		f.database.close();
		await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("a launcher may exit after the request while the detached coordinator activates its own durable process fence", async () => {
	if (process.platform !== "win32") return;
	const directory = await mkdtemp(join(tmpdir(), "study-coordinator-detached-"));
	let workerProcessId = null;
	try {
		const databasePath = join(directory, "harness.sqlite");
		const runRootDirectory = join(directory, "runs");
		const artifactDirectory = join(directory, "artifacts");
		const scriptPath = resolve("scripts/study-execution-coordinator.mjs");
		const launcherPath = join(directory, "launch-worker.mjs");
		const coordinatorUrl = pathToFileURL(resolve("packages/study-execution-host/src/coordinator.ts")).href;
		await writeFile(
			launcherPath,
			`import { DatabaseSync } from "node:sqlite";
import { ensureDetachedStudyExecutionCoordinator } from ${JSON.stringify(coordinatorUrl)};
const database = new DatabaseSync(process.argv[2]);
try {
  const result = await ensureDetachedStudyExecutionCoordinator(database, {
    databasePath: process.argv[2], scriptPath: process.argv[3], runRootDirectory: process.argv[4], artifactDirectory: process.argv[5], coordinatorId: "parent-exit-fixture"
  });
  process.stdout.write(JSON.stringify(result));
} finally {
  database.close();
}
`,
			"utf8",
		);
		const launched = await execFileAsync(
			process.execPath,
			["--import", "tsx", launcherPath, databasePath, scriptPath, runRootDirectory, artifactDirectory],
			{ timeout: 20_000 },
		);
		const request = JSON.parse(launched.stdout);
		assert.equal(request.status, "started");
		assert.equal(request.ready, false);
		workerProcessId = request.processId;
		const worker = await waitForDetachedWorker(databasePath, request.launchKey);
		assert.equal(worker.processId, request.processId);
		assert.match(worker.processCreationIdentity, /^\d{15,20}$/u);
		const serviceDatabase = new DatabaseSync(databasePath);
		try {
			const repeated = await ensureDetachedStudyExecutionCoordinator(serviceDatabase, {
				databasePath,
				scriptPath,
				runRootDirectory,
				artifactDirectory,
				coordinatorId: "parent-exit-fixture",
			});
			assert.deepEqual(
				{ status: repeated.status, processId: repeated.processId, ready: repeated.ready },
				{ status: "already-running", processId: request.processId, ready: false },
			);
		} finally {
			serviceDatabase.close();
		}
		await mkdir(nodeStagingEvidenceDirectory, { recursive: true });
		await writeFile(
			join(nodeStagingEvidenceDirectory, "detached-worker-evidence.json"),
			`${JSON.stringify({ request, worker: { status: worker.status, processId: worker.processId, launchKey: worker.launchKey } }, null, 2)}\n`,
			"utf8",
		);
	} finally {
		if (workerProcessId) process.kill(workerProcessId);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await rm(directory, { recursive: true, force: true });
	}
});

test("native Node adapter executes an immutable AppContainer fixture through the detached coordinator", async () => {
	if (process.platform !== "win32") return;
	const f = setup();
	const artifactDirectory = await mkdtemp(join(tmpdir(), "study-coordinator-native-"));
	try {
		const code = "console.log('native-coordinator-result:4')\n";
		const parameters = stableStringify({ fixture: true });
		const executablePath = process.execPath;
		const executableHash = executionSha256(await readFile(executablePath));
		const environment = {
			adapterKind: "native-windows-node-v1",
			executablePath,
			files: [{ absolutePath: executablePath, sha256: executableHash }],
		};
		const descriptorHash = frozenEnvironmentDescriptorHash(environment);
		const manifest = {
			codeHash: executionSha256(code),
			parameterHash: executionSha256(parameters),
			inputHashes: {},
			environmentHash: descriptorHash,
		};
		const job = f.queue.enqueueStudy(f.scope(), {
			dispatchKey: "native-appcontainer-fixture",
			kind: "execution",
			manifest,
			admission: {
				purpose: "Execute a short AppContainer fixture with frozen Node bytes.",
				language: "python",
				maxWallSeconds: 30,
				maxMemoryMiB: 256,
			},
			producerContextId: f.context.contextId,
			resources: { cpuMilliCores: cpus().length * 1_000, memoryMiB: 256, wallTimeMs: 5_000, diskBytes: 64 * 1024 },
			quota: { maxRuns: 2, maxCumulativeWallTimeMs: 10_000, maxCumulativeDiskBytes: 128 * 1024, expiresAt: null },
		}).job;
		const worker = new StudyExecutionCoordinator({
			database: f.database,
			queue: f.queue,
			coordinatorId: "native-fixture-coordinator",
			adapters: [createNativeWindowsNodeAdapter({ runRootDirectory: artifactDirectory, cpuRatePercent: 25 })],
			artifactDirectory,
		});
		worker.persistPayload(job.queueJobId, {
			version: 1,
			taskId: job.taskId,
			projectId: job.projectId,
			sessionId: job.sessionId,
			manifest,
			language: "node",
			program: { fileName: "fixture.mjs", content: code, sha256: executionSha256(code) },
			parameters: { canonicalJson: parameters, sha256: executionSha256(parameters) },
			inputs: [],
			environment: { ...environment, descriptorHash },
			outputLimitBytes: 16 * 1024,
		});
		for (let attempt = 0; attempt < 80 && !["succeeded", "failed", "cancelled", "limit-reached"].includes(f.queue.getJob(job.queueJobId).status); attempt += 1) {
			await worker.tick();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(f.queue.getJob(job.queueJobId).status, "succeeded");
		const result = worker.getPublicResult(job.queueJobId);
		assert.match(result.logs.stdout, /native-coordinator-result:4/);
		await mkdir(nodeStagingEvidenceDirectory, { recursive: true });
		await writeFile(
			join(nodeStagingEvidenceDirectory, "native-node-evidence.json"),
			`${JSON.stringify(
				{
					capturedAt: new Date().toISOString(),
					adapterKind: environment.adapterKind,
					queueJobId: job.queueJobId,
					status: f.queue.getJob(job.queueJobId).status,
					manifest,
					publicResult: result,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
	} finally {
		f.database.close();
		await rm(artifactDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
