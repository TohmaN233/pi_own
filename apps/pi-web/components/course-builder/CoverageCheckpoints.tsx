"use client";
import { useState } from "react";
import type { courseBuilderWorkspaceState } from "@/lib/course-builder-service";
import type { CoverageCheckpointView, CoverageDraft, CoverageFile } from "../../../../packages/course-builder-host/src/coverage";
import styles from "../../app/course-builder/CourseBuilder.module.css";

type Snapshot = NonNullable<Awaited<ReturnType<typeof courseBuilderWorkspaceState>>["snapshot"]>;
type Lesson = Snapshot["lessonPlans"][number];
function checkpointLabel(checkpoint?: CoverageCheckpointView) { return !checkpoint ? "未记录" : checkpoint.staleReasons.length ? "待核对" : checkpoint.status === "confirmed" ? "已确认覆盖" : "计划覆盖"; }

export function CoverageCheckpoints({ snapshot, sessionId, onReload, onGenerate, busy }: { snapshot: Snapshot; sessionId: string; onReload: () => Promise<void>; onGenerate: (lesson: Lesson) => void; busy: boolean }) {
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lesson = snapshot.lessonPlans.find((item) => item.lessonPlanId === selectedId) ?? snapshot.lessonPlans[0];
  const checkpoint = (snapshot.coverageCheckpoints ?? []).find((item) => item.lessonPlanId === lesson?.lessonPlanId);
  const materials = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  async function submit(body: Record<string, unknown>) {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/course-builder", { method: "POST", headers: { "content-type": "application/json", "x-course-builder-teacher": "1" }, body: JSON.stringify({ ...body, sessionId }) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "Checkpoint 保存失败");
      setEditing(false);
      setNotice(body.action === "confirm_checkpoint" ? "覆盖记录已确认，后续备课会读取它。" : "Checkpoint 草稿已保存，请核对后确认覆盖范围。");
      await onReload();
    } catch (cause) {
      console.error("[course-builder] checkpoint action failed", { sessionId, lessonPlanId: lesson?.lessonPlanId, error: cause });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  }
  return <section className={styles.workspaceSection} id="coverage" tabIndex={-1}>
    <span className={styles.sectionNumber}>CHECKPOINT</span><h3>备课覆盖进度</h3>
    <p className={styles.sectionIntro}>每节课、每个文件一条记录：本课使用了什么内容，讲到哪里，下次从哪里继续。页码或行号仅作可选定位，不按读取批次拆分。记录在课程对话间共享，不代表学生已经学会。</p>
    {!lesson ? <div className={styles.emptyState}>保存单课教案后即可记录 Checkpoint。</div> : <>
      <label className={styles.wideField}>选择 Checkpoint 课次<select value={lesson.lessonPlanId} disabled={saving} onChange={(event) => { setSelectedId(event.target.value); setEditing(false); setError(""); setNotice(""); }}>{snapshot.lessonPlans.map((item) => <option key={item.lessonPlanId} value={item.lessonPlanId}>第 {item.week} 周第 {item.session} 次 · {item.title} · {checkpointLabel((snapshot.coverageCheckpoints ?? []).find((checkpoint) => checkpoint.lessonPlanId === item.lessonPlanId))}</option>)}</select></label>
      {checkpoint ? <article className={styles.outputArticle} aria-label="当前课次覆盖记录">
        <h4>{checkpointLabel(checkpoint)} · Checkpoint r{checkpoint.revision}</h4>
        <p className={styles.sectionIntro}>教案 r{checkpoint.lessonRevision}{checkpoint.deckId && ` · 课件 r${checkpoint.deckRevision}`}</p>
        {checkpoint.staleReasons.length > 0 && <p role="status">{checkpoint.staleReasons.join("；")}。请核对并保存新记录。</p>}
        <div>{checkpoint.coverage.map((file) => <article className={styles.reviewArticle} key={file.materialId} aria-label="文件 Checkpoint"><h4>{materials.get(file.materialId)?.name ?? file.materialId}</h4><p>{file.summary}</p>{file.position && <p className={styles.hint}>定位：{file.position}</p>}<p>下次接续：{file.nextLesson}</p></article>)}</div>
        {checkpoint.coverage.length === 0 && <p>尚未标注可核对的参考文件范围。</p>}
        <h4>覆盖内容</h4><ul>{checkpoint.completed.map((text, index) => <li key={index}>{text}</li>)}</ul>
        <h4>尚未覆盖 / 待核对</h4>{checkpoint.remaining.length ? <ul>{checkpoint.remaining.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>当前记录没有待办项。</p>}
        <h4>下一课衔接</h4><p>{checkpoint.nextLesson}</p>
      </article> : <p className={styles.sectionIntro}>本课尚未记录覆盖范围。可手工填写，也可让 Agent 根据已保存的教案、课件和原始材料整理草稿。</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {!editing && <div className={styles.buttonRow}>
        <button className={styles.secondaryButton} disabled={busy || saving} type="button" onClick={() => setEditing(true)}>{checkpoint ? "编辑 Checkpoint" : "填写 Checkpoint"}</button>
        <button className={styles.secondaryButton} disabled={busy || saving} type="button" onClick={() => onGenerate(lesson)}>让 Agent 整理本课 Checkpoint</button>
        {checkpoint && <button className={styles.primaryButton} disabled={busy || saving || checkpoint.status === "confirmed" || checkpoint.staleReasons.length > 0} type="button" onClick={() => void submit({ action: "confirm_checkpoint", id: lesson.lessonPlanId, expectedRevision: checkpoint.revision })}>确认当前覆盖记录</button>}
      </div>}
      {editing && <CheckpointEditor key={lesson.lessonPlanId} snapshot={snapshot} lesson={lesson} checkpoint={checkpoint} busy={busy || saving} onCancel={() => setEditing(false)} onSave={(draft, expectedRevision) => submit({ action: "save_checkpoint", draft, expectedRevision })}/>}
    </>}
  </section>;
}

function CheckpointEditor({ snapshot, lesson, checkpoint, busy, onCancel, onSave }: { snapshot: Snapshot; lesson: Lesson; checkpoint?: CoverageCheckpointView; busy: boolean; onCancel: () => void; onSave: (draft: CoverageDraft, expectedRevision: number) => Promise<void> }) {
  const [baseRevision] = useState(checkpoint?.revision ?? 0);
  const [target] = useState(() => {
    const deck = snapshot.decks.find((item) => item.lessonPlanId === lesson.lessonPlanId && item.lessonPlanRevision === lesson.revision);
    return { lessonPlanId: lesson.lessonPlanId, lessonRevision: lesson.revision, deckId: deck?.deckId ?? null, deckRevision: deck?.revision ?? null };
  });
  const [ranges, setRanges] = useState<CoverageFile[]>(checkpoint?.coverage ?? []);
  const [completed, setCompleted] = useState(checkpoint?.completed.join("\n") ?? "");
  const [remaining, setRemaining] = useState(checkpoint?.remaining.join("\n") ?? "");
  const [nextLesson, setNextLesson] = useState(checkpoint?.nextLesson ?? "");
  const split = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const updateRange = (index: number, patch: Partial<CoverageFile>) => setRanges((items) => items.map((item, position) => position === index ? { ...item, ...patch } : item));
  return <form className={styles.outputArticle} onSubmit={(event) => { event.preventDefault(); void onSave({ ...target, coverage: ranges, completed: split(completed), remaining: split(remaining), nextLesson }, baseRevision); }}>
    {(checkpoint?.revision ?? 0) !== baseRevision && <p role="alert">Checkpoint 已被其他操作更新。请取消编辑后重新读取，旧草稿不会覆盖新记录。</p>}
    <p className={styles.sectionIntro}>一个文件只添加一次。记录实际教学内容与接续点；读取了文件不等于已经讲完文件。</p>
    {ranges.map((range, index) => <fieldset className={styles.coverageRange} key={index}>
      <legend>文件 Checkpoint {index + 1}</legend>
      <label className={styles.wideField}>参考文件<select required value={snapshot.materials.some((item) => item.materialId === range.materialId && item.sourceHash === range.sourceHash) ? range.materialId : ""} onChange={(event) => { const material = snapshot.materials.find((item) => item.materialId === event.target.value); if (material) updateRange(index, { materialId: material.materialId, sourceHash: material.sourceHash }); }}><option value="">请选择并核对当前参考文件…</option>{snapshot.materials.map((material) => <option key={material.materialId} value={material.materialId} disabled={ranges.some((item, position) => position !== index && item.materialId === material.materialId)}>{material.name}</option>)}</select></label>
      <label className={styles.wideField}>本课使用了哪些内容<textarea required maxLength={4000} value={range.summary} onChange={(event) => updateRange(index, { summary: event.target.value })}/></label>
      <label className={styles.wideField}>讲到哪里（可选定位）<input maxLength={4000} placeholder="例如：函数定义小节；PDF 第 12 页" value={range.position} onChange={(event) => updateRange(index, { position: event.target.value })}/></label>
      <label className={styles.wideField}>这个文件下次从哪里继续<textarea required maxLength={4000} value={range.nextLesson} onChange={(event) => updateRange(index, { nextLesson: event.target.value })}/></label>
      <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => setRanges((items) => items.filter((_, position) => position !== index))}>移除此文件记录</button>
    </fieldset>)}
    <div className={styles.buttonRow}><button className={styles.secondaryButton} type="button" disabled={busy || ranges.length >= Math.min(128, snapshot.materials.length)} onClick={() => setRanges((items) => [...items, { materialId: "", sourceHash: "", summary: "", position: "", nextLesson: "" }])}>添加文件 Checkpoint</button></div>
    <label className={styles.wideField}>本课覆盖内容（每行一项）<textarea required value={completed} onChange={(event) => setCompleted(event.target.value)}/></label>
    <label className={styles.wideField}>尚未覆盖 / 待核对（每行一项）<textarea value={remaining} onChange={(event) => setRemaining(event.target.value)}/></label>
    <label className={styles.wideField}>下一课从哪里接续<textarea required maxLength={4000} value={nextLesson} onChange={(event) => setNextLesson(event.target.value)}/></label>
    <div className={styles.buttonRow}><button className={styles.primaryButton} disabled={busy} type="submit">保存 Checkpoint 草稿</button><button className={styles.secondaryButton} disabled={busy} type="button" onClick={onCancel}>取消编辑</button></div>
  </form>;
}
