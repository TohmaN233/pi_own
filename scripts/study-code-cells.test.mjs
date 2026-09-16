import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { StudyResearchHost } from "../packages/study-research-host/src/index.ts";
import { StudyCodeCells } from "../packages/study-execution-host/src/code-cells.ts";

test("code revisions freeze click-time execution, preserve edits and fail closed on scope/input/manifest conflicts", (t) => {
	const db = new DatabaseSync(":memory:"); t.after(() => db.close());
	db.exec("CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
	for (const id of ["p", "foreign"]) { db.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run(id, JSON.stringify({ id })); db.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run(`s-${id}`, id); }
	const host = new StudyResearchHost(db);
	host.bindSession("p", "s-p"); host.bindSession("foreign", "s-foreign");
	const scope = { projectId: "p", sessionId: "s-p", expectedPhaseRevision: 1 };
	const cells = new StudyCodeCells(db, host);
	const source = host.registerSources(scope, [{ sourceRoot: "G:/synthetic", relativePath: "data.csv", kind: "text", sourceRole: "reference", diagnostics: [], contentHash: contentHash("1,2,3"), parser: "fixture", chunks: [{ ordinal: 1, locator: '{"line":1}', text: "1,2,3" }] }], 0).sources[0];
	const draft = { title: "Mean", purpose: "Understand a simple mean", language: "python", code: "print(2)", parameters: { seed: 7 }, inputs: [{ name: "data.csv", sourceId: source.sourceId, sourceHash: source.contentHash }] };
	const first = cells.save(scope, { draft });
	const manifest = cells.manifest(first, contentHash("verified environment"));
	const producerContextId = host.registerTrustedRunnerContext(scope, "runner-test").contextId;
	const task = host.reserveStudyTask(scope, { dispatchKey: "click-1", kind: "execution", manifest, producerContextId, admission: { purpose: draft.purpose, language: "python", maxWallSeconds: 20, maxMemoryMiB: 256 } }).task;
	const frozen = cells.bindRunFromTrustedAdmission(scope, { cellId: first.cellId, expectedCellRevision: 1, taskId: task.taskId });
	const second = cells.save(scope, { cellId: first.cellId, expectedCellRevision: 1, draft: { ...draft, code: "print(3)" } });
	assert.equal(second.revision, 2); assert.equal(cells.get(scope, first.cellId, 1).code, "print(2)");
	assert.equal(cells.readRun(scope, task.taskId).cell.code, "print(2)");
	assert.deepEqual(cells.bindRunFromTrustedAdmission(scope, { cellId: first.cellId, expectedCellRevision: 1, taskId: task.taskId }), frozen);
	assert.throws(() => cells.bindRunFromTrustedAdmission(scope, { cellId: first.cellId, expectedCellRevision: 2, taskId: task.taskId }), /does not match/);
	assert.throws(() => cells.save(scope, { cellId: first.cellId, expectedCellRevision: 1, draft }), /changed/);
	assert.throws(() => cells.get({ projectId: "foreign", sessionId: "s-foreign", expectedPhaseRevision: 1 }, first.cellId), /not found/);
	for (const name of ["../secret", "C:secret", "NUL.txt"]) assert.throws(() => cells.save(scope, { draft: { ...draft, inputs: [{ ...draft.inputs[0], name }] } }), /portable filenames/);
	assert.throws(() => cells.save(scope, { draft: { ...draft, inputs: [{ ...draft.inputs[0], sourceHash: contentHash("stale") }] } }), /current registered/);
	for (const value of [NaN, Infinity, undefined, new Date(), new Map(), () => 1]) assert.throws(() => cells.save(scope, { draft: { ...draft, parameters: { value } } }), /JSON/);
	db.exec("BEGIN IMMEDIATE"); const rollback = cells.save(scope, { draft }); db.exec("ROLLBACK");
	assert.throws(() => cells.get(scope, rollback.cellId), /not found/);
	const extra = cells.save(scope, { draft: { ...draft, contentHash: "untrusted", revision: 999 } });
	assert.equal(cells.get(scope, extra.cellId).revision, 1);
	const wrongLanguage = host.reserveStudyTask(scope, { dispatchKey: "wrong-language", kind: "execution", manifest, producerContextId,
		admission: { purpose: draft.purpose, language: "r", maxWallSeconds: 20, maxMemoryMiB: 256 } }).task;
	assert.throws(() => cells.bindRunFromTrustedAdmission(scope, { cellId: first.cellId, expectedCellRevision: 1, taskId: wrongLanguage.taskId }), /language and purpose/);
	const newTask = host.reserveStudyTask(scope, { dispatchKey: "not-bound-before-update", kind: "execution", manifest, producerContextId,
		admission: { purpose: draft.purpose, language: "python", maxWallSeconds: 20, maxMemoryMiB: 256 } }).task;
	const proposal = host.proposeSourceUpdate(scope, { sourceId: source.sourceId, candidate: { sourceRoot: source.sourceRoot, relativePath: source.relativePath,
		kind: "text", sourceRole: "reference", diagnostics: [], parser: "fixture", contentHash: contentHash("2,3,4"), chunks: [{ ordinal: 1, locator: '{"line":1}', text: "2,3,4" }] },
		knowledge: { nodes: [], notes: [], relations: [] }, changeSummary: "Input data updated", expectedProjectRevision: host.projectRevision(scope).revision });
	host.acceptSourceUpdate(scope, proposal.proposalId, host.projectRevision(scope).revision);
	assert.deepEqual(cells.bindRunFromTrustedAdmission(scope, { cellId: first.cellId, expectedCellRevision: 1, taskId: task.taskId }), frozen);
	assert.throws(() => cells.bindRunFromTrustedAdmission(scope, { cellId: first.cellId, expectedCellRevision: 1, taskId: newTask.taskId }), /current registered/);
	const phase = host.setPhase(scope, "research");
	assert.equal(cells.get({ ...scope, expectedPhaseRevision: phase.revision }, first.cellId).revision, 2);
	assert.throws(() => cells.get(scope, first.cellId), /phase changed/);
	db.prepare("UPDATE pi_study_code_cell SET payload = ? WHERE cell_id = ? AND revision = 2").run(JSON.stringify({ ...second, code: "tampered" }), first.cellId);
	assert.throws(() => cells.get({ ...scope, expectedPhaseRevision: phase.revision }, first.cellId), /integrity/);
});
