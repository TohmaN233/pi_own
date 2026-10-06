"use client";

import { useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { normalizeToolCalls } from "@/lib/normalize";
import { workflowFeedback, workflowExecutorLabel, workflowStatusLabel, workflowActivityLabel, type WorkflowInspection, type WorkflowExcerpt } from "@/lib/workflow-card-state";
import type { AgentMessage, CustomMessage, ToolResultMessage } from "@/lib/types";
import styles from "./WorkflowRunCard.module.css";

type RenderMessage = (message: AgentMessage, tools: Map<string, ToolResultMessage>) => ReactNode;
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted", "paused", "blocked", "awaiting_acceptance"]);

function Excerpt({ value }: { value: WorkflowExcerpt | null | undefined }) {
  return value ? <><pre className={styles.source}>{value.text}</pre>{value.truncated && <p className={styles.muted}>内容过长，当前显示前 64,000 字符。</p>}</> : null;
}

function ExecutionUserMessage({ message, renderMessage, tools }: { message: AgentMessage; renderMessage: RenderMessage; tools: Map<string, ToolResultMessage> }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>收到的任务 / 后续输入</summary>{open && renderMessage(message, tools)}</details>;
}

export function WorkflowRunCard({ message, sessionId, cwd, onOpenFile, renderMessage }: {
  message: CustomMessage; sessionId?: string; cwd?: string; onOpenFile?: (path: string) => void; renderMessage: RenderMessage;
}) {
  const feedback = workflowFeedback(message);
  const runId = feedback?.run_id, runStatus = feedback?.status;
  const [expanded, setExpanded] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const [sessionIndex, setSessionIndex] = useState(0);
  const [tab, setTab] = useState<"task" | "reply">("reply");
  const [snapshot, setSnapshot] = useState<{ key: string; value: WorkflowInspection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [older, setOlder] = useState<{ key: string; messages: { id: string; message: AgentMessage }[]; before: number | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const generation = useRef({ epoch: 0 });
  const selection = `${feedback?.run_id}/${nodeId}/${attemptId}/${sessionIndex}`;
  const data = snapshot?.key === selection ? snapshot.value : null;
  const nodes = data?.nodes ?? feedback?.nodes ?? [];
  const node = nodes.find(item => item.id === nodeId);
  const detail = data?.detail;
  const messages = useMemo(() => {
    const latest = detail?.transcript?.messages ?? [];
    const earlier = older?.key === selection ? older.messages : [];
    const seen = new Set<string>();
    return [...earlier, ...latest].filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; })
      .map(item => ({ ...item, message: normalizeToolCalls(item.message) }));
  }, [detail?.transcript?.messages, older, selection]);
  const tools = useMemo(() => new Map(messages.filter(item => item.message.role === "toolResult")
    .map(item => [((item.message as ToolResultMessage).toolCallId), item.message as ToolResultMessage])), [messages]);
  const pairedTools = useMemo(() => new Set(messages.flatMap(item => item.message.role === "assistant"
    ? item.message.content.filter(block => block.type === "toolCall").map(block => block.toolCallId) : [])), [messages]);

  useEffect(() => {
    if (!expanded || !runId || !sessionId) return;
    const controller = new AbortController();
    const tracker = generation.current, epoch = ++tracker.epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const query = new URLSearchParams({ sessionId, runId });
      if (nodeId) query.set("nodeId", nodeId);
      if (attemptId) query.set("attemptId", attemptId);
      query.set("sessionIndex", String(sessionIndex));
      try {
        const response = await fetch(`/api/workflows/run?${query}`, { signal: controller.signal, cache: "no-store" });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
        if (value.run_id !== runId || !Array.isArray(value.nodes)) throw new Error("Invalid Workflow execution response");
        if (controller.signal.aborted || tracker.epoch !== epoch) return;
        setSnapshot({ key: selection, value }); setError(null);
        if (!nodeId && !value.process_cleaned) {
          const candidates = value.nodes as WorkflowInspection["nodes"];
          const selected = candidates?.find(item => ["running", "claimed", "ready", "blocked", "failed"].includes(item.status))
            ?? candidates?.findLast(item => item.type !== "start" && item.type !== "end" && item.status !== "skipped");
          if (selected) { setNodeId(selected.id); return; }
        }
        if (!value.process_cleaned && !terminal.has(value.status)) timer = setTimeout(load, 3000);
      } catch (cause) {
        if (!controller.signal.aborted && tracker.epoch === epoch) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => { controller.abort(); tracker.epoch++; if (timer) clearTimeout(timer); };
  // Compact updates do not restart an in-flight transcript read.
  }, [expanded, runId, runStatus, sessionId, nodeId, attemptId, sessionIndex, selection, retry]);

  if (!feedback) return <div className={styles.card}><p role="alert">Workflow 状态缺少有效 Run 信息。</p></div>;
  const status = data?.status ?? feedback.status;
  const active = nodes.filter(item => ["running", "claimed"].includes(item.status));
  const activity = active.map(workflowActivityLabel).join("、")
    || feedback.active_nodes?.join("、");
  const cursor = older?.key === selection ? older.before : detail?.transcript?.before;
  const selectNode = (id: string) => { setNodeId(id); setAttemptId(""); setSessionIndex(0); setOlder(null); setError(null); setLoadingOlder(false); };
  const loadEarlier = async () => {
    if (!sessionId || cursor === undefined || cursor === null) return;
    const epoch = generation.current.epoch;
    setLoadingOlder(true);
    try {
      const query = new URLSearchParams({ sessionId, runId: feedback.run_id, nodeId, sessionIndex: String(sessionIndex), before: String(cursor) });
      if (attemptId || detail?.attempt_id) query.set("attemptId", attemptId || detail!.attempt_id!);
      const response = await fetch(`/api/workflows/run?${query}`, { cache: "no-store" });
      const value = await response.json() as WorkflowInspection & { error?: string };
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      if (generation.current.epoch !== epoch) return;
      const transcript = value.detail?.transcript;
      if (!transcript) throw new Error("Execution transcript is unavailable");
      setOlder({ key: selection, messages: [...transcript.messages, ...(older?.key === selection ? older.messages : [])], before: transcript.before });
    } catch (cause) { if (generation.current.epoch === epoch) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current.epoch === epoch) setLoadingOlder(false); }
  };
  return <section className={styles.card} aria-label={`Workflow ${feedback.workflow_name}`}>
    <button type="button" className={styles.header} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className={styles.icon} aria-hidden="true">◇</span>
      <span className={styles.heading}><strong>{feedback.workflow_name}</strong><span>{activity || `已完成 ${feedback.completed}/${feedback.total} 个节点`}</span></span>
      <span className={styles.status} data-status={status}>{workflowStatusLabel(status)}</span>
      <span className={styles.chevron} data-expanded={expanded} aria-hidden="true">›</span>
    </button>
    {expanded && <div className={styles.expanded}>
      {!sessionId && <p role="alert">缺少当前对话 ID，无法读取执行记录。</p>}
      {error && <div className={styles.error} role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试读取</button></div>}
      {data?.process_cleaned ? <div className={styles.content}><p>运行过程已按保留策略清理，成果仍保留。</p>{data.result && <details><summary>查看保存的结果</summary><Excerpt value={data.result} /></details>}</div> : <>
        <nav className={styles.nodes} aria-label="Workflow 节点">
          {nodes.filter(item => item.type !== "start" && item.type !== "end" && (showSkipped || item.status !== "skipped")).map(item => <button type="button" key={item.id} aria-pressed={item.id === nodeId}
            className={styles.node} data-status={item.status} onClick={() => selectNode(item.id)}>
            <span>{item.tool || item.name}</span><small>{workflowStatusLabel(item.status)}</small>
          </button>)}
          {nodes.some(item => item.status === "skipped") && <button type="button" className={styles.node} aria-pressed={showSkipped} onClick={()=>setShowSkipped(value=>!value)}>{showSkipped ? "收起未选中节点" : `未选中分支 (${nodes.filter(item=>item.status === "skipped").length})`}</button>}
          {data?.loops?.map(loop => <span key={loop.id} className={styles.muted}>{loop.id} · 第 {loop.round} 轮 · {workflowStatusLabel(loop.status)}</span>)}
        </nav>
        <div className={styles.execution}>
          {node && <div className={styles.identity}><strong>{node.tool || node.name}</strong><span>{workflowExecutorLabel(node)}</span>
            <span title={node.model_source === "observed" ? "实际执行模型" : "运行时固定模型配置"}>{node.model ? `${node.model.model_id}${node.model.thinking ? ` · ${node.model.thinking}` : ""}` : node.executor === "main" || node.executor.includes("main") ? "继承当前对话模型" : ""}</span>
          </div>}
          <div className={styles.toolbar}>
            <button type="button" aria-pressed={tab === "task"} onClick={() => setTab("task")}>任务</button>
            <button type="button" aria-pressed={tab === "reply"} onClick={() => setTab("reply")}>执行与回复</button>
            {detail && detail.attempts.length > 1 && <select aria-label="执行尝试" value={attemptId || detail.attempt_id || ""}
              onChange={event => { setAttemptId(event.target.value); setSessionIndex(0); setOlder(null); setLoadingOlder(false); }}>
              {detail.attempts.map((attempt, index) => <option key={attempt.id} value={attempt.id}>第 {index + 1} 次{attempt.rounds?.map(loop=>` · ${loop.id} 第 ${loop.round} 轮`).join("")} · {workflowStatusLabel(attempt.status)}</option>)}
            </select>}
            {detail && detail.session_count > 1 && <select aria-label="执行会话" value={sessionIndex} onChange={event => { setSessionIndex(Number(event.target.value)); setOlder(null); setLoadingOlder(false); }}>
              {Array.from({ length: detail.session_count }, (_, index) => <option key={index} value={index}>会话 {index + 1}</option>)}
            </select>}
          </div>
          <div className={styles.content} aria-live="polite">
            {!data && !error && <p className={styles.muted}>正在读取真实执行记录…</p>}
            {tab === "task" && detail && <>
              <p className={styles.muted}>{detail.instruction_kind === "actual" ? "执行会话实际收到的任务" : "节点指令模板；此节点尚无独立会话任务记录"}</p>
              <Excerpt value={detail.instruction} />
              {!!detail.resources.length && <p className={styles.muted}>已声明资料：{detail.resources.join("、")}</p>}
              {detail.host_tool && <p>Host 工具：{detail.host_tool.tool} · {detail.host_tool.phase}{detail.host_tool.input_summary ? ` · 输入字段：${detail.host_tool.input_summary.keys.join("、")}` : ""}</p>}
            </>}
            {tab === "reply" && detail && <>
              {cursor !== null && cursor !== undefined && <button type="button" onClick={() => void loadEarlier()} disabled={loadingOlder}>{loadingOlder ? "读取中…" : "加载更早的执行记录"}</button>}
              {messages.map(item => item.message.role === "toolResult" ? !pairedTools.has(item.message.toolCallId) && <details key={item.id}><summary>{item.message.toolName || "工具返回"}{item.message.isError ? " · 错误" : ""}</summary><Excerpt value={{ text: item.message.content.filter(block => block.type === "text").map(block => block.text).join("\n"), truncated: false }} /></details>
                : item.message.role === "user" ? <ExecutionUserMessage key={item.id} message={item.message} tools={tools} renderMessage={renderMessage} />
                : <div key={item.id}>{renderMessage(item.message, tools)}</div>)}
              {detail.transcript?.pending && <p className={styles.muted}>{detail.transcript.unpersisted ? "Pi 尚未保存首条完整回复，当前活动见执行事件；保存后会自动显示对话。" : "执行会话正在写入，下一次刷新后显示完整消息。"}</p>}
              {!messages.length && <>
                {!!detail.events.length && <ol className={styles.events}>{detail.events.map(event => <li key={event.sequence}><strong>{String(event.metadata.tool ?? event.kind)}</strong> · {String(event.metadata.phase ?? event.metadata.status ?? "已记录")}{typeof event.metadata.diagnostic === "string" && <span> · {event.metadata.diagnostic}</span>}</li>)}</ol>}
                {detail.events_total > detail.events.length && <p className={styles.muted}>显示最近 {detail.events.length}/{detail.events_total} 条执行事件。</p>}
                {detail.result && <details open={!/^[\[{]/.test(detail.result.text.trim())}><summary>节点结果</summary><Excerpt value={detail.result} /></details>}
                {!detail.events.length && !detail.result && <p className={styles.muted}>{node?.status === "pending" || node?.status === "skipped" ? "此节点尚未执行。" : "尚无工具调用或回复记录。"}</p>}
              </>}
              {detail.error && <p className={styles.error}>{detail.error.code} · {detail.error.message}</p>}
              {detail.child_run_id && <WorkflowRunCard key={detail.child_run_id} message={{ ...message, details: { run_id: detail.child_run_id, workflow_name: `${node?.name ?? "子流程"} · 子 Workflow`, status: node?.status ?? "running", completed: 0, total: 0, active_nodes: [], files: [] } }} sessionId={sessionId} cwd={cwd} onOpenFile={onOpenFile} renderMessage={renderMessage} />}
            </>}
          </div>
        </div>
      </>}
      {!!feedback.files?.length && <div className={styles.files}><MarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{feedback.files.map(path => `[${path.split(/[\\/]/).at(-1)?.replace(/[\[\]]/g, "")}](${`<${path.replaceAll("\\", "/").replaceAll(">", "%3E")}>`})`).join("\n\n")}</MarkdownBody></div>}
    </div>}
  </section>;
}
