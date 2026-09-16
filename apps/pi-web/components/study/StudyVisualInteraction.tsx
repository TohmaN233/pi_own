"use client";
import { useCallback,useEffect,useState } from "react";
import type { VisualizationDraft } from "../../../../packages/study-research-host/src/types.ts";
import type { BrowserVisualObservation } from "../../../../packages/study-research-host/src/study-teaching-host.ts";
import type { studyVisualInteractionState } from "@/lib/study-visual-interaction-service";
import { StudyVisualization } from "./StudyVisualization";
import styles from "@/app/study/Study.module.css";
type State=Awaited<ReturnType<typeof studyVisualInteractionState>>;
export function StudyVisualInteraction({sessionId,phaseRevision,projectRevision,visualization,onChanged}:{sessionId:string;phaseRevision:number;projectRevision:number;visualization:VisualizationDraft;onChanged:()=>void}) {
  const [state,setState]=useState<State|null>(null),[error,setError]=useState("");
  const [selected,setSelected]=useState(""),[step,setStep]=useState<number|null>(null),[observations,setObservations]=useState<BrowserVisualObservation[]>([]),[busy,setBusy]=useState(false);
  const load=useCallback(async()=>{const r=await fetch(`/api/study-research/visual-interaction?sessionId=${encodeURIComponent(sessionId)}&visualizationId=${encodeURIComponent(visualization.visualizationId)}`,{cache:"no-store"});const v=await r.json();if(!r.ok)throw new Error(v.error||"无法读取交互检查");setState(v);},[sessionId,visualization.visualizationId]);
  useEffect(()=>{void load().catch(e=>setError(String(e)));},[load,visualization.contentHash,projectRevision]);
  const specs=state?.specifications.filter(item=>item.target.visualizationHash===visualization.contentHash&&item.target.visualizationRevision===visualization.revision)??[];
  const specification=specs.find(item=>item.specificationId===selected)??specs[0];
  const active=step===null?undefined:specification?.specification.cases[step];
  const save=async()=>{if(!specification)return;setBusy(true);setError("");try{const r=await fetch("/api/study-research/visual-interaction",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,expectedPhaseRevision:phaseRevision,visualizationId:visualization.visualizationId,revision:visualization.revision,targetHash:visualization.contentHash,specificationId:specification.specificationId,specificationRevision:specification.revision,observations})});const v=await r.json();if(!r.ok)throw new Error(v.error||"无法保存浏览器检查");await load();onChanged();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <div className={styles.form}>
    <h5>浏览器交互与正式使用</h5>
    <button type="button" className={styles.button} onClick={()=>void load().catch(e=>setError(String(e)))}>刷新验证状态</button>
    <p>按冻结测试逐步切换参数，记录隔离页面实际生成的 SVG。此检查核对界面结果，数值计算和学术审查分别保留。</p>
    <p role="status">{state?.gate.ready?"当前版本可正式使用":"当前版本保持草稿"}</p>
    <ul>{state?.gate.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
    {error&&<p role="alert">{error}</p>}
    {specs.length===0?<p>请先保存当前版本的验证方案。</p>:<>
      <label className={styles.field}><span>浏览器检查方案</span><select disabled={step!==null} value={specification?.specificationId??""} onChange={e=>{setSelected(e.target.value);setObservations([]);}}>{specs.map(item=><option key={item.specificationId} value={item.specificationId}>{item.specification.scope} · r{item.revision}</option>)}</select></label>
      <p>浏览器断言需要使用 elements 中可见的图元属性；metrics 等不可见数值请在数值验证中检查。</p>
      <button type="button" className={styles.button} disabled={busy||!specification} onClick={()=>{setError("");setObservations([]);setStep(0);}}>开始浏览器交互检查</button>
      {active&&specification&&<>
        <p>步骤 {(step??0)+1} / {specification.specification.cases.length}：{active.description}</p>
        <pre className={styles.codeBlock}>{JSON.stringify(active.inputs,null,2)}</pre>
        <StudyVisualization key={`${visualization.contentHash}:${specification.contentHash}:${step}`} title={`交互检查 ${active.id}`} code={visualization.code} inputs={active.inputs} revision={visualization.revision} validationLabel="本步骤显示的是冻结测试参数。" onObservation={scene=>{const binding=specification.browserCases.find(item=>item.caseId===active.id);if(!binding)return;setObservations(current=>current.some(item=>item.caseId===active.id)?current:[...current,{...binding,scene}]);}} />
        <button className={styles.button} type="button" disabled={!observations.some(item=>item.caseId===active.id)} onClick={()=>setStep((step??0)+1<specification.specification.cases.length?(step??0)+1:null)}>记录后切换下一组参数</button>
      </>}
      <p>已实测 {observations.length} / {specification?.specification.cases.length??0} 组。</p>
      <button className={styles.buttonPrimary} type="button" disabled={busy||!specification||observations.length!==specification.specification.cases.length} onClick={()=>void save()}>保存交互实测</button>
    </>}
    {state?.gate.interactions[0]&&<details><summary>最近实测：{state.gate.interactions[0].status}</summary><pre className={styles.codeBlock}>{JSON.stringify(state.gate.interactions[0].comparisons,null,2)}</pre></details>}
  </div>;
}
