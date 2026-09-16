import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { createNativeWindowsNodeAdapter } from "../packages/study-execution-host/src/coordinator.ts";
import { buildVisualValidationProgram, readVisualValidationObservations, VISUAL_VALIDATION_OBSERVATION_MARKER } from "../packages/study-execution-host/src/visual-validation-execution.ts";
import { executionSha256, frozenEnvironmentDescriptorHash } from "../packages/study-execution-host/src/execution-payloads.ts";
import { compareVisualObservations } from "../packages/study-research-host/src/visual-validation.ts";

const execFileAsync = promisify(execFile);

function fixtureSpecification(targetHash, sourceId, sourceHash) {
	const cases = [
		{ id: "ordinary", category: "ordinary", description: "ordinary input", inputs: { value: 1 }, expectedValue: 1 },
		{ id: "boundary", category: "boundary", description: "boundary input", inputs: { value: 0 }, expectedValue: 0 },
		{ id: "degenerate", category: "degenerate", description: "degenerate input", inputs: { value: -1 }, expectedValue: -1 },
		{ id: "interaction", category: "interaction", description: "interaction input", inputs: { value: 2 }, expectedValue: 2 },
	];
	return {
		version: 1,
		targetHash,
		scope: "Read the metric produced by four frozen scalar inputs.",
		assumptions: ["The metric is the scalar input value."],
		oracle: {
			kind: "hand-calculation",
			description: "The expected metric is the supplied scalar value.",
			material: "Independent hand calculation: metric = value for each case. ORACLE-MUST-NOT-REACH-SUBJECT",
			sourceReferences: [{ sourceId, sourceHash, locator: "§ fixture scalar metric" }],
		},
		cases: cases.map(({ expectedValue, ...entry }) => ({
			...entry,
			expected: [{ path: ["metrics", "value"], value: expectedValue, absoluteTolerance: 0, relativeTolerance: 0 }],
		})),
	};
}

function runtimeCases(specification) {
	return specification.cases.map((entry) => ({ caseId: entry.id, inputHash: contentHash(entry.inputs), inputs: entry.inputs }));
}

function nativeEnvironment() {
	const executablePath = process.execPath;
	const body = { adapterKind: "native-windows-node-v1", executablePath,
		files: [{ absolutePath: executablePath, sha256: executionSha256(readFileSync(executablePath)) }] };
	return { ...body, descriptorHash: frozenEnvironmentDescriptorHash(body) };
}

function receipt(run, specification, mutate = (observations) => observations) {
	const observations = specification.cases.map((entry) => ({
		caseId: entry.id,
		inputHash: contentHash(entry.inputs),
		status: "returned",
		scene: { metrics: { value: entry.inputs.value } },
		error: null,
	}));
	return `${VISUAL_VALIDATION_OBSERVATION_MARKER}${JSON.stringify({ version: 1, key: run.outputKey, observations: mutate(observations) })}\n`;
}

function setup(t) {
	const artifactParent = join(process.cwd(), ".artifacts", "study-research", "visual-validation");
	const root = mkdtempSync(join(artifactParent, "execution-test-"));
	const databasePath = join(root, "harness.sqlite");
	let harness = null;
	const closeBeforeHarness = [];
	t.after(async () => {
		for (const close of closeBeforeHarness) close();
		harness?.close();
		await new Promise((resolve) => setTimeout(resolve, 300));
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	harness = new LearningHarness({ databasePath });
	harness.projectWorkspaces.create({ id: "project", title: "Visual fixture", cwd: root, defaults: null, courseProjectId: null });
	harness.projectWorkspaces.move("session", "project");
	harness.studyResearch.bindSession("project", "session");
	const scope = () => {
		const phase = harness.studyResearch.currentPhase("project", "session");
		if (!phase) throw new Error("fixture phase missing");
		return { projectId: "project", sessionId: "session", expectedPhaseRevision: phase.revision };
	};
	const sourceBytes = "metric = input value\n";
	const source = harness.studyResearch.registerSource(scope(), {
		sourceRoot: root, relativePath: "oracle.txt", kind: "text", sourceRole: "primary", diagnostics: [],
		contentHash: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`,
		parser: "fixture/1", chunks: [{ ordinal: 1, locator: JSON.stringify({ section: "fixture" }), text: sourceBytes }],
	}, 0);
	const creator = harness.studyResearch.registerTrustedRunnerContext(scope(), "visual-fixture-creator");
	const visualization = harness.studyResearch.createVisualizationDraft(scope(), {
		purpose: "Fixture visual", code: "return { metrics: { value: inputs.value }, elements: [] };", inputs: { value: 1 }, inputHashes: {},
		environmentHash: contentHash("fixture visual runtime"), creatorContextId: creator.contextId,
	}, 1);
	harness.studyExecution.configureTrustedPolicy({ maxConcurrentRuns: 1, maxCpuMilliCores: 2_000, maxMemoryMiB: 1_024, leaseDurationMs: 10_000 }, 0);
	let stdout = null;
	const adapter = {
		kind: "native-windows-node-v1",
		async prepare() { return { kind: "native-windows-node-v1", version: 1, privateHandle: {}, publicSummary: {} }; },
		async launch() { return { status: "succeeded", usage: { wallTimeMs: 3, diskBytes: 100 }, processEvidence: "fixture process=7", logs: { stdout, stderr: null, error: null } }; },
		async poll() { throw new Error("fixture validation completes during launch"); },
		async cancel() { return { status: "cancelled", usage: { wallTimeMs: 0, diskBytes: 0 }, processEvidence: null, logs: { stdout: null, stderr: null, error: null } }; },
		async abandonPrepared() { return { status: "cancelled", usage: { wallTimeMs: 0, diskBytes: 0 }, processEvidence: null, logs: { stdout: null, stderr: null, error: null } }; },
	};
	const coordinatorOptions = { coordinatorId: "visual-validation-fixture", adapters: [adapter], artifactDirectory: root };
	const coordinator = harness.createStudyExecutionCoordinator(coordinatorOptions);
	const specification = fixtureSpecification(visualization.contentHash, source.sourceId, source.contentHash);
	const saved = harness.saveVisualValidationSpecification(scope(), {
		target: { visualizationId: visualization.visualizationId, visualizationRevision: visualization.revision, visualizationHash: visualization.contentHash },
		specification,
	});
	const resources = { cpuMilliCores: 500, memoryMiB: 256, wallTimeMs: 4_000, diskBytes: 1024 * 1024 };
	const admit = (requestId) => harness.admitVisualValidationExecution(scope(), {
		specificationId: saved.specificationId, expectedSpecificationRevision: saved.revision,
		dispatchKey: `visual-validation:${requestId}`, intentHash: contentHash({ requestId, specification: saved.contentHash, resources }),
		resources, quota: { maxRuns: 100, maxCumulativeWallTimeMs: 100_000, maxCumulativeDiskBytes: 100_000_000, expiresAt: null },
		environment: nativeEnvironment(), coordinatorOptions,
	});
	return { root, databasePath, harness, scope, visualization, specification, saved, coordinator, coordinatorOptions, resources, admit,
		closeBeforeHarness: (close) => closeBeforeHarness.push(close), setStdout: (value) => { stdout = value; } };
}

test("generated subject receives only target code and frozen inputs, then returns actual Node observations", async (t) => {
	const root = mkdtempSync(join(process.cwd(), ".artifacts", "study-research", "visual-validation", "subject-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const specification = fixtureSpecification(contentHash("target"), "source", contentHash("source"));
	const key = "subjectreceiptkey1234567890123456";
	const program = buildVisualValidationProgram({ targetCode: "return { metrics: { value: inputs.value } };", cases: runtimeCases(specification), outputKey: key, caseTimeoutMs: 500 });
	assert.equal(program.includes("ORACLE-MUST-NOT-REACH-SUBJECT"), false);
	assert.equal(program.includes(JSON.stringify(specification.cases[0].expected)), false);
	const file = join(root, "subject.mjs");
	writeFileSync(file, program, "utf8");
	const result = await execFileAsync(process.execPath, [file], { env: { ...process.env, TMP: root, TEMP: root } });
	const observations = readVisualValidationObservations(result.stdout, { outputKey: key, cases: runtimeCases(specification) });
	assert.equal(compareVisualObservations(specification, observations).status, "passed");
});

test("Harness rejects wrong inputs, records tampered and partial actual output without accepting it, and fails stale targets closed", async (t) => {
	const f = setup(t);
	assert.throws(() => f.harness.saveVisualValidationSpecification(f.scope(), {
		target: { visualizationId: f.visualization.visualizationId, visualizationRevision: f.visualization.revision, visualizationHash: f.visualization.contentHash },
		specification: { ...f.specification, cases: f.specification.cases.slice(0, 3) },
	}), /include an interaction case/i);
	const successful = f.admit("valid");
	f.setStdout(receipt(successful.run, f.specification));
	await f.coordinator.tick();
	let [run] = f.harness.listVisualValidationExecutions(f.scope(), { coordinatorOptions: f.coordinatorOptions });
	assert.equal(run.currentStatus, "passed");
	assert.equal(run.canonical.report.comparisons[0].checks[0].actual, 1);
	const checks = f.harness.studyResearch.listValidations(f.scope(), { targetKind: "visualization", targetId: f.visualization.visualizationId, targetRevision: f.visualization.revision, targetHash: f.visualization.contentHash });
	assert.equal(checks.length, 1);
	assert.equal(checks[0].status, "passed");
	assert.equal(checks[0].taskId, successful.run.taskId);
	f.harness.listVisualValidationExecutions(f.scope(), { coordinatorOptions: f.coordinatorOptions });
	assert.equal(f.harness.studyResearch.listValidations(f.scope()).length, 1, "reconciliation never duplicates a canonical check");

	const wrongInput = f.admit("wrong-input");
	f.setStdout(receipt(wrongInput.run, f.specification, (observations) => [{ ...observations[0], inputHash: contentHash("changed") }]));
	await f.coordinator.tick();
	run = f.harness.listVisualValidationExecutions(f.scope(), { coordinatorOptions: f.coordinatorOptions }).find((item) => item.runId === wrongInput.run.runId);
	assert.equal(run.currentStatus, "inconclusive");
	assert.match(run.canonical.observationError, /receipt rejected/i);

	const tampered = f.admit("tampered-output");
	f.setStdout(receipt(tampered.run, f.specification, (observations) => observations.map((entry) => entry.caseId === "interaction" ? { ...entry, scene: { metrics: { value: 999 } } } : entry)));
	await f.coordinator.tick();
	run = f.harness.listVisualValidationExecutions(f.scope(), { coordinatorOptions: f.coordinatorOptions }).find((item) => item.runId === tampered.run.runId);
	assert.equal(run.currentStatus, "failed");
	assert.equal(run.canonical.report.comparisons.find((comparison) => comparison.caseId === "interaction").checks[0].actual, 999);

	const partial = f.admit("partial-output");
	f.setStdout(receipt(partial.run, f.specification, (observations) => observations.slice(0, 1)));
	await f.coordinator.tick();
	run = f.harness.listVisualValidationExecutions(f.scope(), { coordinatorOptions: f.coordinatorOptions }).find((item) => item.runId === partial.run.runId);
	assert.equal(run.currentStatus, "inconclusive");
	assert.deepEqual(run.canonical.report.missingCategories, []);
	assert.equal(run.canonical.report.comparisons.filter((comparison) => comparison.status === "inconclusive").length, 3);

	const inspection = new DatabaseSync(f.databasePath);
	let inspectionClosed = false;
	f.closeBeforeHarness(() => {
		if (!inspectionClosed) inspection.close();
	});
	const tables = ["pi_study_research_task", "pi_study_execution_job", "pi_study_execution_frozen_payload", "pi_study_visual_validation_run", "pi_study_visual_validation_request", "pi_study_research_runner_context"];
	const before = Object.fromEntries(tables.map((table) => [table, inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
	inspection.exec("CREATE TRIGGER fail_visual_payload BEFORE INSERT ON pi_study_execution_frozen_payload BEGIN SELECT RAISE(ABORT, 'injected visual payload failure'); END;");
	assert.throws(() => f.admit("atomic-rollback"), /injected visual payload failure/);
	for (const table of tables) assert.equal(inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, before[table], table);
	assert.equal(inspection.isTransaction, false);
	inspection.exec("DROP TRIGGER fail_visual_payload");
	inspection.close();
	inspectionClosed = true;

	const stale = f.admit("stale-target");
	const revision = f.harness.studyResearch.reviseVisualizationDraft(f.scope(), {
		visualizationId: f.visualization.visualizationId, expectedVisualizationRevision: f.visualization.revision,
		expectedProjectRevision: f.harness.studyResearch.projectRevision(f.scope()).revision,
		draft: { purpose: f.visualization.purpose, code: "return { metrics: { value: inputs.value + 1 }, elements: [] };", inputs: f.visualization.inputs, inputHashes: {}, environmentHash: f.visualization.environmentHash,
			creatorContextId: f.harness.studyResearch.registerTrustedRunnerContext(f.scope(), "visual-fixture-revision").contextId },
	});
	assert.equal(revision.revision, 2);
	run = f.harness.listVisualValidationExecutions(f.scope(), { coordinatorOptions: f.coordinatorOptions }).find((item) => item.runId === stale.run.runId);
	assert.equal(run.currentStatus, "stale");
	assert.match(run.staleReasons.join("\n"), /target revision/i);
});

test("canonical validation and its detailed run receipt roll back together when persistence fails", async (t) => {
	const f = setup(t);
	const admitted = f.admit("canonical-atomicity");
	f.setStdout(receipt(admitted.run, f.specification));
	await f.coordinator.tick();
	const inspection = new DatabaseSync(f.databasePath);
	f.closeBeforeHarness(() => inspection.close());
	inspection.exec("CREATE TRIGGER fail_visual_receipt BEFORE UPDATE ON pi_study_visual_validation_run BEGIN SELECT RAISE(ABORT, 'injected canonical receipt failure'); END;");
	assert.throws(() => f.harness.reconcileVisualValidationExecution(f.scope(), admitted.run.runId, f.coordinatorOptions), /injected canonical receipt failure/);
	assert.equal(f.harness.studyResearch.listValidations(f.scope()).length, 0, "no orphan passed check survives the failed receipt write");
	assert.equal(JSON.parse(inspection.prepare("SELECT payload FROM pi_study_visual_validation_run WHERE run_id = ?").get(admitted.run.runId).payload).canonical, null);
	assert.equal(inspection.isTransaction, false);
	inspection.exec("DROP TRIGGER fail_visual_receipt");
	const reconciled = f.harness.reconcileVisualValidationExecution(f.scope(), admitted.run.runId, f.coordinatorOptions);
	assert.equal(reconciled.currentStatus, "passed");
	assert.equal(f.harness.studyResearch.listValidations(f.scope()).length, 1);
});

test("the registered native Windows Node adapter executes the generated subject and the Host compares its captured output", async (t) => {
	if (process.platform !== "win32") return;
	const f = setup(t);
	const coordinatorOptions = {
		coordinatorId: "visual-validation-native-fixture",
		adapters: [createNativeWindowsNodeAdapter({ runRootDirectory: f.root, cpuRatePercent: 25 })],
		artifactDirectory: f.root,
	};
	const admitted = f.harness.admitVisualValidationExecution(f.scope(), {
		specificationId: f.saved.specificationId,
		expectedSpecificationRevision: f.saved.revision,
		dispatchKey: "visual-validation:native-subject",
		intentHash: contentHash("native visual validation fixture"),
		resources: f.resources,
		quota: { maxRuns: 10, maxCumulativeWallTimeMs: 100_000, maxCumulativeDiskBytes: 100_000_000, expiresAt: null },
		environment: nativeEnvironment(),
		coordinatorOptions,
	});
	const coordinator = f.harness.createStudyExecutionCoordinator(coordinatorOptions);
	for (let attempt = 0; attempt < 120; attempt += 1) {
		await coordinator.tick();
		if (["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(f.harness.studyExecution.getJob(admitted.job.queueJobId).status)) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(f.harness.studyExecution.getJob(admitted.job.queueJobId).status, "succeeded");
	const run = f.harness.listVisualValidationExecutions(f.scope(), { coordinatorOptions }).find((item) => item.runId === admitted.run.runId);
	assert.equal(run.currentStatus, "passed");
});
