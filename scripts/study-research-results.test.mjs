import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { StudyAgentQueue, StudyResearchHost } from "../packages/study-research-host/src/index.ts";
import { frozenEnvironmentDescriptorHash } from "../packages/study-execution-host/src/execution-payloads.ts";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function setup() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
	`);
	database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run("results-project", JSON.stringify({ id: "results-project" }));
	database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("results-session", "results-project");
	const host = new StudyResearchHost(database, { clock: () => new Date("2026-09-11T12:00:00.000Z") });
	host.bindSession("results-project", "results-session");
	const scope = () => ({
		projectId: "results-project",
		sessionId: "results-session",
		expectedPhaseRevision: host.currentPhase("results-project", "results-session").revision,
	});
	return { database, host, scope };
}

function theoryPlan() {
	return {
		kind: "theory",
		detail: {
			question: "Does the stated conclusion follow from the frozen premise?",
			assumptions: ["The premise holds."],
			propositions: ["The conclusion follows conditionally."],
			proofSteps: ["Apply the premise."],
			counterexamples: [],
			openGaps: ["Independently establish the premise."],
		},
		sourceVersionHashes: [],
	};
}

test("theory results are source-free only for their exact review target and failed review blocks confirmation", () => {
	const f = setup();
	try {
		f.host.setPhase(f.scope(), "research");
		const plan = f.host.createResearchPlan(f.scope(), { plan: theoryPlan(), expectedProjectRevision: 0 });
		const result = f.host.createResearchAnalysisDraft(f.scope(), {
			expectedProjectRevision: 1,
			origin: { kind: "theory-plan", planSnapshot: plan },
			draft: {
				classification: "inconclusive",
				summary: "The conclusion is conditional on its frozen premise.",
				limitations: ["The premise needs independent support."],
				claims: ["The conclusion follows only if the premise holds."],
			},
		});
		assert.equal(result.taskId, null, "a theory result must not synthesize an execution task");
		const target = {
			targetKind: "result",
			targetId: result.resultId,
			targetRevision: result.revision,
			targetHash: result.contentHash,
		};
		assert.deepEqual(f.host.assertStudyAgentReviewEvidence(f.scope(), [], target), []);
		assert.throws(
			() => f.host.assertStudyAgentReviewEvidence(f.scope(), [], { ...target, targetHash: hash("stale-result") }),
			/not the claimed result version/,
		);

		const queue = new StudyAgentQueue(f.database, f.host);
		const enqueue = (dispatchKey, agentSessionId) => queue.enqueueLearning({
			scope: f.scope(),
			dispatchKey,
			intentHash: hash(`${dispatchKey}:intent`),
			kind: "review",
			manifest: {
				codeHash: hash(`${dispatchKey}:code`),
				parameterHash: hash(`${dispatchKey}:parameters`),
				inputHashes: {},
				environmentHash: hash(`${dispatchKey}:environment`),
			},
			admission: { purpose: "Review the exact frozen TheoryPlan result.", language: "none", maxWallSeconds: 30, maxMemoryMiB: 16 },
			target,
			evidence: [],
			context: { agentSessionId, sessionFile: `C:/fixture/${agentSessionId}.jsonl` },
		}, (taskId) => ({ packetHash: hash(`${dispatchKey}:${taskId}:packet`) }));
		const complete = (outcome) => {
			const queued = enqueue(`result-review-${outcome}`, `agent-${outcome}`);
			const claim = queue.claim("results-project", queued.task.taskId, `worker-${outcome}`);
			assert.ok(claim);
			const worker = { projectId: claim.task.projectId, taskId: claim.task.taskId, workerId: claim.workerId, claimToken: claim.claimToken };
			queue.markLaunching(worker);
			queue.markRunning(worker);
			return queue.complete({
				...worker,
				report: {
					summary: `${outcome} exact-result review.`,
					outcome,
					findings: [{ severity: outcome === "passed" ? "minor" : "major", explanation: "Reviewed the frozen TheoryPlan packet.", evidenceIds: [] }],
					notes: [],
					unresolved: [],
					target,
				},
			});
		};
		assert.equal(complete("passed").status, "succeeded");
		assert.equal(complete("failed").status, "succeeded");
		assert.deepEqual(f.host.listIndependentReviews(f.scope(), target).map((review) => review.status).sort(), ["failed", "passed"]);
		assert.throws(
			() => f.host.confirmResultFromTrustedUserEvent(f.scope(), result.resultId, result.revision, "results-confirmation"),
			/no failed or unresolved review/,
		);
	} finally {
		f.database.close();
	}
});

test("terminal-result drafts reject a nonterminal task before the origin can be recorded", () => {
	const f = setup();
	try {
		f.host.setPhase(f.scope(), "research");
		const plan = f.host.createResearchPlan(f.scope(), { plan: theoryPlan(), expectedProjectRevision: 0 });
		const runner = f.host.registerTrustedRunnerContext(f.scope(), "results-terminal-runner");
		const task = f.host.reserveStudyTask(f.scope(), {
			dispatchKey: "nonterminal-result",
			kind: "execution",
			manifest: { codeHash: hash("print('frozen')"), parameterHash: contentHash({}), inputHashes: {}, environmentHash: hash("environment") },
			admission: { purpose: "Retain an actual terminal run only.", language: "python", maxWallSeconds: 30, maxMemoryMiB: 16 },
			producerContextId: runner.contextId,
		}).task;
		assert.throws(() => f.host.createResearchAnalysisDraft(f.scope(), {
			expectedProjectRevision: 1,
			origin: {
				kind: "terminal-run", taskId: task.taskId, taskRevision: task.revision, terminalStatus: "failed", planSnapshot: plan,
				cell: { cellId: "result-cell", revision: 1, contentHash: hash("cell"), language: "python", code: "print('frozen')", parameters: {}, inputs: [] },
				manifest: task.manifest,
				output: { outputHash: hash("output"), status: "failed", usage: null, stdout: null, stderr: null, error: null, truncated: false, observedAt: null },
			},
			draft: { classification: "inconclusive", summary: "No terminal observation exists.", limitations: ["The execution is still queued."], claims: ["No result follows before a terminal observation."] },
		}), /terminal Research execution|terminal execution status/);
	} finally {
		f.database.close();
	}
});

test("Harness saves only a real cancelled Research run and retains its exact frozen cell", (t) => {
	const root = mkdtempSync(join(tmpdir(), "study-results-harness-"));
	const databasePath = join(root, "harness.sqlite");
	const harness = new LearningHarness({ databasePath });
	t.after(() => { harness.close(); rmSync(root, { recursive: true, force: true }); });
	harness.projectWorkspaces.create({ id: "results-harness-project", title: "Results harness", cwd: root, defaults: null, courseProjectId: null });
	harness.projectWorkspaces.move("results-harness-session", "results-harness-project");
	harness.studyResearch.bindSession("results-harness-project", "results-harness-session");
	const scope = () => ({
		projectId: "results-harness-project",
		sessionId: "results-harness-session",
		expectedPhaseRevision: harness.studyResearch.currentPhase("results-harness-project", "results-harness-session").revision,
	});
	const sourceText = "x\n1\n";
	const source = harness.studyResearch.registerSource(scope(), {
		sourceRoot: root, relativePath: "fixture.csv", kind: "text", sourceRole: "primary", diagnostics: [], parser: "results-fixture/1",
		contentHash: hash(sourceText), chunks: [{ ordinal: 1, locator: JSON.stringify({ row: 1 }), text: sourceText }],
	}, 0);
	const cell = harness.studyCells.save(scope(), {
		draft: {
			title: "Cancelled fixture", purpose: "Retain a cancelled result", language: "python", code: "print(inputs['fixture.csv'])", parameters: { seed: 7 },
			inputs: [{ name: "fixture.csv", sourceId: source.sourceId, sourceHash: source.contentHash }],
		},
	});
	harness.studyResearch.setPhase(scope(), "research");
	const plan = harness.studyResearch.createResearchPlan(scope(), {
		expectedProjectRevision: 1,
		plan: {
			kind: "formal",
			detail: {
				question: "Does cancellation retain the frozen cell?", hypotheses: ["The cell remains available."], datasetVersion: "fixture-v1",
				splitProtocol: "not applicable", primaryMetrics: ["traceability"], method: "cancel before launch", stoppingConditions: ["cancel queued run"],
			},
			sourceVersionHashes: [source.contentHash], sourceReferences: [{ sourceId: source.sourceId, contentHash: source.contentHash }],
		},
	});
	const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
	const resources = { cpuMilliCores: 500, memoryMiB: 256, wallTimeMs: 10_000, diskBytes: 1024 * 1024 };
	const approved = harness.grantResearchExecutionScope(scope(), {
		planId: plan.planId, expectedPlanRevision: plan.revision, userEventId: "results-harness-grant", expiresAt,
		allowedLanguages: ["python"], allowedInputs: [{ sourceId: source.sourceId, sourceHash: source.contentHash }], maxResources: resources,
		quota: { maxRuns: 1, maxCumulativeWallTimeMs: resources.wallTimeMs, maxCumulativeDiskBytes: resources.diskBytes, expiresAt },
		changeBoundary: "No execution after cancellation.",
	});
	const fixtureExecutable = "C:\\fixture\\results-runner.exe";
	const environmentBody = {
		adapterKind: "results-cancel-fixture", executablePath: fixtureExecutable,
		files: [{ absolutePath: fixtureExecutable, sha256: contentHash("results fixture runtime") }],
	};
	const never = async () => { throw new Error("cancelled fixture must never launch"); };
	const admitted = harness.admitStudyCellExecution(scope(), {
		cellId: cell.cellId, expectedCellRevision: cell.revision, dispatchKey: "results-cancelled-run", intentHash: hash("results-cancelled-run"),
		resources, environment: { ...environmentBody, descriptorHash: frozenEnvironmentDescriptorHash(environmentBody) },
		inputs: [{ name: "fixture.csv", bytesBase64: Buffer.from(sourceText).toString("base64"), sha256: source.contentHash }],
		coordinatorOptions: { adapters: [{ kind: "results-cancel-fixture", prepare: never, launch: never, poll: never, cancel: never, abandonPrepared: never }], artifactDirectory: join(root, "artifacts") },
		quota: approved.quota,
		research: { mode: "grant", scopeId: approved.scopeId, planId: plan.planId, grantId: approved.grantId, expectedPlanRevision: plan.revision, changeNote: "Cancel before process launch." },
	});
	const draft = { classification: "inconclusive", summary: "The queued process was cancelled.", limitations: ["No process output exists."], claims: ["No numerical conclusion follows from the cancelled run."] };
	const options = { adapters: [{ kind: "results-cancel-fixture", prepare: never, launch: never, poll: never, cancel: never, abandonPrepared: never }], artifactDirectory: join(root, "artifacts") };
	assert.throws(() => harness.saveResearchAnalysisFromTerminalRun(scope(), {
		taskId: admitted.job.taskId, expectedTaskRevision: admitted.job.hostTaskRevision, expectedProjectRevision: 2, draft, coordinatorOptions: options,
	}), /terminal status/);
	const cancelled = harness.studyExecution.requestCancellation(admitted.job.queueJobId);
	const result = harness.saveResearchAnalysisFromTerminalRun(scope(), {
		taskId: admitted.job.taskId, expectedTaskRevision: cancelled.hostTaskRevision, expectedProjectRevision: 2, draft, coordinatorOptions: options,
	});
	assert.equal(result.origin.kind, "terminal-run");
	assert.equal(result.origin.terminalStatus, "cancelled");
	assert.equal(result.origin.cell.contentHash, cell.contentHash);
	assert.equal(result.origin.output.stdout, null);
});
