"use client";

import { useState } from "react";
import type { StudyCodeCell } from "../../../../packages/study-execution-host/src/code-cells.ts";
import type { SourceVersion } from "../../../../packages/study-research-host/src/types.ts";
import styles from "@/app/study/Study.module.css";
import { StudyCellExecution, StudyExecutionProvider } from "./StudyCellExecution";

type Editor = {
  cellId?: string;
  expectedCellRevision?: number;
  title: string;
  purpose: string;
  language: "r" | "python";
  code: string;
  parameters: string;
  inputs: StudyCodeCell["inputs"];
};

const empty = (): Editor => ({ title: "", purpose: "", language: "r", code: "", parameters: "{}", inputs: [] });

export function StudyCodeCells({ cells, sources, busy, save, sessionId, phaseRevision }: {
  sessionId: string;
  phaseRevision: number;
  cells: StudyCodeCell[];
  sources: SourceVersion[];
  busy: boolean;
  save: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [inputName, setInputName] = useState("");
  const [inputRoot, setInputRoot] = useState("");
  const [inputPath, setInputPath] = useState("");
  const current = editor?.cellId ? cells.find((cell) => cell.cellId === editor.cellId) : null;
  return <StudyExecutionProvider key={sessionId} sessionId={sessionId}><section className={styles.section} id="code-cells" tabIndex={-1}>
    <div className={styles.sectionHeader}><div><h3>代码单元</h3><p>用小例子理解定义和算法；代码、参数与来源分别保留版本。</p></div>
      <button type="button" className={styles.button} disabled={busy || editor !== null} onClick={() => { setEditor(empty()); setError(null); }}>新建代码单元</button></div>
    {cells.length === 0 && <p className={styles.dim}>可以编辑并运行 R 或 Python 小例子，运行记录固定所选代码、参数与输入版本。</p>}
    <details><summary>登记论文代码或实验数据</summary><form className={styles.form} onSubmit={async event => {
      event.preventDefault(); setError(null);
      if (await save({ action: "import-supplement", rootPath: inputRoot, entryPath: inputPath })) setInputPath("");
    }}>
      <p>只登记你选择的文件，不运行其中的代码。运行时绑定已登记版本；单文件上限 16 MiB，每次运行输入合计 32 MiB。</p>
      <label className={styles.field}>文件所在根目录<input aria-label="数据根目录" value={inputRoot} onChange={event => setInputRoot(event.target.value)} required /></label>
      <label className={styles.field}>相对文件路径<input aria-label="数据文件路径" value={inputPath} onChange={event => setInputPath(event.target.value)} required placeholder="例如 R/sampling.R 或 data.csv" /></label>
      <button className={styles.button} type="submit" disabled={busy || !inputRoot.trim() || !inputPath.trim()}>登记代码或数据文件</button>
    </form></details>
    <ul className={styles.noteList}>{cells.map((cell) => <li className={styles.note} key={cell.cellId}>
      <div className={styles.row}><h4>{cell.title}</h4><span>{cell.language === "r" ? "R" : "Python"} · r{cell.revision}</span></div>
      <p>{cell.purpose}</p><pre className={styles.codeBlock}>{cell.code}</pre>
      <p className={styles.dim}>{cell.inputs.length} 个输入 · {cell.language === "r" ? "使用本机 R 包库" : "使用项目 Python 环境"}</p>
      <div className={styles.readerButtons}><button type="button" className={styles.button} disabled={busy || editor !== null} onClick={() => {
        setEditor({ cellId: cell.cellId, expectedCellRevision: cell.revision, title: cell.title, purpose: cell.purpose, language: cell.language,
          code: cell.code, parameters: JSON.stringify(cell.parameters, null, 2), inputs: structuredClone(cell.inputs) }); setError(null);
      }}>编辑此版本</button></div>
      <StudyCellExecution key={`${sessionId}:${cell.cellId}`} cell={cell} sessionId={sessionId} phaseRevision={phaseRevision} />
    </li>)}</ul>
    {editor && <form className={styles.form} onSubmit={async (event) => {
      event.preventDefault(); setError(null);
      try {
        const parameters: unknown = JSON.parse(editor.parameters);
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("参数必须为 JSON 对象。");
        if (await save({ action: "save-cell", ...editor, parameters })) setEditor(null);
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    }}>
      <h4>{editor.cellId ? `编辑 r${editor.expectedCellRevision}` : "新建代码单元"}</h4>
      {current && current.revision !== editor.expectedCellRevision && <p className={styles.severityWarning}>已保存版本发生变化。你的编辑仍保留在这里，请先比较；保存会拒绝覆盖新版。</p>}
      <label className={styles.field}><span>标题</span><input value={editor.title} maxLength={1000} required onChange={(event) => setEditor({ ...editor, title: event.target.value })} /></label>
      <label className={styles.field}><span>这个例子要说明什么</span><input value={editor.purpose} maxLength={6000} required onChange={(event) => setEditor({ ...editor, purpose: event.target.value })} /></label>
      <label className={styles.field}><span>语言</span><select aria-label="语言" value={editor.language} onChange={(event) => setEditor({ ...editor, language: event.target.value as Editor["language"] })}><option value="r">R</option><option value="python">Python</option></select></label>
      <label className={styles.field}><span>代码</span><textarea aria-label="代码" className={styles.jsonEditor} value={editor.code} maxLength={131072} rows={12} required spellCheck={false} onChange={(event) => setEditor({ ...editor, code: event.target.value })} /></label>
      <label className={styles.field}><span>参数 JSON</span><textarea aria-label="参数 JSON" className={styles.jsonEditor} value={editor.parameters} maxLength={65536} rows={4} spellCheck={false} onChange={(event) => setEditor({ ...editor, parameters: event.target.value })} /></label>
      <div className={styles.field}><span>输入文件</span><select aria-label="代码单元来源" value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">选择已登记来源</option>{sources.map((source) => <option value={source.sourceId} key={source.sourceId}>{source.relativePath}</option>)}</select>
        <input aria-label="运行时输入文件名" value={inputName} placeholder="运行时文件名，例如 data.csv" onChange={(event) => setInputName(event.target.value)} maxLength={128} />
        <button className={styles.button} type="button" disabled={!sourceId || !inputName.trim()} onClick={() => {
          const source = sources.find((entry) => entry.sourceId === sourceId);
          if (!source) return;
          setEditor({ ...editor, inputs: [...editor.inputs, { name: inputName.trim(), sourceId: source.sourceId, sourceHash: source.contentHash }] }); setInputName("");
        }}>添加输入</button>
      </div>
      {editor.inputs.map((input, index) => <p key={`${input.name}:${index}`}>{input.name} · {sources.find((source) => source.sourceId === input.sourceId)?.relativePath ?? "旧来源"}
        <button type="button" className={styles.button} onClick={() => setEditor({ ...editor, inputs: editor.inputs.filter((_, position) => position !== index) })}>移除绑定</button></p>)}
      {error && <p role="alert" className={styles.severityError}>{error}</p>}
      <div className={styles.readerButtons}><button className={styles.buttonPrimary} type="submit" disabled={busy}>保存代码版本</button><button className={styles.button} type="button" disabled={busy} onClick={() => setEditor(null)}>放弃本次编辑</button></div>
    </form>}
  </section></StudyExecutionProvider>;
}
