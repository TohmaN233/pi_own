"use client";
import { useState } from "react";
import { studyRequest, type StudyState } from "@/lib/study-research-client";
import type { ExperimentPlan, StudyDocument } from "../../../../packages/study-research-host/src/index.ts";
const STARTER:ExperimentPlan={title:'我的小实验',purpose:'study',proposalId:null,hypothesis:'比较一个具体的数学或代码行为',baseline:'已知的小例子',ablations:[],metric:'输出与已知值的差',dataSplit:'合成数据；不能替代外部验证',seeds:[1],successCriterion:'与已知值一致',failureInterpretation:'检查实现、假设和数值误差',language:'python',code:'print(sum(range(1, 11)))',timeoutSeconds:5};
export function StudyCodeLab({sessionId,state,codeEnabled,onSaved}:{sessionId:string;state:StudyState;codeEnabled:boolean;onSaved:()=>void}) {
  const [base,setBase]=useState<StudyDocument<ExperimentPlan>|null>(null);const [draft,setDraft]=useState<ExperimentPlan>(STARTER);const [metadata,setMetadata]=useState(JSON.stringify(STARTER,null,2));const [confirmed,setConfirmed]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const current=base?state.experiments.find(e=>e.id===base.id):null;
  const dirty=!base || JSON.stringify(draft)!==JSON.stringify(base.data);
  const load=(value:StudyDocument<ExperimentPlan>)=>{setBase(value);setDraft(value.data);setMetadata(JSON.stringify(value.data,null,2));setConfirmed(false);setError('');};
  const perform=async(action:string)=>{setBusy(true);setError('');try{
    if(action==='save_experiment'){const saved=await studyRequest<StudyDocument<ExperimentPlan>>({action,sessionId,id:base?.id??null,expectedRevision:base?.revision??0,draft});load(saved);}
    else {await studyRequest({action,sessionId,id:base?.id,expectedRevision:base?.revision,confirmed});setConfirmed(false);}
    onSaved();
  }catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section><h3>代码实验台 · 真实运行，不是完整交互终端</h3>
    <p>可写 Python / JavaScript，保存计划后逐次批准和运行。源目录只读；代码在独立临时目录运行，不能直接导入源目录文件。复杂环境、完整 PTY、长期训练不是本版范围。</p>
    <p role="note"><strong>安全边界：</strong>这是可信本地代码，不是安全沙箱。运行代码仍有你账户的文件和网络权限。默认关闭；仅在理解风险后，启动前设置 <code>PI_STUDY_TRUSTED_CODE=1</code>。</p>
    <select aria-label="选择实验计划" value={base?.id??''} onChange={e=>{const value=state.experiments.find(x=>x.id===e.target.value);if(value)load(value);}}><option value="">新实验</option>{state.experiments.map(e=><option key={e.id} value={e.id}>{e.data.title} · r{e.revision}{e.stale?' · 已过期':''}</option>)}</select>
    <button onClick={()=>{setBase(null);setDraft(STARTER);setMetadata(JSON.stringify(STARTER,null,2));setConfirmed(false);}}>新建草稿</button>
    <details><summary>实验设计：假设、基线、指标、划分、种子与通过标准</summary><textarea aria-label="实验计划 JSON" value={metadata} onChange={e=>setMetadata(e.target.value)} rows={14}/><button onClick={()=>{try{const parsed=JSON.parse(metadata) as ExperimentPlan;if(!parsed || typeof parsed!=="object" || typeof parsed.code!=="string" || typeof parsed.title!=="string" || !["python","javascript"].includes(parsed.language) || typeof parsed.timeoutSeconds!=="number")throw new Error("计划必须包含 title、code、language 和 timeoutSeconds；其他字段保存时严格校验。");setDraft(parsed);setConfirmed(false);setError('');}catch(e){setError(String(e));}}}>应用 JSON 到编辑器</button></details>
    <p>{draft.title} · {draft.purpose} · 最长 {draft.timeoutSeconds} 秒</p>
    <label>语言 <select aria-label="代码语言" value={draft.language} onChange={e=>{setDraft({...draft,language:e.target.value as ExperimentPlan['language']});setConfirmed(false);}}><option value="python">Python</option><option value="javascript">JavaScript</option></select></label>
    <textarea aria-label="实验代码" value={draft.code} onChange={e=>{setDraft({...draft,code:e.target.value});setConfirmed(false);}} rows={12} spellCheck={false}/>
    <button disabled={busy||!state.roadmap||state.roadmap.stale} onClick={()=>void perform('save_experiment')}>保存新的计划修订</button>
    <p>{base?`正在查看 r${base.revision}；当前保存 r${current?.revision??'未知'}`:'需要先保存计划。'}{dirty?' · 编辑尚未保存':''}{current?.stale?' · 上游资料或计划已变化，必须修订':''}</p>
    <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已检查下面这个版本的计划和代码，并同意在本机运行。</label>
    <button disabled={busy||!confirmed||dirty||current?.stale||base?.revision!==current?.revision||current?.consumed} onClick={()=>void perform('approve_experiment')}>批准此版本</button>
    <button disabled={busy||!codeEnabled||!confirmed||dirty||!current?.approved||current.stale||base?.revision!==current.revision} onClick={()=>void perform('run')}>运行已批准版本</button>
    {!codeEnabled&&<p>当前本地代码执行未启用；可以继续编写、保存和讨论计划。</p>}{busy&&<p role="status">正在处理；运行上限由已批准计划决定。</p>}{error&&<p role="alert">{error}</p>}
    <p>一次批准只能运行一次。重跑需保存新修订、重新批准；运行退出码为零不等于假设正确。</p>
    {state.runs.map(run=><article key={run.id}><h4>{run.status} · {run.durationMs} ms · exit {String(run.exitCode)}</h4><small>{run.experimentId} r{run.experimentRevision} · {run.codeHash}</small>{run.status==='started'&&<p>结果尚未确认；重启后不会自动继续或标为成功。</p>}<pre aria-label="运行输出">{run.stdout||'(无标准输出)'}{run.stderr&&`\nSTDERR:\n${run.stderr}`}</pre></article>)}
  </section>;
}
