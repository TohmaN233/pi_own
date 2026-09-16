import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StudyAssignmentError, StudyAssignmentHost, StudyResearchHost } from "../packages/study-research-host/src/index.ts";

const artifactRoot = join(process.cwd(), ".artifacts", "study-research", "assignment", "fixtures");

function hash(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function source(text, relativePath = "main.tex") {
	return {
		sourceRoot: "D:/study-assignment-fixture",
		relativePath,
		kind: "tex",
		sourceRole: "primary",
		contentHash: hash(text),
		parser: "fixture/v1",
		diagnostics: [],
		chunks: [{ ordinal: 1, locator: JSON.stringify({ fixture: true }), text }],
	};
}

function draft(sourceId, question = "这一定义解决了什么问题？", answer = "它把问题转化为可追踪的定义。") {
	return {
		overview: "围绕当前来源做局部理解练习。",
		tasks: [question],
		deliverables: [],
		rubric: [],
		solutionNotes: [answer],
		materialIds: [sourceId],
	};
}

function fixture() {
	const directory = mkdtempSync(join(artifactRoot, "study-assignment-"));
	const databasePath = join(directory, "harness.sqlite");
	const database = new DatabaseSync(databasePath);
	database.exec("PRAGMA foreign_keys = ON");
	database.exec("CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
	database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?), (?, ?)").run(
		"project-a", JSON.stringify({ id: "project-a" }), "project-b", JSON.stringify({ id: "project-b" }),
	);
	database.prepare("INSERT INTO pi_project_member VALUES (?, ?), (?, ?)").run("session-a", "project-a", "session-b", "project-b");
	const study = new StudyResearchHost(database);
	const phaseA = study.bindSession("project-a", "session-a", "study");
	const phaseB = study.bindSession("project-b", "session-b", "study");
	const scopeA = { projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: phaseA.revision };
	const scopeB = { projectId: "project-b", sessionId: "session-b", expectedPhaseRevision: phaseB.revision };
	const sourceA = study.registerSource(scopeA, source("A source"), 0);
	const sourceB = study.registerSource(scopeB, source("B source"), 0);
	const assignments = new StudyAssignmentHost(database, study);
	return {
		database,
		databasePath,
		directory,
		study,
		assignments,
		scopeA: { ...scopeA, expectedPhaseRevision: 1 },
		scopeB: { ...scopeB, expectedPhaseRevision: 1 },
		sourceA,
		sourceB,
		close() {
			database.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function assertCode(error, code) {
	assert.ok(error instanceof StudyAssignmentError, `expected StudyAssignmentError, got ${String(error)}`);
	assert.equal(error.code, code);
}

test("Study Assignment requires an explicit browser request and persists a shared AssignmentDraft across restart", () => {
	mkdirSync(artifactRoot, { recursive: true });
	const f = fixture();
	try {
		assert.throws(
			() => f.assignments.saveDraft(f.scopeA, {
				requestId: "missing-request",
				expectedRequestRevision: 1,
				expectedDraftRevision: 0,
				expectedProjectRevision: 1,
				draft: draft(f.sourceA.sourceId),
			}),
			(error) => (assertCode(error, "REQUEST_NOT_FOUND"), true),
		);
		const request = f.assignments.createRequestFromUser(f.scopeA, {
			goal: "理解当前论文定义",
			sourceRefs: [{ sourceId: f.sourceA.sourceId, sourceHash: f.sourceA.contentHash, locator: "definition-1" }],
			count: 1,
			difficulty: "基础",
			purpose: "准备讨论",
			expectedProjectRevision: 1,
		});
		assert.equal(request.request.status, "requested");
		assert.equal(request.request.draftRevision, 0);
		assert.equal(request.originSources[0].sourceId, f.sourceA.sourceId);
		assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM pi_study_assignment_origin WHERE request_id = ?").get(request.request.requestId).count, 1);
		const saved = f.assignments.saveDraft(f.scopeA, {
			requestId: request.request.requestId,
			expectedRequestRevision: request.request.revision,
			expectedDraftRevision: 0,
			expectedProjectRevision: 1,
			draft: draft(f.sourceA.sourceId),
		});
		assert.equal(saved.request.status, "draft");
		assert.equal(saved.draft.draft.tasks[0], "这一定义解决了什么问题？");
		assert.equal(saved.draft.draft.materialIds[0], f.sourceA.sourceId);
		f.database.close();
		const reopenedDatabase = new DatabaseSync(f.databasePath);
		const reopenedStudy = new StudyResearchHost(reopenedDatabase);
		const reopenedAssignments = new StudyAssignmentHost(reopenedDatabase, reopenedStudy);
		const reopened = reopenedAssignments.readRequest(f.scopeA, request.request.requestId);
		assert.equal(reopened.request.contentHash, saved.request.contentHash);
		assert.equal(reopened.draft.contentHash, saved.draft.contentHash);
		assert.deepEqual(reopened.draft.draft, saved.draft.draft);
		reopenedDatabase.close();
	} finally {
		if (existsSync(f.databasePath)) {
			try { f.database.close(); } catch {}
		}
		rmSync(f.directory, { recursive: true, force: true });
	}
});

test("Study Assignment rejects invalid questions, stale CAS revisions, source versions and other projects", () => {
	mkdirSync(artifactRoot, { recursive: true });
	const f = fixture();
	try {
		const request = f.assignments.createRequestFromUser(f.scopeA, {
			goal: "局部复习",
			sourceRefs: [{ sourceId: f.sourceA.sourceId, sourceHash: f.sourceA.contentHash, locator: null }],
			expectedProjectRevision: 1,
		});
		assert.throws(
			() => f.assignments.saveDraft(f.scopeA, {
				requestId: request.request.requestId,
				expectedRequestRevision: 1,
				expectedDraftRevision: 0,
				expectedProjectRevision: 1,
				draft: { ...draft(f.sourceA.sourceId), tasks: [] },
			}),
			(error) => (assertCode(error, "INVALID_QUESTIONS"), true),
		);
		const saved = f.assignments.saveDraft(f.scopeA, {
			requestId: request.request.requestId,
			expectedRequestRevision: 1,
			expectedDraftRevision: 0,
			expectedProjectRevision: 1,
			draft: draft(f.sourceA.sourceId),
		});
		assert.throws(
			() => f.assignments.saveDraft(f.scopeA, {
				requestId: request.request.requestId,
				expectedRequestRevision: 1,
				expectedDraftRevision: 0,
				expectedProjectRevision: 1,
				draft: draft(f.sourceA.sourceId),
			}),
			(error) => (assertCode(error, "REQUEST_REVISION_CONFLICT"), true),
		);
		assert.throws(
			() => f.assignments.saveDraft(f.scopeA, {
				requestId: request.request.requestId,
				expectedRequestRevision: saved.request.revision,
				expectedDraftRevision: 0,
				expectedProjectRevision: 1,
				draft: draft(f.sourceA.sourceId),
			}),
			(error) => (assertCode(error, "DRAFT_REVISION_CONFLICT"), true),
		);
		assert.throws(
			() => f.assignments.readRequest(f.scopeB, request.request.requestId),
			(error) => (assertCode(error, "REQUEST_NOT_FOUND"), true),
		);
		const sourceUpdate = f.study.proposeSourceUpdate(f.scopeA, {
			sourceId: f.sourceA.sourceId,
			candidate: source("A source v2"),
			knowledge: { nodes: [], notes: [], relations: [] },
			changeSummary: "Fixture source update",
			expectedProjectRevision: 1,
		});
		f.study.acceptSourceUpdate(f.scopeA, sourceUpdate.proposalId, 2);
		const currentProjectRevision = f.study.projectRevision(f.scopeA).revision;
		assert.throws(
			() => f.assignments.saveDraft({ ...f.scopeA }, {
				requestId: request.request.requestId,
				expectedRequestRevision: saved.request.revision,
				expectedDraftRevision: saved.draft.draftRevision,
				expectedProjectRevision: currentProjectRevision,
				draft: draft(f.sourceA.sourceId),
			}),
			(error) => (assertCode(error, "REQUEST_STALE_PROJECT"), true),
		);
		const phaseRequest = f.assignments.createRequestFromUser({ ...f.scopeA }, {
			goal: "阶段切换前请求",
			sourceRefs: [{ sourceId: f.sourceA.sourceId, sourceHash: hash("A source v2"), locator: null }],
			expectedProjectRevision: currentProjectRevision,
		});
		const nextPhase = f.study.setPhase(f.scopeA, "research");
		assert.throws(
			() => f.assignments.saveDraft({ projectId: "project-a", sessionId: "session-a", expectedPhaseRevision: nextPhase.revision }, {
				requestId: phaseRequest.request.requestId,
				expectedRequestRevision: 1,
				expectedDraftRevision: 0,
				expectedProjectRevision: currentProjectRevision,
				draft: draft(f.sourceA.sourceId),
			}),
			(error) => (assertCode(error, "REQUEST_STALE_PHASE"), true),
		);
	} finally {
		try { f.database.close(); } catch {}
		rmSync(f.directory, { recursive: true, force: true });
	}
});
