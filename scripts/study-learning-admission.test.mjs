import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { contentHash, stableStringify } from "../packages/harness-core/src/index.ts";
import { StudyResearchHost } from "../packages/study-research-host/src/index.ts";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function manifest(name) {
	return {
		codeHash: hash(`${name}:code`),
		parameterHash: hash(`${name}:parameters`),
		inputHashes: {},
		environmentHash: hash(`${name}:environment`),
	};
}

function admission() {
	return {
		purpose: "Check a bounded learning calculation against the currently open material.",
		language: "python",
		maxWallSeconds: 30,
		maxMemoryMiB: 256,
	};
}

function setup() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
	`);
	database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run("project-a", JSON.stringify({ id: "project-a" }));
	database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("session-a", "project-a");
	const host = new StudyResearchHost(database, { clock: () => new Date("2026-09-12T12:00:00.000Z") });
	host.bindSession("project-a", "session-a");
	const scope = () => {
		const phase = host.currentPhase("project-a", "session-a");
		if (!phase) throw new Error("fixture phase is unexpectedly absent");
		return { projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: phase.revision };
	};
	return { database, host, scope };
}

function succeed(host, task) {
	let current = host.transitionTaskFromFrozenAuthorization({
		taskId: task.taskId,
		expectedTaskRevision: task.revision,
		nextStatus: "admitted",
		detail: "fixture coordinator admitted the bounded learning task",
	});
	current = host.transitionTaskFromFrozenAuthorization({
		taskId: current.taskId,
		expectedTaskRevision: current.revision,
		nextStatus: "launching",
		detail: "fixture runner prepared the bounded learning task",
	});
	current = host.transitionTaskFromFrozenAuthorization({
		taskId: current.taskId,
		expectedTaskRevision: current.revision,
		nextStatus: "running",
		detail: "fixture runner observed bounded learning execution",
	});
	return host.transitionTaskFromFrozenAuthorization({
		taskId: current.taskId,
		expectedTaskRevision: current.revision,
		nextStatus: "succeeded",
		detail: "fixture runner completed bounded learning execution",
	});
}

function source() {
	return {
		sourceRoot: "D:/paper",
		relativePath: "main.tex",
		kind: "tex",
		sourceRole: "primary",
		diagnostics: [],
		contentHash: hash("source-v1"),
		parser: "tex-reader/1.0.0",
		chunks: [{ ordinal: 1, locator: JSON.stringify({ line: 1 }), text: "source-v1" }],
	};
}

function formalPlan(sourceHash) {
	return {
		kind: "formal",
		detail: {
			question: "Does the bounded calculation improve the fixture metric?",
			hypotheses: ["The fixture calculation is measurable."],
			datasetVersion: "fixture-v1",
			splitProtocol: "fixed split",
			primaryMetrics: ["error"],
			method: "locked fixture method",
			stoppingConditions: ["Stop at the approved budget."],
		},
		sourceVersionHashes: [sourceHash],
	};
}

test("bounded learning reading and execution reserve in Research with learning authorization, not a grant", () => {
	const f = setup();
	try {
		f.host.setPhase(f.scope(), "research");
		const reading = f.host.reserveStudyTask(f.scope(), {
			dispatchKey: "research-learning-reading",
			kind: "reading",
			manifest: manifest("reading"),
			admission: { ...admission(), language: "none" },
		}).task;
		const context = f.host.registerTrustedRunnerContext(f.scope(), "learning-research-runner");
		const execution = f.host.reserveStudyTask(f.scope(), {
			dispatchKey: "research-learning-execution",
			kind: "execution",
			manifest: manifest("execution"),
			admission: admission(),
			producerContextId: context.contextId,
		}).task;
		for (const task of [reading, execution]) {
			assert.equal(task.authorization.kind, "learning");
			assert.equal(task.authorization.phase, "research");
			assert.equal("grantId" in task.authorization, false);
		}
	} finally {
		f.database.close();
	}
});

test("learning execution in Research requires a trusted producer and keeps the current phase CAS", () => {
	const f = setup();
	try {
		const studyScope = f.scope();
		f.host.setPhase(studyScope, "research");
		assert.throws(
			() =>
				f.host.reserveStudyTask(f.scope(), {
					dispatchKey: "missing-learning-producer",
					kind: "execution",
					manifest: manifest("missing-producer"),
					admission: admission(),
				}),
			/trusted runner context/,
		);
		assert.throws(
			() =>
				f.host.reserveStudyTask(studyScope, {
					dispatchKey: "stale-phase-cas",
					kind: "reading",
					manifest: manifest("stale-phase"),
					admission: { ...admission(), language: "none" },
				}),
			/phase changed/,
		);
	} finally {
		f.database.close();
	}
});

test("learning tasks remain coordinator-readable and admissible after an interactive phase change", () => {
	const f = setup();
	try {
		const context = f.host.registerTrustedRunnerContext(f.scope(), "phase-independent-learning-runner");
		const reserved = f.host.reserveStudyTask(f.scope(), {
			dispatchKey: "phase-independent-learning",
			kind: "execution",
			manifest: manifest("phase-independent"),
			admission: admission(),
			producerContextId: context.contextId,
		}).task;
		f.host.setPhase(f.scope(), "research");
		const coordinatorRead = f.host.readTaskForCoordinator(reserved.taskId);
		assert.equal(coordinatorRead.status, "queued");
		assert.equal(coordinatorRead.authorization.kind, "learning");
		assert.equal(coordinatorRead.authorization.phase, "study");
		assert.equal(
			f.host.transitionTaskFromFrozenAuthorization({
				taskId: reserved.taskId,
				expectedTaskRevision: reserved.revision,
				nextStatus: "admitted",
				detail: "trusted coordinator admitted a previously reserved learning task",
			}).status,
			"admitted",
		);
		f.database.prepare("DELETE FROM pi_project_member WHERE session_id = ?").run("session-a");
		assert.throws(() => f.host.readTaskForCoordinator(reserved.taskId), /not a member/);
	} finally {
		f.database.close();
	}
});

test("learning execution cannot record a ResearchResult", () => {
	const f = setup();
	try {
		f.host.setPhase(f.scope(), "research");
		const context = f.host.registerTrustedRunnerContext(f.scope(), "learning-result-runner");
		const task = f.host.reserveStudyTask(f.scope(), {
			dispatchKey: "learning-result-rejection",
			kind: "execution",
			manifest: manifest("learning-result"),
			admission: admission(),
			producerContextId: context.contextId,
		}).task;
		const completed = succeed(f.host, task);
		assert.throws(
			() =>
				f.host.recordResultFromFrozenTask({
					taskId: completed.taskId,
					expectedTaskRevision: completed.revision,
					classification: "positive",
					summary: "A bounded learning execution cannot create a grant-scoped research result.",
					limitations: [],
				}),
			/Study executions/,
		);
	} finally {
		f.database.close();
	}
});

test("legacy Study and Research authorizations normalize unambiguously while mixed records fail closed", () => {
	const f = setup();
	try {
		const context = f.host.registerTrustedRunnerContext(f.scope(), "legacy-learning-runner");
		const learning = f.host.reserveStudyTask(f.scope(), {
			dispatchKey: "legacy-learning",
			kind: "execution",
			manifest: manifest("legacy-learning"),
			admission: admission(),
			producerContextId: context.contextId,
		}).task;
		const learningPayload = JSON.parse(
			f.database.prepare("SELECT payload FROM pi_study_research_task WHERE task_id = ?").get(learning.taskId).payload,
		);
		delete learningPayload.authorization.kind;
		f.database
			.prepare("UPDATE pi_study_research_task SET payload = ?, payload_hash = ? WHERE task_id = ?")
			.run(stableStringify(learningPayload), contentHash(learningPayload), learning.taskId);
		assert.equal(f.host.readTaskForCoordinator(learning.taskId).authorization.kind, "learning");

		const stored = f.host.registerSource(f.scope(), source(), 0);
		f.host.setPhase(f.scope(), "research");
		const plan = f.host.createResearchPlan(f.scope(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(
			f.scope(),
			plan.planId,
			plan.revision,
			"trusted-legacy-grant",
			"2026-09-12T13:00:00.000Z",
		);
		const researchContext = f.host.registerTrustedRunnerContext(f.scope(), "legacy-research-runner");
		const research = f.host.reserveTask(f.scope(), {
			planId: plan.planId,
			grantId: grant.grantId,
			expectedPlanRevision: plan.revision,
			dispatchKey: "legacy-research",
			kind: "execution",
			manifest: manifest("legacy-research"),
			producerContextId: researchContext.contextId,
		}).task;
		const researchPayload = JSON.parse(
			f.database.prepare("SELECT payload FROM pi_study_research_task WHERE task_id = ?").get(research.taskId).payload,
		);
		delete researchPayload.authorization.kind;
		f.database
			.prepare("UPDATE pi_study_research_task SET payload = ?, payload_hash = ? WHERE task_id = ?")
			.run(stableStringify(researchPayload), contentHash(researchPayload), research.taskId);
		assert.equal(f.host.readTaskForCoordinator(research.taskId).authorization.kind, "research-grant");

		learningPayload.authorization = {
			...learningPayload.authorization,
			phase: "research",
			grantId: grant.grantId,
			planId: plan.planId,
			planRevision: plan.revision,
			semanticDigest: plan.semanticDigest,
		};
		f.database
			.prepare("UPDATE pi_study_research_task SET payload = ?, payload_hash = ? WHERE task_id = ?")
			.run(stableStringify(learningPayload), contentHash(learningPayload), learning.taskId);
		assert.throws(() => f.host.readTaskForCoordinator(learning.taskId), /authorization.*ambiguous|ambiguous.*authorization/);
	} finally {
		f.database.close();
	}
});

test("project-level dispatch replay cannot return another session's learning or research task", () => {
	const f = setup();
	try {
		f.database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("session-b", "project-a");
		f.host.bindSession("project-a", "session-b");
		let scopeB = { projectId: "project-a", sessionId: "session-b", expectedPhaseRevision: 1 };
		const request = { dispatchKey: "shared-reading", kind: "reading", manifest: manifest("shared"), admission: { ...admission(), language: "none" } };
		const first = f.host.reserveStudyTask(f.scope(), request);
		assert.equal(f.host.reserveStudyTask(f.scope(), request).task.taskId, first.task.taskId);
		assert.throws(() => f.host.reserveStudyTask(scopeB, request), /different session/);
		const stored = f.host.registerSource(f.scope(), source(), 0);
		f.host.setPhase(f.scope(), "research");
		scopeB = { ...scopeB, expectedPhaseRevision: f.host.setPhase(scopeB, "research").revision };
		const plan = f.host.createResearchPlan(f.scope(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scope(), plan.planId, plan.revision, "trusted-replay-event", "2026-09-12T13:00:00.000Z");
		const researchRequest = { dispatchKey: "shared-research-reading", kind: "reading", manifest: manifest("research-shared"), planId: plan.planId, grantId: grant.grantId, expectedPlanRevision: plan.revision };
		const research = f.host.reserveTask(f.scope(), researchRequest);
		assert.equal(f.host.reserveTask(f.scope(), researchRequest).task.taskId, research.task.taskId);
		assert.throws(() => f.host.reserveTask(scopeB, researchRequest), /different session/);
	} finally { f.database.close(); }
});

test("legacy execution with missing producer fails coordinator reads and transitions closed", () => {
	const f = setup();
	try {
		const producerContextId = f.host.registerTrustedRunnerContext(f.scope(), "legacy-producer-test").contextId;
		const task = f.host.reserveStudyTask(f.scope(), { dispatchKey: "legacy-null-producer", kind: "execution", manifest: manifest("legacy-null"), admission: admission(), producerContextId }).task;
		const damaged = { ...task, producerContextId: null };
		delete damaged.authorization.kind;
		f.database.prepare("UPDATE pi_study_research_task SET payload = ?, payload_hash = ? WHERE task_id = ?").run(stableStringify(damaged), contentHash(damaged), task.taskId);
		assert.throws(() => f.host.readTaskForCoordinator(task.taskId), /lacks its trusted producer/);
		assert.throws(() => f.host.transitionTaskFromFrozenAuthorization({ taskId: task.taskId, expectedTaskRevision: 1, nextStatus: "admitted", detail: "must refuse" }), /lacks its trusted producer/);
	} finally { f.database.close(); }
});
