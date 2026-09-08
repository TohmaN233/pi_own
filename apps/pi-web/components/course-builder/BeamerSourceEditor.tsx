"use client";
import { useEffect, useState } from "react";
import type { BeamerDeck, CourseBuilderSnapshot } from "../../../../packages/course-builder-host/src/types.ts";
import { ensureCourseBuilderRuntime } from "@/lib/course-builder-runtime-client";
import { notifySessionConfiguration } from "@/lib/session-configuration-events";
import { PdfPreview } from "@/components/PdfPreview";

function requireSource(deck: BeamerDeck | undefined): BeamerDeck {
  if (!deck || typeof deck.source !== "string" || !deck.source.trim()) throw new Error("课件响应缺少已保存的 TeX 源码；请重新打开核验。");
  return deck;
}

export function BeamerSourceEditor({ sessionId, deckId }: { sessionId: string; deckId: string }) {
  const storageKey = `pi-tex-edit:${sessionId}:${deckId}`;
  const [deck, setDeck] = useState<BeamerDeck | null>(null);
  const [source, setSource] = useState("");
  const [outline, setOutline] = useState("");
  const [baseRevision, setBaseRevision] = useState(0);
  const [parentRevision, setParentRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pdf, setPdf] = useState<string | null>(null);
  const [compilerEnabled, setCompilerEnabled] = useState(false);
  const dirty = !!deck && (source !== deck.source || outline !== deck.frameOutline.join("\n"));
  const conflict = !!deck && baseRevision !== deck.revision;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(`/api/course-builder/deck?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(deckId)}`, { signal: controller.signal, cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "无法读取课件");
      if (controller.signal.aborted) return;
      const current = requireSource(value.deck);
      setCompilerEnabled(value.compilerEnabled); setDeck(current); setSource(current.source); setOutline(current.frameOutline.join("\n")); setBaseRevision(current.revision); setParentRevision(current.lessonPlanRevision);
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.source !== "string" || typeof parsed.outline !== "string" || !Number.isSafeInteger(parsed.revision) || !Number.isSafeInteger(parsed.parentRevision)) throw new Error("暂存的 TeX 编辑格式损坏；请读取已保存版本后继续。");
        setSource(parsed.source); setOutline(parsed.outline); setBaseRevision(parsed.revision); setParentRevision(parsed.parentRevision);
      }
      setReady(true);
    })().catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [sessionId, deckId, storageKey]);
  useEffect(() => {
    if (!ready || !deck) return;
    try { if (dirty) localStorage.setItem(storageKey, JSON.stringify({ source, outline, revision: baseRevision, parentRevision })); else localStorage.removeItem(storageKey); }
    catch (cause) { setError(`本机暂存失败，请及时保存：${String(cause)}`); }
  }, [ready, deck, dirty, storageKey, source, outline, baseRevision, parentRevision]);
  async function submit(compile: boolean) {
    if (!deck || busy) return;
    setBusy(true); setError(""); setNotice(""); setPdf(null);
    try {
      if (compile) await ensureCourseBuilderRuntime(sessionId);
      const response = await fetch("/api/course-builder", { method: "POST", headers: { "content-type": "application/json", "x-course-builder-teacher": "1" }, body: JSON.stringify(compile ? { sessionId, action: "command", command: { action: "compile", id: deckId, expectedRevision: baseRevision } } : { sessionId, action: "edit_deck", id: deckId, expectedRevision: baseRevision, parentRevision, source, frameOutline: outline.split("\n").map((line) => line.trim()).filter(Boolean) }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "操作失败");
      const state = value.snapshot as CourseBuilderSnapshot;
      // Compile returns a summary; source stays the already-loaded, revision-checked source.
      const compiled = state.decks.find((item) => item.deckId === deckId);
      if (compile && compiled?.revision !== baseRevision) throw new Error("编译期间课件版本已变化，请重新打开核验。");
      const current = requireSource(compile ? { ...deck, ...compiled, source: deck.source } : value.deck);
      setDeck(current); setSource(current.source); setOutline(current.frameOutline.join("\n")); setBaseRevision(current.revision); setParentRevision(current.lessonPlanRevision);
      if (compile) {
        const receipt = state.compileReceipts.filter((item) => item.deckId === deckId && item.deckRevision === current.revision).at(-1);
        if (!receipt?.succeeded) throw new Error(`编译失败：${receipt?.diagnostics.map((item) => item.message).join("；") || "请在工作区查看编译日志"}`);
        setPdf(`/api/course-builder/export?sessionId=${encodeURIComponent(sessionId)}&kind=pdf&id=${encodeURIComponent(receipt.receiptId)}`);
        setNotice(`编译成功 · ${receipt.pageCount ?? ""} 页`);
      } else setNotice(`已保存 TeX revision ${current.revision}，请重新编译。`);
      notifySessionConfiguration(sessionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="beamer-source-editor">
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!deck ? !error && <p>正在读取 TeX…</p> : <>
      <div className="beamer-edit-controls"><strong>TeX 源码 · r{deck.revision}</strong><button disabled={busy || !ready || !dirty || conflict} onClick={() => void submit(false)}>保存修改</button><button disabled={busy || !ready || dirty || conflict || !compilerEnabled} onClick={() => void submit(true)}>编译已保存源码</button></div>
      <p>{dirty ? "有未保存编辑 · 本机暂存" : "修改后保存为新草稿，再编译生成 PDF。"}</p>
      {conflict && <p role="alert">暂存基于 r{baseRevision}，课件已有 r{deck.revision}；请先保留需要的修改，再读取已保存版本。</p>}
      <button disabled={busy} onClick={() => { setSource(deck.source); setOutline(deck.frameOutline.join("\n")); setBaseRevision(deck.revision); setParentRevision(deck.lessonPlanRevision); setReady(true); setError(""); }}>放弃暂存，读取已保存版本</button>
      <textarea aria-label="编辑 TeX 源码" spellCheck={false} disabled={busy || !ready} value={source} onChange={(event) => setSource(event.target.value)}/>
      <details><summary>同步修改 Frame 大纲（每行一项）</summary><textarea aria-label="Frame 大纲" value={outline} disabled={busy} onChange={(event) => setOutline(event.target.value)}/></details>
      {pdf && <div style={{ minHeight: 500, height: 600, flexShrink: 0 }}><PdfPreview url={pdf} title="编译后的 PDF"/></div>}
    </>}
    <style>{`.beamer-source-editor{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}.beamer-source-editor p{margin:0;font-size:12px;line-height:1.5}.beamer-source-editor [role=alert]{color:#d06040}.beamer-edit-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.beamer-source-editor>textarea{flex:1;min-height:360px;resize:vertical;white-space:pre;tab-size:2;font:13px/1.6 var(--font-mono);padding:12px;border:1px solid var(--border);background:var(--bg-panel);color:var(--text)}.beamer-source-editor details textarea{width:100%;min-height:120px;background:var(--bg);color:var(--text)}.beamer-source-editor iframe{width:100%;min-height:500px;border:0}.beamer-source-editor button:disabled{opacity:.5;cursor:default}`}</style>
  </div>;
}
