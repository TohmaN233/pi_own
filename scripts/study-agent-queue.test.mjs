import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { StudyAgentQueue, StudyResearchHost } from "../packages/study-research-host/src/index.ts";

function manifest(key) {
	return {
		codeHash: contentHash(`${key}:code`),
		parameterHash: contentHash(`${key}:parameters`),
		inputHashes: { source: contentHash(`${key}:source`) },
		environmentHash: contentHash("study-agent-queue-fixture"),
	};
}

function admission() {
	return {
		purpose: "Read frozen source chunks and record a source-grounded report.",
		language: "none",
		maxWallSeconds: 30,
		maxMemoryMiB: 128,
	};
}

function setup(options = {}) {
	const database = new DatabaseSync(options.path ?? ":memory:");
	const now = options.now ?? { value: Date.parse("2026-09-12T12:00:00.000Z") };
	if (options.initialize !== false) {
		database.exec("CREATE TABLE pi_project_workspace(id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE pi_project_member(session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);");
		database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run("project", JSON.stringify({ id: "project" }));
		database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("parent", "project");
		database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("peer", "project");
	}
	const clock = () => new Date(now.value);
	const host = new StudyResearchHost(database, { clock });
	if (!host.currentPhase("project", "parent")) host.bindSession("project", "parent");
	if (!host.currentPhase("project", "peer")) host.bindSession("project", "peer");
	const queue = new StudyAgentQueue(database, host, { clock, leaseDurationMs: 1_000 });
	const scope = (sessionId = "parent") => {
		const phase = host.currentPhase("project", sessionId);
		return { projectId: "project", sessionId, expectedPhaseRevision: phase.revision };
	};
	const source = options.initialize === false
		? host.listSources(scope())[0]
		: host.registerSources(
			scope(),
			[
			{
				sourceRoot: "D:/study",
				relativePath: "paper.tex",
				kind: "tex",
				sourceRole: "primary",
				diagnostics: [],
				contentHash: contentHash("queue-source"),
				parser: "queue-test/1",
				chunks: [
					{ ordinal: 1, locator: JSON.stringify({ line: 1 }), text: "A finite first moment does not prove a finite second moment." },
					{ ordinal: 2, locator: JSON.stringify({ line: 2 }), text: "The source must state its variance assumptions explicitly." },
				],
			},
			],
			0,
		).sources[0];
	const evidence = host.readChunks(scope(), source.sourceId, source.contentHash, 0, 8).chunks.map((chunk) => ({
		id: chunk.chunkId,
		sourceId: chunk.sourceId,
		sourceHash: chunk.sourceHash,
		locator: chunk.locator,
	}));
	return {
		database,
		host,
		queue,
		scope,
		source,
		evidence,
		advance(milliseconds) {
			now.value += milliseconds;
		},
		close() {
			database.close();
		},
	};
}

function enqueue(fixture, dispatchKey, overrides = {}) {
	let binds = 0;
	const result = fixture.queue.enqueueLearning(
		{
			scope: overrides.scope ?? fixture.scope(),
			dispatchKey,
			intentHash: overrides.intentHash ?? contentHash({ dispatchKey, kind: overrides.kind ?? "reading", evidence: fixture.evidence }),
			...(overrides.priority !== undefined ? { priority: overrides.priority } : {}),
			kind: overrides.kind ?? "reading",
			evidence: overrides.evidence ?? fixture.evidence,
			context: overrides.context ?? { agentSessionId: `pi-${dispatchKey}`, sessionFile: `D:/sessions/${dispatchKey}.jsonl` },
			manifest: overrides.manifest ?? manifest(dispatchKey),
			admission: overrides.admission ?? admission(),
			...(overrides.target ? { target: overrides.target } : {}),
		},
		(taskId) => {
			binds += 1;
			return { packetHash: contentHash({ taskId, dispatchKey, packet: "frozen" }) };
		},
	);
	return { ...result, binds };
}

function key(claim) {
	return {
		projectId: claim.task.projectId,
		taskId: claim.task.taskId,
		workerId: claim.workerId,
		claimToken: claim.claimToken,
	};
}

function hasCode(code) {
	return (error) => error && typeof error === "object" && error.code === code;
}

function report(task, overrides = {}) {
	return {
		summary: "The selected fragments distinguish the first and second moments.",
		outcome: "inconclusive",
		findings: [],
		notes: [],
		unresolved: ["Read the later theorem before claiming finite variance."],
		target: task.target,
		...overrides,
	};
}

function reviewTarget(fixture, identity = "visualization-fixture") {
	const creator = fixture.host.registerTrustedRunnerContext(fixture.scope(), identity);
	const draft = {
		creatorContextId: creator.contextId,
		purpose: "Show the source condition.",
		code: "plot([1, 2])",
		inputs: {},
		inputHashes: {},
		environmentHash: contentHash("visualization-env"),
	};
	const visualization = fixture.host.createVisualizationDraft(
		fixture.scope(),
		draft,
		fixture.host.projectRevision(fixture.scope()).revision,
	);
	return {
		creator,
		draft,
		target: {
			targetKind: "visualization",
			targetId: visualization.visualizationId,
			targetRevision: visualization.revision,
			targetHash: visualization.contentHash,
		},
	};
}

test("queue binds one task-id packet, replays exactly, and keeps session paths private", () => {
	const fixture = setup();
	try {
		const first = enqueue(fixture, "reading:one");
		const replay = enqueue(fixture, "reading:one");
		assert.equal(first.replay, false);
		assert.equal(first.binds, 1);
		assert.equal(replay.replay, true);
		assert.equal(replay.binds, 0);
		assert.equal(replay.task.taskId, first.task.taskId);
		assert.equal(JSON.stringify(first.task).includes("sessionFile"), false);
		assert.equal(
			fixture.queue.list(fixture.scope("peer")).find((task) => task.taskId === first.task.taskId)?.context.agentSessionId,
			"pi-reading:one",
		);
		const claim = fixture.queue.claim("project", first.task.taskId, "reader");
		assert.ok(claim);
		assert.equal(fixture.queue.readContext(key(claim)).sessionFile, "D:/sessions/reading:one.jsonl");
		assert.throws(
			() => enqueue(fixture, "reading:one", { intentHash: contentHash("different-intent") }),
			hasCode("IDEMPOTENCY_CONFLICT"),
		);
	} finally {
		fixture.close();
	}
});

test("reprioritization uses a priority CAS and changes only unclaimed reading drain order", () => {
	const fixture = setup();
	try {
		const first = enqueue(fixture, "priority-first", { priority: 0 }).task;
		const second = enqueue(fixture, "priority-second", { priority: 0 }).task;
		const updated = fixture.queue.setPriority(fixture.scope(), first.taskId, 0, 10);
		assert.equal(updated.priority, 10);
		assert.deepEqual(
			fixture.queue.listClaimable().slice(0, 2).map((task) => task.taskId),
			[first.taskId, second.taskId],
		);
		assert.equal(updated.context.packetHash, first.context.packetHash);
		assert.deepEqual(updated.evidence, first.evidence);
		assert.equal(
			fixture.database
				.prepare("SELECT event, detail FROM pi_study_agent_queue_diagnostic WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
				.get(first.taskId).event,
			"priority-updated",
		);
		assert.throws(
			() => fixture.queue.setPriority(fixture.scope(), first.taskId, 0, 5),
			hasCode("AGENT_PRIORITY_CONFLICT"),
		);
		assert.throws(
			() => fixture.queue.setPriority(fixture.scope(), first.taskId, 10, 101),
			hasCode("INVALID_AGENT_PRIORITY"),
		);
		assert.throws(
			() => fixture.queue.setPriority({ projectId: "project", sessionId: "outsider", expectedPhaseRevision: 1 }, first.taskId, 10, 5),
			hasCode("PROJECT_ACCESS_DENIED"),
		);

		fixture.database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run("other-project", JSON.stringify({ id: "other-project" }));
		fixture.database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("other-session", "other-project");
		fixture.host.bindSession("other-project", "other-session");
		const otherPhase = fixture.host.currentPhase("other-project", "other-session");
		assert.ok(otherPhase);
		assert.throws(
			() => fixture.queue.setPriority({ projectId: "other-project", sessionId: "other-session", expectedPhaseRevision: otherPhase.revision }, first.taskId, 10, 5),
			hasCode("CROSS_PROJECT"),
		);

		const admitted = enqueue(fixture, "priority-admitted", { priority: 0 }).task;
		const admittedClaim = fixture.queue.claim("project", admitted.taskId, "admitted-worker");
		assert.ok(admittedClaim);
		fixture.advance(1_001);
		assert.equal(fixture.queue.listClaimable().find((task) => task.taskId === admitted.taskId)?.status, "admitted");
		assert.equal(fixture.queue.setPriority(fixture.scope(), admitted.taskId, 0, 8).priority, 8);

		const claimed = enqueue(fixture, "priority-claimed", { priority: 4 }).task;
		const claim = fixture.queue.claim("project", claimed.taskId, "priority-worker");
		assert.ok(claim);
		assert.throws(
			() => fixture.queue.setPriority(fixture.scope(), claimed.taskId, 4, 5),
			hasCode("AGENT_PRIORITY_CONFLICT"),
		);
	} finally {
		fixture.close();
	}
});

test("one global SQLite lease rejects a stale worker and reaps expired launch work into reconciliation", () => {
	const directory = mkdtempSync(join(tmpdir(), "study-agent-queue-"));
	const path = join(directory, "queue.sqlite");
	const now = { value: Date.parse("2026-09-12T12:00:00.000Z") };
	const first = setup({ path, now });
	const second = setup({ path, now, initialize: false });
	try {
		const a = enqueue(first, "a").task;
		const b = enqueue(second, "b").task;
		const firstClaim = first.queue.claim("project", a.taskId, "worker-a");
		assert.ok(firstClaim);
		assert.equal(second.queue.claim("project", b.taskId, "worker-b"), null);
		first.queue.markLaunching(key(firstClaim));
		first.queue.markRunning(key(firstClaim));
		first.advance(1_001);
		const candidates = second.queue.listClaimable();
		assert.equal(candidates.find((task) => task.taskId === a.taskId)?.status, "reconciling");
		const recovered = second.queue.claim("project", a.taskId, "worker-recovery");
		assert.ok(recovered);
		assert.equal(second.queue.heartbeat(key(recovered)).task.status, "reconciling");
		second.queue.reconcile(key(recovered), { status: "needs-input", detail: "The Pi journal contains no durable report." });
		assert.equal(second.queue.list(second.scope()).find((task) => task.taskId === a.taskId)?.status, "needs-input");
	} finally {
		second.close();
		first.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("cancellation wins over a late report and phase switches do not revoke a frozen task", () => {
	const fixture = setup();
	try {
		const task = enqueue(fixture, "cancelled").task;
		const claim = fixture.queue.claim("project", task.taskId, "worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		fixture.host.setPhase(fixture.scope(), "research");
		fixture.queue.cancel(fixture.scope(), task.taskId);
		assert.throws(() => fixture.queue.complete({ ...key(claim), report: report(task) }), hasCode("AGENT_CANCELLED"));
		assert.equal(fixture.queue.acknowledgeCancellation(key(claim), "Pi turn stopped after cancellation.").status, "cancelled");
	} finally {
		fixture.close();
	}
});

test("completion atomically records every frozen read checkpoint and detects packet/report/source corruption", () => {
	const fixture = setup();
	try {
		const task = enqueue(fixture, "complete").task;
		const claim = fixture.queue.claim("project", task.taskId, "worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		assert.equal(fixture.queue.complete({ ...key(claim), report: report(task) }).status, "succeeded");
		assert.equal(fixture.host.listReadCheckpoints(fixture.scope(), fixture.source.sourceId).filter((item) => item.kind === "read").length, fixture.evidence.length);
		fixture.database.prepare("UPDATE pi_study_agent_queue SET report_json = ? WHERE task_id = ?").run("{}", task.taskId);
		assert.throws(() => fixture.queue.list(fixture.scope()), /report failed its integrity check/);
		const packet = enqueue(fixture, "packet").task;
		fixture.database.prepare("UPDATE pi_study_agent_queue SET packet_hash = ? WHERE task_id = ?").run(contentHash("forged-packet"), packet.taskId);
		assert.throws(() => fixture.queue.readByDispatch({ projectId: "project", sessionId: "parent", dispatchKey: "packet" }), /packet binding failed/);
	} finally {
		fixture.close();
	}
});

test("completion rolls back its report when a frozen source locator disappears", () => {
	const fixture = setup();
	try {
		const task = enqueue(fixture, "missing-source").task;
		const claim = fixture.queue.claim("project", task.taskId, "worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		fixture.database.prepare("DELETE FROM pi_study_research_chunk WHERE chunk_id = ?").run(fixture.evidence[0].id);
		assert.throws(() => fixture.queue.complete({ ...key(claim), report: report(task) }), hasCode("SOURCE_LOCATOR_NOT_FOUND"));
		const current = fixture.queue.list(fixture.scope()).find((item) => item.taskId === task.taskId);
		assert.equal(current?.status, "running");
		assert.equal(current?.report, null);
	} finally {
		fixture.close();
	}
});

test("a multi-source note records one automatic node and note per cited source", () => {
	const fixture = setup();
	try {
		const second = fixture.host.registerSources(
			fixture.scope(),
			[
				{
					sourceRoot: "D:/study",
					relativePath: "appendix.tex",
					kind: "tex",
					sourceRole: "primary",
					diagnostics: [],
					contentHash: contentHash("queue-source-appendix"),
					parser: "queue-test/1",
					chunks: [{ ordinal: 1, locator: JSON.stringify({ line: 1 }), text: "The appendix supplies the missing variance condition." }],
				},
			],
			fixture.host.projectRevision(fixture.scope()).revision,
		).sources[0];
		const secondEvidence = fixture.host.readChunks(fixture.scope(), second.sourceId, second.contentHash, 0, 1).chunks[0];
		const evidence = [
			fixture.evidence[0],
			{ id: secondEvidence.chunkId, sourceId: secondEvidence.sourceId, sourceHash: secondEvidence.sourceHash, locator: secondEvidence.locator },
		];
		const task = enqueue(fixture, "multi-source", { evidence }).task;
		const claim = fixture.queue.claim("project", task.taskId, "worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		fixture.queue.complete({
			...key(claim),
			report: report(task, {
				notes: [{ title: "Combined condition", body: "The appendix completes the source's condition.", evidenceIds: evidence.map((item) => item.id) }],
			}),
		});
		const knowledge = fixture.host.getKnowledge(fixture.scope());
		const automaticNodes = knowledge.nodes.filter((node) => node.scope === `reading report ${task.taskId}`);
		const automaticNotes = knowledge.notes.filter((note) => note.author === "agent");
		assert.equal(automaticNodes.length, 2);
		assert.equal(automaticNotes.length, 2);
		assert.equal(new Set(automaticNodes.map((node) => `${node.sourceId}:${node.sourceHash}`)).size, 2);
		assert.equal(knowledge.relations.filter((relation) => relation.author === "agent" && relation.kind === "refers-to").length, 1);
	} finally {
		fixture.close();
	}
});

test("accepted source updates reject old reports atomically before writing fresh artifacts", () => {
	const fixture = setup();
	try {
		const task = enqueue(fixture, "stale-source-report").task;
		const claim = fixture.queue.claim("project", task.taskId, "worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		const candidate = {
			sourceRoot: fixture.source.sourceRoot,
			relativePath: fixture.source.relativePath,
			kind: fixture.source.kind,
			sourceRole: fixture.source.sourceRole,
			diagnostics: fixture.source.diagnostics,
			contentHash: contentHash("queue-source-v2"),
			parser: "queue-test/2",
			chunks: [
				{ ordinal: 1, locator: JSON.stringify({ line: 1 }), text: "The source now has a revised first moment statement." },
				{ ordinal: 2, locator: JSON.stringify({ line: 2 }), text: "The revised source still states its variance assumptions." },
			],
		};
		const proposal = fixture.host.proposeSourceUpdate(
			fixture.scope(),
			{
				sourceId: fixture.source.sourceId,
				candidate,
				knowledge: { notes: [], nodes: [], relations: [] },
				changeSummary: "The source received a revised statement.",
				expectedProjectRevision: fixture.host.projectRevision(fixture.scope()).revision,
			},
		);
		fixture.host.acceptSourceUpdate(
			fixture.scope(),
			proposal.proposalId,
			fixture.host.projectRevision(fixture.scope()).revision,
		);
		assert.throws(
			() => fixture.queue.complete({ ...key(claim), report: report(task) }),
			hasCode("SOURCE_UPDATE_CONFLICT"),
		);
		const current = fixture.queue.list(fixture.scope()).find((item) => item.taskId === task.taskId);
		assert.equal(current?.status, "running");
		assert.equal(current?.report, null);
		assert.equal(
			fixture.host.listReadCheckpoints(fixture.scope(), fixture.source.sourceId).filter((item) => item.kind === "read").length,
			0,
		);
		assert.equal(fixture.host.getKnowledge(fixture.scope()).notes.filter((item) => item.author === "agent").length, 0);
	} finally {
		fixture.close();
	}
});

test("source updates stale automatic cross-source relations through their changed endpoint nodes", () => {
	const fixture = setup();
	try {
		const second = fixture.host.registerSources(
			fixture.scope(),
			[
				{
					sourceRoot: "D:/study",
					relativePath: "appendix.tex",
					kind: "tex",
					sourceRole: "primary",
					diagnostics: [],
					contentHash: contentHash("queue-source-appendix-graph"),
					parser: "queue-test/1",
					chunks: [{ ordinal: 1, locator: JSON.stringify({ line: 1 }), text: "The appendix supplies the graph edge." }],
				},
			],
			fixture.host.projectRevision(fixture.scope()).revision,
		).sources[0];
		const secondEvidence = fixture.host.readChunks(fixture.scope(), second.sourceId, second.contentHash, 0, 1).chunks[0];
		const evidence = [
			fixture.evidence[0],
			{ id: secondEvidence.chunkId, sourceId: secondEvidence.sourceId, sourceHash: secondEvidence.sourceHash, locator: secondEvidence.locator },
		];
		const task = enqueue(fixture, "cross-source-graph", { evidence }).task;
		const claim = fixture.queue.claim("project", task.taskId, "worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		fixture.queue.complete({
			...key(claim),
			report: report(task, {
				notes: [{ title: "Cross-source condition", body: "The appendix supplies the cross-source condition.", evidenceIds: evidence.map((item) => item.id) }],
			}),
		});
		const relation = fixture.host.getKnowledge(fixture.scope()).relations.find(
			(item) => item.author === "agent" && item.kind === "refers-to",
		);
		assert.ok(relation);
		assert.equal(relation.sourceId, null);
		assert.equal(relation.sourceHash, null);
		const candidate = {
			sourceRoot: fixture.source.sourceRoot,
			relativePath: fixture.source.relativePath,
			kind: fixture.source.kind,
			sourceRole: fixture.source.sourceRole,
			diagnostics: fixture.source.diagnostics,
			contentHash: contentHash("queue-source-graph-v2"),
			parser: "queue-test/2",
			chunks: fixture.evidence.map((item, index) => ({
				ordinal: index + 1,
				locator: item.locator,
				text: `Updated graph source chunk ${index + 1}`,
			})),
		};
		const proposal = fixture.host.proposeSourceUpdate(
			fixture.scope(),
			{
				sourceId: fixture.source.sourceId,
				candidate,
				knowledge: { notes: [], nodes: [], relations: [] },
				changeSummary: "The graph source changed.",
				expectedProjectRevision: fixture.host.projectRevision(fixture.scope()).revision,
			},
		);
		const details = fixture.host.getSourceUpdateDetails(fixture.scope(), proposal.proposalId);
		assert.equal(details.affected.relations.some((item) => item.relationId === relation.relationId), true);
		assert.equal(
			fixture.host.getKnowledge(fixture.scope()).relations.find((item) => item.relationId === relation.relationId)?.stale,
			true,
		);
	} finally {
		fixture.close();
	}
});

test("unknown post-launch provider state reaches needs-input in one leased transition", () => {
	const fixture = setup();
	try {
		const launching = enqueue(fixture, "unknown-launching").task;
		const launchingClaim = fixture.queue.claim("project", launching.taskId, "worker-launching");
		assert.ok(launchingClaim);
		const launchingKey = key(launchingClaim);
		fixture.queue.markLaunching(launchingKey);
		assert.equal(
			fixture.queue.markNeedsInput(launchingKey, "Provider state became unknown after launch").status,
			"needs-input",
		);
		assert.equal(fixture.queue.listClaimable().some((item) => item.taskId === launching.taskId), false);
		assert.deepEqual(
			fixture.host.listTaskEvents(fixture.scope(), launching.taskId).map((event) => event.status),
			["queued", "admitted", "launching", "reconciling", "needs-input"],
		);

		const running = enqueue(fixture, "unknown-running").task;
		const runningClaim = fixture.queue.claim("project", running.taskId, "worker-running");
		assert.ok(runningClaim);
		const runningKey = key(runningClaim);
		fixture.queue.markLaunching(runningKey);
		fixture.queue.markRunning(runningKey);
		assert.equal(fixture.queue.markNeedsInput(runningKey, "Provider state became unknown while running").status, "needs-input");
		assert.equal(fixture.queue.listClaimable().some((item) => item.taskId === running.taskId), false);
	} finally {
		fixture.close();
	}
});

test("a changed review target rejects the report and rolls back its durable write", () => {
	const fixture = setup();
	try {
		const creator = fixture.host.registerTrustedRunnerContext(fixture.scope(), "visualization-fixture");
		const draft = {
			creatorContextId: creator.contextId,
			purpose: "Show the source condition.",
			code: "plot([1, 2])",
			inputs: {},
			inputHashes: {},
			environmentHash: contentHash("visualization-env"),
		};
		const visualization = fixture.host.createVisualizationDraft(
			fixture.scope(),
			draft,
			fixture.host.projectRevision(fixture.scope()).revision,
		);
		const task = enqueue(fixture, "stale-target", {
			kind: "review",
			target: {
				targetKind: "visualization",
				targetId: visualization.visualizationId,
				targetRevision: visualization.revision,
				targetHash: visualization.contentHash,
			},
		}).task;
		const claim = fixture.queue.claim("project", task.taskId, "worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		fixture.host.reviseVisualizationDraft(fixture.scope(), {
			visualizationId: visualization.visualizationId,
			expectedVisualizationRevision: visualization.revision,
			expectedProjectRevision: fixture.host.projectRevision(fixture.scope()).revision,
			draft: { ...draft, code: "plot([2, 3])" },
		});
		assert.throws(
			() => fixture.queue.complete({ ...key(claim), report: report(task) }),
			hasCode("VERSION_MISMATCH"),
		);
		const current = fixture.queue.list(fixture.scope()).find((item) => item.taskId === task.taskId);
		assert.equal(current?.report, null);
		assert.equal(current?.status, "running");
	} finally {
		fixture.close();
	}
});

test("review completion rejects frozen evidence after its source version changes", () => {
	const fixture = setup();
	try {
		const target = reviewTarget(fixture);
		const task = enqueue(fixture, "stale-review-source", { kind: "review", target: target.target }).task;
		const claim = fixture.queue.claim("project", task.taskId, "stale-source-worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		const candidate = {
			sourceRoot: fixture.source.sourceRoot,
			relativePath: fixture.source.relativePath,
			kind: fixture.source.kind,
			sourceRole: fixture.source.sourceRole,
			diagnostics: fixture.source.diagnostics,
			contentHash: contentHash("queue-source-review-v2"),
			parser: "queue-test/2",
			chunks: [
				{ ordinal: 1, locator: JSON.stringify({ line: 1 }), text: "The review source now states a revised first moment." },
				{ ordinal: 2, locator: JSON.stringify({ line: 2 }), text: "The review source still states its variance assumptions." },
			],
		};
		const proposal = fixture.host.proposeSourceUpdate(fixture.scope(), {
			sourceId: fixture.source.sourceId,
			candidate,
			knowledge: { notes: [], nodes: [], relations: [] },
			changeSummary: "The review source changed.",
			expectedProjectRevision: fixture.host.projectRevision(fixture.scope()).revision,
		});
		fixture.host.acceptSourceUpdate(
			fixture.scope(),
			proposal.proposalId,
			fixture.host.projectRevision(fixture.scope()).revision,
		);
		assert.throws(
			() => fixture.queue.complete({ ...key(claim), report: report(task) }),
			hasCode("SOURCE_UPDATE_CONFLICT"),
		);
		const current = fixture.queue.list(fixture.scope()).find((item) => item.taskId === task.taskId);
		assert.equal(current?.status, "running");
		assert.equal(current?.report, null);
		assert.equal(fixture.host.listIndependentReviews(fixture.scope()).length, 0);
		assert.equal(fixture.queue.heartbeat(key(claim)).task.status, "running");
	} finally {
		fixture.close();
	}
});

test("review completion records one exact independent canonical review after the queue task succeeds", () => {
	const fixture = setup();
	try {
		const target = reviewTarget(fixture);
		const task = enqueue(fixture, "canonical-review", { kind: "review", target: target.target }).task;
		const claim = fixture.queue.claim("project", task.taskId, "review-worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		const completed = fixture.queue.complete({
			...key(claim),
			report: report(task, {
				outcome: "passed",
				findings: [{ severity: "minor", explanation: "The cited condition is stated clearly.", evidenceIds: [fixture.evidence[0].id] }],
				unresolved: [],
			}),
		});
		assert.equal(completed.status, "succeeded");
		const reviews = fixture.host.listIndependentReviews(fixture.scope());
		assert.equal(reviews.length, 1);
		const review = reviews[0];
		assert.equal(review.taskId, task.taskId);
		assert.equal(review.status, "passed");
		assert.deepEqual(
			{
				targetKind: review.targetKind,
				targetId: review.targetId,
				targetRevision: review.targetRevision,
				targetHash: review.targetHash,
			},
			target.target,
		);
		assert.equal(review.findings[0], "Summary: The selected fragments distinguish the first and second moments.");
		assert.equal(review.findings.some((finding) => finding.includes(fixture.evidence[0].id)), true);
		assert.notEqual(review.reviewerContextId, target.creator.contextId);
		assert.equal(review.reviewerContextId, fixture.host.readTaskForCoordinator(task.taskId).producerContextId);
		assert.throws(
			() => fixture.queue.complete({ ...key(claim), report: report(task, { outcome: "passed", unresolved: [] }) }),
			hasCode("AGENT_CLAIM_CONFLICT"),
		);
		assert.equal(fixture.host.listIndependentReviews(fixture.scope()).length, 1);
	} finally {
		fixture.close();
	}
});

test("canonical review status keeps moderate blockers failed and unresolved or uncertain findings inconclusive", () => {
	const fixture = setup();
	try {
		const target = reviewTarget(fixture);
		const moderateTask = enqueue(fixture, "canonical-moderate", { kind: "review", target: target.target }).task;
		const moderateClaim = fixture.queue.claim("project", moderateTask.taskId, "moderate-worker");
		assert.ok(moderateClaim);
		fixture.queue.markLaunching(key(moderateClaim));
		fixture.queue.markRunning(key(moderateClaim));
		fixture.queue.complete({
			...key(moderateClaim),
			report: report(moderateTask, {
				outcome: "passed",
				findings: [{ severity: "moderate", explanation: "A material assumption is not supported.", evidenceIds: [fixture.evidence[0].id] }],
				unresolved: [],
			}),
		});

		const unresolvedTask = enqueue(fixture, "canonical-unresolved", { kind: "review", target: target.target }).task;
		const unresolvedClaim = fixture.queue.claim("project", unresolvedTask.taskId, "unresolved-worker");
		assert.ok(unresolvedClaim);
		fixture.queue.markLaunching(key(unresolvedClaim));
		fixture.queue.markRunning(key(unresolvedClaim));
		fixture.queue.complete({
			...key(unresolvedClaim),
			report: report(unresolvedTask, { outcome: "passed", findings: [], unresolved: ["The later theorem remains unverified."] }),
		});

		const uncertainTask = enqueue(fixture, "canonical-uncertain", { kind: "review", target: target.target }).task;
		const uncertainClaim = fixture.queue.claim("project", uncertainTask.taskId, "uncertain-worker");
		assert.ok(uncertainClaim);
		fixture.queue.markLaunching(key(uncertainClaim));
		fixture.queue.markRunning(key(uncertainClaim));
		fixture.queue.complete({
			...key(uncertainClaim),
			report: report(uncertainTask, {
				outcome: "passed",
				findings: [{ severity: "uncertain", explanation: "The citation does not resolve the interpretation.", evidenceIds: [fixture.evidence[1].id] }],
				unresolved: [],
			}),
		});

		const reviews = fixture.host.listIndependentReviews(fixture.scope());
		const byTaskId = new Map(reviews.map((review) => [review.taskId, review]));
		assert.equal(reviews.length, 3);
		assert.equal(byTaskId.get(moderateTask.taskId)?.status, "failed");
		assert.equal(byTaskId.get(unresolvedTask.taskId)?.status, "inconclusive");
		assert.equal(byTaskId.get(uncertainTask.taskId)?.status, "inconclusive");
		assert.equal(byTaskId.get(moderateTask.taskId)?.findings.some((finding) => finding.includes(fixture.evidence[0].id)), true);
		assert.equal(byTaskId.get(unresolvedTask.taskId)?.findings.some((finding) => finding.includes("The later theorem remains unverified.")), true);
		assert.equal(byTaskId.get(uncertainTask.taskId)?.findings.some((finding) => finding.includes(fixture.evidence[1].id)), true);
	} finally {
		fixture.close();
	}
});

test("canonical review sink failure rolls back report, notes, Host status, canonical review, and lease", () => {
	const fixture = setup();
	try {
		const target = reviewTarget(fixture);
		const task = enqueue(fixture, "canonical-rollback", { kind: "review", target: target.target }).task;
		const claim = fixture.queue.claim("project", task.taskId, "rollback-worker");
		assert.ok(claim);
		fixture.queue.markLaunching(key(claim));
		fixture.queue.markRunning(key(claim));
		const original = fixture.host.recordIndependentReviewFromFrozenTask;
		fixture.host.recordIndependentReviewFromFrozenTask = () => {
			throw new Error("canonical review sink unavailable");
		};
		try {
			assert.throws(
				() => fixture.queue.complete({
					...key(claim),
					report: report(task, {
						outcome: "passed",
						findings: [],
						unresolved: [],
						notes: [{ title: "Review note", body: "The cited condition is recorded.", evidenceIds: [fixture.evidence[0].id] }],
					}),
				}),
				/canonical review sink unavailable/,
			);
		} finally {
			fixture.host.recordIndependentReviewFromFrozenTask = original;
		}
		const current = fixture.queue.list(fixture.scope()).find((item) => item.taskId === task.taskId);
		assert.equal(current?.status, "running");
		assert.equal(current?.report, null);
		assert.equal(fixture.host.getKnowledge(fixture.scope()).notes.filter((note) => note.author === "agent").length, 0);
		assert.equal(fixture.host.listIndependentReviews(fixture.scope()).length, 0);
		assert.deepEqual(
			fixture.host.listTaskEvents(fixture.scope(), task.taskId).map((event) => event.status),
			["queued", "admitted", "launching", "running"],
		);
		assert.equal(fixture.queue.heartbeat(key(claim)).task.status, "running");
	} finally {
		fixture.close();
	}
});
