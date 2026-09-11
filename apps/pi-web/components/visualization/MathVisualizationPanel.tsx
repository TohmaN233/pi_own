"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MathVisualArtifact, MathVisualSpec } from "../../../../packages/math-visualization-host/src/index.ts";

type Summary = Omit<MathVisualArtifact, "data"> & {seriesCount:number};
const PRESETS: Record<string, MathVisualSpec> = {
  polynomial: {kind:"polynomial", title:"二次函数", purpose:"预测曲线的开口和零点，然后缩放观察。", xLabel:"x",yLabel:"f(x)",coefficients:[-1,0,1],domain:[-3,3],samples:101},
  matrix2d: {kind:"matrix2d",title:"线性变换",purpose:"比较单位正方形变换前后的形状与面积。",xLabel:"x",yLabel:"y",matrix:[[1,1],[0,1]]},
  surface3d: {kind:"surface3d",title:"鞍面",purpose:"拖动旋转，比较沿两个坐标方向的曲率。",xLabel:"x",yLabel:"y",zLabel:"z",shape:"saddle",scale:1,domain:[-2,2],samples:33},
  scatter3d: {kind:"scatter3d",title:"三维点云",purpose:"旋转观察投影如何改变点间关系；图形不证明因果关系。",xLabel:"x",yLabel:"y",zLabel:"z",points:[[0,0,0],[1,1,2],[2,-1,3],[-1,2,1]]},
};
export function MathVisualizationPanel({sessionId}:{sessionId:string}) {
  const [items,setItems]=useState<Summary[]>([]); const [artifact,setArtifact]=useState<MathVisualArtifact|null>(null);
  const [draft,setDraft]=useState(JSON.stringify(PRESETS.polynomial,null,2)); const [error,setError]=useState("");const [busy,setBusy]=useState(false);
  const [ready,setReady]=useState(false);const [painted,setPainted]=useState("");const [token,setToken]=useState('');const frame=useRef<HTMLIFrameElement>(null);
  useEffect(()=>{setToken(crypto.randomUUID());},[]);
  const scopeRef=useRef('');const listController=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{listController.current?.abort();const ctrl=new AbortController();listController.current=ctrl;const response=await fetch(`/api/math-visualization?sessionId=${encodeURIComponent(sessionId)}`,{signal:ctrl.signal});const body=await response.json();if(!response.ok)throw new Error(body.error);if(ctrl.signal.aborted)return;if(scopeRef.current && scopeRef.current!==body.scope)setArtifact(null);scopeRef.current=body.scope;setItems(body.artifacts);},[sessionId]);
  useEffect(()=>{let stopped=false;void load().catch((e)=>{if(!stopped)setError(String(e));});const t=setInterval(()=>{void load().catch(()=>{});},8000);return()=>{stopped=true;clearInterval(t);listController.current?.abort();};},[load]);
  useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.source!==frame.current?.contentWindow || event.data?.token!==token)return;if(event.data.type==='pi-math-ready')setReady(true);if(event.data.type==='pi-math-rendered')setPainted(event.data.id);};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[token]);
  useEffect(()=>{if(ready&&artifact){setPainted("");frame.current?.contentWindow?.postMessage({type:'pi-math-artifact',token,artifact},'*');}},[ready,artifact,token]);
  const select=async(id:string)=>{setError("");try{const response=await fetch(`/api/math-visualization?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`);const body=await response.json();if(!response.ok)throw new Error(body.error);setArtifact(body.artifact);}catch(e){setError(String(e));}};
  const create=async()=>{setBusy(true);setError("");try{const response=await fetch('/api/math-visualization',{method:'POST',headers:{'Content-Type':'application/json','x-math-user':'1'},body:JSON.stringify({sessionId,spec:JSON.parse(draft)})});const body=await response.json();if(!response.ok)throw new Error(body.error);setArtifact(body.artifact);await load();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const download=()=>{if(!artifact)return;const url=URL.createObjectURL(new Blob([JSON.stringify(artifact,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`${artifact.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return <section aria-label="共享数学可视化" style={{padding:16,border:'1px solid var(--border)',borderRadius:8}}>
    <h3>数学可视化 · 2D / 3D</h3><p>固定数值规格，本地渲染。修改参数生成新产物；图形不是数学证明。</p>
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{Object.keys(PRESETS).map(key=><button key={key} type="button" onClick={()=>setDraft(JSON.stringify(PRESETS[key],null,2))}>{key}</button>)}</div>
    <details><summary>编辑数值规格</summary><textarea aria-label="数学可视化规格" value={draft} onChange={e=>setDraft(e.target.value)} rows={12} style={{width:'100%',fontFamily:'monospace'}}/></details>
    <button type="button" disabled={busy} onClick={()=>void create()}>生成／更新可视化</button><button type="button" onClick={()=>void load().catch(e=>setError(String(e)))}>刷新产物</button>
    {error&&<p role="alert">{error}</p>}
    <select aria-label="已保存可视化" value={artifact?.id??''} onChange={e=>void select(e.target.value)}><option value="">选择产物</option>{items.map(item=><option key={item.id} value={item.id}>{item.spec.title} · {item.spec.kind}</option>)}</select>
    <iframe ref={frame} title="交互式数学可视化" src={`/math-visualization.html?token=${encodeURIComponent(token)}`} sandbox="allow-scripts" style={{width:'100%',height:550,border:0,background:'#fff'}}/>
    {artifact&&<><p role="status">{painted===artifact.id?'浏览器已完成绘制':'等待浏览器绘制或查看图内诊断'} · {artifact.rendererVersion}</p><button type="button" onClick={download}>导出规格与数据 JSON</button><details><summary>产物身份与数据</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:200,overflow:'auto'}}>{JSON.stringify(artifact,null,2)}</pre></details></>}
  </section>;
}
