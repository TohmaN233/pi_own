"use client";
import { useEffect,useRef,useState } from "react";
import type { studyTeachingState } from "@/lib/study-teaching-service";
import styles from "@/app/study/Study.module.css";
type State=Awaited<ReturnType<typeof studyTeachingState>>;
export function StudyTeachingTransfer({sessionId,phaseRevision,projectRevision}:{sessionId:string;phaseRevision:number;projectRevision:number}) {
  const [open,setOpen]=useState(false),[state,setState]=useState<State|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [itemId,setItemId]=useState(""),[courseId,setCourseId]=useState(""),[lessonId,setLessonId]=useState(""),[notice,setNotice]=useState("");
  const request=useRef<string|null>(null);
  const [refreshRevision,setRefreshRevision]=useState(0);
  useEffect(()=>{if(!open)return;const abort=new AbortController();void fetch(`/api/study-research/teaching?sessionId=${encodeURIComponent(sessionId)}`,{signal:abort.signal,cache:"no-store"}).then(async r=>{const v=await r.json();if(!r.ok)throw new Error(v.error||"无法读取教学目标");setState(v);}).catch(e=>{if(!abort.signal.aborted)setError(String(e));});return()=>abort.abort();},[open,sessionId,phaseRevision,projectRevision,refreshRevision]);
  const item=state?.items.find(value=>value.id===itemId),course=state?.targets.find(value=>value.courseSessionId===courseId),lesson=course?.lessons.find(value=>value.lessonPlanId===lessonId);
  const transfer=async()=>{if(!item||!course||!lesson)return;setBusy(true);setError("");request.current??=crypto.randomUUID();try{const r=await fetch("/api/study-research/teaching",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,expectedPhaseRevision:phaseRevision,courseSessionId:course.courseSessionId,expectedCourseRevision:course.revision,lessonPlanId:lesson.lessonPlanId,expectedLessonRevision:lesson.revision,week:lesson.week,session:lesson.session,kind:item.kind,id:item.id,revision:item.revision,hash:item.hash,requestId:request.current})});const v=await r.json();if(!r.ok)throw new Error(v.error||"教学移交未完成");setNotice("已保存课程独立副本，请在课程中检查并批准。");request.current=null;setState(null);setRefreshRevision(v=>v+1);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <details className={styles.section} open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>将学习成果移交到课程</summary>
    <p>选择现有课程与真实课次。课程接收独立副本，之后的修改不会反写原学习内容；需要课程教师批准才可正式使用。</p>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <label className={styles.field}><span>选择成果</span><select aria-label="选择成果" value={itemId} onChange={e=>{request.current=null;setItemId(e.target.value);}}><option value="">请选择</option>{state?.items.map(item=><option key={item.id} value={item.id} disabled={!item.eligible}>{item.kind} · {item.label}{item.eligible?"":" · 尚不符合移交条件"}</option>)}</select></label>
    <label className={styles.field}><span>目标课程</span><select aria-label="目标课程" value={courseId} onChange={e=>{request.current=null;setCourseId(e.target.value);setLessonId("");}}><option value="">请选择</option>{state?.targets.map(target=><option key={target.courseSessionId} value={target.courseSessionId}>{target.title} · {target.courseSessionId.slice(-8)}</option>)}</select></label>
    <label className={styles.field}><span>目标课次</span><select aria-label="目标课次" value={lessonId} onChange={e=>{request.current=null;setLessonId(e.target.value);}}><option value="">请选择</option>{course?.lessons.map(lesson=><option key={lesson.lessonPlanId} value={lesson.lessonPlanId}>第 {lesson.week} 周第 {lesson.session} 次 · {lesson.title} · r{lesson.revision}</option>)}</select></label>
    <button type="button" className={styles.buttonPrimary} disabled={busy||!item?.eligible||!course||!lesson} onClick={()=>void transfer()}>保存到课程独立副本</button>
    {course&&<p><a href={`/course-builder/study-assets?sessionId=${encodeURIComponent(course.courseSessionId)}`}>打开该课程的学习成果副本</a></p>}
  </details>;
}
