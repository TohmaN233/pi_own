"use client";

import { useEffect, useMemo, useState } from "react";
import type { ExecutionResourceRequest } from "../../../../packages/study-execution-host/src/execution-queue.ts";
import type { SourceVersion, VisualizationDraft } from "../../../../packages/study-research-host/src/types.ts";
import type { VisualValidationSpecification } from "../../../../packages/study-research-host/src/visual-validation.ts";
import type { VisualValidationSpec, VisualValidationState } from "@/lib/study-visual-validation-service";
import styles from "@/app/study/Study.module.css";

type SourceChoice = Pick<SourceVersion, "sourceId" | "contentHash" | "relativePath">;
type CaseDraft = VisualValidationSpecification["cases"][number];

export interface StudyVisualValidationProps {
	sessionId: string;
	phase: "study" | "research";
	phaseRevision: number;
	projectRevision: number;
	visualization: VisualizationDraft;
	sources: SourceChoice[];
	onChanged?: () => void;
}

function readable(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function specificationIdentity(value: VisualValidationSpecification): string {
	return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}

function defaultCases(inputs: Record<string, unknown>): CaseDraft[] {
	return [
		{ id: "ordinary", category: "ordinary", description: "Ordinary input in the declared domain", inputs, expected: [{ path: ["metrics", "value"], value: 0, absoluteTolerance: 0, relativeTolerance: 0 }] },
		{ id: "boundary", category: "boundary", description: "A declared boundary input", inputs, expected: [{ path: ["metrics", "value"], value: 0, absoluteTolerance: 0, relativeTolerance: 0 }] },
		{ id: "degenerate", category: "degenerate", description: "A degenerate or zero-size input", inputs, expected: [{ path: ["metrics", "value"], value: 0, absoluteTolerance: 0, relativeTolerance: 0 }] },
		{ id: "interaction", category: "interaction", description: "Changing an input changes the declared visual observation", inputs, expected: [{ path: ["metrics", "value"], value: 0, absoluteTolerance: 0, relativeTolerance: 0 }] },
	];
}

function resourceDefaults(state: VisualValidationState | null): ExecutionResourceRequest | null {
	return state?.capacity?.defaults ?? null;
}

function targetFor(visualization: VisualizationDraft) {
	return {
		visualizationId: visualization.visualizationId,
		visualizationRevision: visualization.revision,
		visualizationHash: visualization.contentHash,
	};
}

function currentTarget(state: VisualValidationState | null, fallback: VisualizationDraft) {
	const value = state?.visualization;
	return value
		? { visualizationId: value.visualizationId, visualizationRevision: value.revision, visualizationHash: value.contentHash }
		: targetFor(fallback);
}

function terminal(status: string): boolean {
	return ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(status);
}

/** Numeric scene validation is evidence only. Browser interactions and academic review remain separate gates. */
export function StudyVisualValidation(props: StudyVisualValidationProps) {
	const [state, setState] = useState<VisualValidationState | null>(null);
	const [selectedSpecificationId, setSelectedSpecificationId] = useState("");
	const [scope, setScope] = useState("");
	const [assumptions, setAssumptions] = useState("");
	const [oracleKind, setOracleKind] = useState<"hand-calculation" | "independent-reference">("hand-calculation");
	const [oracleDescription, setOracleDescription] = useState("");
	const [oracleMaterial, setOracleMaterial] = useState("");
	const [sourceIds, setSourceIds] = useState<string[]>([]);
	const [sourceLocator, setSourceLocator] = useState("");
	const [casesText, setCasesText] = useState(() => JSON.stringify(defaultCases(props.visualization.inputs), null, 2));
	const [resources, setResources] = useState<ExecutionResourceRequest | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const fetchState = async (signal?: AbortSignal) => {
		const response = await fetch(`/api/study-research/visual-validation?sessionId=${encodeURIComponent(props.sessionId)}&visualizationId=${encodeURIComponent(props.visualization.visualizationId)}`, {
			cache: "no-store",
			signal,
		});
		const value = await response.json() as VisualValidationState & { error?: string };
		if (!response.ok) throw new Error(value.error || "Unable to load visual validation state");
		setState(value);
		setResources((current) => current ?? resourceDefaults(value));
	};

	useEffect(() => {
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
			try {
				await fetchState(abort.signal);
			} catch (reason) {
				if (!abort.signal.aborted) setError(readable(reason));
			}
			if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3_000);
		};
		void poll();
		return () => {
			abort.abort();
			if (timer) clearTimeout(timer);
		};
	}, [props.sessionId, props.visualization.visualizationId]);

	useEffect(() => {
		setSourceIds((selected) => selected.length > 0 || props.sources.length === 0 ? selected : [props.sources[0].sourceId]);
	}, [props.sources]);

	const target = currentTarget(state, props.visualization);
	const selectedSpecification = state?.specifications.find((item) => item.specificationId === selectedSpecificationId) ?? null;
	const targetChanged = target.visualizationRevision !== props.visualization.revision || target.visualizationHash !== props.visualization.contentHash;
	const parsedCases = useMemo(() => {
		try {
			const value: unknown = JSON.parse(casesText);
			if (!Array.isArray(value)) throw new Error("Cases must be a JSON array");
			return { cases: value as CaseDraft[], error: null };
		} catch (reason) {
			return { cases: null, error: readable(reason) };
		}
	}, [casesText]);
	const selectedSources = props.sources.filter((source) => sourceIds.includes(source.sourceId));
	const canSave = !busy && !targetChanged && !!parsedCases.cases && selectedSources.length > 0 && !!sourceLocator.trim() && !!oracleMaterial.trim() && !!scope.trim() && !!assumptions.trim() && !!oracleDescription.trim();
	const resetRequest = () => { setNotice(""); };
	const draftSpecification = (): VisualValidationSpecification => ({
		version: 1,
		targetHash: target.visualizationHash,
		scope,
		assumptions: assumptions.split("\n").map((item) => item.trim()).filter(Boolean),
		oracle: {
			kind: oracleKind,
			description: oracleDescription,
			material: oracleMaterial,
			sourceReferences: selectedSources.map((source) => ({ sourceId: source.sourceId, sourceHash: source.contentHash, locator: sourceLocator.trim() })),
		},
		cases: parsedCases.cases ?? [],
	});
	const specificationDirty = !!selectedSpecification && specificationIdentity(draftSpecification()) !== specificationIdentity(selectedSpecification.specification);
	const canStart = !busy && !!selectedSpecification && !specificationDirty && !targetChanged && resources !== null && selectedSpecification.target.visualizationRevision === target.visualizationRevision && selectedSpecification.target.visualizationHash === target.visualizationHash;

	const post = async (body: Record<string, unknown>) => {
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/study-research/visual-validation", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const value = await response.json() as { error?: string };
			if (!response.ok) throw new Error(value.error || "Visual validation action failed");
			await fetchState();
			props.onChanged?.();
			return value;
		} finally {
			setBusy(false);
		}
	};

	const loadSpecification = (specification: VisualValidationSpec) => {
		setSelectedSpecificationId(specification.specificationId);
		setScope(specification.specification.scope);
		setAssumptions(specification.specification.assumptions.join("\n"));
		setOracleKind(specification.specification.oracle.kind);
		setOracleDescription(specification.specification.oracle.description);
		setOracleMaterial(specification.specification.oracle.material);
		setSourceIds(specification.sourceReferences.map((reference) => reference.sourceId));
		setSourceLocator(specification.sourceReferences[0]?.locator ?? "");
		setCasesText(JSON.stringify(specification.specification.cases, null, 2));
		resetRequest();
	};

	const save = async () => {
		try {
			const result = await post({
				action: "save-specification",
				sessionId: props.sessionId,
				expectedPhaseRevision: state?.phaseRevision ?? props.phaseRevision,
				specificationId: selectedSpecification?.specificationId,
				expectedSpecificationRevision: selectedSpecification?.revision,
				target,
				specification: draftSpecification(),
			}) as VisualValidationSpec;
			setSelectedSpecificationId(result.specificationId);
			setNotice("检查方案已保存；运行时会固定这一版图形、输入、预期值与计算环境。");
		} catch (reason) {
			setError(readable(reason));
		}
	};

	const start = async () => {
		if (!selectedSpecification || !resources) return;
		try {
			const body = {
				action: "start",
				sessionId: props.sessionId,
				expectedPhaseRevision: state?.phaseRevision ?? props.phaseRevision,
				specificationId: selectedSpecification.specificationId,
				expectedSpecificationRevision: selectedSpecification.revision,
				resources,
			};
			const storageKey = `study-visual-pending-run:${props.sessionId}:${props.visualization.visualizationId}`;
			const intent = JSON.stringify(body);
			const saved = sessionStorage.getItem(storageKey);
			const previous: unknown = saved === null ? null : JSON.parse(saved);
			const requestId = previous && typeof previous === "object" && "intent" in previous && previous.intent === intent && "requestId" in previous && typeof previous.requestId === "string"
				? previous.requestId : crypto.randomUUID();
			sessionStorage.setItem(storageKey, JSON.stringify({ intent, requestId }));
			await post({ ...body, requestId });
			sessionStorage.removeItem(storageKey);
			setNotice("检查已进入后台队列。完成后会展示实际值与预期值的比较。");
		} catch (reason) {
			setError(readable(reason));
		}
	};

	return <section className={styles.form} aria-label="可视化数值验证">
		<h5>数值可视化验证 · {props.phase === "research" ? "Research" : "Study"}</h5>
		<p className={styles.muted}>填写独立推导的预期值，再运行图形代码进行比较。检查只覆盖所列用例；控件操作和数学含义还需要分别核对。</p>
		{targetChanged && <p className={styles.severityWarning}>页面中的可视化版本已变化。先重新加载此区块，旧规格和运行不会用于当前目标。</p>}
		{state?.capacityError && <p className={styles.severityWarning}>本机隔离执行容量不可用：{state.capacityError}</p>}

		<div className={styles.form}>
			<h6>冻结规格</h6>
			<label className={styles.field}><span>已保存规格</span><select value={selectedSpecificationId} disabled={busy} onChange={(event) => {
				const specification = state?.specifications.find((item) => item.specificationId === event.target.value);
				if (specification) loadSpecification(specification);
				else { setSelectedSpecificationId(""); resetRequest(); }
			}}><option value="">新建规格…</option>{state?.specifications.map((item) => <option key={item.specificationId} value={item.specificationId}>r{item.revision} · {item.specification.scope.slice(0, 70)}</option>)}</select></label>
			<label className={styles.field}><span>验证范围</span><textarea aria-label="验证范围" value={scope} maxLength={6000} rows={2} disabled={busy} onChange={(event) => { setScope(event.target.value); resetRequest(); }} /></label>
			<label className={styles.field}><span>假设（每行一条）</span><textarea aria-label="假设（每行一条）" value={assumptions} maxLength={20000} rows={3} disabled={busy} onChange={(event) => { setAssumptions(event.target.value); resetRequest(); }} /></label>
			<label className={styles.field}><span>独立期望来源</span><select value={oracleKind} disabled={busy} onChange={(event) => { setOracleKind(event.target.value as "hand-calculation" | "independent-reference"); resetRequest(); }}><option value="hand-calculation">手工推导</option><option value="independent-reference">独立参考实现</option></select></label>
			<label className={styles.field}><span>来源说明</span><textarea aria-label="来源说明" value={oracleDescription} maxLength={6000} rows={2} disabled={busy} onChange={(event) => { setOracleDescription(event.target.value); resetRequest(); }} /></label>
			<label className={styles.field}><span>推导或独立参考材料</span><textarea aria-label="推导或独立参考材料" value={oracleMaterial} maxLength={131072} rows={5} disabled={busy} onChange={(event) => { setOracleMaterial(event.target.value); resetRequest(); }} placeholder="写出独立推导、公式或参考实现说明；这段内容不会发送给隔离 subject。" /></label>
			<fieldset className={styles.field}><legend>作为数值依据的当前来源</legend>{props.sources.length === 0 ? <p className={styles.severityWarning}>先导入并打开至少一个当前来源。没有可追溯来源时不能开始程序检查。</p> : props.sources.map((source) => <label className={styles.checkbox} key={source.sourceId}><input type="checkbox" checked={sourceIds.includes(source.sourceId)} disabled={busy} onChange={(event) => { setSourceIds(event.target.checked ? [...sourceIds, source.sourceId] : sourceIds.filter((id) => id !== source.sourceId)); resetRequest(); }} />{source.relativePath}</label>)}</fieldset>
			<label className={styles.field}><span>来源定位（页码、章节或稳定段落标识）</span><input value={sourceLocator} maxLength={4000} disabled={busy} onChange={(event) => { setSourceLocator(event.target.value); resetRequest(); }} placeholder="例如 p. 14, Eq. (3); §2.1" /></label>
			<label className={styles.field}><span>四类测试用例 JSON</span><textarea aria-label="四类测试用例 JSON" className={styles.jsonEditor} value={casesText} rows={15} spellCheck={false} disabled={busy} onChange={(event) => { setCasesText(event.target.value); resetRequest(); }} /></label>
			<p className={styles.formHint}>默认草稿显式列出 ordinary、boundary、degenerate 和 interaction。开始前将 inputs、观测路径和期望值替换为独立推导的真实数值；每个 case 的 inputs 会单独冻结并保留哈希。</p>
			{parsedCases.error && <p role="alert" className={styles.severityError}>测试用例 JSON 无法读取：{parsedCases.error}</p>}
			<button className={styles.buttonPrimary} type="button" disabled={!canSave} onClick={() => void save()}>保存冻结规格</button>
		</div>

		<div className={styles.form}>
			<h6>启动隔离数值检查</h6>
			<p className={styles.formHint}>当前目标：r{target.visualizationRevision} · {target.visualizationHash.slice(0, 20)}。提交后，目标代码、运行参数、每个 case 输入和 Node 可执行文件摘要都固定下来。</p>
			{resources && state?.capacity && <div className={styles.row}>
				<label className={styles.field}><span>CPU 核数</span><input type="number" step="0.01" min={state.capacity.minimumCpuMilliCores / 1000} max={state.capacity.maximum.cpuMilliCores / 1000} value={resources.cpuMilliCores / 1000} disabled={busy} onChange={(event) => { setResources({ ...resources, cpuMilliCores: Math.round(Number(event.target.value) * 1000) }); resetRequest(); }} /></label>
				<label className={styles.field}><span>内存 MiB</span><input type="number" min={64} max={state.capacity.maximum.memoryMiB} value={resources.memoryMiB} disabled={busy} onChange={(event) => { setResources({ ...resources, memoryMiB: Number(event.target.value) }); resetRequest(); }} /></label>
				<label className={styles.field}><span>最长秒数</span><input type="number" min={1} max={state.capacity.maximum.wallTimeMs / 1000} value={resources.wallTimeMs / 1000} disabled={busy} onChange={(event) => { setResources({ ...resources, wallTimeMs: Number(event.target.value) * 1000 }); resetRequest(); }} /></label>
				<label className={styles.field}><span>输出 MiB</span><input type="number" min={1} max={state.capacity.maximum.diskBytes / 1048576} value={resources.diskBytes / 1048576} disabled={busy} onChange={(event) => { setResources({ ...resources, diskBytes: Number(event.target.value) * 1048576 }); resetRequest(); }} /></label>
			</div>}
			<button className={styles.buttonPrimary} type="button" disabled={!canStart} onClick={() => void start()}>开始数值检查</button>
			{specificationDirty && <p className={styles.severityWarning}>检查方案有未保存的修改，请先保存再运行。</p>}
			<button className={styles.button} type="button" disabled={busy} onClick={() => void post({ action: "reconnect", sessionId: props.sessionId }).catch((reason) => setError(readable(reason)))}>重新连接后台</button>
			{selectedSpecification && selectedSpecification.target.visualizationHash !== target.visualizationHash && <p className={styles.severityWarning}>所选规格属于旧目标版本，不能启动。</p>}
		</div>

		<div className={styles.form}>
			<h6>冻结运行与实际观测</h6>
			{(state?.runs.length ?? 0) === 0 ? <p className={styles.dim}>当前可视化还没有数值验证运行。</p> : <ul className={styles.noteList}>{state?.runs.map((run) => <li className={styles.note} key={run.runId}>
				<div className={styles.row}><strong>{run.currentStatus === "stale" ? "目标或来源已失效" : run.currentStatus === "pending" ? `队列中：${run.queueStatus}` : `Host 数值比较：${run.currentStatus}`}</strong>{!terminal(run.queueStatus) && <button className={styles.button} type="button" disabled={busy} onClick={() => void post({ action: "cancel", sessionId: props.sessionId, queueJobId: run.queueJobId }).then(() => setNotice("已请求取消隔离运行。"), (reason) => setError(readable(reason)))}>取消运行</button>}</div>
				<p className={styles.dim}>规格 r{run.specificationRevision} · 目标 r{run.target.visualizationRevision} · {new Date(run.createdAt).toLocaleString()}</p>
				{run.staleReasons.map((reason) => <p className={styles.severityWarning} key={reason}>{reason}</p>)}
				{run.canonical?.observationError && <p className={styles.severityWarning}>{run.canonical.observationError}</p>}
				{run.canonical && <details><summary>期望值与实际隔离场景值 · {run.canonical.status}</summary><p>{run.canonical.report.qualification}</p>{run.canonical.report.missingCategories.length > 0 && <p className={styles.severityWarning}>缺少类别：{run.canonical.report.missingCategories.join("、")}</p>}<ul>{run.canonical.report.comparisons.map((comparison) => <li key={comparison.caseId}><strong>{comparison.caseId} · {comparison.status}</strong>{comparison.error && <p>{comparison.error}</p>}<ul>{comparison.checks.map((check, index) => <li key={`${comparison.caseId}:${index}`} className={check.passed ? styles.dim : styles.severityError}>{JSON.stringify(check.path)}：期望 {String(check.expected)}，实际 {check.actual === undefined ? "未返回" : String(check.actual)}；绝对容差 {check.absoluteTolerance}，相对容差 {check.relativeTolerance}</li>)}</ul></li>)}</ul></details>}
			</li>)}</ul>}
		</div>
		{notice && <p role="status">{notice}</p>}
		{error && <p role="alert" className={styles.severityError}>{error}</p>}
	</section>;
}
