"use client";

import { useEffect, useRef, useState } from "react";
import type { IndependentReview, StudyAgentQueueTask, VisualizationDraft } from "../../../../packages/study-research-host/src/types.ts";
import type { StudyReviewSourceSelection } from "@/lib/study-review-service";
import styles from "@/app/study/Study.module.css";

export function StudyVisualReview({ sessionId, phaseRevision, visualization, sources }: {
  sessionId: string; phaseRevision: number; visualization: VisualizationDraft;
  sources: Array<StudyReviewSourceSelection & { label: string }>;
}) {
  return <StudyArtifactReview sessionId={sessionId} phaseRevision={phaseRevision}
    target={{ kind: "visualization", id: visualization.visualizationId, revision: visualization.revision, contentHash: visualization.contentHash }} sources={sources} />;
}

export function StudyArtifactReview({ sessionId, phaseRevision, target, sources }: {
  sessionId: string; phaseRevision: number;
  target: { kind: "visualization" | "result"; id: string; revision: number; contentHash: string };
  sources: Array<StudyReviewSourceSelection & { label: string }>;
}) {
  const [scope, setScope] = useState("核对数学定义、假设、参数含义与现有验证的缺口。");
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [tasks, setTasks] = useState<StudyAgentQueueTask[]>([]);
  const [reviews, setReviews] = useState<IndependentReview[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/study-research/review?sessionId=${encodeURIComponent(sessionId)}`, { signal: abort.signal, cache: "no-store" });
        const value = await response.json() as { tasks: StudyAgentQueueTask[]; reviews: IndependentReview[]; error?: string };
        if (!response.ok || !Array.isArray(value.tasks) || !Array.isArray(value.reviews)) throw new Error(value.error || "无法读取独立审查状态");
        if (!abort.signal.aborted) { setTasks(value.tasks.filter((task) => task.target?.targetId === target.id && task.target.targetKind === target.kind));
          setReviews(value.reviews.filter((review) => review.targetId === target.id && review.targetKind === target.kind)); }
      } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [sessionId, target.id, target.kind, revision]);
  const submit = async () => {
    setBusy(true); setError(""); requestId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/study-research/review", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, expectedPhaseRevision: phaseRevision, targetKind: target.kind, targetId: target.id,
          targetRevision: target.revision, targetHash: target.contentHash, scope, requestId: requestId.current,
          sources: sources.filter((source) => selected.includes(source.chunkId)).map(({ sourceId, sourceHash, chunkId, offset }) => ({ sourceId, sourceHash, chunkId, offset })),
          ...(provider || modelId ? { provider, modelId } : {}) }) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || "无法开始独立审查");
      requestId.current = null; setRevision((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const cancel = async (taskId: string) => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/study-research/reading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", sessionId, taskId }) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || "无法取消独立审查");
      setRevision((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const current = reviews.filter((review) => review.targetHash === target.contentHash && review.targetRevision === target.revision);
  return <div className={styles.form}>
    <h5>独立审查 · 已保存 r{target.revision}</h5>
    <p className={styles.muted}>独立上下文会读取这一版{target.kind === "result" ? "分析和冻结实验或理论依据" : "代码"}、已有程序检查及你选定的原文。审查意见保留范围和疑点，模型一致不等于证明。</p>
    <label className={styles.field}><span>审查范围</span><textarea value={scope} maxLength={6000} onChange={(event) => { setScope(event.target.value); requestId.current = null; }} /></label>
    <fieldset><legend>作为依据的已打开片段</legend>
      {sources.length === 0 && <p>{target.kind === "result" ? "可仅审查冻结的实验/理论结果；需要对照论文时请先打开来源片段。" : "先在来源阅读区打开需要对照的片段。"}</p>}
      {sources.slice(0, 20).map((source) => <label key={source.chunkId} className={styles.row}><input type="checkbox" checked={selected.includes(source.chunkId)}
        onChange={(event) => { requestId.current = null; setSelected((ids) => event.target.checked ? [...ids, source.chunkId] : ids.filter((id) => id !== source.chunkId)); }} />{source.label}</label>)}
    </fieldset>
    <details><summary>指定另一个审查模型（可选）</summary>
      <label className={styles.field}><span>Provider</span><input value={provider} onChange={(event) => { setProvider(event.target.value); requestId.current = null; }} /></label>
      <label className={styles.field}><span>Model ID</span><input value={modelId} onChange={(event) => { setModelId(event.target.value); requestId.current = null; }} /></label>
      <p className={styles.muted}>留空使用本对话的模型；这里的选择不改变前台模型。</p>
    </details>
    <button className={styles.button} type="button" disabled={busy || !scope.trim() || (target.kind !== "result" && !sources.some((source) => selected.includes(source.chunkId)))}
      onClick={() => void submit()}>{busy ? "提交中…" : "开始独立审查"}</button>
    {error && <p role="alert">{error}</p>}
    {current.length === 0 && <p className={styles.muted}>当前版本尚无完成的独立审查，保持草稿。</p>}
    {tasks.filter((task) => !reviews.some((review) => review.taskId === task.taskId)).map((task) => <div key={task.taskId}><p>审查任务：{task.status}；{task.report?.summary ?? "报告尚未完成"}</p>
      {!["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(task.status) && <button className={styles.button} type="button" disabled={busy || !!task.cancelRequestedAt} onClick={() => void cancel(task.taskId)}>{task.cancelRequestedAt ? "正在取消…" : "取消审查"}</button>}</div>)}
    {reviews.map((review) => <details key={review.checkId}><summary>{review.targetHash === target.contentHash && review.targetRevision === target.revision ? "当前版本" : "历史版本 · 对当前草稿无效"}：{review.status}</summary>
      <ul>{review.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul></details>)}
  </div>;
}
