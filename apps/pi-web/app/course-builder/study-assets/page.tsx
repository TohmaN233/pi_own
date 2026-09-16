"use client";
import { Suspense,useCallback,useEffect,useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MarkdownBody } from "@/components/MarkdownBody";
import { StudyVisualization } from "@/components/study/StudyVisualization";
import type { courseStudyCopies } from "@/lib/study-teaching-service";
import styles from "@/app/study/Study.module.css";
type State=Awaited<ReturnType<typeof courseStudyCopies>>;
function CourseStudyAssets(){
  const query=useSearchParams(),sessionId=query.get("sessionId")??"",lesson=query.get("lessonPlanId");
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const r=await fetch(`/api/course-builder/study-assets?sessionId=${encodeURIComponent(sessionId)}${lesson?`&lessonPlanId=${encodeURIComponent(lesson)}`:""}`,{cache:"no-store"});const v=await r.json();if(!r.ok)throw new Error(v.error||"无法读取课程副本");setState(v);},[sessionId,lesson]);
  useEffect(()=>{void load().catch(e=>setError(String(e)));},[load]);
  const approve=async(entry:NonNullable<State>["copies"][number])=>{setBusy(true);setError("");try{const r=await fetch("/api/course-builder/study-assets",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,materialId:entry.materialId,copyHash:entry.copy.contentHash,lessonRevision:entry.copy.owner.lessonRevision,confirmed:true})});const v=await r.json();if(!r.ok)throw new Error(v.error||"课程批准未完成");await load();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <main className={styles.page}><div className={styles.content}>
    <Link href={`/course-builder?sessionId=${encodeURIComponent(sessionId)}`}>← 返回备课工作区</Link>
    <h1>{state?.project.title??"课程"} · 学习成果副本</h1>
    <p>副本属于本课程，保留原来源和验证记录。原项目之后的修改不会自动改变这里的内容。</p>
    {error&&<p role="alert">{error}</p>}
    {state?.copies.length===0&&<p>尚未向本课程移交学习成果。</p>}
    {state?.copies.map(entry=><article key={entry.materialId} className={styles.section} data-course-owner={entry.copy.owner.projectId} data-copy-id={entry.copy.copyId}>
      <h2>第 {entry.copy.owner.week} 周第 {entry.copy.owner.session} 次 · {entry.approved?"可正式使用":"课程草稿"}</h2>
      {entry.reason&&<p>{entry.reason}</p>}
      {entry.copy.payload.kind==="visualization"?<StudyVisualization title={entry.copy.payload.visualization.purpose} code={entry.copy.payload.visualization.code} inputs={entry.copy.payload.visualization.inputs} revision={entry.copy.payload.visualization.revision} validationLabel={entry.approved?"课程教师已批准这份独立副本。":"当前仅供教师查看，尚不能作为正式课件。"}/>:<MarkdownBody>{entry.copy.payload.kind==="note"?entry.copy.payload.note.body:[entry.copy.payload.result.summary,...entry.copy.payload.result.claims,...entry.copy.payload.result.limitations.map(value=>`限制：${value}`)].join("\n\n")}</MarkdownBody>}
      <p>来源：{entry.copy.origin.kind} · r{entry.copy.origin.revision} · {entry.copy.origin.hash}</p>
      <details><summary>查看副本、来源与冻结证据</summary><pre className={styles.codeBlock}>{JSON.stringify(entry.copy,null,2)}</pre></details>
      <button type="button" className={styles.buttonPrimary} disabled={busy||entry.approved||!entry.canApprove} onClick={()=>void approve(entry)}>批准本课程当前副本</button>
    </article>)}
  </div></main>;
}
export default function Page(){return <Suspense fallback={<p>正在读取课程副本…</p>}><CourseStudyAssets/></Suspense>;}
