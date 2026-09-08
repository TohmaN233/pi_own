"use client";
import { useEffect, useRef, useState } from "react";
import type { AgentMessage } from "@/lib/types";

function latestSavedPlan(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "toolResult" || message.toolName !== "course_builder" || message.isError) continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      let saved: { semesterPlanId?: string; lessonPlanId?: string; revision?: number };
      try { saved = JSON.parse(block.text); } catch { continue; } // Non-draft tool replies are also plain text.
      // Only the first semester draft has an automatic prompt; lesson saves and
      // later revisions must not reopen it when historical messages reload.
      if (saved?.semesterPlanId && !saved.lessonPlanId && typeof saved.revision === "number") return saved.revision === 1 ? saved.semesterPlanId : null;
    }
  }
  return null;
}

export function CourseReviewShortcut({ sessionId, messages }: { sessionId: string; messages: AgentMessage[] }) {
  const version = latestSavedPlan(messages);
  const [visible, setVisible] = useState(false);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!version || handled.current === version) return;
    handled.current = version;
    try {
      const key = `pi-course-review-shown:${version}`;
      if (window.localStorage.getItem(key) || window.localStorage.getItem(`pi-course-review-dismissed:${sessionId}`)) return;
      window.localStorage.setItem(key, "1");
      setVisible(true);
    } catch (error) { console.error("[course-builder] cannot persist one-time review prompt", error); }
  }, [version, sessionId]);
  if (!version || !visible) return null;
  return <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
    <a href={`/course-builder?sessionId=${encodeURIComponent(sessionId)}#semester-plan`} style={{ flex: 1, color: "var(--accent)", fontWeight: 600 }}>打开课程计划与教师审阅 →</a>
    <button type="button" aria-label="关闭计划审阅提示" title="关闭提示；以后可从工作区主动打开审阅" onClick={() => setVisible(false)} style={{ cursor: "pointer", padding: "2px 8px", color: "var(--text-muted)", fontSize: 20 }}>×</button>
  </div>;
}
