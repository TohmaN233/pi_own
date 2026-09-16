import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const {
	MAX_STUDY_RESULT_FIELD_CHARS,
	compactStudyResearchResultsState,
	readStudyResultFieldFromState,
} = await createJiti(import.meta.url).import("./study-result-reading.ts");

function baseState(overrides = {}) {
	return {
		phase: "research",
		phaseRevision: 3,
		projectRevision: 8,
		project: { id: "project-1", title: "Bounded result test" },
		results: [],
		terminalRuns: [],
		theoryPlans: [],
		...overrides,
	};
}

function terminalRun({ taskId = "task-1", taskRevision = 4, stdout = "observed output", stderr = null, error = null, code = "print('ok')" } = {}) {
	return {
		kind: "terminal-run",
		taskId,
		taskRevision,
		terminalStatus: "succeeded",
		queueJobId: `queue-${taskId}`,
		planSnapshot: {
			planId: "plan-1",
			projectId: "project-1",
			revision: 2,
			kind: "theory",
			detail: { question: "Does the frozen calculation answer the question?", assumptions: [], propositions: [], proofSteps: [], counterexamples: [], openGaps: [] },
			sourceVersionHashes: [],
			semanticDigest: "digest-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		cell: { cellId: "cell-1", revision: 5, contentHash: "sha256:cell", title: "Frozen cell", purpose: "test", language: "python", code, parameters: { n: 1 }, inputs: [] },
		manifest: { codeHash: "sha256:code", parameterHash: "sha256:param", inputHashes: {}, environmentHash: "sha256:env" },
		output: { logs: { stdout, stderr, error }, status: "succeeded", usage: null, observedAt: "2026-01-01T00:00:00.000Z" },
		createdAt: "2026-01-01T00:00:00.000Z",
		changeNote: "bounded test",
		canCreateAnalysis: true,
	};
}

function result({ resultId = "result-1", revision = 2, projectId = "project-1", origin = terminalRun() } = {}) {
	return {
		resultId,
		projectId,
		taskId: origin.kind === "terminal-run" ? origin.taskId : null,
		revision,
		origin,
		classification: "inconclusive",
		summary: "A compact saved analysis.",
		limitations: ["This is a fixture."],
		claims: [],
		state: "draft",
		manifest: { codeHash: "sha256:code", parameterHash: "sha256:param", inputHashes: {}, environmentHash: "sha256:env" },
		confirmedAt: null,
		confirmedUserEventId: null,
		publishedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		contentHash: "sha256:result",
	};
}

function hasUnpairedSurrogate(value) {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

test("64 MiB stdout is read in bounded pages and the last chunk remains addressable", () => {
	const stdout = "x".repeat(64 * 1024 * 1024);
	const state = baseState({ terminalRuns: [terminalRun({ stdout })] });
	const first = readStudyResultFieldFromState(state, "project-1", {
		taskId: "task-1",
		expectedTaskRevision: 4,
		field: "stdout",
		textLimit: MAX_STUDY_RESULT_FIELD_CHARS,
	});
	assert.equal(first.available, true);
	assert.equal(first.total, stdout.length);
	assert.equal(first.content.length, MAX_STUDY_RESULT_FIELD_CHARS);
	assert.equal(first.nextOffset, MAX_STUDY_RESULT_FIELD_CHARS);
	assert.ok(JSON.stringify(first).length < 20_000, "the response must not echo the complete log");

	const last = readStudyResultFieldFromState(state, "project-1", {
		taskId: "task-1",
		expectedTaskRevision: 4,
		field: "stdout",
		textOffset: stdout.length - 123,
		textLimit: MAX_STUDY_RESULT_FIELD_CHARS,
		fieldHash: first.contentHash,
	});
	assert.equal(last.available, true);
	assert.equal(last.total, stdout.length);
	assert.equal(last.nextOffset, null);
	assert.equal(last.content.length, 123);
	assert.ok(JSON.stringify(last).length < 20_000);
});

test("foreign identity, stale revision, and stale field hash fail closed", () => {
	const foreign = result({ resultId: "foreign-result", projectId: "project-2" });
	const state = baseState({ terminalRuns: [terminalRun()], results: [foreign] });
	assert.throws(
		() => readStudyResultFieldFromState(state, "project-1", { resultId: "foreign-result", expectedResultRevision: 2, field: "analysis" }),
		/project|different|identity/u,
	);
	assert.throws(
		() => readStudyResultFieldFromState(state, "project-1", { taskId: "task-1", expectedTaskRevision: 3, field: "code" }),
		/revision/u,
	);
	assert.throws(
		() => readStudyResultFieldFromState(state, "project-1", { taskId: "task-1", expectedTaskRevision: 4, field: "stdout", fieldHash: "sha256:stale" }),
		/hash/u,
	);
});

test("a rebound project state is rejected before identity lookup", () => {
	const state = baseState({ project: { id: "project-2", title: "Rebound" }, terminalRuns: [terminalRun()] });
	assert.throws(
		() => readStudyResultFieldFromState(state, "project-1", { taskId: "task-1", expectedTaskRevision: 4, field: "code" }),
		/project changed/u,
	);
});

test("missing frozen fields are explicit and never fabricated", () => {
	const state = baseState({ terminalRuns: [terminalRun({ stderr: null })] });
	const read = readStudyResultFieldFromState(state, "project-1", {
		taskId: "task-1",
		expectedTaskRevision: 4,
		field: "stderr",
	});
	assert.equal(read.available, false);
	assert.equal(read.content, null);
	assert.equal(read.total, 0);
	assert.match(read.reason, /unavailable/u);
});

test("result identity reads frozen plan and compact analysis", () => {
	const state = baseState({ results: [result()] });
	const plan = readStudyResultFieldFromState(state, "project-1", {
		resultId: "result-1",
		expectedResultRevision: 2,
		field: "plan",
	});
	assert.equal(plan.available, true);
	assert.equal(plan.identity.resultId, "result-1");
	assert.equal(plan.identity.resultRevision, 2);
	assert.match(plan.content, /frozen calculation/u);
	const analysis = readStudyResultFieldFromState(state, "project-1", {
		resultId: "result-1",
		expectedResultRevision: 2,
		field: "analysis",
	});
	assert.equal(analysis.available, true);
	assert.match(analysis.content, /compact saved analysis/u);
});

test("unicode surrogate pairs are kept intact across pages", () => {
	const stdout = "A😀B😀C";
	const state = baseState({ terminalRuns: [terminalRun({ stdout })] });
	const pages = [];
	let textOffset = 0;
	let fieldHash;
	for (;;) {
		const page = readStudyResultFieldFromState(state, "project-1", {
			taskId: "task-1",
			expectedTaskRevision: 4,
			field: "stdout",
			textOffset,
			textLimit: 3,
			fieldHash,
		});
		assert.equal(hasUnpairedSurrogate(page.content), false);
		pages.push(page.content);
		fieldHash = page.contentHash;
		if (page.nextOffset === null) break;
		assert.ok(page.nextOffset > textOffset);
		textOffset = page.nextOffset;
	}
	assert.equal(pages.join(""), stdout);
});

test("model state is paged, compact, and read-only", () => {
	const huge = "VERY_LARGE_PAYLOAD".repeat(50_000);
	const runs = Array.from({ length: 6 }, (_, index) => terminalRun({ taskId: `task-${index}`, code: huge, stdout: huge }));
	const results = runs.map((origin, index) => result({ resultId: `result-${index}`, origin }));
	const theoryPlans = Array.from({ length: 6 }, (_, index) => ({
		planId: `theory-${index}`,
		projectId: "project-1",
		revision: 1,
		kind: "theory",
		detail: { question: huge, assumptions: [], propositions: [], proofSteps: [], counterexamples: [], openGaps: [] },
		sourceVersionHashes: [],
		semanticDigest: `digest-${index}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	}));
	const state = baseState({ results, terminalRuns: runs, theoryPlans });
	const compact = compactStudyResearchResultsState(state);
	assert.equal(compact.results.length, 5);
	assert.equal(compact.terminalRuns.length, 5);
	assert.equal(compact.theoryPlans.length, 5);
	assert.equal(compact.resultsNextOffset, 5);
	assert.equal(compact.terminalRunsNextOffset, 5);
	assert.equal(compact.theoryPlansNextOffset, 5);
	assert.equal(compact.results[0].origin, undefined);
	assert.equal(compact.terminalRuns[0].code, undefined);
	assert.ok(JSON.stringify(compact).length < 100_000, "model state must stay compact");
	assert.equal(state.terminalRuns[0].cell.code, huge, "compaction must not mutate frozen state");
	assert.equal(state.results[0].origin.cell.code, huge, "compaction must be read-only");
});

test("learning prompt source uses the bounded read_result capability and avoids payload interpolation", async () => {
	const source = await readFile(new URL("../components/study/StudyResearchResults.tsx", import.meta.url), "utf8");
	assert.match(source, /action=read_result/u);
	assert.match(source, /contentHash.*fieldHash/u);
	assert.match(source, /expectedTaskRevision/u);
	assert.match(source, /expectedResultRevision/u);
	assert.doesNotMatch(source, /冻结代码（\$\{run\.cell\.language\}）：\\n\$\{run\.cell\.code\}/u);
	assert.doesNotMatch(source, /实际 stdout：\\n\$\{logs\.stdout/u);
	assert.doesNotMatch(source, /分析摘要：\$\{result\.summary\}/u);
});
