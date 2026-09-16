"use client";

import { useCallback, useEffect, useState } from "react";
import type { ManuscriptPatch, SourceVersion } from "../../../../packages/study-research-host/src/index.ts";
import type { studyManuscriptState } from "@/lib/study-manuscript-service";
import styles from "@/app/study/Study.module.css";

type State = Awaited<ReturnType<typeof studyManuscriptState>>;

function responseError(value: unknown, fallback: string): string {
	return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
}

async function responseJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function operationLabel(patch: ManuscriptPatch): string {
	const additions = patch.operations.filter((operation) => operation.kind === "add").length;
	const rewrites = patch.operations.filter((operation) => operation.kind === "replace").length;
	const deletions = patch.operations.filter((operation) => operation.kind === "delete").length;
	return [
		additions ? `${additions} 新增（绿色）` : null,
		rewrites ? `${rewrites} 改写（蓝色）` : null,
		deletions ? `${deletions} 删除（红色删除线）` : null,
	].filter(Boolean).join("；") || "等待 Agent 生成精确候选";
}

function operationReasons(patch: ManuscriptPatch): string[] {
	return patch.operations.map((operation, index) => {
		if (operation.kind === "add") {
			return "操作 " + (index + 1) + "：在“" + operation.anchor + "”" + (operation.position === "before" ? "之前" : "之后") + "新增；理由：" + operation.reason;
		}
		return "操作 " + (index + 1) + "：" + (operation.kind === "replace" ? "改写" : "删除") + "“" + operation.oldText + "”；理由：" + operation.reason;
	});
}

function manuscriptPrompt(patch: ManuscriptPatch): string {
	return [
		"用户刚从 Study 论文工作区提交了一项明确改稿请求。请先调用 study_manuscript 的 state 查看该请求，再且仅在文本唯一、非数学区域可安全定位时提交精确操作。",
		"patchId: " + patch.patchId,
		"targetPath: " + patch.targetPath,
		"request: " + patch.requestText,
		"不要确认写回或恢复原稿；这些只能由用户在浏览器中显式完成。",
	].join("\n");
}

function sourceLabel(source: SourceVersion): string {
	return `${source.relativePath} · ${source.kind === "tex" ? "TeX" : "Word DOCX"}`;
}

export function StudyManuscript({ sessionId, phase, phaseRevision, projectRevision, onChanged, onAsk }: {
	sessionId: string;
	phase: "study" | "research";
	phaseRevision: number;
	projectRevision: number;
	onChanged: () => void;
	onAsk?: (prompt: string) => void | Promise<void>;
}) {
	const [state, setState] = useState<State | null>(null);
	const [sourceId, setSourceId] = useState("");
	const [requestText, setRequestText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await fetch(`/api/study-research/manuscript?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
		const value = await responseJson(response);
		if (!response.ok) throw new Error(responseError(value, "无法读取论文改稿记录"));
		setState(value as State);
	}, [sessionId]);

	useEffect(() => {
		void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
	}, [load, phaseRevision, projectRevision]);

	useEffect(() => {
		if (!sourceId && state?.sources[0]) setSourceId(state.sources[0].sourceId);
	}, [sourceId, state?.sources]);

	const mutate = useCallback(async (body: Record<string, unknown>, success: string) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const response = await fetch("/api/study-research/manuscript", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const value = await responseJson(response);
			if (!response.ok) throw new Error(responseError(value, "论文改稿操作未完成"));
			setNotice(success);
			await load();
			onChanged();
			return value;
		} finally {
			setBusy(false);
		}
	}, [load, onChanged]);

	const currentPhase = state?.phase ?? phase;
	const currentPhaseRevision = state?.phaseRevision ?? phaseRevision;
	const currentProjectRevision = state?.projectRevision ?? projectRevision;
	const selectedSource = state?.sources.find((source) => source.sourceId === sourceId) ?? null;
	const canMutate = currentPhase === "research";

	return <section className={styles.section} id="manuscript" tabIndex={-1}>
		<div className={styles.sectionHeader}>
			<div>
				<h3>论文改稿候选</h3>
				<p>先由你明确提出修改目标，再由 Research 生成彩色候选。确认前不会写回原稿；确认后可用保存的原始版本恢复。</p>
			</div>
			<span className={styles.statusBadge}>{state?.patches.length ?? 0} 项记录</span>
		</div>
		{currentPhase === "study" && <p className={styles.severityWarning}>当前为 Study。可以查看历史候选；提出请求、生成候选、确认写回和恢复都需要显式切换到 Research。</p>}
		{error && <p className={styles.severityError} role="alert">{error}</p>}
		{notice && <p className={styles.notice} role="status">{notice}</p>}

		<form className={styles.form} onSubmit={(event) => {
			event.preventDefault();
			if (!selectedSource) {
				setError("请选择当前 TeX 或 DOCX 来源。");
				return;
			}
			void mutate({
				action: "request",
				sessionId,
				expectedPhaseRevision: currentPhaseRevision,
				expectedProjectRevision: currentProjectRevision,
				sourceId: selectedSource.sourceId,
				sourceHash: selectedSource.contentHash,
				requestText,
			}, "已记录你的明确改稿请求。Research Agent 现在可以据此生成候选。").then(async (value) => {
				setRequestText("");
				if (!onAsk) return;
				const patch = value as ManuscriptPatch;
				try {
					await onAsk(manuscriptPrompt(patch));
				} catch (reason) {
					setError("改稿请求已经保存，但没有发送到原始 Pi 对话：" + (reason instanceof Error ? reason.message : String(reason)));
				}
			}, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
		}}>
			<h4>提出改稿请求</h4>
			<label className={styles.field}>
				<span>稿件来源</span>
				<select value={sourceId} onChange={(event) => setSourceId(event.target.value)} disabled={busy || !state?.sources.length}>
					<option value="">请选择来源…</option>
					{state?.sources.map((source) => <option key={source.sourceId} value={source.sourceId}>{sourceLabel(source)}</option>)}
				</select>
			</label>
			<label className={styles.field}>
				<span>你希望如何修改</span>
				<textarea value={requestText} onChange={(event) => setRequestText(event.target.value)} rows={4} maxLength={20_000} placeholder="例如：把引言第二段的结论改得更谨慎，并说明理由。" disabled={busy} />
			</label>
			<p className={styles.formHint}>请求会绑定当前文件字节与项目版本。Agent 只能为这份请求生成精确候选，不能自行发起写回。</p>
			<button className={styles.buttonPrimary} type="submit" disabled={!canMutate || busy || !selectedSource || !requestText.trim()}>记录改稿请求</button>
		</form>

		<div className={styles.form}>
			<h4>候选与恢复记录</h4>
			{!state ? <p className={styles.dim}>正在读取改稿记录…</p> : state.patches.length === 0 ? <p className={styles.dim}>还没有论文改稿请求。</p> : <ul className={styles.noteList}>{state.patches.map((patch) => <li className={styles.note} key={patch.patchId}>
				<div className={styles.row}>
					<strong>{patch.kind === "tex" ? "TeX" : "Word DOCX"} · {patch.status} · r{patch.revision}</strong>
					{patch.candidateHash && ["draft", "confirmed", "recovered"].includes(patch.status) && <a className={styles.button} href={`/api/study-research/manuscript?${new URLSearchParams({ action: "candidate", sessionId, patchId: patch.patchId })}`} download>下载彩色候选</a>}
				</div>
				<p className={styles.sourceHash}>目标文件 {patch.targetPath}</p>
				<p>{patch.requestText}</p>
				<p className={styles.dim}>{operationLabel(patch)}</p>
				{patch.operations.length > 0 && <ul className={styles.noteList}>{operationReasons(patch).map((reason) => <li className={styles.dim} key={reason}>{reason}</li>)}</ul>}
				{patch.diagnostic && <p className={styles.severityWarning}>{patch.diagnostic}</p>}
				{patch.status === "requested" && <p className={styles.formHint}>等待 Research Agent 使用 <code>study_manuscript</code> 读取此请求并提交精确操作。</p>}
				{patch.status === "draft" && <div className={styles.readerButtons}>
					<button className={styles.buttonPrimary} type="button" disabled={!canMutate || busy} onClick={() => void mutate({
						action: "confirm",
						confirmed: true,
						sessionId,
						expectedPhaseRevision: currentPhaseRevision,
						patchId: patch.patchId,
						expectedPatchRevision: patch.revision,
					}, "已确认写回干净版本；已保存可恢复的原始版本。").catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))}>确认写回干净版本</button>
					<span className={styles.formHint}>此操作会再次核对原稿字节；任何外部改动都会拒绝写回。</span>
				</div>}
				{patch.status === "confirmed" && <div className={styles.readerButtons}>
					<button className={styles.button} type="button" disabled={!canMutate || busy} onClick={() => void mutate({
						action: "recover",
						confirmed: true,
						sessionId,
						expectedPhaseRevision: currentPhaseRevision,
						patchId: patch.patchId,
						expectedPatchRevision: patch.revision,
					}, "已恢复确认前保存的原始版本。").catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))}>恢复原始版本</button>
					<span className={styles.formHint}>恢复同样使用当前字节 CAS；之后的人工改动不会被覆盖。</span>
				</div>}
				<details className={styles.debugDetails}><summary>查看版本身份</summary><p className={styles.taskId}>{patch.patchId}</p><p className={styles.sourceHash}>基础 {patch.baseFileHash}</p>{patch.candidateHash && <p className={styles.sourceHash}>候选 {patch.candidateHash}</p>}{patch.finalFileHash && <p className={styles.sourceHash}>正式稿 {patch.finalFileHash}</p>}</details>
			</li>)}</ul>}
		</div>
	</section>;
}
