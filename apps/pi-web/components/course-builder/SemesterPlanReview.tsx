"use client";
import { useState } from "react";
import type { SemesterPlan, CourseBuilderMaterial } from "../../../../packages/course-builder-host/src/types";

function Items({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return <div><dt>{label}</dt><dd><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></div>;
}

export function SemesterPlanReview({ plan, materials }: { plan: SemesterPlan; materials: Pick<CourseBuilderMaterial, "materialId" | "name">[] }) {
  const [openSlots, setOpenSlots] = useState(() => new Set([0]));
  const names = new Map(materials.map((material) => [material.materialId, material.name]));
  const allOpen = openSlots.size === plan.sessions.length;
  return <div className="semester-review">
    <h5>{plan.title}</h5>
    <p className="semester-rationale">{plan.rationale}</p>
    <div className="semester-review-controls"><strong>共 {plan.sessions.length} 个时段 · 按周审阅</strong><button type="button" onClick={() => setOpenSlots(allOpen ? new Set() : new Set(plan.sessions.map((_, index) => index)))}>{allOpen ? "收起全部课次" : "展开全部课次"}</button></div>
    {plan.sessions.map((slot, index) => <details key={`${slot.week}:${slot.session}`} open={openSlots.has(index)}>
      <summary onClick={(event) => { event.preventDefault(); setOpenSlots((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; }); }}><span>第 {slot.week} 周 · 第 {slot.session} 次</span><strong>{slot.title}</strong></summary>
      <dl>
        <Items label="学习目标" items={slot.objectives}/><Items label="先修要求" items={slot.prerequisites}/><Items label="主题" items={slot.topics}/><Items label="课堂活动" items={slot.activities}/><Items label="如何检验理解" items={slot.understandingEvidence}/>
        {slot.assessment && <div><dt>评估</dt><dd>{slot.assessment}</dd></div>}{slot.homework && <div><dt>课后任务</dt><dd>{slot.homework}</dd></div>}
        <Items label="对应课程目标" items={slot.courseGoalsCovered}/><Items label="使用资料" items={slot.materialIds.map((id) => names.get(id) ?? `未找到名称的资料：${id}`)}/><Items label="概念重访" items={slot.revisits.map((item) => `${item.conceptId} · ${item.progression}：${item.note}`)}/><Items label="可视化机会" items={slot.visualOpportunities}/>
      </dl>
    </details>)}
    {plan.review && <p>上次审查意见：{plan.review.note || "无附加意见"}</p>}
    <style>{`
      .semester-review { margin:16px 0; line-height:1.7; overflow-wrap:anywhere; }
      .semester-review h5 { font-size:19px; margin:0 0 12px; line-height:1.45; }
      .semester-rationale { white-space:pre-wrap; margin:0 0 18px; color:var(--text-muted); }
      .semester-review-controls { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
      .semester-review-controls button { border:1px solid var(--border); border-radius:6px; padding:7px 10px; cursor:pointer; background:var(--bg-panel); color:var(--text); }
      .semester-review details { border-top:1px solid var(--border); padding:12px 0; }
      .semester-review summary { cursor:pointer; }
      .semester-review summary span { color:var(--text-muted); font-size:12px; margin-right:12px; }
      .semester-review summary strong { font-weight:600; }
      .semester-review dl { margin:14px 0 0; }
      .semester-review dl>div { margin:0 0 12px; }
      .semester-review dt { font-weight:600; font-size:13px; }
      .semester-review dd { margin:3px 0 0; white-space:pre-wrap; }
      .semester-review ul { padding-left:20px; margin:0; }
    `}</style>
  </div>;
}
