import type { StudyExecutionRun } from "./study-execution-service";

export const EXECUTION_NOTICE_THRESHOLD = 0.8;
export const MAX_EXECUTION_NOTICE_HISTORY = 64;

type ExecutionUsage = { wallTimeMs: number; diskBytes: number };

export type ExecutionNoticeEvent = "completion" | "failure" | "cancel" | "limit" | "needs-input" | "limit-warning";

export interface StudyExecutionNotice {
	key: string;
	queueJobId: string;
	event: ExecutionNoticeEvent;
	message: string;
	observedAt: string;
	evidence: string;
}

export interface ExecutionLimitWarning {
	message: string;
	thresholds: readonly ("wall-time" | "output")[];
	evidence: string;
}

export interface ExecutionNoticeCollection {
	added: StudyExecutionNotice[];
	announcements: StudyExecutionNotice[];
	seenKeys: ReadonlySet<string>;
}

export function executionUsage(run: Pick<StudyExecutionRun, "result">): ExecutionUsage | null {
	return run.result?.usage ?? null;
}

function formatDuration(milliseconds: number): string {
	return `${(milliseconds / 1_000).toFixed(2)} 秒`;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MiB`;
	return `${bytes} 字节`;
}

function thresholdNames(run: StudyExecutionRun, usage: ExecutionUsage): Array<"wall-time" | "output"> {
	if (run.status !== "running") return [];
	const thresholds: Array<"wall-time" | "output"> = [];
	if (usage.wallTimeMs >= run.resources.wallTimeMs * EXECUTION_NOTICE_THRESHOLD) thresholds.push("wall-time");
	if (usage.diskBytes >= run.resources.diskBytes * EXECUTION_NOTICE_THRESHOLD) thresholds.push("output");
	return thresholds;
}

export function executionLimitWarning(run: StudyExecutionRun): ExecutionLimitWarning | null {
	const usage = executionUsage(run);
	if (!usage) return null;
	const thresholds = thresholdNames(run, usage);
	if (thresholds.length === 0) return null;
	const details: string[] = [];
	if (thresholds.includes("wall-time")) {
		details.push(`运行时间 ${formatDuration(usage.wallTimeMs)} / ${formatDuration(run.resources.wallTimeMs)}`);
	}
	if (thresholds.includes("output")) {
		details.push(`已观测输出 ${formatBytes(usage.diskBytes)} / ${formatBytes(run.resources.diskBytes)}`);
	}
	return {
		message: `接近资源限制：${details.join("；")}。达到限制后本次运行会停止；不会自动提高配额。`,
		thresholds,
		evidence: thresholds.join(","),
	};
}

function terminalEvent(status: StudyExecutionRun["status"]): Exclude<ExecutionNoticeEvent, "limit-warning"> | null {
	if (status === "succeeded") return "completion";
	if (status === "failed") return "failure";
	if (status === "cancelled") return "cancel";
	if (status === "limit-reached") return "limit";
	if (status === "needs-input") return "needs-input";
	return null;
}

function observedAt(run: StudyExecutionRun): string {
	return run.result?.observedAt ?? run.updatedAt;
}

function terminalMessage(run: StudyExecutionRun, event: Exclude<ExecutionNoticeEvent, "limit-warning">): string {
	const label = `运行 r${run.cellRevision}`;
	if (event === "completion") return `${label} 已完成；已记录日志和输出文件。`;
	if (event === "needs-input") return `${label} 需要调整资源或配置后重新运行；这条记录仍保留。`;
	const detail = run.failure?.message ?? run.result?.logs.error ?? "后台没有提供进一步说明";
	if (event === "failure") return `${label} 失败：${detail}。已记录日志和已写入的输出文件仍保留，内容可能不完整。`;
	if (event === "cancel") return `${label} 已取消。已记录日志和已写入的输出文件仍保留，内容可能不完整。`;
	return `${label} 达到资源限制并停止。已记录日志和已写入的输出文件仍保留，内容可能不完整；不会自动提高配额。`;
}

function noticeKey(queueJobId: string, event: ExecutionNoticeEvent, evidence: string): string {
	return `${queueJobId}|${event}|${evidence}`;
}

function addNotice(
	added: StudyExecutionNotice[],
	seenKeys: Set<string>,
	queueJobId: string,
	event: ExecutionNoticeEvent,
	message: string,
	observed: string,
	evidence: string,
): void {
	const key = noticeKey(queueJobId, event, evidence);
	if (seenKeys.has(key)) return;
	seenKeys.add(key);
	added.push({ key, queueJobId, event, message, observedAt: observed, evidence });
}

export function collectExecutionNotices(
	previousRuns: readonly StudyExecutionRun[] | null,
	currentRuns: readonly StudyExecutionRun[],
	options: { initialized: boolean; seenKeys?: ReadonlySet<string> },
): ExecutionNoticeCollection {
	const previousById = new Map((previousRuns ?? []).map((run) => [run.queueJobId, run]));
	const seenKeys = new Set(options.seenKeys ?? []);
	const added: StudyExecutionNotice[] = [];
	for (const run of currentRuns) {
		const previous = previousById.get(run.queueJobId);
		const event = terminalEvent(run.status);
		if (event && (!previous || previous.status !== run.status)) {
			const observed = observedAt(run);
			addNotice(added, seenKeys, run.queueJobId, event, terminalMessage(run, event), observed, `status:${run.status};observed:${observed}`);
		}

		const warning = executionLimitWarning(run);
		if (!warning) continue;
		const previousThresholds = previous ? executionLimitWarning(previous)?.thresholds ?? [] : [];
		const crossed = warning.thresholds.filter((threshold) => !previousThresholds.includes(threshold));
		if (crossed.length > 0) {
			const observed = observedAt(run);
			addNotice(
				added,
				seenKeys,
				run.queueJobId,
				"limit-warning",
				warning.message,
				observed,
				`threshold:${crossed.join(",")};observed:${observed}`,
			);
		}
	}
	return { added, announcements: options.initialized ? added : [], seenKeys };
}

export function appendExecutionNoticeHistory(
	existing: readonly StudyExecutionNotice[],
	added: readonly StudyExecutionNotice[],
): StudyExecutionNotice[] {
	return [...existing, ...added].slice(-MAX_EXECUTION_NOTICE_HISTORY);
}
