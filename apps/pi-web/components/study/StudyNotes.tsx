"use client";
import { useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { studyRequest, type StudyState } from "@/lib/study-research-client";
import type { SourceAnchor, StudyDocument, StudyNote } from "../../../../packages/study-research-host/src/index.ts";
export function StudyNotes({sessionId,state,selectedNode,anchor,onSaved}:{sessionId:string;state:StudyState;selectedNode:string|null;anchor:SourceAnchor|null;onSaved:()=>void}) {
  const [body,setBody]=useState('');const [base,setBase]=useState<StudyDocument<StudyNote>|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const edit=(note:StudyDocument<StudyNote>)=>{setBase(note);setBody(note.data.body);setError('');};
  const save=async()=>{setBusy(true);setError('');try{await studyRequest({action:'save_note',sessionId,id:base?.id??null,expectedRevision:base?.revision??0,draft:{nodeId:base?.data.nodeId??selectedNode,anchor:base?base.data.anchor:anchor,body}});setBody('');setBase(null);onSaved();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section><h3>共同笔记 · Markdown / TeX 数学</h3><p>你的笔记和 Agent 笔记独立保存。修改冲突不会覆盖你的草稿；刷新前请复制尚未保存的内容。</p>
    <p>{base?`编辑 ${base.id} · 基于修订 ${base.revision}`:`新笔记 · ${selectedNode??'项目'}${anchor?' · 已附精确来源引用':''}`}</p>
    <textarea aria-label="我的数学笔记" value={body} onChange={e=>setBody(e.target.value)} rows={7} placeholder="用 $...$ 或 $$...$$ 写公式，也可写疑问、推导和反例。"/>
    <div className="study-preview"><MarkdownBody>{body||'预览区'}</MarkdownBody></div>
    <button type="button" disabled={busy||!body.trim()} onClick={()=>void save()}>保存我的笔记</button>{base&&<button onClick={()=>{setBase(null);setBody('');}}>取消编辑</button>}{error&&<p role="alert">{error}</p>}
    {state.notes.map(note=><article key={note.id}><header><strong>{note.data.author==='user'?'我的笔记':'Agent 笔记'}</strong> · r{note.revision} {note.stale&&'· 引用版本已变化'} {note.data.author==='user'&&<button onClick={()=>edit(note)}>编辑</button>}</header><MarkdownBody>{note.data.body}</MarkdownBody>{note.data.anchor&&<details><summary>来源与原文</summary><pre>{JSON.stringify(note.data.anchor,null,2)}</pre></details>}</article>)}
  </section>;
}
