"use client";

import { useState } from "react";
import type { VisualizationDraft } from "../../../../packages/study-research-host/src/types.ts";
import styles from "@/app/study/Study.module.css";

type Editor = { visualizationId?: string; expectedVisualizationRevision?: number; expectedProjectRevision: number; expectedPhaseRevision: number; purpose: string; code: string; inputs: string };

export function StudyVisualEditor(props: { sessionId: string; phaseRevision: number; projectRevision: number; visualizations: VisualizationDraft[]; onChanged: () => void }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const edit = async (draft?: VisualizationDraft) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      const response = await fetch(`/api/study-research?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: "no-store" });
      const state = await response.json() as { error?: string; revision: number; phase: { revision: number }; visualizations: VisualizationDraft[] };
      if (!response.ok) throw new Error(state.error || "无法读取当前编辑版本。");
      if (!Number.isSafeInteger(state.revision) || !Number.isSafeInteger(state.phase?.revision) || !Array.isArray(state.visualizations)) throw new Error("当前编辑版本响应无效。");
      const observed = draft ? state.visualizations.find(value => value.visualizationId === draft.visualizationId) : undefined;
      if (draft && (!observed || observed.contentHash !== draft.contentHash || observed.revision !== draft.revision)) { props.onChanged(); throw new Error("此图已改变，请查看最新版本后再编辑。"); }
      setEditor({ visualizationId: draft?.visualizationId, expectedVisualizationRevision: draft?.revision,
        expectedProjectRevision: state.revision, expectedPhaseRevision: state.phase.revision,
        purpose: draft?.purpose ?? "", code: draft?.code ?? "", inputs: JSON.stringify(draft?.inputs ?? {}, null, 2) });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <section className={styles.section} aria-label="定制图代码与参数">
    <div className={styles.sectionHeader}><div><h3>定制图</h3><p>按论文内容编写图形，或调整已有图的代码和参数。保存为新草稿后，可以预览并重新检查。</p></div>
      <button className={styles.button} type="button" disabled={busy || editor !== null} onClick={() => void edit()}>新建定制图</button></div>
    <div className={styles.readerButtons}>{props.visualizations.map((draft) => <button key={draft.visualizationId} className={styles.button} type="button" disabled={busy || editor !== null} onClick={() => void edit(draft)}>编辑：{draft.purpose} · r{draft.revision}</button>)}</div>
    {editor && <form className={styles.form} onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError("");
      try {
        const inputs: unknown = JSON.parse(editor.inputs);
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("参数必须是 JSON 对象。");
        const response = await fetch("/api/study-research/visualization", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...editor, sessionId: props.sessionId, inputs }) });
        const value = await response.json() as { error?: string; visualization?: VisualizationDraft };
        if (!response.ok) throw new Error(value.error || "未能保存可视化。你的草稿仍在。 ");
        if (!value.visualization) throw new Error("保存响应缺少可视化版本。");
        setEditor(null); setNotice(`已保存 r${value.visualization.revision} 草稿；旧验证仍归属于原版本。`); props.onChanged();
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { setBusy(false); }
    }}>
      {(props.phaseRevision !== editor.expectedPhaseRevision || props.projectRevision !== editor.expectedProjectRevision) && <p className={styles.severityWarning}>项目或阶段在编辑期间发生了变化。保存会核对原版本；你的输入保留在这里。</p>}
      <label className={styles.field}><span>这张图要解释什么</span><input value={editor.purpose} required maxLength={20000} onChange={(event) => setEditor({ ...editor, purpose: event.target.value })} /></label>
      <label className={styles.field}><span>图形代码</span><textarea aria-label="图形代码" value={editor.code} rows={12} required spellCheck={false} maxLength={131072} className={styles.jsonEditor} onChange={(event) => setEditor({ ...editor, code: event.target.value })} /></label>
      <label className={styles.field}><span>图形参数 JSON</span><textarea aria-label="图形参数 JSON" value={editor.inputs} rows={4} required spellCheck={false} maxLength={65536} className={styles.jsonEditor} onChange={(event) => setEditor({ ...editor, inputs: event.target.value })} /></label>
      <details><summary>代码接口</summary><p>输入为 <code>inputs</code>；返回 <code>{'{elements:[{tag,attrs,text?}],summary,metrics?}'}</code>。画布坐标为 800 × 500，支持 path、circle、ellipse、line、rect、polyline、polygon、text。可用 metrics 返回要单独验证的数值。</p></details>
      <div className={styles.readerButtons}><button className={styles.buttonPrimary} disabled={busy} type="submit">保存定制图草稿</button><button className={styles.button} disabled={busy} type="button" onClick={() => setEditor(null)}>放弃本次编辑</button></div>
    </form>}
    {error && <p role="alert" className={styles.severityError}>{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
