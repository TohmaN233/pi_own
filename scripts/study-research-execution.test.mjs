import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { frozenEnvironmentDescriptorHash } from "../packages/study-execution-host/src/execution-payloads.ts";

const future = (hours = 2) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

function adapter() {
	const never = async () => { throw new Error("research admission fixture must not launch a native process"); };
	return { kind: "research-admission-fixture", prepare: never, launch: never, poll: never, cancel: never, abandonPrepared: never };
}

function environment() {
	const executablePath = "C:\\fixture\\research-runner.exe";
	const body = { adapterKind: "research-admission-fixture", executablePath,
		files: [{ absolutePath: executablePath, sha256: contentHash("research fixture runtime") }] };
	return { ...body, descriptorHash: frozenEnvironmentDescriptorHash(body) };
}

function formal(sourceHash, sourceId) {
	return { kind: "formal", detail: { question: "Does the fixture remain traceable?", hypotheses: ["The bounded input is preserved."],
		datasetVersion: "fixture-v1", splitProtocol: "fixed", primaryMetrics: ["traceability"], method: "fixture method", stoppingConditions: ["stop at quota"] },
		sourceVersionHashes: [sourceHash], sourceReferences: [{ sourceId, contentHash: sourceHash }] };
}

function theory(sourceHash, sourceId) {
	return { kind: "theory", detail: { question: "Does the frozen learning run retain a usable proof provenance?", assumptions: [], propositions: ["The snapshot remains immutable."], proofSteps: [], counterexamples: [], openGaps: [] },
		sourceVersionHashes: [sourceHash], sourceReferences: [{ sourceId, contentHash: sourceHash }] };
}

function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "study-research-execution-"));
	const path = join(root, "harness.sqlite");
	const harness = new LearningHarness({ databasePath: path });
	const inspection = new DatabaseSync(path);
	t.after(() => { inspection.close(); harness.close(); rmSync(root, { recursive: true, force: true }); });
	harness.projectWorkspaces.create({ id: "project", title: "Research fixture", cwd: root, defaults: null, courseProjectId: null });
	harness.projectWorkspaces.move("session", "project");
	harness.studyResearch.bindSession("project", "session");
	const scope = (sessionId = "session") => {
		const phase = harness.studyResearch.currentPhase("project", sessionId);
		if (!phase) throw new Error("fixture phase is missing");
		return { projectId: "project", sessionId, expectedPhaseRevision: phase.revision };
	};
	const sourceBytes = "x,y\n1,2\n";
	const source = harness.studyResearch.registerSource(scope(), { sourceRoot: root, relativePath: "fixture.csv", kind: "text", sourceRole: "primary",
		diagnostics: [], contentHash: `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`, parser: "fixture-reader/1", chunks: [{ ordinal: 1, locator: JSON.stringify({ kind: "fixture", row: 1 }), text: sourceBytes }] }, 0);
	const cell = harness.studyCells.save(scope(), { draft: { title: "Fixture cell", purpose: "Preserve exact source bytes", language: "python", code: "print(inputs['fixture.csv'])", parameters: { seed: 7 },
		inputs: [{ name: "fixture.csv", sourceId: source.sourceId, sourceHash: source.contentHash }] } });
	const resources = { cpuMilliCores: 500, memoryMiB: 256, wallTimeMs: 10_000, diskBytes: 1024 * 1024 };
	const frozen = [{ name: "fixture.csv", bytesBase64: Buffer.from(sourceBytes).toString("base64"), sha256: source.contentHash }];
	const base = { cellId: cell.cellId, expectedCellRevision: cell.revision, resources, environment: environment(), inputs: frozen,
		coordinatorOptions: { coordinatorId: "research-fixture", adapters: [adapter()], artifactDirectory: join(root, "artifacts") } };
	return { root, harness, inspection, scope, source, cell, resources, frozen, base };
}

test("Research scope admission atomically freezes native payload, rejects forged/expired/revoked/wrong-session grants, and replays across phase changes", (t) => {
	const f = setup(t);
	f.harness.studyResearch.setPhase(f.scope(), "research");
	const plan = f.harness.studyResearch.createResearchPlan(f.scope(), { plan: formal(f.source.contentHash, f.source.sourceId), expectedProjectRevision: 1 });
	const expiresAt = future();
	const approved = f.harness.grantResearchExecutionScope(f.scope(), { planId: plan.planId, expectedPlanRevision: plan.revision,
		userEventId: "trusted-browser-event", expiresAt, allowedLanguages: ["python"], allowedInputs: [{ sourceId: f.source.sourceId, sourceHash: f.source.contentHash }],
		maxResources: f.resources, quota: { maxRuns: 2, maxCumulativeWallTimeMs: 20_000, maxCumulativeDiskBytes: 2 * 1024 * 1024, expiresAt }, changeBoundary: "Repair only implementation defects." });
	const research = { mode: "grant", scopeId: approved.scopeId, planId: plan.planId, grantId: approved.grantId, expectedPlanRevision: plan.revision, changeNote: "Initial approved implementation." };
	const input = { ...f.base, dispatchKey: "research-cell-1", intentHash: contentHash({ research, request: 1 }), quota: approved.quota, research };
	const first = f.harness.admitStudyCellExecution(f.scope(), input);
	assert.equal(first.job.mode, "research");
	assert.equal(first.snapshot.cell.contentHash, f.cell.contentHash);
	assert.equal(f.harness.listResearchCellExecutions(f.scope()).length, 1);
	const replay = f.harness.admitStudyCellExecution(f.scope(), input);
	assert.equal(replay.replay, true); assert.equal(replay.job.queueJobId, first.job.queueJobId);
	for (const table of ["pi_study_research_task", "pi_study_execution_job", "pi_study_cell_run", "pi_study_execution_frozen_payload", "pi_study_research_execution_run", "pi_study_cell_request"])
		assert.equal(f.inspection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, table);

	// A committed approval remains observable and cancellable even if the user changes mode.
	f.harness.studyResearch.setPhase(f.scope(), "study");
	const afterModeChange = f.harness.admitStudyCellExecution(f.scope(), input);
	assert.equal(afterModeChange.replay, true); assert.equal(afterModeChange.job.taskId, first.job.taskId);

	f.harness.projectWorkspaces.move("other", "project"); f.harness.studyResearch.bindSession("project", "other"); f.harness.studyResearch.setPhase(f.scope("other"), "research");
	assert.throws(() => f.harness.admitStudyCellExecution(f.scope("other"), { ...input, dispatchKey: "wrong-session", intentHash: contentHash("wrong-session") }), /scope does not match/i);
	assert.throws(() => f.harness.admitStudyCellExecution(f.scope(), { ...input, dispatchKey: "forged-grant", intentHash: contentHash("forged-grant"), research: { ...research, grantId: "scope-grant-forged" } }), /scope does not match/i);

	// The Host grant hash is deliberately updated as an attacker/clock fixture; admission fails closed.
	const storedGrant = f.inspection.prepare("SELECT payload FROM pi_study_research_grant WHERE grant_id = ?").get(approved.grantId);
	const expiredGrant = { ...JSON.parse(storedGrant.payload), expiresAt: "2000-01-01T00:00:00.000Z" };
	f.inspection.prepare("UPDATE pi_study_research_grant SET payload = ?, payload_hash = ? WHERE grant_id = ?").run(JSON.stringify(expiredGrant), contentHash(expiredGrant), approved.grantId);
	assert.throws(() => f.harness.admitStudyCellExecution(f.scope(), { ...input, dispatchKey: "expired-grant", intentHash: contentHash("expired-grant") }), /missing, revoked, or expired/i);

	// Restore a current grant only to prove explicit revocation has its own durable effect.
	const restoredGrant = { ...expiredGrant, expiresAt };
	f.inspection.prepare("UPDATE pi_study_research_grant SET payload = ?, payload_hash = ? WHERE grant_id = ?").run(JSON.stringify(restoredGrant), contentHash(restoredGrant), approved.grantId);
	f.harness.revokeResearchExecutionScope(f.scope(), approved.scopeId);
	assert.throws(() => f.harness.admitStudyCellExecution(f.scope(), { ...input, dispatchKey: "revoked-grant", intentHash: contentHash("revoked-grant") }), /revoked or expired/i);

	f.harness.studyResearch.setPhase(f.scope(), "research");
	const freshExpiry = future();
	const fresh = f.harness.grantResearchExecutionScope(f.scope(), { planId: plan.planId, expectedPlanRevision: plan.revision,
		userEventId: "trusted-browser-event-atomic", expiresAt: freshExpiry, allowedLanguages: ["python"], allowedInputs: [{ sourceId: f.source.sourceId, sourceHash: f.source.contentHash }],
		maxResources: f.resources, quota: { maxRuns: 2, maxCumulativeWallTimeMs: 20_000, maxCumulativeDiskBytes: 2 * 1024 * 1024, expiresAt: freshExpiry }, changeBoundary: "Repair only implementation defects." });
	const freshResearch = { mode: "grant", scopeId: fresh.scopeId, planId: plan.planId, grantId: fresh.grantId, expectedPlanRevision: plan.revision, changeNote: "Atomic payload fixture." };
	f.inspection.exec("CREATE TRIGGER fail_research_payload BEFORE INSERT ON pi_study_execution_frozen_payload BEGIN SELECT RAISE(ABORT, 'injected payload failure'); END;");
	assert.throws(() => f.harness.admitStudyCellExecution(f.scope(), { ...input, dispatchKey: "atomic-payload-failure", intentHash: contentHash("atomic-payload-failure"), quota: fresh.quota, research: freshResearch }), /injected payload failure/);
	for (const table of ["pi_study_research_task", "pi_study_execution_job", "pi_study_cell_run", "pi_study_execution_frozen_payload", "pi_study_research_execution_run", "pi_study_cell_request"])
		assert.equal(f.inspection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, `${table} remains atomic`);
	assert.equal(f.inspection.isTransaction, false);
});
test("a learning cell run promotes to a separate theory plan without relabelling its original authorization", (t) => {
	const f = setup(t);
	const learning = f.harness.admitStudyCellExecution(f.scope(), { ...f.base, dispatchKey: "learning-cell", intentHash: contentHash("learning-cell"),
		quota: { maxRuns: 10, maxCumulativeWallTimeMs: 100_000, maxCumulativeDiskBytes: 10 * 1024 * 1024, expiresAt: null } });
	assert.equal(f.harness.studyResearch.readTaskForCoordinator(learning.job.taskId).authorization.kind, "learning");
	f.harness.studyResearch.setPhase(f.scope(), "research");
	const promoted = f.harness.promoteLearningCellRunToResearchPlan(f.scope(), { sourceTaskId: learning.job.taskId, plan: theory(f.source.contentHash, f.source.sourceId), expectedProjectRevision: 1 });
	assert.equal(promoted.plan.kind, "theory");
	assert.equal("datasetVersion" in promoted.plan.detail, false, "theory must not require a dataset field");
	assert.equal(f.harness.studyResearch.readTaskForCoordinator(learning.job.taskId).authorization.kind, "learning");
	assert.equal(promoted.promotion.sourceCellContentHash, learning.snapshot.cell.contentHash);
	assert.equal(f.harness.listResearchLearningPromotions(f.scope()).length, 1);
});

test("repair provenance rejects learning tasks, unchanged revisions and unrelated cells or scientific plans", (t) => {
	const f = setup(t);
	const quota = { maxRuns: 10, maxCumulativeWallTimeMs: 100000, maxCumulativeDiskBytes: 10 * 1024 * 1024, expiresAt: null };
	const learning = f.harness.admitStudyCellExecution(f.scope(), { ...f.base, dispatchKey: "learning-repair-source", intentHash: contentHash("learning-repair-source"), quota });
	f.harness.studyExecution.requestCancellation(learning.job.queueJobId);
	f.harness.studyResearch.setPhase(f.scope(), "research");
	const planInput = { kind: "smoke", detail: { question: "Does the corrected implementation run?", method: "bounded arithmetic", evaluation: "actual result", allowedChanges: ["code repairs"] }, sourceVersionHashes: [f.source.contentHash], sourceReferences: [{ sourceId: f.source.sourceId, contentHash: f.source.contentHash }] };
	const plan = f.harness.studyResearch.createResearchPlan(f.scope(), { plan: planInput, expectedProjectRevision: 1 });
	const failed = f.harness.admitStudyCellExecution(f.scope(), { ...f.base, dispatchKey: "research-repair-source", intentHash: contentHash("research-repair-source"), quota,
		research: { mode: "smoke-learning", planId: plan.planId, expectedPlanRevision: plan.revision, changeNote: "original implementation" } });
	f.harness.studyExecution.requestCancellation(failed.job.queueJobId);
	const input = { failedTaskId: failed.job.taskId, repairCellId: f.cell.cellId, repairCellRevision: f.cell.revision, planId: plan.planId, expectedPlanRevision: plan.revision, changeReason: "Fix incorrect computation" };
	assert.throws(() => f.harness.recordResearchCellRepair(f.scope(), { ...input, failedTaskId: learning.job.taskId }), /recorded Research execution/);
	assert.throws(() => f.harness.recordResearchCellRepair(f.scope(), input), /changed code in a newer revision/);
	const revision = f.harness.studyCells.save(f.scope(), { cellId: f.cell.cellId, expectedCellRevision: 1, draft: { ...f.cell, code: "print(42)" } });
	const unrelated = f.harness.studyCells.save(f.scope(), { draft: { ...f.cell, code: "print(43)" } });
	assert.throws(() => f.harness.recordResearchCellRepair(f.scope(), { ...input, repairCellId: unrelated.cellId, repairCellRevision: unrelated.revision }), /original cell/);
	const otherPlan = f.harness.studyResearch.createResearchPlan(f.scope(), { plan: planInput, expectedProjectRevision: f.harness.studyResearch.projectRevision(f.scope()).revision });
	assert.throws(() => f.harness.recordResearchCellRepair(f.scope(), { ...input, repairCellRevision: revision.revision, planId: otherPlan.planId }), /new experiment/);
	const repaired = f.harness.recordResearchCellRepair(f.scope(), { ...input, repairCellRevision: revision.revision });
	assert.equal(repaired.failedCellContentHash, f.cell.contentHash);
	assert.equal(repaired.repairCellContentHash, revision.contentHash);
	assert.equal(repaired.semanticDigest, plan.semanticDigest);
	assert.equal(f.harness.listResearchCellRepairs(f.scope()).length, 1);
});

test("approved scopes and admitted runs preserve full scientific r1 semantics after plan revision and database reopen", (t) => {
	const f = setup(t); f.harness.studyResearch.setPhase(f.scope(), "research");
	const firstPlan = f.harness.studyResearch.createResearchPlan(f.scope(), { plan: formal(f.source.contentHash, f.source.sourceId), expectedProjectRevision: 1 });
	const expiresAt = future();
	const approved = f.harness.grantResearchExecutionScope(f.scope(), { planId: firstPlan.planId, expectedPlanRevision: 1, userEventId: "snapshot-test-user", expiresAt,
		allowedLanguages: ["python"], allowedInputs: [{ sourceId: f.source.sourceId, sourceHash: f.source.contentHash }], maxResources: f.resources,
		quota: { maxRuns: 2, maxCumulativeWallTimeMs: 20000, maxCumulativeDiskBytes: 2 * 1024 * 1024, expiresAt }, changeBoundary: "Implementation only" });
	const admitted = f.harness.admitStudyCellExecution(f.scope(), { ...f.base, dispatchKey: "snapshot-test", intentHash: contentHash("snapshot-test"), quota: approved.quota,
		research: { mode: "grant", scopeId: approved.scopeId, planId: firstPlan.planId, grantId: approved.grantId, expectedPlanRevision: 1, changeNote: "First version" } });
	const changed = formal(f.source.contentHash, f.source.sourceId); changed.detail.hypotheses = ["A different hypothesis"];
	f.harness.studyResearch.reviseResearchPlan(f.scope(), { planId: firstPlan.planId, expectedPlanRevision: 1, expectedProjectRevision: f.harness.studyResearch.projectRevision(f.scope()).revision, plan: changed });
	const reopened = new LearningHarness({ databasePath: join(f.root, "harness.sqlite") });
	try {
		assert.equal(reopened.studyResearch.getResearchPlan(f.scope(), firstPlan.planId).revision, 2);
		assert.deepEqual(reopened.listResearchExecutionScopes(f.scope())[0].planSnapshot, firstPlan);
		const historical = reopened.listResearchCellExecutions(f.scope()).find((run) => run.taskId === admitted.job.taskId);
		assert.deepEqual(historical.planSnapshot, firstPlan);
		assert.notDeepEqual(historical.planSnapshot.detail.hypotheses, changed.detail.hypotheses);
	} finally { reopened.close(); }
});
