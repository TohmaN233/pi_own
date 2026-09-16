import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { scientificResultHash, StudyResearchHost } from "../packages/study-research-host/src/index.ts";
import { contentHash, stableStringify } from "../packages/harness-core/src/index.ts";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("source acceptance rejects newly appended old-version knowledge and rolls back", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash), 1);
		const candidate = source("pending-v2");
		const proposal = f.host.proposeSourceUpdate(f.scopeA(), { sourceId: stored.sourceId, candidate,
			knowledge: automaticKnowledge(stored.sourceId, candidate.contentHash), changeSummary: "Replace source", expectedProjectRevision: 2 });
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash, "Concurrent old claim"), 3);
		const before = f.host.getKnowledge(f.scopeA());
		assert.throws(() => f.host.acceptSourceUpdate(f.scopeA(), proposal.proposalId, 4), /source-bound knowledge changed/);
		assert.deepEqual(f.host.getKnowledge(f.scopeA()), before);
		assert.equal(f.host.getSourceUpdate(f.scopeA(), proposal.proposalId).status, "pending");
		assert.equal(f.host.listSources(f.scopeA()).find((item) => item.current).contentHash, stored.contentHash);
	} finally { f.database.close(); }
});

test("candidate cycle baseline retires automatic edges even with unmatched endpoints", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		const nodes = ["a", "b", "c"].map((key) => ({ ...automaticKnowledge(stored.sourceId, stored.contentHash).nodes[0], localKey: key, title: key }));
		f.host.commitKnowledgeChange(f.scopeA(), { nodes, notes: [], relations: [{ fromNodeLocalKey: "a", toNodeLocalKey: "b", kind: "prerequisite" }] }, 1);
		const saved = f.host.getKnowledge(f.scopeA()).nodes;
		const id = (key) => saved.find((node) => node.title === key).nodeId;
		f.host.addKnowledgeRelation(f.scopeA(), { fromNodeId: id("b"), toNodeId: id("c"), kind: "prerequisite", expectedProjectRevision: 2 });
		const candidate = source("candidate-noncycle-v2");
		const proposal = f.host.proposeSourceUpdate(f.scopeA(), { sourceId: stored.sourceId, candidate, expectedProjectRevision: 3, changeSummary: "Retire A-B and add C-A",
			knowledge: { nodes: nodes.filter((node) => node.localKey !== "b").map((node) => ({ ...node, replaceNodeId: id(node.localKey), sourceHash: candidate.contentHash })), notes: [], relations: [{ fromNodeLocalKey: "c", toNodeLocalKey: "a", kind: "prerequisite" }] } });
		f.host.acceptSourceUpdate(f.scopeA(), proposal.proposalId, 4);
		const edges = f.host.getKnowledge(f.scopeA()).relations;
		assert.equal(edges.find((edge) => edge.fromNodeId === id("a")).stale, true);
		assert.equal(edges.filter((edge) => !edge.stale).length, 2);
	} finally { f.database.close(); }
});

test("node provenance is strictly boolean and unknown legacy nodes cannot be replaced", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		for (const manuallyEdited of [undefined, null, 0, "false"]) {
			const draft = automaticKnowledge(stored.sourceId, stored.contentHash); draft.nodes[0].manuallyEdited = manuallyEdited;
			assert.throws(() => f.host.commitKnowledgeChange(f.scopeA(), draft, 1), /must be boolean/);
		}
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash), 1);
		const node = f.host.getKnowledge(f.scopeA()).nodes[0];
		const { manuallyEdited: _manual, contentHash: _identity, ...legacyBody } = node;
		const legacy = { ...legacyBody, contentHash: contentHash(legacyBody) };
		f.database.prepare("UPDATE pi_study_research_node SET payload = ?, payload_hash = ? WHERE node_id = ?").run(stableStringify(legacy), contentHash(legacy), node.nodeId);
		const candidate = source("legacy-protection-v2"), draft = automaticKnowledge(stored.sourceId, candidate.contentHash);
		draft.nodes[0].replaceNodeId = node.nodeId;
		assert.throws(() => f.host.proposeSourceUpdate(f.scopeA(), { sourceId: stored.sourceId, candidate, knowledge: draft, changeSummary: "Unknown provenance stays protected", expectedProjectRevision: 2 }), /automatic backed-up node/);
		assert.equal(f.host.getKnowledge(f.scopeA()).nodes[0].statement, node.statement);
	} finally { f.database.close(); }
});

test("replacement IDs reject missing, other-source, manual and duplicate mappings before mutation", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash), 1);
		const automatic = f.host.getKnowledge(f.scopeA()).nodes[0];
		f.host.commitKnowledgeChange(f.scopeA(), knowledge(stored.sourceId, stored.contentHash, "Manual"), 2);
		const manual = f.host.getKnowledge(f.scopeA()).nodes.find((node) => node.manuallyEdited);
		const otherSource = { ...source("second-paper"), relativePath: "other.tex" };
		const other = f.host.registerSource(f.scopeA(), otherSource, 3);
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(other.sourceId, other.contentHash, "Other source"), 4);
		const otherNode = f.host.getKnowledge(f.scopeA()).nodes.find((node) => node.sourceId === other.sourceId);
		const candidate = source("replacement-v2"), before = f.host.getKnowledge(f.scopeA());
		for (const replacement of ["missing", manual.nodeId, otherNode.nodeId]) {
			const draft = automaticKnowledge(stored.sourceId, candidate.contentHash); draft.nodes[0].replaceNodeId = replacement;
			assert.throws(() => f.host.proposeSourceUpdate(f.scopeA(), { sourceId: stored.sourceId, candidate, knowledge: draft, changeSummary: "Invalid mapping", expectedProjectRevision: 5 }), /automatic backed-up node/);
		}
		const duplicate = automaticKnowledge(stored.sourceId, candidate.contentHash); duplicate.nodes[0].replaceNodeId = automatic.nodeId;
		duplicate.nodes.push({ ...duplicate.nodes[0], localKey: "duplicate" });
		assert.throws(() => f.host.proposeSourceUpdate(f.scopeA(), { sourceId: stored.sourceId, candidate, knowledge: duplicate, changeSummary: "Duplicate mapping", expectedProjectRevision: 5 }), /replacement ids must be unique/);
		assert.deepEqual(f.host.getKnowledge(f.scopeA()), before); assert.equal(f.host.projectRevision(f.scopeA()).revision, 5);
	} finally { f.database.close(); }
});

test("constructor migrates actual old relation schema to unknown protected provenance", () => {
	const f = setup();
	try {
		const stored = addSource(f), original = automaticKnowledge(stored.sourceId, stored.contentHash);
		original.nodes.push({ ...original.nodes[0], localKey: "b", title: "B" });
		f.host.commitKnowledgeChange(f.scopeA(), original, 1);
		const nodes = f.host.getKnowledge(f.scopeA()).nodes;
		f.database.exec("DROP TABLE pi_study_research_relation; CREATE TABLE pi_study_research_relation(relation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)");
		f.database.prepare("INSERT INTO pi_study_research_relation VALUES (?, ?, ?, ?, ?, ?)").run("legacy-real", "project-a", nodes[0].nodeId, nodes[1].nodeId, "supports", "2026-09-11T12:00:00.000Z");
		const reopened = new StudyResearchHost(f.database);
		const relation = reopened.getKnowledge(f.scopeA()).relations[0];
		assert.equal(relation.author, "unknown"); assert.equal(relation.requiresReview, true);
		const candidate = source("migrated-source-v2");
		const proposal = reopened.proposeSourceUpdate(f.scopeA(), { sourceId: stored.sourceId, candidate, knowledge: { nodes: [], notes: [], relations: [] }, changeSummary: "Preserve migrated edge", expectedProjectRevision: 2 });
		reopened.acceptSourceUpdate(f.scopeA(), proposal.proposalId, 3);
		assert.equal(reopened.getKnowledge(f.scopeA()).relations[0].relationId, "legacy-real");
		assert.equal(reopened.getKnowledge(f.scopeA()).relations[0].requiresReview, true);
	} finally { f.database.close(); }
});

function source(version = "source v1") {
	return {
		sourceRoot: "C:/fixtures/research-source",
		relativePath: "main.tex",
		kind: "tex",
		sourceRole: "primary",
		diagnostics: [
			{
				severity: "warning",
				code: "OMML_UNCHECKED",
				message: "Formula requires visual confirmation.",
				path: "main.tex",
				locator: JSON.stringify({ section: "2" }),
				requiresPdfInspection: true,
			},
		],
		contentHash: hash(version),
		parser: "tex-reader/1.0.0",
		chunks: [{ ordinal: 1, locator: JSON.stringify({ lines: [1, 2] }), text: `${version}\nDefinition` }],
	};
}

function knowledge(sourceId, sourceHash, title = "Current claim") {
	return {
		nodes: [
			{
				localKey: "claim",
				kind: "claim",
				title,
				statement: "A version-bound claim.",
				scope: "paper/section-2",
				sourceId,
				sourceHash,
				manuallyEdited: true,
			},
		],
		notes: [
			{
				author: "user",
				body: "Keep this note synchronized with the source.",
				sourceId,
				sourceHash,
				nodeLocalKeys: ["claim"],
			},
		],
		relations: [],
	};
}

function automaticKnowledge(sourceId, sourceHash, title = "Current claim") {
	const change = knowledge(sourceId, sourceHash, title);
	change.nodes[0].manuallyEdited = false;
	change.notes[0].author = "agent";
	change.notes[0].body = "Generated source-bound note.";
	return change;
}

function sourceWithChunks(version, count) {
	const document = source(version);
	document.chunks = Array.from({ length: count }, (_, index) => ({
		ordinal: index + 1,
		locator: JSON.stringify({ line: index + 1 }),
		text: `${version} chunk ${index + 1}`,
	}));
	document.contentHash = hash(`${version}:${count}`);
	return document;
}

function formalPlan(sourceHash) {
	return {
		kind: "formal",
		detail: {
			question: "Does the selected method improve the stated metric?",
			hypotheses: ["The method improves the primary metric."],
			datasetVersion: "dataset-v1",
			splitProtocol: "fixed held-out split",
			primaryMetrics: ["error"],
			method: "locked-method-v1",
			stoppingConditions: ["Stop after the approved wall time."],
		},
		sourceVersionHashes: [sourceHash],
	};
}

function setup(path = ":memory:") {
	const database = new DatabaseSync(path);
	database.exec(`
		CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
	`);
	for (const [projectId, sessionId] of [
		["project-a", "session-a"],
		["project-b", "session-b"],
	]) {
		database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run(projectId, JSON.stringify({ id: projectId }));
		database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run(sessionId, projectId);
	}
	let now = Date.parse("2026-09-11T12:00:00.000Z");
	const host = new StudyResearchHost(database, { clock: () => new Date(now) });
	host.bindSession("project-a", "session-a");
	host.bindSession("project-b", "session-b");
	const defaultResearchExecutor = host.registerTrustedRunnerContext(
		{ projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: 1 },
		"fixture-research-executor",
	);
	return {
		database,
		host,
		defaultResearchExecutor,
		scopeA: () => ({ projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: host.currentPhase("project-a", "session-a").revision }),
		scopeB: () => ({ projectId: "project-b", sessionId: "session-b", expectedPhaseRevision: host.currentPhase("project-b", "session-b").revision }),
		advance: (milliseconds) => {
			now += milliseconds;
		},
	};
}

function addSource(fixture) {
	const created = fixture.host.registerSource(fixture.scopeA(), source(), 0);
	return created;
}

function enterResearch(fixture) {
	return fixture.host.setPhase(fixture.scopeA(), "research");
}

function reserveResearchTask(fixture, plan, grant, dispatchKey, kind = "execution", options = {}) {
	const defaultProducer = kind === "execution"
		? { producerContextId: fixture.defaultResearchExecutor.contextId }
		: {};
	return fixture.host.reserveTask(fixture.scopeA(), {
		planId: plan.planId,
		grantId: grant.grantId,
		expectedPlanRevision: plan.revision,
		dispatchKey,
		kind,
		manifest: {
			codeHash: hash(`${dispatchKey}:code`),
			parameterHash: hash(`${dispatchKey}:parameters`),
			inputHashes: { "input.csv": hash(`${dispatchKey}:input`) },
			environmentHash: hash("python-3.12-lock"),
		},
		...defaultProducer,
		...options,
	});
}

function succeedTask(host, task) {
	let current = task;
	for (const status of ["admitted", "launching", "running", "succeeded"]) {
		current = host.transitionTaskFromFrozenAuthorization({
			taskId: current.taskId,
			expectedTaskRevision: current.revision,
			nextStatus: status,
			detail: status,
		});
	}
	return current;
}

test("cross-project source access is rejected and phase CAS is explicit", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		assert.throws(() => f.host.listChunks(f.scopeB(), stored.sourceId, stored.contentHash), /source version does not belong/);
		const stale = f.scopeA();
		const research = f.host.setPhase(stale, "research");
		assert.equal(research.revision, 2);
		assert.throws(() => f.host.setPhase(stale, "study"), /phase changed/);
	} finally {
		f.database.close();
	}
});

test("source roots, diagnostics, and bounded persisted chunks survive a fresh connection", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-study-research-"));
	const databasePath = join(directory, "harness.sqlite");
	let f = setup(databasePath);
	try {
		const stored = addSource(f);
		const read = f.host.readChunks(f.scopeA(), stored.sourceId, stored.contentHash, 0, 1);
		assert.equal(read.chunks[0].text, "source v1\nDefinition");
		assert.equal(read.chunks[0].textHash, hash("source v1\nDefinition"));
		assert.equal(f.host.listSources(f.scopeA())[0].sourceRoot, "C:/fixtures/research-source");
		assert.equal(f.host.listSources(f.scopeA())[0].diagnostics[0].requiresPdfInspection, true);
		f.database.close();
		f = null;
		const database = new DatabaseSync(databasePath);
		const restored = new StudyResearchHost(database);
		const scope = { projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: 1 };
		assert.equal(restored.currentPhase("project-a", "session-a").phase, "study");
		assert.equal(restored.readChunks(scope, stored.sourceId, stored.contentHash, 0, 10).chunks.length, 1);
		database.close();
	} finally {
		f?.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Study admission freezes independently of Research grants and phase changes", () => {
	const f = setup();
	try {
		const producer = f.host.registerTrustedRunnerContext(f.scopeA(), "study-computation-runner");
		const study = f.host.reserveStudyTask(f.scopeA(), {
			dispatchKey: "study-computation",
			kind: "execution",
			manifest: {
				codeHash: hash("study code"),
				parameterHash: hash("study parameters"),
				inputHashes: {},
				environmentHash: hash("study environment"),
			},
			admission: { purpose: "Check a displayed derivation.", language: "python", maxWallSeconds: 30, maxMemoryMiB: 256 },
			producerContextId: producer.contextId,
		});
		assert.equal(study.task.authorization.phase, "study");
		enterResearch(f);
		const done = succeedTask(f.host, study.task);
		assert.equal(done.status, "succeeded");
		assert.throws(() => f.host.recordResultFromFrozenTask({ taskId: done.taskId, expectedTaskRevision: done.revision, classification: "positive", summary: "Not a research result", limitations: [] }), /Study executions/);
	} finally {
		f.database.close();
	}
});

test("visualization drafts retain code and bounded inputs for version-bound validation", () => {
	const f = setup();
	try {
		const creator = f.host.registerTrustedRunnerContext(f.scopeA(), "study-visualization-creator");
		const visualization = f.host.createVisualizationDraft(
			f.scopeA(),
			{
				creatorContextId: creator.contextId,
				purpose: "Show a curve band boundary.",
				code: "return { type: 'svg', children: [] };",
				inputs: { bandWidth: 0.25, sampleCount: 12 },
				inputHashes: { "curve.json": hash("curve-v1") },
				environmentHash: hash("visual-renderer-v1"),
			},
			0,
		);
		assert.equal(visualization.owner, "study");
		assert.equal(visualization.creatorContextId, creator.contextId);
		assert.equal(visualization.creatorIdentity, "study-visualization-creator");
		assert.deepEqual(visualization.inputs, { bandWidth: 0.25, sampleCount: 12 });
		const validator = f.host.registerTrustedRunnerContext(f.scopeA(), "study-validator");
		const validationTask = succeedTask(
			f.host,
			f.host.reserveStudyTask(f.scopeA(), {
				dispatchKey: "visual-validation",
				kind: "validation",
				manifest: {
					codeHash: hash("oracle"),
					parameterHash: hash("visual parameters"),
					inputHashes: {},
					environmentHash: hash("visual environment"),
				},
				admission: { purpose: "Check the rendered boundary.", language: "none", maxWallSeconds: 30, maxMemoryMiB: 64 },
				producerContextId: validator.contextId,
				target: {
					targetKind: "visualization",
					targetId: visualization.visualizationId,
					targetRevision: visualization.revision,
					targetHash: visualization.contentHash,
				},
			}).task,
		);
		const check = f.host.recordValidationFromFrozenTask({
			taskId: validationTask.taskId,
			expectedTaskRevision: validationTask.revision,
			targetKind: "visualization",
			targetId: visualization.visualizationId,
			targetRevision: visualization.revision,
			targetHash: visualization.contentHash,
			status: "inconclusive",
			findings: ["This host records the check; the renderer supplies browser evidence."],
		});
		assert.equal(check.targetKind, "visualization");
	} finally {
		f.database.close();
	}
});

test("scope semantic digest excludes notes but formal scientific changes invalidate a grant", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		enterResearch(f);
		const plan = f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(
			f.scopeA(),
			plan.planId,
			plan.revision,
			"trusted-ui-event-1",
			"2026-09-11T13:00:00.000Z",
		);
		f.host.commitKnowledgeChange(f.scopeA(), knowledge(stored.sourceId, stored.contentHash), 2);
		const reserved = reserveResearchTask(f, plan, grant, "semantic-separation");
		assert.equal(reserved.task.manifest.codeHash, hash("semantic-separation:code"));
		const revised = f.host.reviseResearchPlan(f.scopeA(), {
			planId: plan.planId,
			expectedPlanRevision: 1,
			expectedProjectRevision: 3,
			plan: {
				...formalPlan(stored.contentHash),
				detail: { ...formalPlan(stored.contentHash).detail, primaryMetrics: ["different-primary-metric"] },
			},
		});
		assert.equal(revised.revision, 2);
		assert.throws(() => reserveResearchTask(f, revised, grant, "stale-scope"), /scope grant no longer matches/);
	} finally {
		f.database.close();
	}
});

test("theory, smoke, formal, and exploration plans persist their distinct required fields", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		enterResearch(f);
		const theory = f.host.createResearchPlan(f.scopeA(), {
			expectedProjectRevision: 1,
			plan: {
				kind: "theory",
				detail: {
					question: "Can the stated proposition be proved?",
					assumptions: ["Continuity"],
					propositions: ["A bounded result"],
					proofSteps: ["Reduce to the lemma"],
					counterexamples: ["Try a discontinuous boundary case"],
					openGaps: ["Lemma remains unproved"],
				},
				sourceVersionHashes: [stored.contentHash],
			},
		});
		const smoke = f.host.createResearchPlan(f.scopeA(), {
			expectedProjectRevision: 2,
			plan: {
				kind: "smoke",
				detail: {
					question: "Does the small example run?",
					method: "A deterministic local sample.",
					evaluation: "Compare to the known value.",
					allowedChanges: ["Fix implementation bugs"],
				},
				sourceVersionHashes: [stored.contentHash],
			},
		});
		const formal = f.host.createResearchPlan(f.scopeA(), { expectedProjectRevision: 3, plan: formalPlan(stored.contentHash) });
		const exploration = f.host.createResearchPlan(f.scopeA(), {
			expectedProjectRevision: 4,
			plan: {
				kind: "exploration",
				detail: {
					question: "Which bounded variation is promising?",
					direction: "Vary only the approved initialization.",
					allowedChanges: ["Initialization", "Learning rate"],
					stoppingConditions: ["Stop at the resource limit"],
				},
				sourceVersionHashes: [stored.contentHash],
			},
		});
		assert.deepEqual([theory.kind, smoke.kind, formal.kind, exploration.kind], ["theory", "smoke", "formal", "exploration"]);
	} finally {
		f.database.close();
	}
});

test("dispatch idempotency reserves one durable task and rejects a changed manifest", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		enterResearch(f);
		const plan = f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scopeA(), plan.planId, 1, "trusted-ui-event-2", "2026-09-11T13:00:00.000Z");
		const first = reserveResearchTask(f, plan, grant, "same-dispatch");
		const replay = reserveResearchTask(f, plan, grant, "same-dispatch");
		assert.equal(replay.replay, true);
		assert.equal(replay.task.taskId, first.task.taskId);
		assert.throws(
			() =>
				f.host.reserveTask(f.scopeA(), {
					planId: plan.planId,
					grantId: grant.grantId,
					expectedPlanRevision: 1,
					dispatchKey: "same-dispatch",
					kind: "execution",
					manifest: { ...first.task.manifest, codeHash: hash("different code") },
					producerContextId: f.defaultResearchExecutor.contextId,
				}),
			/dispatch key was reused/,
		);
		assert.equal(f.host.listTasks(f.scopeA()).length, 1);
	} finally {
		f.database.close();
	}
});

test("knowledge changes append atomically and explicit user edits preserve stable IDs", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		const first = knowledge(stored.sourceId, stored.contentHash);
		f.database.exec("CREATE TRIGGER fail_knowledge BEFORE INSERT ON pi_study_research_node BEGIN SELECT RAISE(ABORT, 'injected node failure'); END;");
		assert.throws(() => f.host.commitKnowledgeChange(f.scopeA(), first, 1), /injected node failure/);
		assert.deepEqual(f.host.getKnowledge(f.scopeA()), { notes: [], nodes: [], relations: [] });
		f.database.exec("DROP TRIGGER fail_knowledge");
		f.host.commitKnowledgeChange(f.scopeA(), first, 1);
		const original = f.host.getKnowledge(f.scopeA());
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash, "Second claim"), 2);
		const afterSecondSave = f.host.getKnowledge(f.scopeA());
		assert.equal(afterSecondSave.notes.length, 2);
		assert.equal(afterSecondSave.nodes.length, 2);
		assert.ok(afterSecondSave.notes.some((note) => note.noteId === original.notes[0].noteId));
		const edited = f.host.editKnowledgeNote(f.scopeA(), {
			noteId: original.notes[0].noteId,
			expectedNoteRevision: original.notes[0].revision,
			expectedProjectRevision: 3,
			body: "User correction that a source update may not overwrite.",
			sourceId: stored.sourceId,
			sourceHash: stored.contentHash,
			nodeIds: original.notes[0].nodeIds,
		});
		assert.equal(edited.noteId, original.notes[0].noteId);
		assert.equal(edited.revision, original.notes[0].revision + 1);
	} finally {
		f.database.close();
	}
});

test("source updates touch only automatic source-bound entities and clean temporary backups", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		f.host.commitKnowledgeChange(f.scopeA(), knowledge(stored.sourceId, stored.contentHash), 1);
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash), 2);
		const before = f.host.getKnowledge(f.scopeA());
		const userNote = before.notes.find((note) => note.author === "user");
		const automaticNode = before.nodes.find((node) => !node.manuallyEdited);
		const automaticNote = before.notes.find((note) => note.author === "agent");
		const v2 = source("source v2");
		const candidateKnowledge = automaticKnowledge(stored.sourceId, v2.contentHash, "Updated automatic claim");
		candidateKnowledge.nodes[0].replaceNodeId = automaticNode.nodeId;
		candidateKnowledge.notes[0].replaceNoteId = automaticNote.noteId;
		const proposal = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate: v2,
			knowledge: candidateKnowledge,
			changeSummary: "The main TeX source changed.",
			expectedProjectRevision: 3,
		});
		assert.equal(f.host.getSourceUpdateDetails(f.scopeA(), proposal.proposalId).affected.nodes.length, 2);
		const rejected = f.host.rejectSourceUpdate(f.scopeA(), proposal.proposalId, 4);
		assert.equal(rejected.status, "rejected");
		const afterReject = f.host.getKnowledge(f.scopeA());
		assert.equal(afterReject.notes.find((note) => note.noteId === userNote.noteId).body, userNote.body);
		assert.equal(afterReject.nodes.find((node) => node.nodeId === automaticNode.nodeId).nodeId, automaticNode.nodeId);
		assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_research_source_backup").get().count, 0);
		const next = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate: v2,
			knowledge: candidateKnowledge,
			changeSummary: "Retry the rejected candidate.",
			expectedProjectRevision: 5,
		});
		const accepted = f.host.acceptSourceUpdate(f.scopeA(), next.proposalId, 6);
		assert.equal(accepted.status, "accepted");
		assert.equal(f.host.listSources(f.scopeA()).filter((item) => item.current)[0].contentHash, v2.contentHash);
		assert.equal(f.host.getKnowledge(f.scopeA()).nodes.find((node) => node.nodeId === automaticNode.nodeId).title, "Updated automatic claim");
		assert.equal(f.host.getKnowledge(f.scopeA()).notes.find((note) => note.noteId === userNote.noteId).body, userNote.body);
		assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_research_source_backup").get().count, 0);
	} finally {
		f.database.close();
	}
});

test("a failed independent review of the exact result version blocks publication", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		enterResearch(f);
		const plan = f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scopeA(), plan.planId, 1, "trusted-ui-event-3", "2026-09-11T13:00:00.000Z");
		const executor = f.host.registerTrustedRunnerContext(f.scopeA(), "execution-worker-1");
		const validator = f.host.registerTrustedRunnerContext(f.scopeA(), "validation-worker-1");
		const reviewer = f.host.registerTrustedRunnerContext(f.scopeA(), "review-worker-1");
		const execution = succeedTask(f.host, reserveResearchTask(f, plan, grant, "result-run", "execution", { producerContextId: executor.contextId }).task);
		const result = f.host.recordResultFromFrozenTask({
			taskId: execution.taskId,
			expectedTaskRevision: execution.revision,
			classification: "negative",
			summary: "The method did not improve the held-out metric.",
			limitations: ["Small fixture only."],
		});
		const target = { targetKind: "result", targetId: result.resultId, targetRevision: result.revision, targetHash: result.contentHash };
		const validation = succeedTask(f.host, reserveResearchTask(f, plan, grant, "validation-run", "validation", { producerContextId: validator.contextId, target }).task);
		f.host.recordValidationFromFrozenTask({
			taskId: validation.taskId,
			expectedTaskRevision: validation.revision,
			targetKind: "result",
			targetId: result.resultId,
			targetRevision: result.revision,
			targetHash: result.contentHash,
			status: "passed",
			findings: ["Independent numerical check passed."],
		});
		const review = succeedTask(f.host, reserveResearchTask(f, plan, grant, "review-run", "review", { producerContextId: reviewer.contextId, target }).task);
		f.host.recordIndependentReviewFromFrozenTask({
			taskId: review.taskId,
			expectedTaskRevision: review.revision,
			targetKind: "result",
			targetId: result.resultId,
			targetRevision: result.revision,
			targetHash: result.contentHash,
			status: "failed",
			findings: ["The conclusion exceeds the measured evidence."],
		});
		assert.throws(
			() => f.host.confirmResultFromTrustedUserEvent(f.scopeA(), result.resultId, result.revision, "trusted-ui-event-4"),
			/exact-version independent review/,
		);
	} finally {
		f.database.close();
	}
});

test("batch source import is atomic, idempotent, and uses SQL pagination with chunk integrity", () => {
	const f = setup();
	try {
		const first = sourceWithChunks("first", 4);
		const invalid = source("invalid");
		invalid.relativePath = "appendix.tex";
		invalid.parser = "";
		assert.throws(() => f.host.registerSources(f.scopeA(), [first, invalid], 0), /parser/);
		assert.equal(f.host.listSources(f.scopeA()).length, 0);
		const second = source("second");
		second.relativePath = "appendix.tex";
		const imported = f.host.registerSources(f.scopeA(), [first, second], 0);
		assert.equal(imported.created.length, 2);
		assert.equal(f.host.projectRevision(f.scopeA()).revision, 1);
		const replay = f.host.registerSources(f.scopeA(), [first, second], 1);
		assert.equal(replay.created.length, 0);
		assert.equal(replay.idempotent.length, 2);
		assert.equal(f.host.projectRevision(f.scopeA()).revision, 1);
		const page = f.host.readChunks(f.scopeA(), imported.sources[0].sourceId, first.contentHash, 1, 2);
		assert.deepEqual(page.chunks.map((chunk) => chunk.ordinal), [2, 3]);
		assert.equal(page.nextOffset, 3);
		f.database.prepare("UPDATE pi_study_research_chunk SET text = ? WHERE chunk_id = ?").run("corrupt", page.chunks[0].chunkId);
		assert.throws(() => f.host.readChunks(f.scopeA(), imported.sources[0].sourceId, first.contentHash, 1, 1), /text hash/);
	} finally {
		f.database.close();
	}
});

test("grants ignore unrelated knowledge, plans, and sources but reject a referenced source change", () => {
	const f = setup();
	try {
		const one = source("one");
		const two = source("two");
		two.relativePath = "appendix.tex";
		const [primary, unrelated] = f.host.registerSources(f.scopeA(), [one, two], 0).sources;
		enterResearch(f);
		const plan = f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(primary.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scopeA(), plan.planId, plan.revision, "trusted-grant", "2026-09-11T13:00:00.000Z");
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(primary.sourceId, primary.contentHash), 2);
		f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(unrelated.contentHash), expectedProjectRevision: 3 });
		const unrelatedV2 = source("two-v2");
		unrelatedV2.relativePath = "appendix.tex";
		const unrelatedProposal = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: unrelated.sourceId,
			candidate: unrelatedV2,
			knowledge: automaticKnowledge(unrelated.sourceId, unrelatedV2.contentHash),
			changeSummary: "Unrelated appendix changed.",
			expectedProjectRevision: 4,
		});
		f.host.acceptSourceUpdate(f.scopeA(), unrelatedProposal.proposalId, 5);
		assert.equal(reserveResearchTask(f, plan, grant, "unrelated-does-not-stale").task.authorization.phase, "research");
		const primaryV2 = source("one-v2");
		const primaryProposal = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: primary.sourceId,
			candidate: primaryV2,
			knowledge: automaticKnowledge(primary.sourceId, primaryV2.contentHash),
			changeSummary: "Primary paper changed.",
			expectedProjectRevision: 6,
		});
		f.host.acceptSourceUpdate(f.scopeA(), primaryProposal.proposalId, 7);
		assert.throws(() => reserveResearchTask(f, plan, grant, "primary-stales-grant"), /scope grant no longer matches|plan source is no longer/);
	} finally {
		f.database.close();
	}
});

test("frozen target and trusted producer contexts prevent retargeting and permit a complete result", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		enterResearch(f);
		const plan = f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scopeA(), plan.planId, 1, "trusted-event", "2026-09-11T13:00:00.000Z");
		const executor = f.host.registerTrustedRunnerContext(f.scopeA(), "executor");
		const validator = f.host.registerTrustedRunnerContext(f.scopeA(), "validator");
		const reviewer = f.host.registerTrustedRunnerContext(f.scopeA(), "reviewer");
		const execution = succeedTask(f.host, reserveResearchTask(f, plan, grant, "complete-execution", "execution", { producerContextId: executor.contextId }).task);
		const result = f.host.recordResultFromFrozenTask({ taskId: execution.taskId, expectedTaskRevision: execution.revision, classification: "positive", summary: "Measured result.", limitations: ["Fixture only."] });
		const target = { targetKind: "result", targetId: result.resultId, targetRevision: result.revision, targetHash: result.contentHash };
		const validation = succeedTask(f.host, reserveResearchTask(f, plan, grant, "complete-validation", "validation", { producerContextId: validator.contextId, target }).task);
		assert.throws(() => f.host.recordValidationFromFrozenTask({ ...target, taskId: validation.taskId, expectedTaskRevision: validation.revision, targetId: "result_retarget", status: "passed", findings: ["bad callback"] }), /target differs/);
		f.host.recordValidationFromFrozenTask({ ...target, taskId: validation.taskId, expectedTaskRevision: validation.revision, status: "passed", findings: ["Independent numeric oracle passed."] });
		const selfReview = succeedTask(f.host, reserveResearchTask(f, plan, grant, "self-review", "review", { producerContextId: executor.contextId, target }).task);
		assert.throws(() => f.host.recordIndependentReviewFromFrozenTask({ ...target, taskId: selfReview.taskId, expectedTaskRevision: selfReview.revision, status: "passed", findings: ["self review"] }), /independent/);
		const review = succeedTask(f.host, reserveResearchTask(f, plan, grant, "complete-review", "review", { producerContextId: reviewer.contextId, target }).task);
		f.host.recordIndependentReviewFromFrozenTask({ ...target, taskId: review.taskId, expectedTaskRevision: review.revision, status: "passed", findings: ["Independent review passed."] });
		const confirmed = f.host.confirmResultFromTrustedUserEvent(f.scopeA(), result.resultId, result.revision, "trusted-confirmation");
		assert.equal(confirmed.confirmedUserEventId, "trusted-confirmation");
		assert.ok(f.host.publishConfirmedResult(f.scopeA(), confirmed.resultId, confirmed.revision).publishedAt);
		assert.equal(f.host.listResults(f.scopeA()).length, 1);
		assert.equal(f.host.listValidations(f.scopeA(), target)[0].taskId, validation.taskId);
		assert.equal(f.host.listIndependentReviews(f.scopeA(), target)[0].reviewerContextId, reviewer.contextId);
	} finally {
		f.database.close();
	}
});

test("task events are monotonic and Host savepoints compose with an owner transaction", () => {
	const f = setup();
	try {
		f.database.exec("BEGIN IMMEDIATE");
		f.host.reserveStudyTask(f.scopeA(), {
			dispatchKey: "outer-rollback", kind: "reading",
			manifest: { codeHash: hash("outer-code"), parameterHash: hash("outer-parameters"), inputHashes: {}, environmentHash: hash("outer-env") },
			admission: { purpose: "Outer transaction proof.", language: "none", maxWallSeconds: 10, maxMemoryMiB: 16 },
		});
		f.database.exec("ROLLBACK");
		assert.equal(f.host.listTasks(f.scopeA()).length, 0);
		const task = succeedTask(f.host, f.host.reserveStudyTask(f.scopeA(), {
			dispatchKey: "event-ledger", kind: "reading",
			manifest: { codeHash: hash("event-code"), parameterHash: hash("event-parameters"), inputHashes: {}, environmentHash: hash("event-env") },
			admission: { purpose: "Event ledger proof.", language: "none", maxWallSeconds: 10, maxMemoryMiB: 16 },
		}).task);
		assert.deepEqual(f.host.listTaskEvents(f.scopeA(), task.taskId).map((event) => event.sequence), [1, 2, 3, 4, 5]);
	} finally {
		f.database.close();
	}
});

test("task event ledger remains ordered after reopening its SQLite database", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-study-research-ledger-"));
	const databasePath = join(directory, "harness.sqlite");
	let f = setup(databasePath);
	try {
		const task = succeedTask(
			f.host,
			f.host.reserveStudyTask(f.scopeA(), {
				dispatchKey: "restart-ledger",
				kind: "reading",
				manifest: {
					codeHash: hash("restart-code"),
					parameterHash: hash("restart-parameters"),
					inputHashes: {},
					environmentHash: hash("restart-env"),
				},
				admission: { purpose: "Restart ledger proof.", language: "none", maxWallSeconds: 10, maxMemoryMiB: 16 },
			}).task,
		);
		f.database.close();
		f = null;
		const database = new DatabaseSync(databasePath);
		const host = new StudyResearchHost(database);
		const scope = { projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: 1 };
		assert.deepEqual(host.listTaskEvents(scope, task.taskId).map((event) => event.sequence), [1, 2, 3, 4, 5]);
		database.close();
	} finally {
		f?.database.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("concurrent affected edits block source update promotion and prerequisite links remain acyclic", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash), 1);
		const v2 = source("concurrent-v2");
		const proposal = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate: v2,
			knowledge: automaticKnowledge(stored.sourceId, v2.contentHash, "Rebased claim"),
			changeSummary: "Source changed while a human was editing.",
			expectedProjectRevision: 2,
		});
		const marked = f.host.getKnowledge(f.scopeA()).notes[0];
		f.host.editKnowledgeNote(f.scopeA(), {
			noteId: marked.noteId,
			expectedNoteRevision: marked.revision,
			expectedProjectRevision: 3,
			body: "Human edit after proposal.",
			sourceId: marked.sourceId,
			sourceHash: marked.sourceHash,
			nodeIds: marked.nodeIds,
		});
		assert.throws(() => f.host.acceptSourceUpdate(f.scopeA(), proposal.proposalId, 4), /affected note changed/);
		const plain = {
			nodes: [
				{ localKey: "a", kind: "concept", title: "A", statement: "A", scope: "local", sourceId: null, sourceHash: null, manuallyEdited: false },
				{ localKey: "b", kind: "concept", title: "B", statement: "B", scope: "local", sourceId: null, sourceHash: null, manuallyEdited: false },
			],
			notes: [], relations: [],
		};
		f.host.commitKnowledgeChange(f.scopeA(), plain, 4);
		const nodes = f.host.getKnowledge(f.scopeA()).nodes.filter((node) => node.sourceId === null);
		f.host.addKnowledgeRelation(f.scopeA(), { fromNodeId: nodes[0].nodeId, toNodeId: nodes[1].nodeId, kind: "prerequisite", expectedProjectRevision: 5 });
		assert.throws(() => f.host.addKnowledgeRelation(f.scopeA(), { fromNodeId: nodes[1].nodeId, toNodeId: nodes[0].nodeId, kind: "prerequisite", expectedProjectRevision: 6 }), /acyclic/);
	} finally {
		f.database.close();
	}
});

test("superseding a pending source proposal transfers only its current temporary backup", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		f.host.commitKnowledgeChange(f.scopeA(), automaticKnowledge(stored.sourceId, stored.contentHash), 1);
		const v2 = source("supersede-v2");
		const first = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate: v2,
			knowledge: automaticKnowledge(stored.sourceId, v2.contentHash),
			changeSummary: "First candidate.",
			expectedProjectRevision: 2,
		});
		const v3 = source("supersede-v3");
		const second = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate: v3,
			knowledge: automaticKnowledge(stored.sourceId, v3.contentHash),
			changeSummary: "Replacement candidate.",
			expectedProjectRevision: 3,
		});
		assert.equal(f.host.getSourceUpdate(f.scopeA(), first.proposalId).status, "superseded");
		assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_research_source_backup").get().count, 1);
		f.host.rejectSourceUpdate(f.scopeA(), second.proposalId, 4);
		assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_research_source_backup").get().count, 0);
	} finally {
		f.database.close();
	}
});

test("source rebases require explicit stable replacements and preserve manual knowledge and links", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		const original = {
			nodes: [
				{ localKey: "a", kind: "claim", title: "A", statement: "A", scope: "section", sourceId: stored.sourceId, sourceHash: stored.contentHash, manuallyEdited: false },
				{ localKey: "b", kind: "concept", title: "B", statement: "B", scope: "section", sourceId: stored.sourceId, sourceHash: stored.contentHash, manuallyEdited: false },
				{ localKey: "removed", kind: "claim", title: "Removed", statement: "Removed", scope: "section", sourceId: stored.sourceId, sourceHash: stored.contentHash, manuallyEdited: false },
			],
			notes: [
				{ author: "agent", body: "Agent draft.", sourceId: stored.sourceId, sourceHash: stored.contentHash, nodeLocalKeys: ["b"] },
				{ author: "user", body: "User keeps A.", sourceId: stored.sourceId, sourceHash: stored.contentHash, nodeLocalKeys: ["a"] },
			],
			relations: [{ fromNodeLocalKey: "a", toNodeLocalKey: "b", kind: "supports" }],
		};
		f.host.commitKnowledgeChange(f.scopeA(), original, 1);
		const before = f.host.getKnowledge(f.scopeA());
		const a = before.nodes.find((node) => node.title === "A");
		const b = before.nodes.find((node) => node.title === "B");
		const removed = before.nodes.find((node) => node.title === "Removed");
		const agentNote = before.notes.find((note) => note.author === "agent");
		const userNote = before.notes.find((note) => note.author === "user");
		f.host.commitKnowledgeChange(f.scopeA(), {
			nodes: [{ localKey: "manual", kind: "question", title: "Manual", statement: "Manual", scope: "local", sourceId: null, sourceHash: null, manuallyEdited: true }],
			notes: [], relations: [],
		}, 2);
		const manual = f.host.getKnowledge(f.scopeA()).nodes.find((node) => node.title === "Manual");
		f.host.addKnowledgeRelation(f.scopeA(), { fromNodeId: a.nodeId, toNodeId: manual.nodeId, kind: "refers-to", expectedProjectRevision: 3 });
		f.database
			.prepare(
				"INSERT INTO pi_study_research_relation (relation_id, project_id, from_node_id, to_node_id, kind, revision, author, manually_edited, source_id, source_hash, stale, requires_review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("legacy-unknown-relation", "project-a", a.nodeId, b.nodeId, "refers-to", 1, "unknown", 0, null, null, 0, 1, "2026-09-12T00:00:00.000Z");
		const firstCandidate = source("rebase-v2");
		const first = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate: firstCandidate,
			knowledge: automaticKnowledge(stored.sourceId, firstCandidate.contentHash, "Unused first candidate"),
			changeSummary: "First candidate before a manual edit.",
			expectedProjectRevision: 4,
		});
		const staleAgentNote = f.host.getKnowledge(f.scopeA()).notes.find((note) => note.noteId === agentNote.noteId);
		f.host.editKnowledgeNote(f.scopeA(), {
			noteId: staleAgentNote.noteId,
			expectedNoteRevision: staleAgentNote.revision,
			expectedProjectRevision: 5,
			body: "User corrected the agent draft.",
			sourceId: staleAgentNote.sourceId,
			sourceHash: staleAgentNote.sourceHash,
			nodeIds: staleAgentNote.nodeIds,
		});
		const candidate = source("rebase-v3");
		const rebase = {
			nodes: [
				{ localKey: "b", replaceNodeId: b.nodeId, kind: "concept", title: "B v3", statement: "B v3", scope: "section", sourceId: stored.sourceId, sourceHash: candidate.contentHash, manuallyEdited: false },
				{ localKey: "new", kind: "claim", title: "New", statement: "New", scope: "section", sourceId: stored.sourceId, sourceHash: candidate.contentHash, manuallyEdited: false },
				{ localKey: "a", replaceNodeId: a.nodeId, kind: "claim", title: "A v3", statement: "A v3", scope: "section", sourceId: stored.sourceId, sourceHash: candidate.contentHash, manuallyEdited: false },
			],
			notes: [],
			relations: [{ fromNodeLocalKey: "a", toNodeLocalKey: "b", kind: "prerequisite" }],
		};
		const second = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate,
			knowledge: rebase,
			changeSummary: "Rebased candidate after the manual edit.",
			expectedProjectRevision: 6,
		});
		assert.equal(f.host.getSourceUpdate(f.scopeA(), first.proposalId).status, "superseded");
		f.host.acceptSourceUpdate(f.scopeA(), second.proposalId, 7);
		const after = f.host.getKnowledge(f.scopeA());
		assert.deepEqual(after.nodes.find((node) => node.nodeId === a.nodeId).title, "A v3");
		assert.deepEqual(after.nodes.find((node) => node.nodeId === b.nodeId).title, "B v3");
		assert.equal(after.nodes.find((node) => node.nodeId === removed.nodeId).stale, true);
		assert.equal(after.notes.find((note) => note.noteId === userNote.noteId).body, "User keeps A.");
		assert.equal(after.notes.find((note) => note.noteId === userNote.noteId).nodeIds[0], a.nodeId);
		assert.equal(after.notes.find((note) => note.noteId === agentNote.noteId).manuallyEdited, true);
		assert.equal(after.notes.find((note) => note.noteId === agentNote.noteId).body, "User corrected the agent draft.");
		const manualRelation = after.relations.find((relation) => relation.fromNodeId === a.nodeId && relation.toNodeId === manual.nodeId);
		assert.equal(manualRelation.author, "user");
		assert.equal(manualRelation.manuallyEdited, true);
		assert.equal(manualRelation.sourceId, null);
		assert.equal(manualRelation.stale, false);
		const retiredSupports = after.relations.find((relation) => relation.fromNodeId === a.nodeId && relation.toNodeId === b.nodeId && relation.kind === "supports");
		assert.equal(retiredSupports.author, "agent");
		assert.equal(retiredSupports.sourceId, stored.sourceId);
		assert.equal(retiredSupports.sourceHash, stored.contentHash);
		assert.equal(retiredSupports.stale, true);
		const activePrerequisite = after.relations.find((relation) => relation.fromNodeId === a.nodeId && relation.toNodeId === b.nodeId && relation.kind === "prerequisite");
		assert.equal(activePrerequisite.author, "agent");
		assert.equal(activePrerequisite.sourceId, stored.sourceId);
		assert.equal(activePrerequisite.sourceHash, candidate.contentHash);
		assert.equal(activePrerequisite.stale, false);
		const legacyUnknown = after.relations.find((relation) => relation.relationId === "legacy-unknown-relation");
		assert.equal(legacyUnknown.author, "unknown");
		assert.equal(legacyUnknown.requiresReview, true);
		assert.equal(legacyUnknown.stale, false);
		const editedOldVersion = f.host.editKnowledgeNote(f.scopeA(), {
			noteId: userNote.noteId,
			expectedNoteRevision: after.notes.find((note) => note.noteId === userNote.noteId).revision,
			expectedProjectRevision: 8,
			body: "User keeps A after the source update.",
			sourceId: stored.sourceId,
			sourceHash: stored.contentHash,
			nodeIds: [a.nodeId],
		});
		assert.equal(editedOldVersion.stale, true);
		const staleRemoved = after.nodes.find((node) => node.nodeId === removed.nodeId);
		const editedOldNode = f.host.editKnowledgeNode(f.scopeA(), {
			nodeId: staleRemoved.nodeId,
			expectedNodeRevision: staleRemoved.revision,
			expectedProjectRevision: 9,
			kind: staleRemoved.kind,
			title: staleRemoved.title,
			statement: "Edited against the retained old source version.",
			scope: staleRemoved.scope,
			sourceId: staleRemoved.sourceId,
			sourceHash: staleRemoved.sourceHash,
			manuallyEdited: false,
		});
		assert.equal(editedOldNode.stale, true);
	} finally {
		f.database.close();
	}
});

test("source update rejection restores retired automatic source-local relations", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		f.host.commitKnowledgeChange(
			f.scopeA(),
			{
				nodes: [
					{ localKey: "a", kind: "claim", title: "A", statement: "A", scope: "section", sourceId: stored.sourceId, sourceHash: stored.contentHash, manuallyEdited: false },
					{ localKey: "b", kind: "concept", title: "B", statement: "B", scope: "section", sourceId: stored.sourceId, sourceHash: stored.contentHash, manuallyEdited: false },
				],
				notes: [],
				relations: [{ fromNodeLocalKey: "a", toNodeLocalKey: "b", kind: "supports" }],
			},
			1,
		);
		const candidate = source("reject-relation-v2");
		const proposal = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate,
			knowledge: { nodes: [], notes: [], relations: [] },
			changeSummary: "Rejecting must restore the automatic relation.",
			expectedProjectRevision: 2,
		});
		assert.equal(f.host.getKnowledge(f.scopeA()).relations[0].stale, true);
		f.host.rejectSourceUpdate(f.scopeA(), proposal.proposalId, 3);
		const restored = f.host.getKnowledge(f.scopeA()).relations[0];
		assert.equal(restored.author, "agent");
		assert.equal(restored.sourceId, stored.sourceId);
		assert.equal(restored.sourceHash, stored.contentHash);
		assert.equal(restored.stale, false);
	} finally {
		f.database.close();
	}
});

test("cross-source generated relations retain identity but become stale after an endpoint source update", () => {
	const f = setup();
	try {
		const first = addSource(f);
		const secondInput = source("cross-source-b");
		secondInput.relativePath = "appendix.tex";
		const [second] = f.host.registerSources(f.scopeA(), [secondInput], 1).sources;
		f.host.commitKnowledgeChange(
			f.scopeA(),
			{
				nodes: [
					{ localKey: "a", kind: "claim", title: "A", statement: "A", scope: "section", sourceId: first.sourceId, sourceHash: first.contentHash, manuallyEdited: false },
					{ localKey: "b", kind: "concept", title: "B", statement: "B", scope: "section", sourceId: second.sourceId, sourceHash: second.contentHash, manuallyEdited: false },
				],
				notes: [],
				relations: [{ fromNodeLocalKey: "a", toNodeLocalKey: "b", kind: "refers-to" }],
			},
			2,
		);
		const before = f.host.getKnowledge(f.scopeA()).relations[0];
		assert.equal(before.author, "agent");
		assert.equal(before.sourceId, null);
		assert.equal(before.sourceHash, null);
		const candidate = source("cross-source-a-v2");
		const proposal = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: first.sourceId,
			candidate,
			knowledge: { nodes: [], notes: [], relations: [] },
			changeSummary: "This update invalidates the relation's changed source endpoint.",
			expectedProjectRevision: 3,
		});
		f.host.acceptSourceUpdate(f.scopeA(), proposal.proposalId, 4);
		const after = f.host.getKnowledge(f.scopeA()).relations[0];
		assert.equal(after.relationId, before.relationId);
		assert.equal(after.stale, true);
		assert.equal(after.sourceId, null);
	} finally {
		f.database.close();
	}
});

test("invalid source candidates do not supersede pending proposals or mutate knowledge", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		f.host.commitKnowledgeChange(
			f.scopeA(),
			{
				nodes: [
					{ localKey: "a", kind: "claim", title: "A", statement: "A", scope: "section", sourceId: stored.sourceId, sourceHash: stored.contentHash, manuallyEdited: false },
					{ localKey: "b", kind: "concept", title: "B", statement: "B", scope: "section", sourceId: stored.sourceId, sourceHash: stored.contentHash, manuallyEdited: false },
				],
				notes: [],
				relations: [{ fromNodeLocalKey: "a", toNodeLocalKey: "b", kind: "supports" }],
			},
			1,
		);
		const firstCandidate = source("valid-pending-v2");
		const first = f.host.proposeSourceUpdate(f.scopeA(), {
			sourceId: stored.sourceId,
			candidate: firstCandidate,
			knowledge: { nodes: [], notes: [], relations: [] },
			changeSummary: "This pending proposal must remain pending.",
			expectedProjectRevision: 2,
		});
		const before = f.host.getKnowledge(f.scopeA());
		const a = before.nodes.find((node) => node.title === "A");
		const b = before.nodes.find((node) => node.title === "B");
		const invalidCandidate = source("invalid-cycle-v3");
		assert.throws(
			() =>
				f.host.proposeSourceUpdate(f.scopeA(), {
					sourceId: stored.sourceId,
					candidate: invalidCandidate,
					knowledge: {
						nodes: [
							{ localKey: "a", replaceNodeId: a.nodeId, kind: "claim", title: "A v3", statement: "A v3", scope: "section", sourceId: stored.sourceId, sourceHash: invalidCandidate.contentHash, manuallyEdited: false },
							{ localKey: "b", replaceNodeId: b.nodeId, kind: "concept", title: "B v3", statement: "B v3", scope: "section", sourceId: stored.sourceId, sourceHash: invalidCandidate.contentHash, manuallyEdited: false },
						],
						notes: [],
						relations: [
							{ fromNodeLocalKey: "a", toNodeLocalKey: "b", kind: "prerequisite" },
							{ fromNodeLocalKey: "b", toNodeLocalKey: "a", kind: "prerequisite" },
						],
					},
					changeSummary: "An invalid cyclic candidate cannot replace the pending proposal.",
					expectedProjectRevision: 3,
				}),
			/acyclic/,
		);
		assert.equal(f.host.getSourceUpdate(f.scopeA(), first.proposalId).status, "pending");
		assert.deepEqual(f.host.getKnowledge(f.scopeA()), before);
		assert.equal(f.host.projectRevision(f.scopeA()).revision, 3);
	} finally {
		f.database.close();
	}
});

test("queued research admission rechecks frozen provenance without consulting the interactive phase", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		enterResearch(f);
		const plan = f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scopeA(), plan.planId, plan.revision, "trusted-admission", "2026-09-11T13:00:00.000Z");
		assert.throws(
			() => f.host.reserveTask(f.scopeA(), { planId: plan.planId, grantId: grant.grantId, expectedPlanRevision: plan.revision, dispatchKey: "missing-execution-provenance", kind: "execution", manifest: { codeHash: hash("missing-code"), parameterHash: hash("missing-parameters"), inputHashes: {}, environmentHash: hash("missing-environment") } }),
			/trusted runner context/,
		);
		const execution = reserveResearchTask(f, plan, grant, "frozen-admission").task;
		f.host.setPhase(f.scopeA(), "study");
		f.host.assertFrozenResearchAuthorizationCurrent(execution.authorization);
		assert.equal(f.host.transitionTaskFromFrozenAuthorization({ taskId: execution.taskId, expectedTaskRevision: execution.revision, nextStatus: "admitted", detail: "queue revalidated frozen scope" }).status, "admitted");
	} finally {
		f.database.close();
	}
});

test("result hashes are scientific-only and reviews compare stable producer identities", () => {
	const f = setup();
	try {
		const stored = addSource(f);
		enterResearch(f);
		const plan = f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(stored.contentHash), expectedProjectRevision: 1 });
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scopeA(), plan.planId, plan.revision, "trusted-result", "2026-09-11T13:00:00.000Z");
		const executor = f.host.registerTrustedRunnerContext(f.scopeA(), "shared-producer");
		const sameProducerDifferentContext = f.host.registerTrustedRunnerContext(f.scopeA(), "shared-producer");
		const validator = f.host.registerTrustedRunnerContext(f.scopeA(), "independent-validator");
		const reviewer = f.host.registerTrustedRunnerContext(f.scopeA(), "independent-reviewer");
		const execution = succeedTask(f.host, reserveResearchTask(f, plan, grant, "scientific-result", "execution", { producerContextId: executor.contextId }).task);
		const result = f.host.recordResultFromFrozenTask({ taskId: execution.taskId, expectedTaskRevision: execution.revision, classification: "positive", summary: "Measured evidence.", limitations: ["Fixture scope."] });
		const target = { targetKind: "result", targetId: result.resultId, targetRevision: result.revision, targetHash: result.contentHash };
		const validation = succeedTask(f.host, reserveResearchTask(f, plan, grant, "scientific-validation", "validation", { producerContextId: validator.contextId, target }).task);
		f.host.recordValidationFromFrozenTask({ ...target, taskId: validation.taskId, expectedTaskRevision: validation.revision, status: "passed", findings: ["Independent validation passed."] });
		const selfReview = succeedTask(f.host, reserveResearchTask(f, plan, grant, "same-identity-review", "review", { producerContextId: sameProducerDifferentContext.contextId, target }).task);
		assert.throws(() => f.host.recordIndependentReviewFromFrozenTask({ ...target, taskId: selfReview.taskId, expectedTaskRevision: selfReview.revision, status: "passed", findings: ["Same producer context id changed."] }), /independent/);
		const independentReview = succeedTask(f.host, reserveResearchTask(f, plan, grant, "scientific-review", "review", { producerContextId: reviewer.contextId, target }).task);
		f.host.recordIndependentReviewFromFrozenTask({ ...target, taskId: independentReview.taskId, expectedTaskRevision: independentReview.revision, status: "passed", findings: ["Independent review passed."] });
		const confirmed = f.host.confirmResultFromTrustedUserEvent(f.scopeA(), result.resultId, result.revision, "trusted-confirmation-hash");
		const published = f.host.publishConfirmedResult(f.scopeA(), result.resultId, result.revision);
		assert.equal(result.contentHash, scientificResultHash(result));
		assert.equal(confirmed.contentHash, result.contentHash);
		assert.equal(published.contentHash, result.contentHash);
		assert.equal(f.host.getResult(f.scopeA(), result.resultId).contentHash, result.contentHash);
	} finally {
		f.database.close();
	}
});

test("exact source references reject hash ambiguity and same-hash candidate mutations", () => {
	const f = setup();
	try {
		const first = source("duplicate-content");
		const second = source("duplicate-content");
		second.relativePath = "appendix.tex";
		const [primary, appendix] = f.host.registerSources(f.scopeA(), [first, second], 0).sources;
		enterResearch(f);
		assert.throws(
			() => f.host.createResearchPlan(f.scopeA(), { plan: formalPlan(primary.contentHash), expectedProjectRevision: 1 }),
			/multiple project sources/i,
		);
		const explicitPlan = f.host.createResearchPlan(f.scopeA(), {
			expectedProjectRevision: 1,
			plan: {
				...formalPlan(primary.contentHash),
				sourceVersionHashes: [primary.contentHash, appendix.contentHash],
				sourceReferences: [
					{ sourceId: primary.sourceId, contentHash: primary.contentHash },
					{ sourceId: appendix.sourceId, contentHash: appendix.contentHash },
				],
			},
		});
		const grant = f.host.grantScopeFromTrustedUserEvent(f.scopeA(), explicitPlan.planId, explicitPlan.revision, "trusted-explicit", "2026-09-11T13:00:00.000Z");
		const changedAppendix = source("appendix-v2");
		changedAppendix.relativePath = "appendix.tex";
		const proposal = f.host.proposeSourceUpdate(f.scopeA(), { sourceId: appendix.sourceId, candidate: changedAppendix, knowledge: { nodes: [], notes: [], relations: [] }, changeSummary: "Appendix changed.", expectedProjectRevision: 2 });
		f.host.acceptSourceUpdate(f.scopeA(), proposal.proposalId, 3);
		assert.throws(() => f.host.assertFrozenResearchAuthorizationCurrent({ projectId: "project-a", sessionId: "session-a", phase: "research", phaseRevision: 2, grantId: grant.grantId, planId: explicitPlan.planId, planRevision: explicitPlan.revision, semanticDigest: explicitPlan.semanticDigest }), /source.*current|source.*changed/i);
		const isolated = setup();
		try {
			const sourceV1 = addSource(isolated);
			const candidate = source("candidate-same-hash");
			const pending = isolated.host.proposeSourceUpdate(isolated.scopeA(), { sourceId: sourceV1.sourceId, candidate, knowledge: { nodes: [], notes: [], relations: [] }, changeSummary: "Persist candidate bytes.", expectedProjectRevision: 1 });
			isolated.host.rejectSourceUpdate(isolated.scopeA(), pending.proposalId, 2);
			const changedMetadata = source("candidate-same-hash");
			changedMetadata.parser = "different-parser/1.0.0";
			assert.throws(() => isolated.host.proposeSourceUpdate(isolated.scopeA(), { sourceId: sourceV1.sourceId, candidate: changedMetadata, knowledge: { nodes: [], notes: [], relations: [] }, changeSummary: "Do not reinterpret identical bytes.", expectedProjectRevision: 3 }), /same-hash source candidate/);
		} finally {
			isolated.database.close();
		}
	} finally {
		f.database.close();
	}
});
