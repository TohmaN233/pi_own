"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { MarkdownBody } from "@/components/MarkdownBody";
import { ensureCourseBuilderRuntime } from "@/lib/course-builder-runtime-client";
import { lessonReviewDraft, LESSON_TEXT_SECTIONS } from "@/lib/lesson-review";
import type { CourseBuilderSnapshot, LessonPlan, LessonPlanDraft } from "../../../../../packages/course-builder-host/src/types";
import styles from "./review.module.css";

function LessonReviewPage() {
  const query = useSearchParams();
  const sid = query.get("sessionId") ?? "";
  const id = query.get("lessonPlanId") ?? "";
  const storageKey = `pi-course-lesson-review:${sid}:${id}`;
  const [snapshot, setSnapshot] = useState<CourseBuilderSnapshot | null>(null);
  const [plan, setPlan] = useState<LessonPlan | null>(null);
  const [draft, setDraft] = useState<LessonPlanDraft | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [parentRevision, setParentRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoveryReady, setRecoveryReady] = useState(false);
  const dirty = !!plan && !!draft && JSON.stringify(draft) !== JSON.stringify(lessonReviewDraft(plan));
  const conflict = !!plan && baseRevision !== plan.revision;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!sid || !id) throw new Error("缺少课程会话或单课计划，请从备课工作区打开教案。");
      const response = await fetch(`/api/course-builder?sessionId=${encodeURIComponent(sid)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "无法加载教案");
      const state = data.snapshot as CourseBuilderSnapshot;
      const current = state?.lessonPlans.find((lesson) => lesson.lessonPlanId === id);
      if (!current) throw new Error("当前课程中没有这份单课计划");
      if (cancelled) return;
      setSnapshot(state); setPlan(current); setDraft(lessonReviewDraft(current)); setBaseRevision(current.revision); setParentRevision(current.semesterPlanRevision); setNote(current.review?.note ?? "");
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const saved = JSON.parse(stored);
        const restored = lessonReviewDraft(saved.draft);
        if (restored.week !== current.week || restored.session !== current.session || !Number.isInteger(saved.baseRevision) || !Number.isInteger(saved.parentRevision) || typeof saved.note !== "string") throw new Error("暂存内容与当前教案不匹配");
        setDraft(restored); setBaseRevision(saved.baseRevision); setParentRevision(saved.parentRevision); setNote(saved.note); setEditing(true);
        setNotice("已恢复上次未保存的编辑。保存后会写入课程工作区。");
      }
      setRecoveryReady(true);
    })().catch((cause) => { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => { cancelled = true; };
  }, [sid, id, storageKey]);

  useEffect(() => {
    if (!draft || !plan || !recoveryReady) return;
    try {
      if (dirty || note !== (plan.review?.note ?? "")) localStorage.setItem(storageKey, JSON.stringify({ draft, note, baseRevision, parentRevision }));
      else localStorage.removeItem(storageKey);
    } catch (cause) { setError(`无法暂存编辑：${String(cause)}`); }
  }, [draft, note, plan, dirty, baseRevision, parentRevision, storageKey, recoveryReady]);

  async function submit(action: "edit_lesson" | "review_lesson", decision?: "approve" | "request-changes") {
    if (!plan || !draft || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (decision === "request-changes") await ensureCourseBuilderRuntime(sid);
      const response = await fetch("/api/course-builder", { method: "POST", headers: { "content-type": "application/json", "x-course-builder-teacher": "1" }, body: JSON.stringify({ action, sessionId: sid, id, expectedRevision: baseRevision, ...(action === "edit_lesson" ? { draft, parentRevision } : { decision, note, requestId: crypto.randomUUID() }) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "保存失败");
      const state = data.snapshot as CourseBuilderSnapshot;
      const current = state.lessonPlans.find((lesson) => lesson.lessonPlanId === id);
      if (!current) throw new Error("保存响应缺少当前教案，请刷新核验");
      setSnapshot(state); setPlan(current); setDraft(lessonReviewDraft(current)); setBaseRevision(current.revision); setParentRevision(current.semesterPlanRevision); setEditing(false);
      setNote(current.review?.note ?? note);
      setNotice(action === "edit_lesson" ? "修改已保存为新版本，请阅读后批准。" : decision === "approve" ? "已批准当前教案，下次打开仍会保留。" : "修改意见已发送给 Agent，生成修改稿后可重新打开审阅。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <main className={styles.page}>
    <header className={styles.toolbar}><Link href={`/course-builder?sessionId=${encodeURIComponent(sid)}#review`}>← 返回备课工作区</Link><span>单课教案 · 阅读与审阅</span><button onClick={() => window.print()}>打印 / 保存 PDF</button></header>
    <article className={styles.paper}>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!draft || !plan || !snapshot ? <p>正在读取已保存的教案…</p> : <>
        <p className={styles.meta}>{snapshot.project.title} · 第 {draft.week} 周 / 第 {draft.session} 次 · r{plan.revision} · {plan.status === "approved" ? "已批准" : plan.status === "changes-requested" ? "待修改" : "待审阅"}</p>
        {conflict && <p role="alert" className={styles.error}>工作区已有 r{plan.revision}，暂存编辑基于 r{baseRevision}。请先保留需要的内容，再读取最新版；不会覆盖新版本。</p>}
        <div className={styles.actions}><button disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "阅读排版" : "编辑教案"}</button><button disabled={busy || !dirty || conflict} onClick={() => void submit("edit_lesson")}>保存修改</button><button disabled={busy} onClick={() => { setDraft(lessonReviewDraft(plan)); setBaseRevision(plan.revision); setParentRevision(plan.semesterPlanRevision); setNote(plan.review?.note ?? ""); setRecoveryReady(true); setNotice("已恢复工作区保存的版本。"); }}>放弃暂存，读取已保存版本</button>{dirty && <span>有未保存的编辑 · 已在本机暂存</span>}</div>
        {editing ? <label>教案标题<input aria-label="教案标题" value={draft.title} disabled={busy} onChange={(event) => setDraft({ ...draft, title: event.target.value })}/></label> : <h1>{draft.title}</h1>}
        {LESSON_TEXT_SECTIONS.slice(0, 3).map(([key, title]) => <section key={key}><h2>{title}</h2>{renderList(key, title)}</section>)}
        <section><h2>教学流程 <small>共 {draft.segments.reduce((sum, segment) => sum + segment.minutes, 0)} 分钟</small></h2>{draft.segments.map((segment, index) => <div className={styles.segment} key={index}>
          {editing ? <><label>环节 {index + 1} 标题<input value={segment.title} disabled={busy} onChange={(event) => changeSegment(index, "title", event.target.value)}/></label><label>时长（分钟）<input type="number" value={segment.minutes} disabled={busy} onChange={(event) => changeSegment(index, "minutes", Number(event.target.value))}/></label></> : <h3>{index + 1}. {segment.title} <small>{segment.minutes} 分钟</small></h3>}
          {([["teacherAction", "教师活动"], ["learnerAction", "学生任务"], ["checkForUnderstanding", "理解检查"]] as const).map(([key, label]) => <div key={key}><h4>{label}</h4>{editing ? <textarea aria-label={`环节 ${index + 1} ${label}`} disabled={busy} rows={3} value={segment[key] ?? ""} onChange={(event) => changeSegment(index, key, event.target.value || (key === "checkForUnderstanding" ? null : ""))}/> : <MarkdownBody>{segment[key] || "未安排"}</MarkdownBody>}</div>)}
          {editing && <button disabled={busy} onClick={() => setDraft({ ...draft, segments: draft.segments.filter((_, position) => position !== index) })}>删除环节 {index + 1}</button>}
        </div>)}{editing && <button disabled={busy} onClick={() => setDraft({ ...draft, segments: [...draft.segments, { minutes: 5, title: "新环节", teacherAction: "", learnerAction: "", checkForUnderstanding: null }] })}>添加教学环节</button>}</section>
        {LESSON_TEXT_SECTIONS.slice(3).map(([key, title]) => <section key={key}><h2>{title}</h2>{renderList(key, title)}</section>)}
        <section><h2>参考资料</h2>{editing ? snapshot.materials.map((material) => <label className={styles.check} key={material.materialId}><input type="checkbox" disabled={busy} checked={draft.materialIds.includes(material.materialId)} onChange={(event) => setDraft({ ...draft, materialIds: event.target.checked ? [...draft.materialIds, material.materialId] : draft.materialIds.filter((id) => id !== material.materialId) })}/>{material.name}</label>) : <ul>{draft.materialIds.map((id) => <li key={id}>{snapshot.materials.find((material) => material.materialId === id)?.name ?? id}</li>)}</ul>}</section>
        <section className={styles.review}><h2>教师确认</h2><label>审阅意见<textarea aria-label="审阅意见" rows={3} disabled={busy} value={note} onChange={(event) => setNote(event.target.value)}/></label><p>编辑后请先保存，再批准当前版本。审阅意见也会在本机暂存。</p><div className={styles.actions}><button disabled={busy || dirty || conflict || plan.status === "approved"} onClick={() => void submit("review_lesson", "approve")}>同意并批准当前教案</button><button disabled={busy || dirty || conflict || !note.trim()} onClick={() => void submit("review_lesson", "request-changes")}>发送修改意见给 Agent</button></div></section>
      </>}
    </article>
  </main>;

  function renderList(key: typeof LESSON_TEXT_SECTIONS[number][0], title: string) {
    if (!draft) return null;
    const items = draft[key];
    return editing ? <>{items.map((item, index) => <div className={styles.listEdit} key={index}><textarea disabled={busy} aria-label={`${title} ${index + 1}`} rows={3} value={item} onChange={(event) => setDraft({ ...draft, [key]: items.map((value, position) => position === index ? event.target.value : value) })}/><button disabled={busy} onClick={() => setDraft({ ...draft, [key]: items.filter((_, position) => position !== index) })}>删除</button></div>)}<button disabled={busy} onClick={() => setDraft({ ...draft, [key]: [...items, ""] })}>添加{title}</button></> : items.length ? <ul>{items.map((item, index) => <li key={index}><MarkdownBody>{item}</MarkdownBody></li>)}</ul> : <p className={styles.meta}>未填写</p>;
  }
  function changeSegment(index: number, key: string, value: string | number | null) {
    if (draft) setDraft({ ...draft, segments: draft.segments.map((segment, position) => position === index ? { ...segment, [key]: value } : segment) });
  }
}

export default function Page() { return <Suspense fallback={<p>正在打开教案…</p>}><LessonReviewPage/></Suspense>; }
