"use client";
import { useState } from "react";
import type { ExternalReference } from "@/lib/study-external-references";
import styles from "@/app/study/Study.module.css";
export function StudyExternalReferences({sessionId,phaseRevision,onChanged}:{sessionId:string;phaseRevision:number;onChanged:()=>void}) {
  const [query,setQuery]=useState(""); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  const [result,setResult]=useState<{references:ExternalReference[];retrievedAt:string}|null>(null);
  const search=async()=>{setBusy(true);setError("");try{
    const response=await fetch("/api/study-research/references",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,expectedPhaseRevision:phaseRevision,query})});
    const value=await response.json();if(!response.ok)throw new Error(value.error||"外部检索失败");setResult(value);onChanged();
  }catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}};
  return <details className={styles.form}><summary>补充阅读与外部来源</summary>
    <p>按简短概念、标题或 DOI 查找 Crossref 书目信息和已有摘要。这里只补充学习；不自动寻找研究方向，也不会把检索结果当作已读全文。</p>
    <label className={styles.field}><span>检索词（不要粘贴私有全文）</span><input value={query} maxLength={160} onChange={(event)=>setQuery(event.target.value)}/></label>
    <button type="button" className={styles.button} disabled={busy||!query.trim()} onClick={()=>void search()}>{busy?"检索中…":"检索并保留出处"}</button>
    {error&&<p role="alert">{error}</p>}{result&&<><p>检索时间：{new Date(result.retrievedAt).toLocaleString()}。已作为单独的外部参考来源保存。</p>
      {result.references.length===0?<p>未找到结果。</p>:<ul>{result.references.map((reference)=><li key={reference.doi}><a href={reference.url} target="_blank" rel="noopener noreferrer">{reference.title}</a><p>{reference.authors.join(", ")} · {reference.year??"年份未知"}</p>{reference.abstract&&<details><summary>出版方提供的摘要{reference.abstractTruncated?"（已截断）":""}</summary><p>{reference.abstract}</p></details>}</li>)}</ul>}</>}
  </details>;
}
