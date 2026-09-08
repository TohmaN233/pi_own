import { notifySessionConfiguration } from "./session-configuration-events";
const pending = new Map<string, Promise<void>>();
export function ensureCourseBuilderRuntime(sessionId: string): Promise<void> {
  const previous = pending.get(sessionId);
  if (previous) return previous;
  const operation = (async () => {
    const response = await fetch("/api/course-builder/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceSessionId: sessionId }) });
    const value = await response.json() as { sessionId?: string; verified?: boolean; error?: string };
    if (!response.ok) throw new Error(value.error ?? "无法启动备课 Agent");
    if (value.sessionId !== sessionId || value.verified !== true) throw new Error("备课 Skills 没有通过运行时核验");
    notifySessionConfiguration(sessionId);
  })().finally(() => { pending.delete(sessionId); });
  pending.set(sessionId, operation);
  return operation;
}
