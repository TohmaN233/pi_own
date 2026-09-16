"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResearchResult } from "../../../../packages/study-research-host/src/index.ts";
import type { studyResearchResultsState } from "@/lib/study-results-service";
import { StudyArtifactReview } from "@/components/study/StudyVisualReview";
import type { StudyReviewSourceSelection } from "@/lib/study-review-service";
import styles from "@/app/study/Study.module.css";

type ResultsState = Awaited<ReturnType<typeof studyResearchResultsState>>;

export type StudyResearchLearnRequest = {
	prompt: string;
	resultId?: string;
	taskId?: string;
};

type Props = {
	sessionId: string;
	phase: "study" | "research";
	phaseRevision: number;
	projectRevision: number;
	sources: Array<StudyReviewSourceSelection & {label:string}>;
	onChanged: () => void;
	/** Parent dispatches this original foreground Pi prompt without switching Study/Research or starting an assessment. */
	onLearn: (request: StudyResearchLearnRequest) => void;
};

type Editor =
	| { kind: "edit"; result: ResearchResult }
	| { kind: "terminal-run"; taskId: string; taskRevision: number; label: string }
	| { kind: "theory-plan"; planId: string; planRevision: number; label: string };

type Draft = {
	classification: "positive" | "negative" | "inconclusive";
	summary: string;
	limitations: string;
	claims: string;
};

const emptyDraft = (): Draft => ({ classification: "inconclusive", summary: "", limitations: "", claims: "" });
const lines = (value: string) => value.split("\n").map((entry) => entry.trim()).filter(Boolean);
const terminalLabel: Record<string, string> = { succeeded: "完成", failed: "失败", cancelled: "已取消", "limit-reached": "到达限制" };

function draftFromResult(result: ResearchResult): Draft {
	return {
		classification: result.classification,
		summary: result.summary,
		limitations: result.limitations.join("\n"),
		claims: result.claims.join("\n"),
	};
}

function responseError(value: unknown, fallback: string): string {
	return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
		? value.error
		: fallback;
}

async function responseJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try { return JSON.parse(text) as unknown; } catch { return text; }
}

export function runLearnPrompt(run: ResultsState["terminalRuns"][number]): string {
	return [
		"请只帮助我理解这次已经结束的实验。不要切换 Study/Research 阶段，不要出题、考试或创建新运行。",
		`冻结实验身份：taskId=${JSON.stringify(run.taskId)}，expectedTaskRevision=${run.taskRevision}，终态=${run.terminalStatus}，代码语言=${run.cell.language}，计划revision=${run.planSnapshot.revision}。进程结束不等于科学结论已确认。`,
		"请按需调用现有 study_paper 工具的 action=read_result，使用上述 taskId 和 expectedTaskRevision，分别读取 field=plan、code、parameters、stdout、stderr、error 或 analysis。首次 textOffset=0；把返回的 contentHash 作为后续 fieldHash，以 textOffset=nextOffset 和同一 fieldHash 继续，每次 textLimit 不超过 8000。",
		"只依据这些冻结字段解释已观察内容、推导、限制和仍需独立审查的部分；字段缺失要明确说明。",
	].join("\n\n");
}

export function resultLearnPrompt(result: ResearchResult): string {
	const originIdentity = result.origin.kind === "terminal-run"
		? `origin=terminal-run，taskId=${JSON.stringify(result.origin.taskId)}，expectedTaskRevision=${result.origin.taskRevision}`
		: result.origin.kind === "theory-plan"
			? `origin=theory-plan，planId=${JSON.stringify(result.origin.planSnapshot.planId)}，planRevision=${result.origin.planSnapshot.revision}`
			: `origin=legacy-execution，taskId=${JSON.stringify(result.origin.taskId)}`;
	return [
		"请只帮助我理解这个冻结研究结果。不要切换 Study/Research 阶段，不要出题、考试或创建新运行。",
		`冻结结果身份：resultId=${JSON.stringify(result.resultId)}，expectedResultRevision=${result.revision}，${originIdentity}。这不是正式确认。`,
		"请按需调用现有 study_paper 工具的 action=read_result，使用 resultId 和 expectedResultRevision，分别读取 field=analysis、plan、code、parameters、stdout、stderr 或 error（不可用字段要如实说明）。首次 textOffset=0；把返回的 contentHash 作为后续 fieldHash，以 textOffset=nextOffset 和同一 fieldHash 继续，每次 textLimit 不超过 8000。",
		"区分已观察内容、推导、限制和仍需独立审查的部分。",
	].join("\n\n");
}

export function StudyResearchResults({ sessionId, phase, phaseRevision, projectRevision, sources, onChanged, onLearn }: Props) {
	const [state, setState] = useState<ResultsState | null>(null);
	const [editor, setEditor] = useState<Editor | null>(null);
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await fetch(`/api/study-research/results?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
		const value = await responseJson(response);
		if (!response.ok) throw new Error(responseError(value, "无法读取研究结果"));
		setState(value as ResultsState);
	}, [sessionId]);

	useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [load, phaseRevision, projectRevision]);

	const displayedPhase = state?.phase ?? phase;
	const canMutate = displayedPhase === "research";
	const currentPhaseRevision = state?.phaseRevision ?? phaseRevision;
	const currentProjectRevision = state?.projectRevision ?? projectRevision;
	const resultTaskIds = useMemo(
		() => new Set(state?.results.flatMap((result) => result.origin.kind === "terminal-run" ? [result.origin.taskId] : [])),
		[state],
	);
	const resultTheoryKeys = useMemo(
		() => new Set(state?.results.flatMap((result) => result.origin.kind === "theory-plan" ? [`${result.origin.planSnapshot.planId}:${result.origin.planSnapshot.revision}`] : [])),
		[state],
	);

	const post = useCallback(async (body: Record<string, unknown>) => {
		setBusy(true); setError(null); setNotice(null);
		try {
			const response = await fetch("/api/study-research/results", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, expectedPhaseRevision: currentPhaseRevision, ...body }),
			});
			const value = await responseJson(response);
			if (!response.ok) throw new Error(responseError(value, "研究结果操作未完成"));
			await load(); onChanged();
			return value;
		} finally { setBusy(false); }
	}, [currentPhaseRevision, load, onChanged, sessionId]);

	const beginEditor = (next: Editor) => {
		setEditor(next); setDraft(next.kind === "edit" ? draftFromResult(next.result) : emptyDraft()); setError(null); setNotice(null);
	};

	const save = async () => {
		if (!editor) return;
		const payload = {
			action: "save-analysis",
			expectedProjectRevision: currentProjectRevision,
			draft: { classification: draft.classification, summary: draft.summary, limitations: lines(draft.limitations), claims: lines(draft.claims) },
			...(editor.kind === "edit" ? { resultId: editor.result.resultId, expectedResultRevision: editor.result.revision }
				: editor.kind === "terminal-run" ? { originKind: "terminal-run", taskId: editor.taskId, expectedTaskRevision: editor.taskRevision }
				: { originKind: "theory-plan", planId: editor.planId, expectedPlanRevision: editor.planRevision }),
		};
		await post(payload); setEditor(null); setNotice("分析草稿已保存；程序终态和草稿都不是正式确认。");
	};

	return <section className={styles.section} id="research-results" tabIndex={-1}>
		<div className={styles.sectionHeader}><div><h3>Research 结果与分析</h3><p>每个条目保留冻结的 TheoryPlan，或终态运行的代码和输出。失败、取消和到限运行也会进入学习记录；程序完成不能确认结论。</p></div><span className={styles.statusBadge}>{state?.results.length ?? 0} 份分析</span></div>
		{displayedPhase === "study" && <p className={styles.severityWarning}>当前为 Study。历史结果和“理解本次实验”可用；创建、编辑和正式确认必须显式切换到 Research。</p>}
		{error && <p className={styles.severityError} role="alert">{error}</p>}
		{notice && <p className={styles.notice} role="status">{notice}</p>}
		{state && state.terminalRuns.length > 0 && <details className={styles.form}><summary>分别导出实验目录</summary><ul>{state.terminalRuns.map((run) => <li key={run.taskId}>
			<a href={`/api/study-research/export?sessionId=${encodeURIComponent(sessionId)}&format=project&queueJobId=${encodeURIComponent(run.queueJobId)}`} download="study-project.zip">{run.cell.title} · {terminalLabel[run.terminalStatus] ?? run.terminalStatus}</a>
		</li>)}</ul></details>}

		<div className={styles.form}><h4>自动学习条目：终态 Research 运行</h4>{!state ? <p className={styles.dim}>正在读取终态运行…</p> : state.terminalRuns.length === 0 ? <p className={styles.dim}>尚无终态 Research 运行。</p> : <ul className={styles.noteList}>{state.terminalRuns.map((run) => <li className={styles.note} key={run.taskId}><div className={styles.row}><strong>{terminalLabel[run.terminalStatus] ?? run.terminalStatus} · {run.cell.title} r{run.cell.revision}</strong><div><button className={styles.button} type="button" onClick={() => onLearn({ taskId: run.taskId, prompt: runLearnPrompt(run) })}>理解本次实验</button>{run.canCreateAnalysis && !resultTaskIds.has(run.taskId) && <button className={styles.buttonPrimary} type="button" disabled={!canMutate || busy} onClick={() => beginEditor({ kind: "terminal-run", taskId: run.taskId, taskRevision: run.taskRevision, label: `${run.cell.title} · ${run.terminalStatus}` })}>创建分析草稿</button>}</div></div><p className={styles.dim}>计划 r{run.planSnapshot.revision} · {new Date(run.createdAt).toLocaleString()} · {run.changeNote}{!run.canCreateAnalysis ? " · 其他对话的运行，仅可查看和理解" : ""}</p><details><summary>冻结代码与实际输出</summary><pre className={styles.codeBlock}>{run.cell.code}</pre>{run.output?.logs.stdout && <pre className={styles.codeBlock}>{run.output.logs.stdout}</pre>}{run.output?.logs.stderr && <pre className={styles.codeBlock}>{run.output.logs.stderr}</pre>}{run.output?.logs.error && <pre className={styles.codeBlock}>{run.output.logs.error}</pre>}</details></li>)}</ul>}</div>

		<div className={styles.form}><h4>TheoryPlan 分析入口</h4>{!state ? <p className={styles.dim}>正在读取理论计划…</p> : state.theoryPlans.length === 0 ? <p className={styles.dim}>尚无 TheoryPlan。</p> : <ul className={styles.noteList}>{state.theoryPlans.map((plan) => <li className={styles.note} key={plan.planId}><div className={styles.row}><strong>TheoryPlan r{plan.revision}</strong>{!resultTheoryKeys.has(`${plan.planId}:${plan.revision}`) && <button className={styles.buttonPrimary} type="button" disabled={!canMutate || busy} onClick={() => beginEditor({ kind: "theory-plan", planId: plan.planId, planRevision: plan.revision, label: `TheoryPlan r${plan.revision}` })}>创建理论分析草稿</button>}</div><p>{plan.detail.question}</p><details><summary>冻结理论内容</summary><pre className={styles.planDetail}>{JSON.stringify(plan.detail, null, 2)}</pre></details></li>)}</ul>}</div>

		{editor && <div className={styles.form}><div className={styles.row}><h4>{editor.kind === "edit" ? `编辑分析 r${editor.result.revision}` : `分析草稿：${editor.label}`}</h4><button className={styles.button} type="button" disabled={busy} onClick={() => setEditor(null)}>取消</button></div><label className={styles.field}><span>判断</span><select value={draft.classification} onChange={(event) => setDraft({ ...draft, classification: event.target.value as Draft["classification"] })} disabled={busy}><option value="positive">支持/正向</option><option value="negative">不支持/负向</option><option value="inconclusive">不确定</option></select></label><label className={styles.field}><span>分析摘要</span><textarea rows={4} maxLength={200000} value={draft.summary} disabled={busy} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label><label className={styles.field}><span>限制（每行一项）</span><textarea rows={4} maxLength={200000} value={draft.limitations} disabled={busy} onChange={(event) => setDraft({ ...draft, limitations: event.target.value })} /></label><label className={styles.field}><span>明确主张（每行一项）</span><textarea rows={4} maxLength={200000} value={draft.claims} disabled={busy} onChange={(event) => setDraft({ ...draft, claims: event.target.value })} /></label><p className={styles.dim}>正式确认还需要针对本版本的独立审查通过、没有失败或未解决审查，并由浏览器用户显式确认。数值检查或进程完成本身不能代替这些条件。</p><button className={styles.buttonPrimary} type="button" disabled={!canMutate || busy} onClick={() => void save().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))}>保存分析草稿</button></div>}

		<div className={styles.form}><h4>已保存分析</h4>{!state ? <p className={styles.dim}>正在读取…</p> : state.results.length === 0 ? <p className={styles.dim}>尚未保存分析草稿。</p> : <ul className={styles.noteList}>{state.results.map((result) => <li className={styles.note} key={result.resultId}><div className={styles.row}><strong>{result.state === "confirmed" ? "已正式确认" : "草稿"} · {result.classification} · r{result.revision}</strong><div><button className={styles.button} type="button" onClick={() => onLearn({ resultId: result.resultId, prompt: resultLearnPrompt(result) })}>理解此结果</button>{result.state === "draft" && <button className={styles.button} type="button" disabled={!canMutate || busy} onClick={() => beginEditor({ kind: "edit", result })}>编辑</button>}{result.state === "draft" && <button className={styles.buttonPrimary} type="button" disabled={!canMutate || busy} onClick={() => void post({ action: "confirm", resultId: result.resultId, expectedResultRevision: result.revision }).then(() => setNotice("已记录你的正式确认。"), (reason) => setError(reason instanceof Error ? reason.message : String(reason)))}>正式确认</button>}</div></div><p>{result.summary}</p><p className={styles.dim}>主张：{result.claims.join("；") || "尚未写入"}</p><p className={styles.dim}>限制：{result.limitations.join("；") || "尚未写入"}</p><details><summary>冻结来源</summary><pre className={styles.planDetail}>{JSON.stringify(result.origin, null, 2)}</pre></details></li>)}</ul>}</div>
		{state?.results.map((result) => <details key={`review:${result.resultId}:${result.contentHash}`} className={styles.form}>
			<summary>独立审查：{result.summary.slice(0, 100)} · r{result.revision}</summary>
			<StudyArtifactReview sessionId={sessionId} phaseRevision={currentPhaseRevision}
				target={{ kind: "result", id: result.resultId, revision: result.revision, contentHash: result.contentHash }} sources={sources} />
		</details>)}
	</section>;
}
