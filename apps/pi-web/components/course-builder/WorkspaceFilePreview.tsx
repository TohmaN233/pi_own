"use client";
import { useEffect, useRef, useState } from "react";
import { FileViewer } from "@/components/FileViewer";
import { MarkdownBody } from "@/components/MarkdownBody";
import { getFileName } from "@/lib/file-paths";
import type { WorkspacePreviewTarget } from "@/lib/workspace-preview";
import { BeamerSourceEditor } from "./BeamerSourceEditor";
import { PdfPreview } from "@/components/PdfPreview";

function CourseArtifactPreview({ target }: { target: Extract<WorkspacePreviewTarget, { kind: "artifact" }> }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  useEffect(() => {
    if (target.format === "pdf") return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(target.url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? `无法读取产物：HTTP ${response.status}`);
      }
      const text = await response.text();
      if (!controller.signal.aborted) setContent(text);
    })().catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { controller.abort(); };
  }, [target.url, target.format]);
  return <>
    <div className="workspace-preview-toolbar"><a href={`${target.url}&download=1`} download={target.title}>下载文件</a>{(target.format === "markdown" || target.format === "html") && <button type="button" onClick={() => setSource((value) => !value)}>{source ? "查看预览" : "查看源码"}</button>}</div>
    {error ? <p role="alert" className="workspace-preview-error">{error}</p> : target.format === "pdf" ? <PdfPreview url={target.url} title={target.title}/> : content === null ? <p role="status">正在读取文件…</p> : target.format === "html" && !source ? <iframe title={target.title} sandbox="" srcDoc={content!} className="workspace-preview-frame"/> : <div className="workspace-preview-document">{target.format === "markdown" && !source ? <MarkdownBody>{content!}</MarkdownBody> : <pre>{content}</pre>}</div>}
  </>;
}

export function WorkspaceFilePreview({ target, sessionId, onClose, onOpenFile }: { target: WorkspacePreviewTarget; sessionId: string; onClose: () => void; onOpenFile: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, [onClose]);
  const title = target.kind === "file" ? getFileName(target.path) : target.title;
  const artifactQuery = target.kind === "artifact" ? new URL(target.url, "http://localhost").searchParams : null;
  const texDeckId = artifactQuery?.get("kind") === "tex" ? artifactQuery.get("id") : null;
  return <aside className={`workspace-file-preview${expanded ? " is-expanded" : ""}`} aria-label="文件预览">
    <header><strong title={target.kind === "file" ? target.path : title}>{title}</strong><button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起宽度" : "展开"}</button><button type="button" ref={closeButton} aria-label="关闭文件预览" onClick={onClose}>关闭 ×</button></header>
    <div className="workspace-preview-body">{target.kind === "file" ? <FileViewer key={target.path} filePath={target.path} cwd={target.cwd} sourceSessionId={sessionId} onOpenFile={onOpenFile}/> : texDeckId ? <><div className="workspace-preview-toolbar"><a href={`${target.url}&download=1`} download="deck.tex">下载已保存的 TeX</a></div><BeamerSourceEditor key={texDeckId} sessionId={sessionId} deckId={texDeckId}/></> : <CourseArtifactPreview key={target.url} target={target}/>}</div>
    <style>{`
      .workspace-file-preview { position:fixed; z-index:55; inset:0 0 0 auto; width:min(760px,60vw); min-width:440px; display:flex; flex-direction:column; background:var(--bg); color:var(--text); border-left:1px solid var(--border); box-shadow:-14px 0 40px #0002; }
      .workspace-file-preview.is-expanded { width:calc(100vw - 28px); }
      .workspace-file-preview>header { display:flex; align-items:center; gap:10px; min-height:58px; padding:10px 16px; border-bottom:1px solid var(--border); }
      .workspace-file-preview>header strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .workspace-file-preview button, .workspace-preview-toolbar a { cursor:pointer; border:1px solid var(--border); border-radius:6px; padding:6px 10px; color:var(--text); background:var(--bg-panel); font:inherit; text-decoration:none; }
      .workspace-preview-body { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
      .workspace-preview-toolbar { display:flex; gap:10px; padding:10px 16px; border-bottom:1px solid var(--border); }
      .workspace-preview-document { flex:1; min-height:0; overflow:auto; padding:22px; }
      .workspace-preview-document pre { white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.7 var(--font-mono); }
      .workspace-preview-frame { flex:1; width:100%; min-height:0; border:0; background:white; }
      .workspace-preview-error { padding:20px; color:#d06040; overflow-wrap:anywhere; }
      @media(max-width:680px) { .workspace-file-preview { width:100%; min-width:0; } }
    `}</style>
  </aside>;
}
