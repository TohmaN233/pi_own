import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { contentHash, stableStringify } from "../packages/harness-core/src/index.ts";
import { StudyExecutionQueue } from "../packages/study-execution-host/src/execution-queue.ts";
import { StudyResearchHost } from "../packages/study-research-host/src/index.ts";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function manifest(key) {
	return {
		codeHash: hash(`${key}:code`),
		parameterHash: hash(`${key}:parameters`),
		inputHashes: { "input.csv": hash(`${key}:input`) },
		environmentHash: hash("python-3.12-lock"),
	};
}

function source(version = "source-v1", relativePath = "main.tex") {
	return {
		sourceRoot: "D:/paper",
		relativePath,
		kind: "tex",
		sourceRole: "primary",
		diagnostics: [],
		contentHash: hash(version),
		parser: "tex-reader/1.0.0",
		chunks: [{ ordinal: 1, locator: JSON.stringify({ line: 1 }), text: version }],
	};
}

function formalPlan(sourceHash) {
	return {
		kind: "formal",
		detail: {
			question: "Does the bounded test improve the primary metric?",
			hypotheses: ["The bounded test has a measurable result."],
			datasetVersion: "fixture-v1",
			splitProtocol: "fixed split",
			primaryMetrics: ["error"],
			method: "locked fixture method",
			stoppingConditions: ["Stop at the approved budget."],
		},
		sourceVersionHashes: [sourceHash],
	};
}

function resources(overrides = {}) {
	return {
		cpuMilliCores: 500,
		memoryMiB: 128,
		wallTimeMs: 20_000,
		diskBytes: 1_024,
		...overrides,
	};
}

function quota(overrides = {}) {
	return {
		maxRuns: 10,
		maxCumulativeWallTimeMs: 1_000_000,
		maxCumulativeDiskBytes: 1_000_000,
		expiresAt: null,
		...overrides,
	};
}

function preparedHandle(kind = "windows-isolated-run") {
	return {
		kind,
		version: 1,
		privateHandle: {
			runId: "run_fixture",
			cancelToken: "must-remain-private",
			configBindingHash: hash("runner-config"),
		},
		publicSummary: {
			runId: "run_fixture",
			configBindingHash: hash("runner-config"),
		},
	};
}

function setup(options = {}) {
	const database = new DatabaseSync(options.path ?? ":memory:");
	const projectId = options.projectId ?? "project-a";
	const sessionId = options.sessionId ?? "session-a";
	const now = options.now ?? { value: Date.parse("2026-09-11T12:00:00.000Z") };
	if (options.initialize !== false) {
		database.exec(`
			CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
		`);
		database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run(projectId, JSON.stringify({ id: projectId }));
		database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run(sessionId, projectId);
	}
	const clock = () => new Date(now.value);
	const host = new StudyResearchHost(database, { clock });
	if (!host.currentPhase(projectId, sessionId)) host.bindSession(projectId, sessionId);
	const queue = new StudyExecutionQueue(database, host, { clock });
	if (!queue.getPolicy()) {
		queue.configureTrustedPolicy(
			{ maxConcurrentRuns: 1, maxCpuMilliCores: 2_000, maxMemoryMiB: 2_048, leaseDurationMs: 1_000 },
			0,
		);
	}
	const scope = () => {
		const phase = host.currentPhase(projectId, sessionId);
		if (!phase) throw new Error("fixture phase is unexpectedly absent");
		return { projectId, sessionId, expectedPhaseRevision: phase.revision };
	};
	const context = host.registerTrustedRunnerContext(scope(), `fixture-runner-${Math.random().toString(16).slice(2)}`);
	return {
		database,
		host,
		queue,
		projectId,
		sessionId,
		scope,
		context,
		advance(milliseconds) {
			now.value += milliseconds;
		},
	};
}

function enqueueStudy(fixture, dispatchKey, overrides = {}) {
	return fixture.queue.enqueueStudy(fixture.scope(), {
		kind: overrides.kind,
		dispatchKey,
		manifest: overrides.manifest ?? manifest(dispatchKey),
		admission: overrides.admission ?? {
			purpose: "Run a small bounded computation with an explicit purpose.",
			language: "python",
			maxWallSeconds: 60,
			maxMemoryMiB: 512,
		},
		producerContextId: overrides.producerContextId ?? fixture.context.contextId,
		resources: overrides.resources ?? resources(),
		quota: overrides.quota ?? quota(),
	});
}

function enqueueResearch(fixture, plan, grant, dispatchKey, overrides = {}) {
	return fixture.queue.enqueueResearch(fixture.scope(), {
		planId: plan.planId,
		grantId: grant.grantId,
		expectedPlanRevision: plan.revision,
		dispatchKey,
		manifest: overrides.manifest ?? manifest(dispatchKey),
		producerContextId: overrides.producerContextId ?? fixture.context.contextId,
		resources: overrides.resources ?? resources(),
		quota: overrides.quota ?? quota(),
	});
}

function createResearchScope(fixture, expiresAt = "2026-09-11T13:00:00.000Z") {
	const stored = fixture.host.registerSource(fixture.scope(), source(), 0);
	fixture.host.setPhase(fixture.scope(), "research");
	const plan = fixture.host.createResearchPlan(fixture.scope(), {
		plan: formalPlan(stored.contentHash),
		expectedProjectRevision: 1,
	});
	const grant = fixture.host.grantScopeFromTrustedUserEvent(
		fixture.scope(),
		plan.planId,
		plan.revision,
		"trusted-ui-event-fixture",
		expiresAt,
	);
	return { stored, plan, grant };
}

function closeFixture(fixture) {
	fixture.database.close();
}

test("two SQLite connections share a globally bounded reservation", () => {
	const directory = mkdtempSync(join(tmpdir(), "study-execution-queue-"));
	const path = join(directory, "queue.sqlite");
	const now = { value: Date.parse("2026-09-11T12:00:00.000Z") };
	const first = setup({ path, now });
	const second = setup({ path, now, initialize: false });
	try {
		enqueueStudy(first, "first");
		enqueueStudy(second, "second");
		assert.ok(["first", "second"].includes(first.queue.claimNext("coordinator-one")?.job.dispatchKey));
		assert.equal(second.queue.claimNext("coordinator-two"), null);
	} finally {
		closeFixture(second);
		closeFixture(first);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("queue dispatch replay is exact and an altered payload is rejected", () => {
	const f = setup();
	try {
		const first = enqueueStudy(f, "replay");
		const replay = enqueueStudy(f, "replay");
		assert.equal(replay.replay, true);
		assert.equal(replay.job.queueJobId, first.job.queueJobId);
		assert.equal(enqueueStudy(f, "replay", { kind: "execution" }).job.queueJobId, first.job.queueJobId);
		assert.throws(
			() => enqueueStudy(f, "replay", { resources: resources({ diskBytes: 2_048 }) }),
			/dispatch key was reused with changed queue payload/,
		);
	} finally {
		closeFixture(f);
	}
});

test("queueing requires a Host-registered frozen execution producer", () => {
	const f = setup();
	try {
		assert.throws(
			() => enqueueStudy(f, "forged-producer", { producerContextId: "runner-context-not-registered" }),
			/trusted runner context/,
		);
		assert.equal(f.host.listTasks(f.scope()).length, 0);
	} finally {
		closeFixture(f);
	}
});

test("an outer queue rollback also rolls back the Host task reservation", () => {
	const f = setup();
	try {
		f.database.exec(
			"CREATE TRIGGER fail_queue_job BEFORE INSERT ON pi_study_execution_job BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END;",
		);
		assert.throws(() => enqueueStudy(f, "rollback"), /injected queue failure/);
		assert.equal(f.host.listTasks(f.scope()).length, 0);
	} finally {
		closeFixture(f);
	}
});

test("expired coordinator claims reject stale writers and allow one replacement claimant", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "lease");
		const first = f.queue.claimNext("old-coordinator");
		assert.ok(first);
		f.advance(1_001);
		const replacement = f.queue.claimNext("new-coordinator");
		assert.ok(replacement);
		assert.equal(replacement.job.queueJobId, queued.job.queueJobId);
		assert.equal(replacement.job.claimRevision, first.job.claimRevision + 1);
		assert.throws(
			() => f.queue.heartbeat(queued.job.queueJobId, "old-coordinator", first.job.claimRevision),
			/stale or no longer owned/,
		);
	} finally {
		closeFixture(f);
	}
});

test("prepared launch expiry is reconciled and cannot be launched twice", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "ambiguous-launch");
		const claim = f.queue.claimNext("launcher");
		assert.ok(claim);
		const stored = f.queue.persistPreparedHandle(queued.job.queueJobId, "launcher", claim.job.claimRevision, preparedHandle());
		assert.equal(stored.preparedHandle?.kind, "windows-isolated-run");
		assert.equal(JSON.stringify(stored.preparedHandle).includes("must-remain-private"), false);
		const lease = f.queue.beginPreparedLaunch(queued.job.queueJobId, "launcher", claim.job.claimRevision);
		assert.equal(lease.handle.privateHandle.cancelToken, "must-remain-private");
		f.advance(1_001);
		assert.equal(f.queue.reconcileExpired()[0].status, "reconciling");
		assert.equal(f.queue.claimNext("other-launcher"), null);
		const reconciliation = f.queue.acquireReconciliation(queued.job.queueJobId, "reconciler");
		assert.equal(reconciliation.handle.kind, "windows-isolated-run");
		assert.throws(
			() => f.queue.beginPreparedLaunch(queued.job.queueJobId, "reconciler", reconciliation.job.claimRevision),
			/only a prepared job/,
		);
	} finally {
		closeFixture(f);
	}
});

test("queued cancellation is durable and releases global capacity exactly once", () => {
	const f = setup();
	try {
		const neverAdmitted = enqueueStudy(f, "cancel-without-reservation");
		assert.equal(f.queue.requestCancellation(neverAdmitted.job.queueJobId).status, "cancelled");
		assert.equal(
			f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_execution_resource WHERE queue_job_id = ?").get(neverAdmitted.job.queueJobId).count,
			0,
		);
		const first = enqueueStudy(f, "cancel-first");
		assert.ok(f.queue.claimNext("canceller"));
		assert.equal(f.queue.requestCancellation(first.job.queueJobId).status, "cancelled");
		assert.equal(f.queue.requestCancellation(first.job.queueJobId).status, "cancelled");
		enqueueStudy(f, "cancel-second");
		assert.equal(f.queue.claimNext("replacement")?.job.dispatchKey, "cancel-second");
	} finally {
		closeFixture(f);
	}
});

test("a cancellation requested during execution wins over a late success receipt", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "late-cancel");
		const claim = f.queue.claimNext("late-canceller");
		assert.ok(claim);
		f.queue.persistPreparedHandle(queued.job.queueJobId, "late-canceller", claim.job.claimRevision, preparedHandle());
		f.queue.beginPreparedLaunch(queued.job.queueJobId, "late-canceller", claim.job.claimRevision);
		f.queue.confirmRunning(
			queued.job.queueJobId,
			"late-canceller",
			claim.job.claimRevision,
			"runner reported a live process before cancellation",
		);
		assert.equal(f.queue.requestCancellation(queued.job.queueJobId).status, "running");
		assert.equal(
			f.queue.recordTerminalReceipt({
				jobId: queued.job.queueJobId,
				claimOwner: "late-canceller",
				expectedClaimRevision: claim.job.claimRevision,
				status: "succeeded",
				usage: { wallTimeMs: 1, diskBytes: 1 },
			}).status,
			"cancelled",
		);
		enqueueStudy(f, "after-late-cancel");
		assert.equal(f.queue.claimNext("replacement")?.job.dispatchKey, "after-late-cancel");
	} finally {
		closeFixture(f);
	}
});

test("actual terminal usage is cumulative and fails subsequent admission closed", () => {
	const f = setup();
	try {
		const boundedQuota = quota({ maxRuns: 3, maxCumulativeWallTimeMs: 100, maxCumulativeDiskBytes: 1_000_000 });
		const first = enqueueStudy(f, "usage-first", { resources: resources({ wallTimeMs: 80 }), quota: boundedQuota });
		const claim = f.queue.claimNext("usage-runner");
		assert.ok(claim);
		f.queue.persistPreparedHandle(first.job.queueJobId, "usage-runner", claim.job.claimRevision, preparedHandle("pi-agent-context"));
		f.queue.beginPreparedLaunch(first.job.queueJobId, "usage-runner", claim.job.claimRevision);
		f.queue.confirmRunning(
			first.job.queueJobId,
			"usage-runner",
			claim.job.claimRevision,
			"runner reported a live process for usage measurement",
		);
		const terminal = f.queue.recordTerminalReceipt({
			jobId: first.job.queueJobId,
			claimOwner: "usage-runner",
			expectedClaimRevision: claim.job.claimRevision,
			status: "succeeded",
			usage: { wallTimeMs: 120, diskBytes: 1 },
		});
		assert.equal(terminal.status, "limit-reached");
		const second = enqueueStudy(f, "usage-second", { resources: resources({ wallTimeMs: 1 }), quota: boundedQuota });
		assert.equal(f.queue.claimNext("blocked-runner"), null);
		assert.equal(f.queue.getJob(second.job.queueJobId).status, "needs-input");
	} finally {
		closeFixture(f);
	}
});

test("an admitted Study task survives an interactive phase switch", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "phase-switch");
		const claim = f.queue.claimNext("phase-runner");
		assert.ok(claim);
		f.host.setPhase(f.scope(), "research");
		f.queue.persistPreparedHandle(queued.job.queueJobId, "phase-runner", claim.job.claimRevision, preparedHandle());
		f.queue.beginPreparedLaunch(queued.job.queueJobId, "phase-runner", claim.job.claimRevision);
		f.queue.confirmRunning(
			queued.job.queueJobId,
			"phase-runner",
			claim.job.claimRevision,
			"runner reported a live process after the phase switch",
		);
		assert.equal(
			f.queue.recordTerminalReceipt({
				jobId: queued.job.queueJobId,
				claimOwner: "phase-runner",
				expectedClaimRevision: claim.job.claimRevision,
				status: "succeeded",
				usage: { wallTimeMs: 1, diskBytes: 1 },
			}).status,
			"succeeded",
		);
	} finally {
		closeFixture(f);
	}
});

test("queued Research admission fails closed for an expired or revoked frozen grant", () => {
	const expired = setup();
	const revoked = setup();
	try {
		const expiredScope = createResearchScope(expired, "2026-09-11T12:00:01.000Z");
		enqueueResearch(expired, expiredScope.plan, expiredScope.grant, "expired-grant");
		expired.advance(1_001);
		assert.equal(expired.queue.claimNext("expired-runner"), null);
		assert.equal(expired.queue.getJob(expired.queue.listJobs(expired.projectId)[0].queueJobId).status, "needs-input");

		const revokedScope = createResearchScope(revoked);
		enqueueResearch(revoked, revokedScope.plan, revokedScope.grant, "revoked-grant");
		revoked.host.revokeScopeGrant(revoked.scope(), revokedScope.grant.grantId);
		assert.equal(revoked.queue.claimNext("revoked-runner"), null);
		assert.equal(revoked.queue.getJob(revoked.queue.listJobs(revoked.projectId)[0].queueJobId).status, "needs-input");
	} finally {
		closeFixture(expired);
		closeFixture(revoked);
	}
});

test("a queued Research task is rejected when a frozen source version changes", () => {
	const f = setup();
	try {
		const { stored, plan, grant } = createResearchScope(f);
		enqueueResearch(f, plan, grant, "source-change");
		const candidate = source("source-v2");
		const proposal = f.host.proposeSourceUpdate(f.scope(), {
			sourceId: stored.sourceId,
			candidate,
			knowledge: { nodes: [], notes: [], relations: [] },
			changeSummary: "The linked source was corrected before execution.",
			expectedProjectRevision: 2,
		});
		f.host.acceptSourceUpdate(f.scope(), proposal.proposalId, 3);
		assert.equal(f.queue.claimNext("source-runner"), null);
		assert.equal(f.queue.getJob(f.queue.listJobs(f.projectId)[0].queueJobId).status, "needs-input");
	} finally {
		closeFixture(f);
	}
});

test("Research queueing accepts duplicate content hashes when explicit source identities disambiguate them", () => {
	const f = setup();
	try {
		const sameHash = hash("same-content");
		const first = source("same-content", "main.tex");
		const second = source("same-content", "appendix.tex");
		assert.equal(first.contentHash, sameHash);
		const imported = f.host.registerSources(f.scope(), [first, second], 0).sources;
		f.host.setPhase(f.scope(), "research");
		const plan = f.host.createResearchPlan(f.scope(), {
			expectedProjectRevision: 1,
			plan: {
				...formalPlan(sameHash),
				sourceVersionHashes: [sameHash, sameHash],
				sourceReferences: imported.map((item) => ({ sourceId: item.sourceId, contentHash: sameHash })),
			},
		});
		const grant = f.host.grantScopeFromTrustedUserEvent(
			f.scope(),
			plan.planId,
			plan.revision,
			"trusted-ui-event-ambiguous-hash",
			"2026-09-11T13:00:00.000Z",
		);
		const queued = enqueueResearch(f, plan, grant, "explicit-source-identities");
		assert.equal(f.queue.claimNext("source-identity-coordinator")?.job.queueJobId, queued.job.queueJobId);
	} finally {
		closeFixture(f);
	}
});

test("learning reading and execution in Research retain real phase and require no research grant", () => {
	const f = setup();
	try {
		f.host.setPhase(f.scope(), "research");
		for (const kind of ["reading", "execution"]) {
			const result = f.queue.enqueueStudy(f.scope(), {
				kind, dispatchKey: `research-learning-${kind}`, manifest: manifest(kind),
				admission: { purpose: "Understand the existing paper and its calculation", language: kind === "reading" ? "none" : "python", maxWallSeconds: 60, maxMemoryMiB: 512 },
				producerContextId: f.context.contextId, resources: resources(), quota: quota(),
			});
			assert.equal(result.job.mode, "research");
			const task = f.host.readTaskForCoordinator(result.job.taskId);
			assert.equal(task.authorization.kind, "learning");
			assert.equal(task.authorization.phase, "research");
			assert.equal(task.kind, kind);
			const claim = f.queue.claimNext("learning-coordinator");
			assert.equal(claim.job.queueJobId, result.job.queueJobId);
			f.queue.requestCancellation(result.job.queueJobId);
		}
		assert.equal(f.host.listScopeGrants(f.scope()).length, 0);
		assert.equal(f.host.currentPhase(f.projectId, f.sessionId).phase, "research");
	} finally { closeFixture(f); }
});

test("claiming skips a permanently invalid earlier job across projects and a transient global-capacity miss", () => {
	const directory = mkdtempSync(join(tmpdir(), "study-execution-queue-scan-"));
	const path = join(directory, "queue.sqlite");
	const now = { value: Date.parse("2026-09-11T12:00:00.000Z") };
	const first = setup({ path, now });
	first.database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run("project-b", JSON.stringify({ id: "project-b" }));
	first.database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("session-b", "project-b");
	const second = setup({ path, now, initialize: false, projectId: "project-b", sessionId: "session-b" });
	try {
		const research = createResearchScope(first, "2026-09-11T12:00:01.000Z");
		const invalid = enqueueResearch(first, research.plan, research.grant, "invalid-first");
		now.value += 1_001;
		const valid = enqueueStudy(second, "valid-second");
		const claim = first.queue.claimNext("cross-project-coordinator");
		assert.equal(claim?.job.queueJobId, valid.job.queueJobId);
		const invalidAfter = first.queue.getJob(invalid.job.queueJobId);
		assert.equal(invalidAfter.status, "needs-input");
		assert.equal(invalidAfter.admissionFailure?.coordinatorId, "cross-project-coordinator");

		const transient = enqueueStudy(second, "too-large-first", { resources: resources({ cpuMilliCores: 3_000 }) });
		const fitting = enqueueStudy(second, "fits-after-transient");
		assert.equal(first.queue.claimNext("capacity-coordinator"), null);
		first.queue.requestCancellation(valid.job.queueJobId);
		assert.equal(first.queue.claimNext("capacity-coordinator")?.job.queueJobId, fitting.job.queueJobId);
		assert.equal(first.queue.getJob(transient.job.queueJobId).status, "queued");
	} finally {
		closeFixture(second);
		closeFixture(first);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("missing or released reservations fail closed and roll back cancellation", () => {
	for (const corruption of ["missing", "released"]) {
		const f = setup();
		try {
			const queued = enqueueStudy(f, `reservation-${corruption}`);
			assert.ok(f.queue.claimNext(`coordinator-${corruption}`));
			if (corruption === "missing") {
				f.database.prepare("DELETE FROM pi_study_execution_resource WHERE queue_job_id = ?").run(queued.job.queueJobId);
			} else {
				const row = f.database
					.prepare("SELECT payload FROM pi_study_execution_resource WHERE queue_job_id = ?")
					.get(queued.job.queueJobId);
				const reservation = JSON.parse(row.payload);
				reservation.releasedAt = "2026-09-11T12:00:00.000Z";
				f.database
					.prepare("UPDATE pi_study_execution_resource SET payload = ?, payload_hash = ? WHERE queue_job_id = ?")
					.run(stableStringify(reservation), contentHash(reservation), queued.job.queueJobId);
			}
			assert.throws(() => f.queue.requestCancellation(queued.job.queueJobId), /missing or already released resource reservation/);
			assert.equal(f.queue.getJob(queued.job.queueJobId).status, "admitted");
			assert.equal(f.host.listTasks(f.scope())[0].status, "admitted");
		} finally {
			closeFixture(f);
		}
	}
});

test("prepared cancellation retains its private cleanup handle and records measured usage", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "prepared-cancel");
		const claim = f.queue.claimNext("prepared-cleanup");
		assert.ok(claim);
		f.queue.persistPreparedHandle(queued.job.queueJobId, "prepared-cleanup", claim.job.claimRevision, preparedHandle());
		assert.equal(f.queue.requestCancellation(queued.job.queueJobId).status, "prepared");
		assert.throws(
			() => f.queue.beginPreparedLaunch(queued.job.queueJobId, "prepared-cleanup", claim.job.claimRevision),
			/cancelled admission cannot launch/,
		);
		const cleanup = f.queue.acquirePreparedCancellation(queued.job.queueJobId, "prepared-cleanup", claim.job.claimRevision);
		assert.equal(cleanup.handle.privateHandle.cancelToken, "must-remain-private");
		const cancelled = f.queue.recordTerminalReceipt({
			jobId: queued.job.queueJobId,
			claimOwner: "prepared-cleanup",
			expectedClaimRevision: claim.job.claimRevision,
			status: "cancelled",
			usage: { wallTimeMs: 7, diskBytes: 3 },
		});
		assert.equal(cancelled.status, "cancelled");
		assert.deepEqual(cancelled.actualUsage, { wallTimeMs: 7, diskBytes: 3 });
	} finally {
		closeFixture(f);
	}
});

test("scope quotas are materialized at enqueue and per-run overages force limit-reached", () => {
	const f = setup();
	try {
		const fixedQuota = quota({ maxRuns: 5, maxCumulativeWallTimeMs: 1_000_000, maxCumulativeDiskBytes: 1_000_000 });
		enqueueStudy(f, "quota-first", { quota: fixedQuota });
		assert.throws(
			() => enqueueStudy(f, "quota-conflict", { quota: quota({ maxRuns: 6 }) }),
			/materialized for this execution scope/,
		);
		assert.equal(f.host.listTasks(f.scope()).length, 1);
		const overrun = enqueueStudy(f, "per-run-overage", { resources: resources({ wallTimeMs: 10, diskBytes: 10 }), quota: fixedQuota });
		const claim = f.queue.claimNext("overrun-runner");
		assert.ok(claim);
		assert.equal(claim.job.dispatchKey, "quota-first");
		f.queue.requestCancellation(claim.job.queueJobId);
		const overrunClaim = f.queue.claimNext("overrun-runner");
		assert.equal(overrunClaim?.job.queueJobId, overrun.job.queueJobId);
		f.queue.persistPreparedHandle(overrun.job.queueJobId, "overrun-runner", overrunClaim.job.claimRevision, preparedHandle());
		f.queue.beginPreparedLaunch(overrun.job.queueJobId, "overrun-runner", overrunClaim.job.claimRevision);
		f.queue.confirmRunning(overrun.job.queueJobId, "overrun-runner", overrunClaim.job.claimRevision, "runner established a process");
		assert.equal(
			f.queue.recordTerminalReceipt({
				jobId: overrun.job.queueJobId,
				claimOwner: "overrun-runner",
				expectedClaimRevision: overrunClaim.job.claimRevision,
				status: "succeeded",
				usage: { wallTimeMs: 11, diskBytes: 10 },
			}).status,
			"limit-reached",
		);
	} finally {
		closeFixture(f);
	}
});

test("replay identity binds the session and public queue DTOs redact producer provenance", () => {
	const f = setup();
	try {
		const first = enqueueStudy(f, "session-replay");
		assert.equal("producerContextId" in first.job, false);
		f.database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("session-b", f.projectId);
		f.host.bindSession(f.projectId, "session-b");
		const phase = f.host.currentPhase(f.projectId, "session-b");
		const scopeB = { projectId: f.projectId, sessionId: "session-b", expectedPhaseRevision: phase.revision };
		const contextB = f.host.registerTrustedRunnerContext(scopeB, "fixture-runner-session-b");
		assert.throws(
			() =>
				f.queue.enqueueStudy(scopeB, {
					dispatchKey: "session-replay",
					manifest: manifest("session-replay"),
					admission: {
						purpose: "Run a small bounded computation with an explicit purpose.",
						language: "python",
						maxWallSeconds: 60,
						maxMemoryMiB: 512,
					},
					producerContextId: contextB.contextId,
					resources: resources(),
					quota: quota(),
				}),
			/different session scope/,
		);
		assert.equal("producerContextId" in f.queue.getJob(first.job.queueJobId), false);
	} finally {
		closeFixture(f);
	}
});

test("launch and reconciliation failures never synthesize running, while success requires evidence", () => {
	const f = setup();
	try {
		const failed = enqueueStudy(f, "launch-failure");
		const claim = f.queue.claimNext("failure-runner");
		assert.ok(claim);
		f.queue.persistPreparedHandle(failed.job.queueJobId, "failure-runner", claim.job.claimRevision, preparedHandle());
		f.queue.beginPreparedLaunch(failed.job.queueJobId, "failure-runner", claim.job.claimRevision);
		assert.throws(
			() =>
				f.queue.recordTerminalReceipt({
					jobId: failed.job.queueJobId,
					claimOwner: "failure-runner",
					expectedClaimRevision: claim.job.claimRevision,
					status: "succeeded",
					usage: { wallTimeMs: 1, diskBytes: 1 },
				}),
			/running confirmation/,
		);
		assert.equal(
			f.queue.recordTerminalReceipt({
				jobId: failed.job.queueJobId,
				claimOwner: "failure-runner",
				expectedClaimRevision: claim.job.claimRevision,
				status: "failed",
				usage: { wallTimeMs: 1, diskBytes: 1 },
			}).status,
			"failed",
		);
		assert.equal(f.host.listTaskEvents(f.scope(), failed.job.taskId).some((event) => event.status === "running"), false);

		const reconciling = enqueueStudy(f, "reconciliation-failure");
		const launch = f.queue.claimNext("reconcile-runner");
		assert.ok(launch);
		f.queue.persistPreparedHandle(reconciling.job.queueJobId, "reconcile-runner", launch.job.claimRevision, preparedHandle());
		f.queue.beginPreparedLaunch(reconciling.job.queueJobId, "reconcile-runner", launch.job.claimRevision);
		f.advance(1_001);
		f.queue.reconcileExpired();
		const reconciliation = f.queue.acquireReconciliation(reconciling.job.queueJobId, "receipt-reconciler");
		assert.equal(
			f.queue.recordTerminalReceipt({
				jobId: reconciling.job.queueJobId,
				claimOwner: "receipt-reconciler",
				expectedClaimRevision: reconciliation.job.claimRevision,
				status: "cancelled",
				usage: { wallTimeMs: 1, diskBytes: 1 },
			}).status,
			"cancelled",
		);
		assert.equal(f.host.listTaskEvents(f.scope(), reconciling.job.taskId).some((event) => event.status === "running"), false);
	} finally {
		closeFixture(f);
	}
});

test("prepared handles reject Date, Map, and class instances before persistence", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "plain-json-only");
		const claim = f.queue.claimNext("json-coordinator");
		assert.ok(claim);
		class PrivateHandle {
			constructor() {
				this.runId = "class-instance";
			}
		}
		for (const privateHandle of [{ createdAt: new Date() }, { mapping: new Map([["a", "b"]]) }, new PrivateHandle()]) {
			assert.throws(
				() =>
					f.queue.persistPreparedHandle(queued.job.queueJobId, "json-coordinator", claim.job.claimRevision, {
						kind: "windows-isolated-run",
						version: 1,
						privateHandle,
						publicSummary: { runId: "safe" },
					}),
				/plain JSON|plain objects/,
			);
		}
	} finally {
		closeFixture(f);
	}
});

test("prepared public summaries cannot contain a secret-shaped field", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "redaction");
		const claim = f.queue.claimNext("redactor");
		assert.ok(claim);
		const bad = preparedHandle();
		bad.publicSummary.cancelToken = "leaked";
		assert.throws(
			() => f.queue.persistPreparedHandle(queued.job.queueJobId, "redactor", claim.job.claimRevision, bad),
			/public prepared-handle summary contains a sensitive field/,
		);
	} finally {
		closeFixture(f);
	}
});

test("never-started cleanup and launch failure charge overages without inventing running or leaking capacity", () => {
	for (const scenario of ["prepared-cancellation", "launch-failure"]) {
		const f = setup();
		try {
			const fixed = quota({ maxCumulativeWallTimeMs: 10, maxCumulativeDiskBytes: 10 });
			const queued = enqueueStudy(f, scenario, { resources: resources({ wallTimeMs: 10, diskBytes: 10 }), quota: fixed });
			const claim = f.queue.claimNext("cleanup");
			f.queue.persistPreparedHandle(queued.job.queueJobId, "cleanup", claim.job.claimRevision, preparedHandle());
			if (scenario === "prepared-cancellation") f.queue.requestCancellation(queued.job.queueJobId);
			else f.queue.beginPreparedLaunch(queued.job.queueJobId, "cleanup", claim.job.claimRevision);
			const status = scenario === "prepared-cancellation" ? "cancelled" : "failed";
			const terminal = f.queue.recordTerminalReceipt({
				jobId: queued.job.queueJobId, claimOwner: "cleanup", expectedClaimRevision: claim.job.claimRevision,
				status, usage: { wallTimeMs: 11, diskBytes: 12 },
			});
			assert.equal(terminal.status, status);
			assert.deepEqual(terminal.actualUsage, { wallTimeMs: 11, diskBytes: 12 });
			assert.equal(terminal.claimOwner, null);
			assert.equal(terminal.leaseExpiresAt, null);
			const events = f.host.listTaskEvents(f.scope(), queued.job.taskId);
			assert.equal(events.some((event) => event.status === "running"), false);
			assert.match(events.at(-1).detail, /exceeded=run.wallTimeMs,run.diskBytes,scope.wallTimeMs,scope.diskBytes/);
			const aggregate = JSON.parse(f.database.prepare("SELECT payload FROM pi_study_execution_scope_usage").get().payload);
			assert.equal(aggregate.reservedWallTimeMs, 0);
			assert.equal(aggregate.reservedDiskBytes, 0);
			assert.equal(aggregate.consumedWallTimeMs, 11);
			assert.equal(aggregate.consumedDiskBytes, 12);
			assert.ok(JSON.parse(f.database.prepare("SELECT payload FROM pi_study_execution_resource").get().payload).releasedAt);
			const blocked = enqueueStudy(f, `${scenario}-next`, { resources: resources({ wallTimeMs: 1, diskBytes: 1 }), quota: fixed });
			assert.equal(f.queue.claimNext("next"), null);
			assert.equal(f.queue.getJob(blocked.job.queueJobId).status, "needs-input");
		} finally { closeFixture(f); }
	}
});

test("immediate admitted cancellation clears the lease and refuses terminal heartbeats", () => {
	const f = setup();
	try {
		const queued = enqueueStudy(f, "cancel-lease");
		const claim = f.queue.claimNext("owner");
		const cancelled = f.queue.requestCancellation(queued.job.queueJobId);
		assert.equal(cancelled.claimOwner, null);
		assert.equal(cancelled.leaseExpiresAt, null);
		assert.throws(() => f.queue.heartbeat(queued.job.queueJobId, "owner", claim.job.claimRevision), /terminal jobs/);
	} finally { closeFixture(f); }
});
