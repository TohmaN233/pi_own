import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { frozenEnvironmentDescriptorHash } from "../packages/study-execution-host/src/execution-payloads.ts";

test("Harness admission atomically freezes code, queue identity and exact payload and keeps retry idempotent", (t) => {
	const root = mkdtempSync(join(tmpdir(), "study-cell-admission-"));
	const path = join(root, "harness.sqlite");
	const harness = new LearningHarness({ databasePath: path });
	const inspection = new DatabaseSync(path);
	t.after(() => { inspection.close(); harness.close(); rmSync(root, { recursive: true, force: true }); });
	harness.projectWorkspaces.create({ id: "p", title: "Paper", cwd: root, defaults: null, courseProjectId: null });
	harness.projectWorkspaces.move("s", "p"); harness.studyResearch.bindSession("p", "s");
	const scope = { projectId: "p", sessionId: "s", expectedPhaseRevision: 1 };
	const cell = harness.studyCells.save(scope, { draft: { title: "Average", purpose: "Understand the mean", language: "python", code: "print(2)", parameters: {}, inputs: [] } });
	const adapter = { kind: "fixture", prepare: async () => { throw new Error("Saving a run must not launch"); }, launch: async () => { throw new Error("must not launch"); }, poll: async () => { throw new Error("must not poll"); }, cancel: async () => { throw new Error("must not cancel"); }, abandonPrepared: async () => { throw new Error("must not clean"); } };
	const environmentBody = { adapterKind: "fixture", executablePath: process.execPath, files: [{ absolutePath: process.execPath, sha256: contentHash("fixture runtime; no real execution") }] };
	const input = { cellId: cell.cellId, expectedCellRevision: 1, dispatchKey: "click-1", intentHash: contentHash("complete UI request"), resources: { cpuMilliCores: 500, memoryMiB: 256, wallTimeMs: 10000, diskBytes: 1024 },
		quota: { maxRuns: 20, maxCumulativeWallTimeMs: 1000000, maxCumulativeDiskBytes: 1000000, expiresAt: null }, environment: { ...environmentBody, descriptorHash: frozenEnvironmentDescriptorHash(environmentBody) },
		inputs: [], coordinatorOptions: { coordinatorId: "fixture-coordinator", adapters: [adapter], artifactDirectory: join(root, "artifacts") } };
	const first = harness.admitStudyCellExecution(scope, input);
	assert.equal(first.job.status, "queued");
	const replay = harness.admitStudyCellExecution(scope, input);
	assert.equal(replay.replay, true); assert.equal(replay.job.taskId, first.job.taskId);
	assert.deepEqual(replay.snapshot, first.snapshot);
	assert.equal(harness.replayStudyCellExecution(scope, input.dispatchKey, input.intentHash).queueJobId, first.job.queueJobId);
	assert.throws(() => harness.replayStudyCellExecution(scope, input.dispatchKey, contentHash("changed UI resources")), /request changed/);
	harness.projectWorkspaces.move("other", "p"); harness.studyResearch.bindSession("p", "other");
	assert.throws(() => harness.replayStudyCellExecution({ ...scope, sessionId: "other" }, input.dispatchKey, input.intentHash), /another conversation/);
	for (const table of ["pi_study_research_task", "pi_study_execution_job", "pi_study_cell_run", "pi_study_execution_frozen_payload", "pi_study_research_runner_context", "pi_study_cell_request"])
		assert.equal(inspection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1);
	inspection.exec("CREATE TRIGGER fail_admission_payload BEFORE INSERT ON pi_study_execution_frozen_payload BEGIN SELECT RAISE(ABORT, 'injected frozen payload failure'); END;");
	assert.throws(() => harness.admitStudyCellExecution(scope, { ...input, dispatchKey: "must-rollback" }), /injected frozen payload failure/);
	for (const table of ["pi_study_research_task", "pi_study_execution_job", "pi_study_cell_run", "pi_study_execution_frozen_payload", "pi_study_research_runner_context", "pi_study_cell_request"])
		assert.equal(inspection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);
	assert.equal(inspection.isTransaction, false);
});
