"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import { SkillsConfig } from "@/components/SkillsConfig";
import { ProjectConversations } from "@/components/projects/ProjectConversations";
import { studyRequest } from "@/lib/study-research-client";
import type { SessionInfo } from "@/lib/types";
import type { ChatInputHandle } from "@/components/ChatInput";
export function StudyConversation({sessionId,onOpenFile,onReady,onSettled}:{sessionId:string;onOpenFile:(path:string,cwd?:string)=>void;onReady:(ready:boolean)=>void;onSettled:()=>void}) {
  const [session,setSession]=useState<SessionInfo|null>(null);const [error,setError]=useState('');const [retry,setRetry]=useState(0);const [settings,setSettings]=useState(false);const input=useRef<ChatInputHandle|null>(null);
  useEffect(()=>{let stopped=false;onReady(false);setSession(null);setError('');void(async()=>{
    await studyRequest({action:'activate',sessionId});
    const response=await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);const value=await response.json() as {info?:SessionInfo;error?:string};
    if(!response.ok||!value.info)throw new Error(value.error??'无法读取原 Pi 会话');
    if(!stopped){setSession(value.info);onReady(true);}
  })().catch(e=>{if(!stopped)setError(String(e));});return()=>{stopped=true;};},[sessionId,retry,onReady]);
  const openFile=useCallback((path:string)=>onOpenFile(path,session?.cwd),[onOpenFile,session?.cwd]);
  return <aside className="study-chat" aria-label="Study Agent">
    <header><strong>Study & Research Agent</strong><button type="button" onClick={()=>setSettings(!settings)}>{settings?'对话':'Skills 与提示词'}</button></header>
    <ProjectConversations sessionId={sessionId}/>
    {error?<div role="alert"><p>{error}</p><button onClick={()=>setRetry(x=>x+1)}>重试激活模式</button><p>模型不可用时，已保存的地图和笔记仍可阅读。</p></div>:!session?<p role="status">正在启动原生 Pi 会话…</p>:<>
      <div className="study-chat-body" style={{display:settings?'none':'flex'}}><ChatWindow session={session} newSessionCwd={null} newSessionDraftKey={null} chatInputRef={input} onAgentEnd={onSettled} onOpenFile={openFile} soundEnabled={false}/></div>
      {settings&&<SkillsConfig sessionId={sessionId} cwd={session.cwd} embedded section="all" onClose={()=>setSettings(false)}/>}
    </>}
  </aside>;
}
