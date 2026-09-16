"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StudyAgentQueueTask, StudyPaperMap } from "../../../../packages/study-research-host/src/types.ts";
import styles from "@/app/study/Study.module.css";

const terminal = (status: string) => ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(status);
const statuses: Record<string, string> = { queued: "等待阅读", admitted: "准备阅读", launching: "启动中", running: "正在阅读",
  succeeded: "已保存理解与笔记", failed: "阅读失败", cancelled: "已取消", "limit-reached": "达到运行限制", reconciling: "核对运行状态", "needs-input": "需要处理" };
const mapSections: Array<[keyof StudyPaperMap["sections"], string]> = [["problem", "核心问题"], ["contributions", "主要贡献"],
  ["assumptionsNotation", "假设与符号"], ["argumentDependencies", "论证与依赖"], ["limitationsUnresolved", "限制与未解决问题"]];
type PaperMapView = { map: { task: StudyAgentQueueTask; paperMap: StudyPaperMap | null } | null; historical: Array<{ task: StudyAgentQueueTask; paperMap: StudyPaperMap | null }>; reductions:StudyAgentQueueTask[]; plan: {
  mapGroupHash: string; rootInputHash: string; ready: boolean; sourceCurrent: boolean; coverage: StudyPaperMap["coverage"];
} };

export function StudyBackgroundReading({ sessionId, phaseRevision, source, onChanged }: {
  sessionId: string; phaseRevision: number; source: { sourceId: string; contentHash: string; relativePath: string } | null;
  onChanged: () => void;
}) {
  const [tasks, setTasks] = useState<Array<StudyAgentQueueTask & { detail: string }>>([]);
  const [maps, setMaps] = useState<PaperMapView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const observed = useRef("");
  const generation = useRef(0);
  const retries = useRef(new Map<string, string>());
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = generation.current;
    const response = await fetch(`/api/study-research/reading?sessionId=${encodeURIComponent(sessionId)}`, { signal, cache: "no-store" });
    const value = await response.json() as { tasks?: Array<StudyAgentQueueTask & { detail: string }>; maps?: PaperMapView[]; error?: string };
    if (!response.ok || !Array.isArray(value.tasks)) throw new Error(value.error || "无法读取后台阅读状态");
    if (signal?.aborted || current !== generation.current) return;
    setTasks(value.tasks);
    setMaps(Array.isArray(value.maps) ? value.maps : []);
    const signature = value.tasks.map((task) => `${task.taskId}:${task.taskRevision}`).join(",");
    if (observed.current && observed.current !== signature) changed.current();
    observed.current = signature;
  }, [sessionId]);
  useEffect(() => {
    generation.current++;
    observed.current = "";
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await load(abort.signal); if (!abort.signal.aborted) setError(""); }
      catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [load]);
  const act = async (action: string, taskId?: string, priority?: number, expectedPriority?: number) => {
    setBusy(true); setError("");
    try {
      if (action === "retry" && taskId && !retries.current.has(taskId)) retries.current.set(taskId, crypto.randomUUID());
      const response = await fetch("/api/study-research/reading", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, sessionId, expectedPhaseRevision: phaseRevision, taskId, requestId: taskId ? retries.current.get(taskId) : undefined,
          sourceId: source?.sourceId, sourceHash: source?.contentHash, priority, expectedPriority }) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || "后台阅读操作失败");
      if (action === "retry" && taskId) retries.current.delete(taskId);
      await load(); changed.current();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <div className={styles.form}>
    <h4>后台理解论文</h4>
    <p className={styles.muted}>分段阅读并同步笔记与图谱。你可以继续在对话中提问，随时查看尚未确定的内容。</p>
    <div className={styles.readerButtons}>
      <button type="button" className={styles.buttonPrimary} disabled={busy || !source} onClick={() => void act("start")}>开始后台阅读</button>
      <button type="button" className={styles.button} disabled={busy} onClick={() => void act("reconnect")}>恢复后台连接</button>
    </div>
    {source && <p className={styles.muted}>{source.relativePath}</p>}
    {error && <p role="alert">{error}</p>}
    {tasks.length > 0 && <p>{tasks.filter((task) => task.status === "succeeded").length} / {tasks.length} 个片段已完成</p>}
    {maps.map(({ map, historical, reductions, plan }) => {
      const compiled = map?.paperMap;
      return <section className={styles.sourceCard} key={plan.mapGroupHash}>
      <strong>整篇学习地图</strong>
      {!plan.sourceCurrent && <p role="status">源文件已经更新；这份地图保留作审计记录，不能代表当前版本。</p>}
      {plan.sourceCurrent && !plan.ready && <p className={styles.muted}>等待所有本次阅读片段结束后自动综合。</p>}
      {plan.ready && !map && <p className={styles.muted}>{plan.coverage.completedReadingTaskIds.length===0?"本次没有可供综合的成功报告，请先处理阅读失败。":reductions.some(task=>terminal(task.status)&&task.status!=="succeeded")?"地图综合未完成；请在任务记录中查看失败或需要处理的原因。":"正在把已完成的分段报告逐层综合为全文地图。"}</p>}
      {reductions.filter(task=>terminal(task.status)&&task.status!=="succeeded").map(task=><p role="status" key={task.taskId}>地图任务 {task.taskId}：{statuses[task.status]??task.status}。不会自动重复不确定的模型调用。</p>)}
      {compiled && <>
        <p>{compiled.coverage.unavailableReadingTasks.length === 0 ? "已覆盖本次所有阅读报告。" : `部分地图：${compiled.coverage.unavailableReadingTasks.length} 个分段报告不可用。`}</p>
        {mapSections.map(([key, label]) => <details key={key}><summary>{label}</summary><p>{compiled.sections[key]}</p></details>)}
        {map.task.report && map.task.report.unresolved.length > 0 && <details><summary>仍待核实（{map.task.report.unresolved.length}）</summary><ul>{map.task.report.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      </>}
      {historical.length > 0 && <details><summary>历史地图（{historical.length}）</summary><p className={styles.muted}>这些记录保留原始报告链，不能代表当前阅读快照。</p>
        {historical.map((entry) => <p key={entry.task.taskId}>{entry.paperMap?.sections.problem ?? "结构化地图记录不完整"}</p>)}</details>}
    </section>;
    })}
    <ul className={styles.taskList}>{tasks.map((task) => <li className={styles.sourceCard} key={task.taskId}>
      <div className={styles.row}><strong>{statuses[task.status] ?? task.status}</strong>
        {!terminal(task.status) && <button type="button" className={styles.button} disabled={busy || !!task.cancelRequestedAt} onClick={() => void act("cancel", task.taskId)}>{task.cancelRequestedAt ? "正在取消" : "取消"}</button>}
      </div>
      {!task.report && <p className={styles.muted}>{task.detail}</p>}
      {["admitted", "queued"].includes(task.status) && <label className={styles.field}><span>阅读顺序（数值越大越优先，不打断当前阅读）</span>
        <select value={task.priority} disabled={busy} onChange={(event) => void act("priority", task.taskId, Number(event.target.value), task.priority)}>
          {Array.from(new Set([-100, 0, 100, task.priority])).sort((a, b) => a - b).map((priority) => <option value={priority} key={priority}>{priority === -100 ? "稍后阅读" : priority === 0 ? "通常顺序" : priority === 100 ? "优先阅读" : `优先级 ${priority}`}</option>)}
        </select></label>}
      {task.kind === "reading" && ["failed", "needs-input", "cancelled", "limit-reached"].includes(task.status) &&
        <button type="button" className={styles.button} disabled={busy} onClick={() => void act("retry", task.taskId)}>重新阅读这个片段</button>}
      {task.report && <><p>{task.report.summary}</p>
        {task.report.findings.filter((finding) => finding.severity !== "minor").map((finding, index) => <p key={index}>{finding.severity === "uncertain" ? "有待核实" : "需要注意"}：{finding.explanation}</p>)}
        {task.report.unresolved.length > 0 && <details><summary>尚未确定的内容（{task.report.unresolved.length}）</summary><ul>{task.report.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      </>}
    </li>)}</ul>
  </div>;
}
