"use client";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";
import type { WorkspacePreviewTarget } from "@/lib/workspace-preview";
import styles from "./CourseWorkflowTaskControl.module.css";
import { courseWorkflowStartLabel, courseWorkflowLaunchCanRetry, type CourseWorkflowLaunchRecord } from "@/lib/course-workflow-launch-state";

type ProductAction = import("@/lib/course-workflow-tasks").CourseWorkflowProductAction;
export type CourseWorkflowLaunch = { productAction: ProductAction; task: string; course?: true; assignmentId?: string; lessonId?: string; week?: number; session?: number; materialIds?: string[]; attachmentIds?: string[]; baselineTaskId?: string };
export type CourseWorkflowTaskControlHandle = { launch: (input: CourseWorkflowLaunch) => Promise<void> };
type Task = CourseWorkflowLaunchRecord & { taskId: string; workflowId: string; productAction?: ProductAction; product?: string; operation?: string; kind: string; target: { course?: true; assignmentId?: string; lessonId?: string; week?: number; session?: number }; week?: number; session?: number;
  materialIds: string[]; attachmentIds?: string[]; task: string; workspace: string; createdAt: string };
type Catalog = { workflow: { id?: string; ready: boolean; disabledReason: string | null }; products: { id: ProductAction; title: string; kind: string; scope: string; ready: boolean; disabledReason: string | null }[];
  slides: { lessonId: string; week: number; session: number; deckId?: string; title?: string; disabledReason: string | null }[]; tasks: Task[] };
type Status = Task & { teacherReviewPending: true; revisionReconciliation?: {status:string;diagnostic?:string}; files: { path: string; name: string; bytes: number; sha256: string; verification: "verified" | "modified" | "missing"; diagnostic?: string }[];
  run: null | { runId: string; status: string; error?: unknown; nodes: { id: string; status: string; error?: unknown }[] } };
const finished = new Set(["succeeded", "failed", "cancelled"]);
const labels: Record<string,string> = { running: "运行中", succeeded: "已完成", failed: "失败", cancelled: "已取消", paused: "已暂停", blocked: "需要处理", pending: "待运行", claimed: "已领取", ready: "待执行" };
const label = (value: string) => labels[value] ?? value;
const productTitle = (id: string | undefined, fallback: string) => id === "course-lesson-artifacts" ? "教案、课件与实验组合"
  : id === "course-lesson-plan" ? "单课教案" : fallback;
function diagnostic(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value); }
async function request<T>(sessionId: string, args?: Record<string,unknown>, taskId?: string, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams({sessionId, ...(taskId ? {taskId} : {})});
  const response = await fetch(`/api/course-builder/workflows${args ? "" : `?${query}`}`, {
    method: args ? "POST" : "GET", cache: "no-store", signal,
    headers: {"x-course-builder-teacher":"1", ...(args ? {"content-type":"application/json"} : {})},
    ...(args ? {body:JSON.stringify({sessionId,...args})} : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Course Workflow HTTP ${response.status}`);
  return body as T;
}

export function CourseWorkflowTaskControl({ sessionId, controlRef, onRefresh, additionalRequirements = "" }: {
  sessionId: string; controlRef: React.Ref<CourseWorkflowTaskControlHandle>; onRefresh: () => Promise<unknown>; additionalRequirements?: string;
}) {
  const completed = useRef(new Set<string>());
  const refreshRef = useRef(onRefresh); refreshRef.current = onRefresh;
  const [catalog,setCatalog] = useState<Catalog | null>(null), [taskId,setTaskId] = useState("");
  const [status,setStatus] = useState<Status | null>(null), [working,setWorking] = useState(false), [error,setError] = useState("");
  const [preview,setPreview] = useState<WorkspacePreviewTarget | null>(null);
  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    const next = await request<Catalog>(sessionId,undefined,undefined,signal);
    if (!signal?.aborted) setCatalog(next);
    return next;
  },[sessionId]);
  useEffect(() => {
    const controller = new AbortController(); setCatalog(null); setError(""); setTaskId(""); setStatus(null);
    void loadCatalog(controller.signal).then(next => {
      if (!controller.signal.aborted) setTaskId(next.tasks[0]?.taskId ?? "");
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  },[loadCatalog]);
  useEffect(() => {
    setStatus(null);
    if (!taskId) return;
    const controller = new AbortController();
    const refresh = () => void request<Status>(sessionId,undefined,taskId,controller.signal).then(next => {
      if (!controller.signal.aborted) { setStatus(next); setError(""); if (next.run && finished.has(next.run.status)) { clearInterval(timer); if (!completed.current.has(next.run.runId)) { completed.current.add(next.run.runId); void refreshRef.current().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); } } }
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : String(cause)); clearInterval(timer); } });
    const timer = setInterval(refresh,3000); refresh();
    return () => { controller.abort(); clearInterval(timer); };
  },[sessionId,taskId]);
  const selected = catalog?.tasks.find(task => task.taskId === taskId);
  const perform = async (action: () => Promise<void>) => { setWorking(true); setError(""); try { await action(); } catch(cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setWorking(false); } };
  const launch = useCallback(async (input: CourseWorkflowLaunch) => {
    if (working) throw new Error("请等待当前任务启动操作完成。");
    setWorking(true); setError("");
    try {
      const current = await loadCatalog();
      if (!current.workflow.ready) throw new Error(current.workflow.disabledReason ?? "备课流程未安装或尚未 Ready。");
      const product = current.products.find(item => item.id === input.productAction);
      if (!product?.ready) throw new Error(product?.disabledReason ?? "所选生成内容暂不可用。");
      const task = await request<Task>(sessionId, {action:"prepare", ...input});
      setTaskId(task.taskId);
      try { await request(sessionId,{action:"run",taskId:task.taskId}); }
      finally { await loadCatalog(); setStatus(await request<Status>(sessionId,undefined,task.taskId)); }
      await refreshRef.current();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { setWorking(false); }
  }, [working, loadCatalog, sessionId]);
  useImperativeHandle(controlRef, () => ({ launch }), [launch]);
  const openFile = (path: string) => setPreview({kind:"file",path,cwd:status?.workspace ?? selected?.workspace});
  const availableTasks = catalog?.tasks ?? [];
  const selectedProduct = catalog?.products.find(item => item.id === (selected?.productAction ?? selected?.workflowId))
    ?? catalog?.products.find(item => item.kind === (selected?.product ?? selected?.kind));
  return <div className={styles.control} aria-label="课程生成任务">
    <p className={styles.hint}>各项生成操作使用统一备课流程。已有产物会作为修订基线，完成后保留待教师审阅状态。</p>
    {catalog && !catalog.workflow.ready && <p className={styles.hint}>备课流程：{catalog.workflow.disabledReason}</p>}
    {availableTasks.length > 0 && <label className={styles.selector}>任务记录<select value={taskId} disabled={working} onChange={event => {setTaskId(event.target.value);setError("");}}>
      <option value="">选择任务</option>
      {availableTasks.map(task => <option key={task.taskId} value={task.taskId}>{new Date(task.createdAt).toLocaleString()} · {productTitle(task.productAction ?? task.workflowId,catalog?.products.find(item => item.id === (task.productAction ?? task.workflowId))?.title ?? catalog?.products.find(item => item.kind === (task.product ?? task.kind))?.title ?? task.kind)} · {courseWorkflowStartLabel(task)} · {task.taskId.slice(0,8)}</option>)}
    </select></label>}
    {selected && !selected.runId && <p className={styles.hint}>待启动记录的要求：{selected.task}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {status?.revisionReconciliation?.diagnostic && <p role="alert" className={styles.error}>{status.revisionReconciliation.diagnostic}</p>}
    {status?.legacyStartRecord && <p className={styles.hint}>这是旧版启动记录；原诊断已保留，确认状态以准确 Run 核验为准。</p>}
    {status?.runId && status.startState === "intent" && <p role="status" className={styles.hint}>正在启动并核验任务；刷新不会中断启动。</p>}
    {status?.runId && status.startState === "refused" && <p role="status" className={styles.hint}>此任务在执行前被拒绝，没有运行。修复后可直接重试，原要求和素材仍保留。</p>}
    {status?.runId && status.startState !== "confirmed" && status.startState !== "intent" && status.startState !== "refused" && <p role="alert" className={styles.error}>{courseWorkflowStartLabel(status)}。已保留 Run ID {status.runId}；当前查不到 Run 不证明此前没有执行或产生效果，不能重复启动此任务。</p>}
    {status?.startError && status.startState !== "refused" && <p role="alert" className={styles.error}>{status.startState === "confirmed" ? "已确认此 Run；保留此前启动诊断：" : "启动诊断："}{diagnostic(status.startError)}</p>}
    {selected && status && (!status.runId || courseWorkflowLaunchCanRetry(status)) && <button className={styles.launch} type="button" disabled={working || !catalog?.workflow.ready} onClick={() => void perform(async () => {
      try { await request(sessionId,{action:"run",taskId}); }
      finally { await loadCatalog(); setStatus(await request<Status>(sessionId,undefined,taskId)); }
      await refreshRef.current();
    })}>{status.runId ? "重试此任务" : "启动此任务"}</button>}
    {status?.startState === "refused" && <details><summary>查看上次启动诊断</summary>
      <p className={styles.error}>启动诊断：{diagnostic(status.startError)}</p>
      <p className={styles.error}>Run 核验诊断：{diagnostic(status.startLookupError)}</p>
    </details>}
    {status?.startLookupError && status.startState !== "refused" && <p role="alert" className={styles.error}>Run 核验诊断：{diagnostic(status.startLookupError)}</p>}
    {status?.run && <div className={styles.status} aria-live="polite">
      <p><strong>{label(status.run.status)}</strong> · <code>{status.run.runId}</code></p>
      <p className={styles.hint}>流程完成与编译成功不会自动批准教案。</p>
      {Boolean(status.run.error) && <p role="alert" className={styles.error}>{diagnostic(status.run.error)}</p>}
      <ul>{status.run.nodes.map(node => <li key={node.id}><code>{node.id}</code> · {label(node.status)}{Boolean(node.error) && <span className={styles.error}> · {diagnostic(node.error)}</span>}</li>)}</ul>
      {status.files.length > 0 && <ul aria-label="此 Run 的产物及凭据核验状态">{status.files.map(file => <li key={file.path}><button type="button" disabled={file.verification === "missing"} onClick={() => openFile(file.path)}>{file.name}</button> <small>{Math.ceil(file.bytes / 1024)} KB · {file.verification === "verified" ? "匹配此 Run 凭据" : file.verification === "modified" ? "已修改" : "文件不存在"}</small>{file.diagnostic && <p className={styles.error}>{file.diagnostic}</p>}</li>)}</ul>}
      {!finished.has(status.run.status) && <button type="button" disabled={working} onClick={() => void perform(async () => {await request(sessionId,{action:"cancel",taskId});setStatus(await request<Status>(sessionId,undefined,taskId));})}>取消此 Run</button>}
      {status.run.status === "failed" && selected?.target && selectedProduct && <>
        <p className={styles.hint}>修复会创建新任务，并明确引用当前选中的历史任务产物。Host 会核验保存凭据，不会改写历史 Run。</p>
        <button type="button" disabled={working} onClick={() => void perform(() => launch({productAction:selectedProduct.id,...selected.target,
          materialIds:selected.materialIds,attachmentIds:selected.attachmentIds,baselineTaskId:selected.taskId,
          task:`基于此任务已保存的产物和编译诊断修复，保留有效内容与样式。原要求：${selected.task}${additionalRequirements.trim() ? `\n教师额外要求：${additionalRequirements.trim()}` : ""}`}))}>修复此任务已保存的产物</button>
      </>}
    </div>}
    <button className={styles.cleanup} type="button" disabled={working} onClick={() => void perform(async()=>{await request(sessionId,{action:"cleanup"});setTaskId("");setStatus(null);await loadCatalog();})}>清理已结束记录</button>
    <p className={styles.hint}>失败记录在执行进程关闭后清理，完成记录默认保留 24 小时。中断与待确认记录保留以便恢复；成果仍可打开。</p>
    {preview && <WorkspaceFilePreview target={preview} sessionId={sessionId} onClose={() => setPreview(null)} onOpenFile={openFile}/>}
  </div>;
}
