"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResearchPlan, ResearchPlanInput, SourceVersion } from "../../../../packages/study-research-host/src/index.ts";
import type { StudyCodeCell } from "../../../../packages/study-execution-host/src/code-cells.ts";
import type { ExecutionResourceRequest } from "../../../../packages/study-execution-host/src/execution-queue.ts";
import type { ResearchExecutionState } from "@/lib/research-execution-service";
import styles from "@/app/study/Study.module.css";

type Props = {
	sessionId: string;
	phase: "study" | "research";
	phaseRevision: number;
	projectRevision: number;
	plans: ResearchPlan[];
	sources: SourceVersion[];
	cells: StudyCodeCell[];
	onChanged: () => void;
};

type PlanKind = ResearchPlan["kind"];

type PlanDraft = {
	kind: PlanKind;
	question: string;
	assumptions: string;
	propositions: string;
	proofSteps: string;
	counterexamples: string;
	openGaps: string;
	method: string;
	evaluation: string;
	allowedChanges: string;
	hypotheses: string;
	datasetVersion: string;
	splitProtocol: string;
	primaryMetrics: string;
	stoppingConditions: string;
	direction: string;
	sourceIds: string[];
};

const emptyDraft = (kind: PlanKind = "theory"): PlanDraft => ({
	kind, question: "", assumptions: "", propositions: "", proofSteps: "", counterexamples: "", openGaps: "",
	method: "", evaluation: "", allowedChanges: "", hypotheses: "", datasetVersion: "", splitProtocol: "",
	primaryMetrics: "", stoppingConditions: "", direction: "", sourceIds: [],
});

const terminal = (status: string) => ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(status);
const splitLines = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);
const planLabels: Record<PlanKind, string> = { theory: "理论", smoke: "Smoke 小演示", formal: "正式实验", exploration: "自由探索" };
const statusLabels: Record<string, string> = { queued: "排队中", admitted: "已准入", prepared: "已准备", launching: "启动中", running: "运行中", reconciling: "核对中", succeeded: "已完成", failed: "失败", cancelled: "已取消", "limit-reached": "到达限制", "needs-input": "需要调整" };

function readable(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

async function responseJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try { return JSON.parse(text) as unknown; } catch { return text; }
}

function responseError(value: unknown, fallback: string): string {
	return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
}

function toPlan(draft: PlanDraft, sources: SourceVersion[]): ResearchPlanInput {
	const references = draft.sourceIds.map((sourceId) => {
		const source = sources.find((candidate) => candidate.sourceId === sourceId && candidate.current);
		if (!source) throw new Error("Selected source is no longer current; reload before saving the plan");
		return { sourceId: source.sourceId, contentHash: source.contentHash };
	});
	const detail = draft.kind === "theory"
		? { question: draft.question.trim(), assumptions: splitLines(draft.assumptions), propositions: splitLines(draft.propositions), proofSteps: splitLines(draft.proofSteps), counterexamples: splitLines(draft.counterexamples), openGaps: splitLines(draft.openGaps) }
		: draft.kind === "smoke"
			? { question: draft.question.trim(), method: draft.method.trim(), evaluation: draft.evaluation.trim(), allowedChanges: splitLines(draft.allowedChanges) }
			: draft.kind === "formal"
				? { question: draft.question.trim(), hypotheses: splitLines(draft.hypotheses), datasetVersion: draft.datasetVersion.trim(), splitProtocol: draft.splitProtocol.trim(), primaryMetrics: splitLines(draft.primaryMetrics), method: draft.method.trim(), stoppingConditions: splitLines(draft.stoppingConditions) }
				: { question: draft.question.trim(), direction: draft.direction.trim(), allowedChanges: splitLines(draft.allowedChanges), stoppingConditions: splitLines(draft.stoppingConditions) };
	return { kind: draft.kind, detail, sourceVersionHashes: references.map((reference) => reference.contentHash), sourceReferences: references } as ResearchPlanInput;
}

function draftFromPlan(plan: ResearchPlan, sources: SourceVersion[]): PlanDraft {
	const detail: Record<string, unknown> = { ...plan.detail };
	const lines = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
	const sourceIds = (plan.sourceReferences ?? []).map((reference) => reference.sourceId).filter((id) => sources.some((source) => source.sourceId === id && source.current));
	return {
		...emptyDraft(plan.kind), kind: plan.kind, question: typeof detail.question === "string" ? detail.question : "",
		assumptions: lines(detail.assumptions), propositions: lines(detail.propositions), proofSteps: lines(detail.proofSteps), counterexamples: lines(detail.counterexamples), openGaps: lines(detail.openGaps),
		method: typeof detail.method === "string" ? detail.method : "", evaluation: typeof detail.evaluation === "string" ? detail.evaluation : "", allowedChanges: lines(detail.allowedChanges),
		hypotheses: lines(detail.hypotheses), datasetVersion: typeof detail.datasetVersion === "string" ? detail.datasetVersion : "", splitProtocol: typeof detail.splitProtocol === "string" ? detail.splitProtocol : "", primaryMetrics: lines(detail.primaryMetrics),
		stoppingConditions: lines(detail.stoppingConditions), direction: typeof detail.direction === "string" ? detail.direction : "", sourceIds,
	};
}

function localExpiry(hours = 4): string {
	const value = new Date(Date.now() + hours * 60 * 60 * 1000);
	value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
	return value.toISOString().slice(0, 16);
}

function sourceList(sources: SourceVersion[], selected: string[], setSelected: (value: string[]) => void) {
	return <fieldset className={styles.field}><legend>绑定当前来源版本（理论计划可不选）</legend>{sources.filter((source) => source.current).length === 0
		? <p className={styles.dim}>当前没有可绑定的来源版本。</p>
		: sources.filter((source) => source.current).map((source) => <label className={styles.checkbox} key={source.sourceId}><input type="checkbox" checked={selected.includes(source.sourceId)} onChange={(event) => setSelected(event.target.checked ? [...selected, source.sourceId] : selected.filter((id) => id !== source.sourceId))} />{source.relativePath}</label>)}</fieldset>;
}

function PlanFields({ draft, setDraft, sources }: { draft: PlanDraft; setDraft: (next: PlanDraft) => void; sources: SourceVersion[] }) {
	const set = (key: keyof PlanDraft, value: string | string[]) => setDraft({ ...draft, [key]: value });
	const text = (key: keyof PlanDraft, label: string, required = false) => <label className={styles.field}><span>{label}</span><textarea value={String(draft[key])} rows={3} required={required} maxLength={20000} onChange={(event) => set(key, event.target.value)} /></label>;
	return <>
		<label className={styles.field}><span>计划类型</span><select aria-label="计划类型" value={draft.kind} onChange={(event) => setDraft({ ...emptyDraft(event.target.value as PlanKind), sourceIds: draft.sourceIds })}><option value="theory">理论</option><option value="smoke">Smoke 小演示</option><option value="formal">正式实验</option><option value="exploration">自由探索</option></select></label>
		{text("question", "研究问题", true)}
		{draft.kind === "theory" && <>{text("assumptions", "假设（每行一项）")}{text("propositions", "命题（每行一项）")}{text("proofSteps", "证明步骤（每行一项）")}{text("counterexamples", "反例或边界（每行一项）")}{text("openGaps", "尚未解决的问题（每行一项）")}</>}
		{draft.kind === "smoke" && <>{text("method", "演示方法", true)}{text("evaluation", "观察或判据", true)}{text("allowedChanges", "允许尝试的改变（每行一项）")}</>}
		{draft.kind === "formal" && <>{text("hypotheses", "假设 / 假设检验（每行一项）", true)}{text("datasetVersion", "数据版本", true)}{text("splitProtocol", "划分协议", true)}{text("primaryMetrics", "主要指标（每行一项）", true)}{text("method", "关键方法", true)}{text("stoppingConditions", "停止条件（每行一项）", true)}</>}
		{draft.kind === "exploration" && <>{text("direction", "探索方向", true)}{text("allowedChanges", "约定范围内允许的改变（每行一项）", true)}{text("stoppingConditions", "停止条件（每行一项）", true)}</>}
		{sourceList(sources, draft.sourceIds, (sourceIds) => setDraft({ ...draft, sourceIds }))}
	</>;
}

export function StudyResearchPlans({ sessionId, phase, phaseRevision, projectRevision, plans, sources, cells, onChanged }: Props) {
	const [state, setState] = useState<ResearchExecutionState | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [editingPlan, setEditingPlan] = useState<ResearchPlan | null>(null);
	const [draft, setDraft] = useState<PlanDraft>(() => emptyDraft());
	const [scopePlanId, setScopePlanId] = useState("");
	const [scopeLanguages, setScopeLanguages] = useState<Array<"python" | "r">>(["python", "r"]);
	const [scopeSourceIds, setScopeSourceIds] = useState<string[]>([]);
	const [scopeResources, setScopeResources] = useState<ExecutionResourceRequest | null>(null);
	const [scopeRuns, setScopeRuns] = useState("5");
	const [cumulativeSeconds, setCumulativeSeconds] = useState<string | null>(null);
	const [cumulativeMiB, setCumulativeMiB] = useState<string | null>(null);
	const [scopeExpiry, setScopeExpiry] = useState(() => localExpiry());
	const [scopeBoundary, setScopeBoundary] = useState("仅修复实现缺陷或执行已批准的方案；改变科学假设、划分、指标或关键方法前必须修订计划并重新批准。");
	const [runPlanId, setRunPlanId] = useState("");
	const [runScopeId, setRunScopeId] = useState("");
	const [runCellId, setRunCellId] = useState("");
	const [runResources, setRunResources] = useState<ExecutionResourceRequest | null>(null);
	const [packages, setPackages] = useState("");
	const [changeNote, setChangeNote] = useState("首次执行当前冻结的代码版本。");
	const [promotionTaskId, setPromotionTaskId] = useState("");
	const [repairTaskId, setRepairTaskId] = useState("");
	const [repairCellId, setRepairCellId] = useState("");
	const [repairPlanId, setRepairPlanId] = useState("");
	const [repairReason, setRepairReason] = useState("");

	const refresh = useCallback(async () => {
		const response = await fetch(`/api/study-research/research?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
		const value = await responseJson(response);
		if (!response.ok) throw new Error(responseError(value, `Research 状态请求失败（HTTP ${response.status}）。`));
		setState(value as ResearchExecutionState);
	}, [sessionId]);

	useEffect(() => {
		let active = true;
		setLoading(true);
		void refresh().catch((reason) => { if (active) setError(readable(reason)); }).finally(() => { if (active) setLoading(false); });
		const timer = setInterval(() => { void refresh().catch((reason) => { if (active) setError(readable(reason)); }); }, 4000);
		return () => { active = false; clearInterval(timer); };
	}, [refresh]);

	const displayPlans = state?.plans ?? plans;
	const capacity = state?.capacity;
	const defaults = capacity?.defaults ?? null;
	const activePlan = displayPlans.find((plan) => plan.planId === runPlanId) ?? displayPlans[0] ?? null;
	const selectedCell = cells.find((cell) => cell.cellId === runCellId) ?? cells[0] ?? null;
	const currentScopes = (state?.scopes ?? []).filter((scope) => scope.usableInCurrentSession && scope.revokedAt === null && Date.parse(scope.expiresAt) > Date.now());
	const planScopes = activePlan ? currentScopes.filter((scope) => scope.planId === activePlan.planId && scope.planRevision === activePlan.revision) : [];
	const learningRuns = state?.learningRuns ?? [];
	const failedRuns = (state?.runs ?? []).filter((run) => run.job && ["failed", "cancelled", "limit-reached"].includes(run.job.status));

	useEffect(() => {
		if (!scopeResources && defaults) setScopeResources(defaults);
		if (!runResources && defaults) setRunResources(defaults);
	}, [defaults, runResources, scopeResources]);
	useEffect(() => { if (!scopePlanId && displayPlans[0]) setScopePlanId(displayPlans[0].planId); }, [displayPlans, scopePlanId]);
	useEffect(() => { if (!runPlanId && displayPlans[0]) setRunPlanId(displayPlans[0].planId); }, [displayPlans, runPlanId]);
	useEffect(() => { if (!runCellId && cells[0]) setRunCellId(cells[0].cellId); }, [cells, runCellId]);

	const post = useCallback(async (body: Record<string, unknown>) => {
		setBusy(true); setError(null); setNotice(null);
		try {
			const response = await fetch("/api/study-research/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, ...body }) });
			const value = await responseJson(response);
			if (!response.ok) throw new Error(responseError(value, `Research 操作失败（HTTP ${response.status}）。`));
			await refresh(); onChanged(); return value;
		} catch (reason) { setError(readable(reason)); throw reason; }
		finally { setBusy(false); }
	}, [onChanged, refresh, sessionId]);

	const submitRun = async (body: Record<string, unknown>) => {
		const storageKey = `study-research-pending-run:${sessionId}`;
		const intent = JSON.stringify(body);
		const saved = sessionStorage.getItem(storageKey);
		const previous: unknown = saved === null ? null : JSON.parse(saved);
		const requestId = previous && typeof previous === "object" && "intent" in previous && previous.intent === intent && "requestId" in previous && typeof previous.requestId === "string"
			? previous.requestId : crypto.randomUUID();
		sessionStorage.setItem(storageKey, JSON.stringify({ intent, requestId }));
		await post({ ...body, requestId });
		sessionStorage.removeItem(storageKey);
	};

	const fixedSources = useMemo(() => sources.filter((source) => source.current), [sources]);
	const scopePlan = displayPlans.find((plan) => plan.planId === scopePlanId) ?? null;
	const canMutate = phase === "research";
	const boundedScopeResources = scopeResources ?? defaults;
	const effectiveRunResources = runResources ?? defaults;
	const approvedCumulativeSeconds = cumulativeSeconds ?? String((boundedScopeResources?.wallTimeMs ?? 0) / 1000 * Number(scopeRuns));
	const approvedCumulativeMiB = cumulativeMiB ?? String((boundedScopeResources?.diskBytes ?? 0) / 1048576 * Number(scopeRuns));

	function setResource(setter: (value: ExecutionResourceRequest) => void, current: ExecutionResourceRequest | null, key: keyof ExecutionResourceRequest, value: number) {
		if (!current) return;
		setter({ ...current, [key]: value });
	}

	return <section className={styles.section} id="research-execution" tabIndex={-1}>
		<div className={styles.sectionHeader}><div><h3>Research 计划与执行范围</h3><p>计划、用户批准范围、代码快照和后台运行分开保存。运行完成只表示程序结束，不表示科学结论已确认。</p></div><span className={styles.statusBadge}>{displayPlans.length} 个计划</span></div>
		{phase === "study" && <p className={styles.severityWarning}>当前为 Study。历史、产物和取消操作仍可查看；创建或修改计划、批准范围、运行、提升和修复记录需要显式切换到 Research。</p>}
		{loading && <p className={styles.dim}>正在读取 Research 执行历史…</p>}
		{error && <p className={styles.severityError} role="alert">{error}</p>}
		{notice && <p className={styles.notice} role="status">{notice}</p>}

		<div className={styles.form}>
			<div className={styles.row}><h4>{editingPlan ? `修订 ${planLabels[editingPlan.kind]}计划 r${editingPlan.revision}` : "新建研究计划"}</h4><button className={styles.button} type="button" disabled={busy || !canMutate} onClick={() => { setEditingPlan(null); setDraft(emptyDraft()); }}>新建</button></div>
			<PlanFields draft={draft} setDraft={setDraft} sources={fixedSources} />
			<div className={styles.readerButtons}><button className={styles.buttonPrimary} type="button" disabled={busy || !canMutate} onClick={() => void (async () => {
				try {
					const action = editingPlan ? "revise-plan" : "create-plan";
					await post({ action, expectedPhaseRevision: phaseRevision, expectedProjectRevision: projectRevision, plan: toPlan(draft, fixedSources),
						...(editingPlan ? { planId: editingPlan.planId, expectedPlanRevision: editingPlan.revision } : {}) });
					setNotice(editingPlan ? "计划已修订；旧范围不会自动延续到新科学版本。" : "研究计划已创建；尚未获得执行范围批准。"); setEditingPlan(null); setDraft(emptyDraft());
				} catch (reason) { setError(readable(reason)); }
			})()}>{editingPlan ? "保存修订" : "创建计划"}</button>{editingPlan && <button className={styles.button} type="button" disabled={busy} onClick={() => { setEditingPlan(null); setDraft(emptyDraft()); }}>取消编辑</button>}</div>
		</div>

		{displayPlans.length > 0 && <div className={styles.planList}>{displayPlans.map((plan) => <article className={styles.planCard} key={plan.planId}><div className={styles.planHeader}><div><h4>{planLabels[plan.kind]} · r{plan.revision}</h4><p>{new Date(plan.updatedAt).toLocaleString()}</p></div><button className={styles.button} type="button" disabled={busy || !canMutate} onClick={() => { setEditingPlan(plan); setDraft(draftFromPlan(plan, fixedSources)); }}>编辑计划</button></div><div className={styles.planBody}><pre className={styles.planDetail}>{JSON.stringify(plan.detail, null, 2)}</pre><p className={styles.dim}>来源版本：{plan.sourceReferences?.length ?? 0} 个 · semantic digest 已绑定到批准范围。</p></div></article>)}</div>}

		<div className={styles.form}>
			<h4>用户批准执行范围</h4><p className={styles.formHint}>正式、探索和理论运行必须先由你批准范围。范围固定可用语言、来源输入、单次资源、累计次数/时间/输出和实现改动边界；不包含模型费用或 token 预算。</p>
			<label className={styles.field}><span>计划</span><select value={scopePlanId} onChange={(event) => setScopePlanId(event.target.value)} disabled={!canMutate}><option value="">选择计划…</option>{displayPlans.map((plan) => <option key={plan.planId} value={plan.planId}>{planLabels[plan.kind]} · r{plan.revision}</option>)}</select></label>
			<fieldset className={styles.field}><legend>允许语言</legend>{(["python", "r"] as const).map((language) => <label className={styles.checkbox} key={language}><input type="checkbox" checked={scopeLanguages.includes(language)} onChange={(event) => setScopeLanguages(event.target.checked ? [...scopeLanguages, language] : scopeLanguages.filter((item) => item !== language))} disabled={!canMutate} />{language === "python" ? "Python" : "R"}</label>)}</fieldset>
			{sourceList(fixedSources, scopeSourceIds, setScopeSourceIds)}
			{boundedScopeResources && capacity && <div className={styles.row}><label className={styles.field}>CPU 核数<input type="number" step="0.01" min={capacity.minimumCpuMilliCores / 1000} max={capacity.maximum.cpuMilliCores / 1000} value={boundedScopeResources.cpuMilliCores / 1000} disabled={!canMutate} onChange={(event) => setResource(setScopeResources, boundedScopeResources, "cpuMilliCores", Math.round(Number(event.target.value) * 1000))} /></label><label className={styles.field}>内存 MiB<input type="number" min={64} max={capacity.maximum.memoryMiB} value={boundedScopeResources.memoryMiB} disabled={!canMutate} onChange={(event) => setResource(setScopeResources, boundedScopeResources, "memoryMiB", Number(event.target.value))} /></label><label className={styles.field}>单次最长秒数<input type="number" min={1} max={capacity.maximum.wallTimeMs / 1000} value={boundedScopeResources.wallTimeMs / 1000} disabled={!canMutate} onChange={(event) => setResource(setScopeResources, boundedScopeResources, "wallTimeMs", Number(event.target.value) * 1000)} /></label><label className={styles.field}>单次输出 MiB<input type="number" min={1} max={capacity.maximum.diskBytes / 1048576} value={boundedScopeResources.diskBytes / 1048576} disabled={!canMutate} onChange={(event) => setResource(setScopeResources, boundedScopeResources, "diskBytes", Number(event.target.value) * 1048576)} /></label></div>}
			<div className={styles.row}><label className={styles.field}>最多运行次数<input type="number" min="1" max="10000" value={scopeRuns} disabled={!canMutate} onChange={(event) => setScopeRuns(event.target.value)} /></label><label className={styles.field}>到期时间<input type="datetime-local" value={scopeExpiry} disabled={!canMutate} onChange={(event) => setScopeExpiry(event.target.value)} /></label></div>
			<div className={styles.row}><label className={styles.field}>累计运行时间上限（秒）<input type="number" min="1" value={approvedCumulativeSeconds} disabled={!canMutate} onChange={(event) => setCumulativeSeconds(event.target.value)} /></label><label className={styles.field}>累计输出上限（MiB）<input type="number" min="1" value={approvedCumulativeMiB} disabled={!canMutate} onChange={(event) => setCumulativeMiB(event.target.value)} /></label></div><label className={styles.field}><span>实现改动边界</span><textarea value={scopeBoundary} rows={3} maxLength={6000} disabled={!canMutate} onChange={(event) => setScopeBoundary(event.target.value)} /></label>
			<div className={styles.readerButtons}><button className={styles.buttonPrimary} type="button" disabled={busy || !canMutate || !scopePlan || !boundedScopeResources || scopeLanguages.length === 0} onClick={() => void (async () => { try {
				if (!boundedScopeResources) throw new Error("本机资源限制尚未读取完成。");
				const expiresAt = new Date(scopeExpiry).toISOString(); const runs = Number(scopeRuns);
				await post({ action: "grant", expectedPhaseRevision: phaseRevision, planId: scopePlan?.planId, expectedPlanRevision: scopePlan?.revision, expiresAt, allowedLanguages: scopeLanguages,
					allowedInputs: scopeSourceIds.map((sourceId) => { const source = fixedSources.find((candidate) => candidate.sourceId === sourceId); if (!source) throw new Error("Selected source is no longer current"); return { sourceId: source.sourceId, sourceHash: source.contentHash }; }),
					maxResources: boundedScopeResources, quota: { maxRuns: runs, maxCumulativeWallTimeMs: Number(approvedCumulativeSeconds) * 1000, maxCumulativeDiskBytes: Number(approvedCumulativeMiB) * 1048576 }, changeBoundary: scopeBoundary });
				setNotice("范围已由当前浏览器用户事件批准。计划、来源或范围变化后需重新批准。");
			} catch (reason) { setError(readable(reason)); } })()}>批准此范围</button>{state?.capacityError && <span className={styles.severityWarning}>本机容量暂不可用：{state.capacityError}</span>}</div>
		</div>

		{(state?.scopes.length ?? 0) > 0 && <div className={styles.form}><h4>范围历史</h4><ul className={styles.noteList}>{state?.scopes.map((scope) => <li className={styles.note} key={scope.scopeId}><div className={styles.row}><strong>{scope.planId === activePlan?.planId ? "当前计划范围" : "已批准范围"} · {scope.revokedAt ? "已撤销" : Date.parse(scope.expiresAt) <= Date.now() ? "已到期" : "有效"}</strong>{scope.usableInCurrentSession && !scope.revokedAt && <button className={styles.button} type="button" disabled={busy} onClick={() => void post({ action: "revoke", scopeId: scope.scopeId }).then(() => setNotice("范围已撤销；未启动的运行将不能继续准入。"), (reason) => setError(readable(reason)))}>撤销范围</button>}</div><p className={styles.dim}>计划 r{scope.planRevision} · 语言 {scope.allowedLanguages.join(" / ")} · 最多 {scope.quota.maxRuns} 次 · 至 {new Date(scope.expiresAt).toLocaleString()}</p><p>{scope.changeBoundary}</p>{!scope.usableInCurrentSession && <p>其他对话的范围 · 仅查看</p>}<p>累计上限：{scope.quota.maxCumulativeWallTimeMs / 1000} 秒，{scope.quota.maxCumulativeDiskBytes / 1048576} MiB</p></li>)}</ul></div>}

		<div className={styles.form}>
			<h4>执行选定代码单元</h4><p className={styles.formHint}>每次运行冻结代码、参数、输入字节与环境。Smoke 可按计划走受限学习准入；其他类型必须选择有效的已批准范围。</p>
			<label className={styles.field}><span>计划</span><select value={runPlanId} disabled={!canMutate} onChange={(event) => { setRunPlanId(event.target.value); setRunScopeId(""); }}><option value="">选择计划…</option>{displayPlans.map((plan) => <option key={plan.planId} value={plan.planId}>{planLabels[plan.kind]} · r{plan.revision}</option>)}</select></label>
			<label className={styles.field}><span>代码单元</span><select value={runCellId} disabled={!canMutate} onChange={(event) => setRunCellId(event.target.value)}><option value="">选择代码单元…</option>{cells.map((cell) => <option key={cell.cellId} value={cell.cellId}>{cell.title} · {cell.language.toUpperCase()} r{cell.revision}</option>)}</select></label>
			{activePlan?.kind === "smoke" && <label className={styles.checkbox}><input type="checkbox" checked={!runScopeId} disabled={!canMutate} onChange={(event) => { if (event.target.checked) setRunScopeId(""); }} />使用 Smoke 的受限学习准入（不需要每次额外批准）</label>}
			<label className={styles.field}><span>已批准范围{activePlan?.kind === "smoke" ? "（Smoke 可留空）" : ""}</span><select value={runScopeId} disabled={!canMutate} onChange={(event) => setRunScopeId(event.target.value)}><option value="">{activePlan?.kind === "smoke" ? "使用 Smoke 学习准入" : "选择有效范围…"}</option>{planScopes.map((scope) => <option key={scope.scopeId} value={scope.scopeId}>至 {new Date(scope.expiresAt).toLocaleString()} · 最多 {scope.quota.maxRuns} 次</option>)}</select></label>
			{effectiveRunResources && capacity && <div className={styles.row}><label className={styles.field}>CPU 核数<input type="number" step="0.01" min={capacity.minimumCpuMilliCores / 1000} max={capacity.maximum.cpuMilliCores / 1000} value={effectiveRunResources.cpuMilliCores / 1000} disabled={!canMutate} onChange={(event) => setResource(setRunResources, effectiveRunResources, "cpuMilliCores", Math.round(Number(event.target.value) * 1000))} /></label><label className={styles.field}>内存 MiB<input type="number" min={64} max={capacity.maximum.memoryMiB} value={effectiveRunResources.memoryMiB} disabled={!canMutate} onChange={(event) => setResource(setRunResources, effectiveRunResources, "memoryMiB", Number(event.target.value))} /></label><label className={styles.field}>最长秒数<input type="number" min={1} max={capacity.maximum.wallTimeMs / 1000} value={effectiveRunResources.wallTimeMs / 1000} disabled={!canMutate} onChange={(event) => setResource(setRunResources, effectiveRunResources, "wallTimeMs", Number(event.target.value) * 1000)} /></label><label className={styles.field}>输出 MiB<input type="number" min={1} max={capacity.maximum.diskBytes / 1048576} value={effectiveRunResources.diskBytes / 1048576} disabled={!canMutate} onChange={(event) => setResource(setRunResources, effectiveRunResources, "diskBytes", Number(event.target.value) * 1048576)} /></label></div>}
			{selectedCell?.language === "r" && <label className={styles.field}><span>额外 R 包（逗号分隔）</span><input value={packages} disabled={!canMutate} onChange={(event) => setPackages(event.target.value)} placeholder="例如 ggplot2, dplyr" /></label>}
			<label className={styles.field}><span>本次实现/修复说明</span><textarea value={changeNote} rows={3} maxLength={6000} disabled={!canMutate} onChange={(event) => setChangeNote(event.target.value)} /></label>
			<div className={styles.readerButtons}><button className={styles.buttonPrimary} type="button" disabled={busy || !canMutate || !activePlan || !selectedCell || !effectiveRunResources || (!runScopeId && activePlan.kind !== "smoke")} onClick={() => void (async () => { try {
				await submitRun({ action: "run", expectedPhaseRevision: phaseRevision, cellId: selectedCell?.cellId, expectedCellRevision: selectedCell?.revision, resources: effectiveRunResources, rPackages: selectedCell?.language === "r" ? splitLines(packages.replaceAll(",", "\n")) : [], planId: activePlan?.planId, expectedPlanRevision: activePlan?.revision, ...(runScopeId ? { scopeId: runScopeId } : {}), changeNote });
				setNotice("运行已进入持久化队列；切换页面或对话不会取消它。");
			} catch (reason) { setError(readable(reason)); } })()}>提交 Research 运行</button><button className={styles.button} type="button" disabled={busy} onClick={() => void post({ action: "reconnect" }).catch(() => undefined)}>重新连接后台</button></div>
		</div>

		<div className={styles.form}><h4>Research 运行历史</h4>{(state?.runs.length ?? 0) === 0 ? <p className={styles.dim}>还没有 Research 运行。</p> : <ul className={styles.noteList}>{state?.runs.map((run) => <li className={styles.note} key={run.recordId}><div className={styles.row}><strong>{run.mode === "smoke-learning" ? "Smoke 学习准入" : "已批准 Research 范围"} · r{run.cellRevision} · {run.job ? (statusLabels[run.job.status] ?? run.job.status) : "队列记录不可用"}</strong>{run.job && !terminal(run.job.status) && <button className={styles.button} type="button" disabled={busy || !!run.job.cancellationRequestedAt} onClick={() => void post({ action: "cancel", queueJobId: run.queueJobId }).then(() => setNotice("已请求取消 Research 运行。"), (reason) => setError(readable(reason)))}>{run.job.cancellationRequestedAt ? "正在取消…" : "取消运行"}</button>}</div><p className={styles.dim}>计划 r{run.planRevision} · {new Date(run.createdAt).toLocaleString()} · {run.changeNote}</p><details><summary>本次运行冻结的研究方案</summary>{run.planSnapshot ? <pre className={styles.planDetail}>{JSON.stringify(run.planSnapshot.detail, null, 2)}</pre> : <p className={styles.severityWarning}>旧开发记录未保存完整方案，无法据此重建科学语义。</p>}</details>{run.job?.failure && <p className={styles.severityError}>{run.job.failure.message}</p>}{run.job?.result?.logs.stdout && <pre className={styles.codeBlock}>{run.job.result.logs.stdout}</pre>}{run.job?.result?.logs.stderr && <pre className={styles.codeBlock}>{run.job.result.logs.stderr}</pre>}</li>)}</ul>}</div>

		<div className={styles.form}><h4>把学习运行提升为 Research 计划</h4><p className={styles.formHint}>原学习运行保持原身份和结果；提升会新建计划并记录它引用的代码快照。</p><label className={styles.field}><span>学习运行</span><select value={promotionTaskId} disabled={!canMutate} onChange={(event) => setPromotionTaskId(event.target.value)}><option value="">选择已完成或历史学习运行…</option>{learningRuns.map((run) => <option key={run.taskId} value={run.taskId}>{run.title} · r{run.cellRevision} · {statusLabels[run.status] ?? run.status}</option>)}</select></label><div className={styles.readerButtons}><button className={styles.buttonPrimary} type="button" disabled={busy || !canMutate || !promotionTaskId} onClick={() => void (async () => { try { await post({ action: "promote", expectedPhaseRevision: phaseRevision, expectedProjectRevision: projectRevision, sourceTaskId: promotionTaskId, plan: toPlan(draft, fixedSources) }); setNotice("已创建独立 Research 计划，并保留学习运行的原始身份。 "); } catch (reason) { setError(readable(reason)); } })()}>用上方计划草稿提升</button></div></div>

		<div className={styles.form}><h4>记录实现修复</h4><p className={styles.formHint}>修复关联新的不可变代码版本与失败记录，不自动宣称两版代码语义等价。</p><label className={styles.field}><span>失败的 Research 运行</span><select value={repairTaskId} disabled={!canMutate} onChange={(event) => setRepairTaskId(event.target.value)}><option value="">选择失败/取消/到限运行…</option>{failedRuns.map((run) => <option key={run.taskId} value={run.taskId}>{run.cellId} r{run.cellRevision} · {run.job ? statusLabels[run.job.status] : "历史"}</option>)}</select></label><label className={styles.field}><span>修复后的代码版本</span><select value={repairCellId} disabled={!canMutate} onChange={(event) => setRepairCellId(event.target.value)}><option value="">先用代码单元编辑器保存新版本…</option>{cells.map((cell) => <option key={cell.cellId} value={cell.cellId}>{cell.title} · r{cell.revision}</option>)}</select></label><label className={styles.field}><span>计划</span><select value={repairPlanId} disabled={!canMutate} onChange={(event) => setRepairPlanId(event.target.value)}><option value="">选择计划…</option>{displayPlans.map((plan) => <option key={plan.planId} value={plan.planId}>{planLabels[plan.kind]} · r{plan.revision}</option>)}</select></label><label className={styles.field}><span>修复原因</span><textarea value={repairReason} rows={3} maxLength={6000} disabled={!canMutate} onChange={(event) => setRepairReason(event.target.value)} /></label><div className={styles.readerButtons}><button className={styles.buttonPrimary} type="button" disabled={busy || !canMutate || !repairTaskId || !repairCellId || !repairPlanId || !repairReason.trim()} onClick={() => void (async () => { try { const repairPlan = displayPlans.find((plan) => plan.planId === repairPlanId); const repairCell = cells.find((cell) => cell.cellId === repairCellId); if (!repairPlan || !repairCell) throw new Error("Repair plan or cell changed; reload"); await post({ action: "repair", expectedPhaseRevision: phaseRevision, failedTaskId: repairTaskId, repairCellId: repairCell.cellId, repairCellRevision: repairCell.revision, planId: repairPlan.planId, expectedPlanRevision: repairPlan.revision, changeReason: repairReason }); setNotice("修复原因与新代码版本已记录；旧失败运行仍保留。 "); } catch (reason) { setError(readable(reason)); } })()}>记录修复</button></div></div>
	</section>;
}
