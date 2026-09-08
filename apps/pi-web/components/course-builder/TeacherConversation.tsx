"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import { SkillsConfig } from "@/components/SkillsConfig";
import { ensureCourseBuilderRuntime } from "@/lib/course-builder-runtime-client";
import { notifySessionConfiguration } from "@/lib/session-configuration-events";
import type { SessionInfo } from "@/lib/types";
import type { ChatInputHandle } from "@/components/ChatInput";
import { ProjectConversations } from "@/components/projects/ProjectConversations";

export function TeacherConversation({ sessionId, onOpenFile }: { sessionId: string; onOpenFile: (path: string, cwd?: string) => void }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<"chat" | "settings">("chat");
  const input = useRef<ChatInputHandle | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError("");
    void (async () => {
      await ensureCourseBuilderRuntime(sessionId);
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      const value = await response.json() as { info?: SessionInfo; error?: string };
      if (!response.ok || !value.info) throw new Error(value.error ?? "无法读取备课对话");
      if (!cancelled) setSession(value.info);
    })().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [sessionId, attempt]);
  const settled = useCallback(() => { notifySessionConfiguration(sessionId); }, [sessionId]);
  const openFile = useCallback((path: string) => { onOpenFile(path, session?.cwd); }, [onOpenFile, session?.cwd]);
  return <aside className="teacher-conversation" aria-label="备课 Agent 对话">
    <header><strong>备课 Agent</strong><div role="tablist" aria-label="Agent 面板"><button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>对话</button><button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>Skills 与提示词</button></div></header>
    <ProjectConversations sessionId={sessionId}/>
    {error ? <div role="alert" className="teacher-agent-error"><p>{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>重试启动 Agent</button><p>已保存的课程仍可在左侧编辑。</p></div> : !session ? <p className="teacher-agent-loading" role="status">正在加载备课模式、Skills 和原会话…</p> : <>
      <div className="teacher-agent-chat" style={{ display: tab === "chat" ? "flex" : "none" }}><ChatWindow key={session.id} session={session} newSessionCwd={null} newSessionDraftKey={null} chatInputRef={input} onAgentEnd={settled} onOpenFile={openFile} soundEnabled={false}/></div>
      <div className="teacher-agent-settings" style={{ display: tab === "settings" ? "block" : "none" }}>{tab === "settings" && <SkillsConfig sessionId={sessionId} cwd={session.cwd} embedded section="all" onClose={() => setTab("chat")}/>}</div>
    </>}
    <style>{`
      .teacher-conversation { display:flex; flex-direction:column; min-width:0; min-height:0; height:100%; border-left:1px solid var(--border); background:var(--bg); }
      .teacher-conversation>header { min-height:55px; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 16px; border-bottom:1px solid var(--border); }
      .teacher-conversation>header button, .teacher-agent-error button { padding:7px 10px; color:var(--text-muted); background:var(--bg-panel); border:1px solid var(--border); border-radius:6px; cursor:pointer; }
      .teacher-conversation>header button[aria-selected=true] { color:var(--accent); background:var(--bg-selected); }
      .teacher-agent-chat, .teacher-agent-settings { flex:1; min-height:0; min-width:0; overflow:hidden; flex-direction:column; }
      .teacher-agent-loading, .teacher-agent-error { padding:20px; color:var(--text-muted); }
      .teacher-agent-error { color:#ef8354; overflow-wrap:anywhere; }
    `}</style>
  </aside>;
}
