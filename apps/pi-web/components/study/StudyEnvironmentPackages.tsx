"use client";

import { useEffect, useRef, useState } from "react";
import type { StudyEnvironmentPackageOperation, StudyEnvironmentPackagePlan } from "@/lib/study-environment-service";
import styles from "@/app/study/Study.module.css";

interface EnvironmentState {
	plans: StudyEnvironmentPackagePlan[];
	operations: StudyEnvironmentPackageOperation[];
}

export interface StudyEnvironmentPackagesProps {
	sessionId: string;
	phaseRevision: number;
}

function readable(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function packageRequests(text: string) {
	const seen = new Set<string>();
	const values = text.split(/\r?\n|,/u).map((entry) => entry.trim()).filter(Boolean).map((entry) => {
		const match = /^([A-Za-z][A-Za-z0-9._-]{0,127})(?:\s*==\s*(.{1,256}))?$/u.exec(entry);
		if (!match) throw new Error(`Invalid package request: ${entry}`);
		if (seen.has(match[1].toLowerCase())) throw new Error(`Repeated package request: ${match[1]}`);
		seen.add(match[1].toLowerCase());
		return { name: match[1], version: match[2]?.trim() || null };
	});
	if (values.length === 0) throw new Error("Enter at least one package name");
	return values;
}

/** This control only previews immutable plans and submits a same-origin installation request. */
export function StudyEnvironmentPackages(props: StudyEnvironmentPackagesProps) {
	const [state, setState] = useState<EnvironmentState | null>(null);
	const [language, setLanguage] = useState<"python" | "r">("python");
	const [requestText, setRequestText] = useState("");
	const [selectedPlanId, setSelectedPlanId] = useState("");
	const [acceptExistingChanges, setAcceptExistingChanges] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const installRequestId = useRef<string | null>(null);

	const fetchState = async (signal?: AbortSignal) => {
		const response = await fetch(`/api/study-research/environment?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: "no-store", signal });
		const value = await response.json() as EnvironmentState & { error?: string };
		if (!response.ok) throw new Error(value.error || "Unable to load package state");
		setState(value);
	};

	useEffect(() => {
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
			try { await fetchState(abort.signal); }
			catch (reason) { if (!abort.signal.aborted) setError(readable(reason)); }
			if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3_000);
		};
		void poll();
		return () => { abort.abort(); if (timer) clearTimeout(timer); };
	}, [props.sessionId]);

	const plans = state?.plans ?? [];
	const selectedPlan = plans.find((plan) => plan.planId === selectedPlanId) ?? plans[0] ?? null;

	const post = async (body: Record<string, unknown>) => {
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/study-research/environment", {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
			});
			const value = await response.json() as { error?: string; plan?: StudyEnvironmentPackagePlan };
			if (!response.ok) throw new Error(value.error || "Package action failed");
			await fetchState();
			return value;
		} finally { setBusy(false); }
	};

	const preview = async () => {
		try {
			const result = await post({ action: "preview", sessionId: props.sessionId, expectedPhaseRevision: props.phaseRevision, language, requests: packageRequests(requestText) });
			if (result.plan) setSelectedPlanId(result.plan.planId);
			installRequestId.current = null;
			setAcceptExistingChanges(false);
			setNotice("已冻结当前环境快照、解析版本、依赖和源哈希。请核对后再安装。");
		} catch (reason) { setError(readable(reason)); }
	};

	const install = async () => {
		if (!selectedPlan) return;
		try {
			installRequestId.current ??= crypto.randomUUID();
			await post({
				action: "install", sessionId: props.sessionId, expectedPhaseRevision: props.phaseRevision,
				planId: selectedPlan.planId, expectedPlanRevision: selectedPlan.revision,
				requestId: installRequestId.current, acceptExistingChanges,
			});
			installRequestId.current = null;
			setNotice("安装请求已持久化并交给后台工作进程；完成后会重新读取实际安装清单验证。若后台在包管理器运行后失联，状态会保留为未知而不会自动重试。");
		} catch (reason) { setError(readable(reason)); }
	};

	const reconcile = async (operationId: string) => {
		try {
			await post({ action: "reconcile", sessionId: props.sessionId, expectedPhaseRevision: props.phaseRevision, operationId });
			setNotice("已核对安装进程与实际环境清单。只有证据一致时才解除占用；未知状态不会当成安装成功。");
		} catch (reason) {
			setError(`${readable(reason)} 若清单仍无法核实，请先修复该项目环境或 R 用户库，再重新核对；不会跳过核验强制解锁。`);
		}
	};

	return <section className={styles.form} aria-label="R 和 Python 包环境">
		<h5>R / Python 缺失包准备</h5>
		<p className={styles.muted}>Python 只使用项目的 <code>.study-python-venv</code>；R 使用现有普通用户库。预览不会改包。已经安装的包发生升级或降级时，必须勾选并提交这一份冻结计划。</p>
		<div className={styles.row}>
			<label className={styles.field}><span>语言</span><select value={language} disabled={busy} onChange={(event) => { setLanguage(event.target.value as "python" | "r"); installRequestId.current = null; }}><option value="python">Python 项目 venv</option><option value="r">R 用户库</option></select></label>
			<label className={styles.field}><span>包请求（每行一个；可选 <code>==版本</code>）</span><textarea value={requestText} rows={4} maxLength={16_000} disabled={busy} onChange={(event) => { setRequestText(event.target.value); installRequestId.current = null; }} placeholder={language === "python" ? "pandas==2.2.3\nmatplotlib" : "ggplot2\ndplyr"} /></label>
		</div>
		<button className={styles.buttonPrimary} type="button" disabled={busy || !requestText.trim()} onClick={() => void preview()}>解析并冻结安装计划</button>

		<div className={styles.form}>
			<h6>冻结计划</h6>
			{plans.length === 0 ? <p className={styles.dim}>尚未解析包计划。</p> : <label className={styles.field}><span>已保存计划</span><select value={selectedPlan?.planId ?? ""} disabled={busy} onChange={(event) => { setSelectedPlanId(event.target.value); setAcceptExistingChanges(false); installRequestId.current = null; }}>{plans.map((plan) => <option key={plan.planId} value={plan.planId}>{plan.language.toUpperCase()} · {new Date(plan.createdAt).toLocaleString()} · {plan.packages.length} 个包</option>)}</select></label>}
			{selectedPlan && <>
				<p className={styles.formHint}>解析器：{selectedPlan.resolver}；环境清单哈希：{selectedPlan.inventoryHash.slice(0, 20)}。安装前任何环境改变都会使计划过期。</p>
				<ul className={styles.noteList}>{selectedPlan.packages.map((entry) => <li className={styles.note} key={entry.name}><strong>{entry.name} {entry.version}</strong> · {entry.change}{entry.direct ? " · 直接请求" : " · 传递依赖"}<br /><span className={styles.dim}>源：{entry.source} · {entry.sourceHash}</span></li>)}</ul>
				{selectedPlan.requiresExistingChangeConsent && <label className={styles.checkbox}><input type="checkbox" checked={acceptExistingChanges} disabled={busy} onChange={(event) => { setAcceptExistingChanges(event.target.checked); installRequestId.current = null; }} />我确认这个冻结计划会升级或降级已安装的包。</label>}
				<button className={styles.buttonPrimary} type="button" disabled={busy || (selectedPlan.requiresExistingChangeConsent && !acceptExistingChanges)} onClick={() => void install()}>提交此冻结计划安装</button>
			</>}
		</div>

		<div className={styles.form}>
			<h6>后台操作与最终验证</h6>
			{(state?.operations.length ?? 0) === 0 ? <p className={styles.dim}>还没有安装操作。</p> : <ul className={styles.noteList}>{state?.operations.map((operation) => <li className={styles.note} key={operation.operationId}><strong>{operation.status === "unknown" ? "未知 · 环境仍被占用" : operation.status === "reconciled" ? "已核对恢复 · 未宣称安装成功" : operation.status}</strong> · 尝试 {operation.attempts} 次 · {new Date(operation.updatedAt).toLocaleString()}{operation.diagnostic && <p className={operation.status === "unknown" ? styles.severityWarning : styles.severityError}>{operation.diagnostic}</p>}{operation.result && <p className={styles.dim}>最终清单哈希：{operation.result.finalInventoryHash}；验证于 {new Date(operation.result.validatedAt).toLocaleString()}。</p>}{operation.status === "unknown" && <button type="button" className={styles.button} disabled={busy} onClick={() => void reconcile(operation.operationId)}>核对进程与环境后恢复</button>}</li>)}</ul>}
		</div>
		{notice && <p role="status">{notice}</p>}
		{error && <p role="alert" className={styles.severityError}>{error}</p>}
	</section>;
}
