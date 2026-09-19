"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PdfPreview } from "@/components/PdfPreview";
import { TexSourcePdfEditor } from "./TexSourcePdfEditor";

type Loaded = { source: string; sourceHash: string; extension: string };

async function responseError(response: Response): Promise<string> {
	try { return ((await response.json()) as { error?: string }).error ?? `HTTP ${response.status}`; }
	catch { return `HTTP ${response.status}`; }
}

export function AssignmentSourceEditor({ sessionId, assignmentId, path, pdfPath }: { sessionId: string; assignmentId: string; path: string; pdfPath: string | null }) {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [source, setSource] = useState("");
	const sourceRef = useRef("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [log, setLog] = useState("");
	const [pdfRevision, setPdfRevision] = useState(0);
	const query = new URLSearchParams({ sessionId, assignmentId, path }).toString();
	const load = useCallback(async () => {
		const response = await fetch(`/api/course-builder/assignment-assets?${query}`, { cache: "no-store" });
		if (!response.ok) throw new Error(await responseError(response));
		const value = await response.json() as Loaded;
		setLoaded(value); setSource(value.source); sourceRef.current = value.source; setError("");
	}, [query]);
	useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [load]);

	const save = useCallback(async (compile: boolean) => {
		if (!loaded || busy) return;
		setBusy(true); setError(""); setNotice(""); setLog("");
		try {
			const response = await fetch("/api/course-builder/assignment-assets", { method: "POST", headers: { "content-type": "application/json", "x-course-builder-teacher": "1" }, body: JSON.stringify({ sessionId, assignmentId, path, source: sourceRef.current, expectedHash: loaded.sourceHash, compile }) });
			if (!response.ok) throw new Error(await responseError(response));
			const value = await response.json() as { sourceHash: string; compile: { succeeded: boolean; log: string; pdfRelativePath: string | null } | null };
			setLoaded({ ...loaded, source: sourceRef.current, sourceHash: value.sourceHash });
			if (value.compile) {
				setLog(value.compile.log);
				if (!value.compile.succeeded) throw new Error("XeLaTeX 编译失败；旧 PDF 已保留。请查看编译日志并修复源码。");
				setPdfRevision((current) => current + 1);
			}
			setNotice(value.compile ? "源码已保存，PDF 已重新编译。" : "源码已保存。未重新编译的旧 PDF 保持可见。");
		} catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(false); }
	}, [assignmentId, busy, loaded, path, sessionId]);

	if (error && !loaded) return <p role="alert" className="workspace-preview-error">{error}</p>;
	if (!loaded) return <p role="status">正在读取 Assignment 源文件…</p>;
	const dirty = source !== loaded.source;
	const pdfUrl = pdfPath ? `/api/course-builder/assignment-assets?${new URLSearchParams({ sessionId, assignmentId, path: pdfPath, type: "pdf", v: String(pdfRevision) }).toString()}` : null;
	if (loaded.extension === ".tex") return <div className="assignment-source-editor">
		<div className="assignment-source-actions"><button type="button" disabled={busy || !dirty} onClick={() => void save(false)}>保存源码</button><button type="button" disabled={busy} onClick={() => void save(true)}>保存并编译（Ctrl+S）</button>{notice && <span>{notice}</span>}</div>
		{error && <p role="alert" className="workspace-preview-error">{error}</p>}
		<TexSourcePdfEditor source={source} onSourceChange={(value) => { sourceRef.current = value; setSource(value); }} disabled={busy} sourceLabel="编辑 Assignment TeX" sourcePaneLabel="Assignment TeX 编辑区" pdfPaneLabel="Assignment PDF 预览" pdfTitle="Assignment PDF" pdfUrl={pdfUrl} sourcePaneTestId="assignment-tex-source-pane" pdfPaneTestId="assignment-tex-pdf-pane" onSaveShortcut={() => void save(true)} pdfFallback={<div className="tex-pdf-placeholder">尚未生成同名 PDF；按 Ctrl+S 保存并编译。</div>}/>
		{log && <details><summary>编译日志</summary><pre>{log}</pre></details>}
		<style>{`.assignment-source-editor{display:flex;flex:1;min-height:0;flex-direction:column}.assignment-source-actions{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border)}.assignment-source-actions button{padding:6px 10px}.assignment-source-actions span{color:var(--text-muted);font-size:12px}.assignment-source-editor details{max-height:12rem;overflow:auto;padding:8px 12px;border-top:1px solid var(--border)}.assignment-source-editor pre{white-space:pre-wrap;font-size:11px}`}</style>
	</div>;

	return <div className="assignment-text-editor" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") { event.preventDefault(); void save(false); } }}>
		<div className="assignment-source-actions"><button type="button" disabled={busy || !dirty} onClick={() => void save(false)}>保存（Ctrl+S）</button>{notice && <span>{notice}</span>}</div>
		{error && <p role="alert" className="workspace-preview-error">{error}</p>}
		<div className="assignment-text-columns"><label><span>源码</span><textarea aria-label="编辑 Assignment 文本源码" value={source} disabled={busy} onChange={(event) => { sourceRef.current = event.target.value; setSource(event.target.value); }}/></label><section aria-label="Assignment Markdown 预览"><span>数学 Markdown 预览</span><div><MarkdownBody>{source}</MarkdownBody></div></section></div>
		<style>{`.assignment-text-editor{display:flex;flex:1;min-height:0;flex-direction:column}.assignment-source-actions{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border)}.assignment-source-actions span{color:var(--text-muted);font-size:12px}.assignment-text-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);flex:1;min-height:0}.assignment-text-columns>label,.assignment-text-columns>section{display:flex;min-width:0;min-height:0;flex-direction:column}.assignment-text-columns>label{border-right:1px solid var(--border)}.assignment-text-columns>label>span,.assignment-text-columns>section>span{padding:7px 10px;border-bottom:1px solid var(--border);font-size:11px;color:var(--text-muted)}.assignment-text-columns textarea{flex:1;min-height:0;resize:none;border:0;padding:14px;font:13px/1.55 var(--font-mono);color:var(--text);background:var(--bg);white-space:pre-wrap;overflow-wrap:anywhere}.assignment-text-columns section>div{flex:1;min-height:0;overflow:auto;padding:18px}@media(max-width:760px){.assignment-text-columns{grid-template-columns:1fr}.assignment-text-columns>label{border-right:0;border-bottom:1px solid var(--border)}}`}</style>
	</div>;
}

export function AssignmentPdfPreview({ sessionId, assignmentId, path }: { sessionId: string; assignmentId: string; path: string }) {
	const url = `/api/course-builder/assignment-assets?${new URLSearchParams({ sessionId, assignmentId, path, type: "pdf" }).toString()}`;
	return <PdfPreview url={url} title={path.split("/").at(-1) ?? "Assignment PDF"}/>;
}
