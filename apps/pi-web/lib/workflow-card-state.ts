import type { AgentMessage, CustomMessage } from "./types";

export interface WorkflowNodeStatus {
  id: string; name: string; type: string; status: string; executor: string; tool?: string | null;
  main_mode: string | null;
  model: { provider: string; model_id: string; thinking?: string } | null;
  model_source: string | null; attempt_id: string | null; attempts: number; session_count: number;
  activity: { kind: string; tool?: string; phase?: string; status?: string } | null;
  event_count: number; started_at: string | null; finished_at: string | null;
  error: { message?: string; code?: string } | null;
}
export interface WorkflowFeedback {
  run_id: string; workflow_name: string; status: string; label: string;
  completed: number; total: number; active_nodes: string[]; files: string[];
  nodes?: WorkflowNodeStatus[];
}
export interface WorkflowExcerpt { text: string; truncated: boolean }
export interface WorkflowInspection extends WorkflowFeedback {
  process_cleaned: boolean; cleaned_at?: string; result?: WorkflowExcerpt;
  loops?: { id: string; status: string; round: number }[];
  detail?: {
    node_id: string; attempt_id: string | null;
    attempts: { id: string; status: string; started_at?: string; finished_at?: string; rounds?: { id: string; round: number }[] }[];
    session_count: number; session_index: number;
    instruction: WorkflowExcerpt | null; instruction_kind: "template" | "actual";
    resources: string[];
    events: { sequence: number; kind: string; metadata: Record<string, unknown> }[];
    events_total: number;
    host_tool: { tool: string; phase: string; status?: string; input_summary?: { keys: string[]; bytes: number } } | null;
    result: WorkflowExcerpt | null; error: { message?: string; code?: string } | null;
    child_run_id: string | null;
    transcript: { messages: { id: string; message: AgentMessage }[]; before: number | null; pending: boolean; prompt: WorkflowExcerpt | null; unpersisted?: boolean } | null;
  };
}

export function workflowFeedback(message: CustomMessage): WorkflowFeedback | null {
  const details = message.details as Partial<WorkflowFeedback> | undefined;
  return details && typeof details.run_id === "string" && typeof details.workflow_name === "string"
    && typeof details.status === "string" ? details as WorkflowFeedback : null;
}

/** Keep a Run at its first visible position, while displaying its latest facts. */
export function workflowCardEntries(messages: AgentMessage[]) {
  const result = new Map<string, { first: number; message: CustomMessage }>();
  messages.forEach((message, index) => {
    if (message.role !== "custom" || message.customType !== "pi-caw:status") return;
    const runId = (message.details as { run_id?: unknown } | undefined)?.run_id;
    if (typeof runId !== "string") return;
    const prior = result.get(runId);
    result.set(runId, { first: prior?.first ?? index, message });
  });
  return result;
}

export const workflowStatusLabel = (status: string) => ({ pending: "待执行", ready: "待启动", claimed: "正在启动", running: "运行中",
  succeeded: "已完成", failed: "失败", skipped: "未选中", cancelled: "已取消", interrupted: "已中断", blocked: "等待处理",
  paused: "已暂停", awaiting_acceptance: "等待确认", accepted: "已通过", rejected: "待返修", exhausted: "轮次耗尽" }[status] ?? status);
export const workflowExecutorLabel = (node: WorkflowNodeStatus) => ({ "pi-isolated-main": "Main · 独立上下文", "pi-current-chat-main": "Main · 当前对话",
  "pi-sdk-subagent": "Pi 执行会话", "pi-sdk-authoring-review": "独立审阅", main: node.main_mode === "orchestration" ? "Main · 当前对话" : "Main worker",
  provider: "Pi 执行会话", thread: "连续执行会话", tool: "Host 工具", control: "流程判断" }[node.executor] ?? node.executor);

export function workflowActivityLabel(node: WorkflowNodeStatus) {
  const activity = node.activity;
  if (!activity) return node.name;
  const phase = ({ dispatch_started: "正在请求模型", message_started: "开始回复", thinking: "思考中", responding: "输出中", started: "执行中",
    completed: "完成", failed: "失败", message_completed: "回复已保存", closed: "会话已结束" }[activity.phase ?? activity.status ?? ""]);
  return `${node.name}${activity.tool && activity.tool !== "model" ? ` · ${activity.tool}` : ""}${phase ? ` · ${phase}` : ""}`;
}
