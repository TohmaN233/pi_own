import assert from "node:assert/strict";
import test from "node:test";
import {
	appendExecutionNoticeHistory,
	collectExecutionNotices,
	executionLimitWarning,
	executionUsage,
	MAX_EXECUTION_NOTICE_HISTORY,
} from "./study-execution-notices.ts";

const usage = (wallTimeMs, diskBytes) => ({ wallTimeMs, diskBytes });
const result = (queueJobId, currentUsage, observedAt = "2026-09-12T00:00:00.000Z") => ({
	queueJobId,
	status: "running",
	usage: currentUsage,
	logs: { stdout: null, stderr: null, error: null },
	observedAt,
});
const run = (overrides = {}) => ({
	queueJobId: "job-1",
	taskId: "task-1",
	mode: "study",
	status: "running",
	resources: { cpuMilliCores: 1000, memoryMiB: 512, wallTimeMs: 10_000, diskBytes: 10_000 },
	actualUsage: null,
	createdAt: "2026-09-12T00:00:00.000Z",
	updatedAt: "2026-09-12T00:00:01.000Z",
	cancellationRequestedAt: null,
	failure: null,
	cellId: "cell-1",
	cellRevision: 1,
	title: "Example",
	language: "python",
	result: result("job-1", usage(0, 0)),
	...overrides,
});

test("only persisted native usage drives progress and warning excludes non-running time", () => {
	const live = run({ actualUsage: usage(1_000, 2_000), result: result("job-1", usage(8_000, 1_000)) });
	assert.deepEqual(executionUsage(live), usage(8_000, 1_000));
  assert.match(executionLimitWarning(live)?.message ?? "", /接近资源限制/);
  assert.match(executionLimitWarning(live)?.message ?? "", /运行时间 8\.00 秒 \/ 10\.00 秒/);
  const unobserved = run({ actualUsage: usage(9_000, 9_000), result: null });
  assert.equal(executionUsage(unobserved), null);
  assert.equal(executionLimitWarning(unobserved), null);
  assert.doesNotMatch(executionLimitWarning(live)?.message ?? "", /内存/);

	for (const status of ["queued", "admitted", "prepared", "launching", "reconciling"]) {
		assert.equal(executionLimitWarning(run({ status, result: result("job-1", usage(9_000, 9_000)) })), null, status);
	}
});

test("warning begins at either 80 percent resource boundary and combines only measured running usage", () => {
	const wall = executionLimitWarning(run({ result: result("job-1", usage(8_000, 1_000)) }));
	assert.deepEqual(wall?.thresholds, ["wall-time"]);
	const output = executionLimitWarning(run({ result: result("job-1", usage(1_000, 8_000)) }));
	assert.deepEqual(output?.thresholds, ["output"]);
	const both = executionLimitWarning(run({ result: result("job-1", usage(8_000, 8_000)) }));
	assert.deepEqual(both?.thresholds, ["wall-time", "output"]);
	assert.match(both?.message ?? "", /运行时间/);
	assert.match(both?.message ?? "", /输出/);
});

test("initial history is visible without live announcements; transitions and threshold crossings are deduplicated", () => {
	const completed = run({ status: "succeeded", result: { ...result("job-1", usage(10_000, 2_000)), status: "succeeded" } });
	const initial = collectExecutionNotices(null, [completed], { initialized: false });
	assert.equal(initial.added.length, 1);
	assert.equal(initial.announcements.length, 0);

	const started = run({ result: result("job-1", usage(7_900, 1_000), "2026-09-12T00:00:02.000Z") });
	const crossed = run({ result: result("job-1", usage(8_000, 1_000), "2026-09-12T00:00:03.000Z") });
	const threshold = collectExecutionNotices([started], [crossed], { initialized: true, seenKeys: initial.seenKeys });
	assert.equal(threshold.added.length, 1);
	assert.equal(threshold.announcements[0].event, "limit-warning");

	const unchanged = collectExecutionNotices([crossed], [run({ result: result("job-1", usage(8_500, 1_000), "2026-09-12T00:00:04.000Z") })], { initialized: true, seenKeys: threshold.seenKeys });
	assert.equal(unchanged.added.length, 0, "an unchanged threshold does not toast on every poll");

	const finished = run({ status: "failed", failure: { code: "EXECUTION_FAILED", message: "Example failed" }, result: { ...result("job-1", usage(9_000, 1_000), "2026-09-12T00:00:05.000Z"), status: "failed", logs: { stdout: "partial", stderr: null, error: null } } });
	const terminal = collectExecutionNotices([crossed], [finished], { initialized: true, seenKeys: unchanged.seenKeys });
	assert.equal(terminal.added.length, 1);
	assert.equal(terminal.announcements[0].event, "failure");
	const repeated = collectExecutionNotices([finished], [finished], { initialized: true, seenKeys: terminal.seenKeys });
	assert.equal(repeated.added.length, 0);
});

test("notice history stays bounded for a long lived shared provider view", () => {
	const notices = Array.from({ length: MAX_EXECUTION_NOTICE_HISTORY + 11 }, (_, index) => ({
		key: `job-${index}|completion|status:succeeded`,
		queueJobId: `job-${index}`,
		event: "completion",
		message: `运行 r${index} 已完成`,
		observedAt: "2026-09-12T00:00:00.000Z",
		evidence: "status:succeeded",
	}));
	const bounded = appendExecutionNoticeHistory([], notices);
	assert.equal(bounded.length, MAX_EXECUTION_NOTICE_HISTORY);
	assert.equal(bounded[0].queueJobId, "job-11");
});
