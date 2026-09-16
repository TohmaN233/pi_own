"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { StudyCodeCell } from "../../../../packages/study-execution-host/src/code-cells.ts";
import type { ExecutionResourceRequest } from "../../../../packages/study-execution-host/src/execution-queue.ts";
import type { StudyExecutionRun, StudyExecutionState } from "@/lib/study-execution-service";
import {
  appendExecutionNoticeHistory,
  collectExecutionNotices,
  executionLimitWarning,
  executionUsage,
  type StudyExecutionNotice,
} from "@/lib/study-execution-notices";
import styles from "@/app/study/Study.module.css";
import { StudyExecutionArtifacts } from "./StudyExecutionArtifacts";

const terminal = (status: string) => ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(status);
const statusLabels: Record<string, string> = { queued: "排队中", admitted: "准备环境", prepared: "快照已准备", launching: "正在启动",
  running: "运行中", reconciling: "正在核对进程", succeeded: "运行完成", failed: "运行失败", cancelled: "已取消", "limit-reached": "达到资源限制", "needs-input": "需要调整" };

async function requestExecution(sessionId: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/study-research/execution?sessionId=${encodeURIComponent(sessionId)}`, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, ...body }), signal }
    : { cache: "no-store", signal });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `执行请求失败：${response.status}`);
  return value;
}

type ExecutionContextValue = {
  state: StudyExecutionState | null;
  error: string | null;
  refresh: (signal?: AbortSignal) => Promise<void>;
  notices: readonly StudyExecutionNotice[];
  liveAnnouncement: string | null;
};

const ExecutionContext = createContext<ExecutionContextValue | null>(null);

/** Share one status request among every code cell in the project view. */
export function StudyExecutionProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [state, setState] = useState<StudyExecutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<StudyExecutionNotice[]>([]);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string | null>(null);
  const live = useRef(true);
  const sequence = useRef(0);
  const previousRuns = useRef<StudyExecutionState["runs"] | null>(null);
  const seenNoticeKeys = useRef<ReadonlySet<string>>(new Set());
  const initialized = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestSequence = ++sequence.current;
    const value = await requestExecution(sessionId, undefined, signal) as StudyExecutionState;
    if (!value || !Array.isArray(value.runs) || (!value.capacity?.defaults && typeof value.capacityError !== "string")) throw new Error("后台执行状态格式无效");
    if (signal?.aborted || !live.current || requestSequence !== sequence.current) return;
    const collection = collectExecutionNotices(previousRuns.current, value.runs, {
      initialized: initialized.current,
      seenKeys: seenNoticeKeys.current,
    });
    previousRuns.current = value.runs;
    seenNoticeKeys.current = collection.seenKeys;
    initialized.current = true;
    setState(value); setError(null);
    if (collection.added.length > 0) setNotices((current) => appendExecutionNoticeHistory(current, collection.added));
    if (collection.announcements.length > 0) setLiveAnnouncement(collection.announcements.map((notice) => notice.message).join(" "));
  }, [sessionId]);

  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { live.current = false; controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  return <ExecutionContext.Provider value={{ state, error, refresh, notices, liveAnnouncement }}>
    {liveAnnouncement && <p className={styles.severityInfo} aria-live="polite" aria-atomic="true">{liveAnnouncement}</p>}
    {children}
  </ExecutionContext.Provider>;
}

/** One resource panel and durable run list per cell. The original conversation stays available beside it. */
export function StudyCellExecution({ cell, sessionId, phaseRevision }: { cell: StudyCodeCell; sessionId: string; phaseRevision: number }) {
  const shared = useContext(ExecutionContext);
  if (!shared) throw new Error("Study execution context is required");
  const { state, refresh, notices } = shared;
  const [customResources, setResources] = useState<ExecutionResourceRequest | null>(null);
  const resources = customResources ?? state?.capacity?.defaults ?? null;
  const [packages, setPackages] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdentity = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function action(body: Record<string, unknown>) {
    setBusy(true); setError(null);
    try { await requestExecution(sessionId, { ...body, expectedPhaseRevision: phaseRevision }); await refresh(); return true; }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { if (live.current) setBusy(false); }
  }
  const runs = state?.runs.filter((run) => run.cellId === cell.cellId) ?? [];
  const runIds = new Set(runs.map((run) => run.queueJobId));
  const cellNotices = notices.filter((notice) => runIds.has(notice.queueJobId));
  const language = cell.language === "r" ? "R" : "Python";
  return <div className={styles.form}>
    <details><summary>运行设置：自动读取本机资源，可调整</summary>
      {resources && state?.capacity && <>
        <p className={styles.dim}>当前可用内存 {state.capacity.observed.availableMemoryMiB} MiB · {state.capacity.observed.logicalCores} 个逻辑 CPU。全项目共用后台队列。</p>
        <p className={styles.dim}>建议值为系统预留 CPU、内存和磁盘；可用资源变化时重新校验。</p>
        <div className={styles.row}>
          <label className={styles.field}>CPU 核数<input aria-label="CPU 核数" type="number" step="0.01" min={state.capacity.minimumCpuMilliCores / 1000} max={state.capacity.maximum.cpuMilliCores / 1000} value={resources.cpuMilliCores / 1000} onChange={(event) => setResources({ ...resources, cpuMilliCores: Math.round(Number(event.target.value) * 1000) })} /></label>
          <label className={styles.field}>内存 MiB<input aria-label="内存 MiB" type="number" min={64} max={state.capacity.maximum.memoryMiB} value={resources.memoryMiB} onChange={(event) => setResources({ ...resources, memoryMiB: Number(event.target.value) })} /></label>
          <label className={styles.field}>最长运行秒数<input aria-label="最长运行秒数" type="number" min={1} max={3600} value={resources.wallTimeMs / 1000} onChange={(event) => setResources({ ...resources, wallTimeMs: Number(event.target.value) * 1000 })} /></label>
          <label className={styles.field}>输出上限 MiB<input aria-label="输出上限 MiB" type="number" min={1} max={state.capacity.maximum.diskBytes / 1048576} value={resources.diskBytes / 1048576} onChange={(event) => setResources({ ...resources, diskBytes: Number(event.target.value) * 1048576 })} /></label>
        </div>
      </>}
      {cell.language === "r" && <label className={styles.field}>使用的额外 R 包（逗号分隔）<input aria-label="额外 R 包" value={packages} onChange={(event) => setPackages(event.target.value)} placeholder="例如 ggplot2, dplyr" /><span className={styles.dim}>读取本机已安装包及其依赖；基础 R 包自动包含。</span></label>}
      <p className={styles.dim}>代码中可用 parameters、inputs 和 output_directory。图形与写入输出目录的文件会保存在本次运行中。</p>
    </details>
    <p className={styles.dim}>当前环境：{language}。运行不会自动创建检查点或自动恢复；停止后仍保留已记录的日志和已写入的输出文件，但内容可能不完整。再次运行会新建一条运行记录，不会从上次继续。</p>
    <div className={styles.readerButtons}>
      <button type="button" className={styles.buttonPrimary} disabled={busy || !resources || !state?.capacity} onClick={async () => {
        if (!resources) return;
        const body = { action: "run", cellId: cell.cellId, expectedCellRevision: cell.revision, resources,
          rPackages: cell.language === "r" ? packages.split(/[,\s]+/u).filter(Boolean) : [] };
        const fingerprint = JSON.stringify({ ...body, phaseRevision });
        if (requestIdentity.current?.fingerprint !== fingerprint) requestIdentity.current = { fingerprint, requestId: crypto.randomUUID() };
        if (await action({ ...body, requestId: requestIdentity.current.requestId })) requestIdentity.current = null;
      }}>{busy ? "提交中…" : `运行 r${cell.revision}`}</button>
      <button type="button" className={styles.button} disabled={busy} onClick={() => void action({ action: "reconnect" })}>重新连接后台服务</button>
    </div>
    {(error || shared.error) && <p role="alert" className={styles.severityError}>{error || shared.error}</p>}
    {state?.capacityError && <p role="alert" className={styles.severityWarning}>暂时不能开始新运行：{state.capacityError}。已有运行仍可查看和取消。</p>}
    {cellNotices.length > 0 && <div className={styles.note} aria-label="运行事件历史">
      <strong>运行事件历史</strong>
      <ul className={styles.noteList}>{cellNotices.map((notice) => <li key={notice.key}>
        <span>{notice.message}</span> <time className={styles.dim} dateTime={notice.observedAt}>{new Date(notice.observedAt).toLocaleString()}</time>
      </li>)}</ul>
    </div>}
    {runs.length > 0 && <ul className={styles.noteList}>{runs.map((run) => <RunOutput key={run.queueJobId} sessionId={sessionId} run={run} busy={busy}
      cancel={() => void action({ action: "cancel", queueJobId: run.queueJobId })} />)}</ul>}
  </div>;
}

function RunOutput({ run, busy, cancel, sessionId }: { run: StudyExecutionRun; busy: boolean; cancel: () => void; sessionId: string }) {
  const usage = executionUsage(run);
  const limitWarning = executionLimitWarning(run);
  return <li className={styles.note}>
    <div className={styles.row}><strong>r{run.cellRevision} · {statusLabels[run.status] ?? run.status}</strong>
      {!terminal(run.status) && <button type="button" className={styles.button} disabled={busy || !!run.cancellationRequestedAt} onClick={cancel}>{run.cancellationRequestedAt ? "正在取消…" : "取消运行"}</button>}</div>
    <p className={styles.dim}>{new Date(run.createdAt).toLocaleString()} {usage && `· ${(usage.wallTimeMs / 1000).toFixed(2)} 秒运行时间 · 已观测输出 ${usage.diskBytes} 字节`}</p>
    {limitWarning && <p className={styles.severityWarning}>{limitWarning.message}</p>}
    {run.failure && <p role="alert" className={styles.severityError}>{run.failure.message}</p>}
    {run.result?.logs.error && <p className={styles.severityError}>{run.result.logs.error}</p>}
    {run.result?.logs.stdout && <pre aria-label="标准输出" className={styles.codeBlock}>{run.result.logs.stdout}</pre>}
    {run.result?.logs.stderr && <pre aria-label="错误输出" className={styles.codeBlock}>{run.result.logs.stderr}</pre>}
    {terminal(run.status) && run.status !== "needs-input" && <StudyExecutionArtifacts sessionId={sessionId} queueJobId={run.queueJobId} />}
    {run.status === "succeeded" && <p className={styles.dim}>程序已结束；这条记录保留实际结果，尚不代表结论已验证。</p>}
  </li>;
}
