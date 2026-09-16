"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PdfPreview, type PdfLocation } from "@/components/PdfPreview";

type SourceQuery = { line: number } | { page: number; x: number; y: number };

export type TexSourceSync = {
	endpoint: string;
	sessionId: string;
	receiptId: string;
	revision: number;
	sourceHash: string;
};

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("双向定位响应格式无效。");
	return value as Record<string, unknown>;
}

function isForwardLocation(value: Record<string, unknown>): value is Record<string, number> {
	return (
		Number.isSafeInteger(value.page) &&
		(value.page as number) >= 1 &&
		[value.x, value.y, value.width, value.height].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
	);
}

function isBackwardLocation(value: Record<string, unknown>, source: string): value is Record<string, number> {
	return (
		Number.isSafeInteger(value.line) &&
		(value.line as number) >= 1 &&
		(value.line as number) <= source.split("\n").length &&
		Number.isSafeInteger(value.column)
	);
}

/** Shared persisted-TeX editor: soft source wrapping and receipt-bound PDF navigation. */
export function TexSourcePdfEditor(props: {
	source: string;
	onSourceChange: (source: string) => void;
	disabled: boolean;
	sourceLabel: string;
	sourcePaneLabel: string;
	pdfPaneLabel: string;
	pdfTitle: string;
	pdfUrl: string | null;
	pdfFallback: ReactNode;
	onSaveShortcut: () => void;
	sourceBefore?: ReactNode;
	sourceAfter?: ReactNode;
	sync?: TexSourceSync;
	sourcePaneTestId: string;
	pdfPaneTestId: string;
}) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const sourceRef = useRef(props.source);
	const syncKeyRef = useRef("");
	const locateRequestRef = useRef(0);
	const [pdfLocation, setPdfLocation] = useState<PdfLocation>();
	const [syncError, setSyncError] = useState("");
	const [syncNotice, setSyncNotice] = useState("");
	const syncKey = props.sync
		? `${props.sync.receiptId}:${props.sync.revision}:${props.sync.sourceHash}`
		: "";

	useEffect(() => {
		sourceRef.current = props.source;
		syncKeyRef.current = syncKey;
		locateRequestRef.current += 1;
		setPdfLocation(undefined);
	}, [props.source, syncKey]);

	function invalidateForEdit(nextSource: string) {
		locateRequestRef.current += 1;
		sourceRef.current = nextSource;
		setPdfLocation(undefined);
		setSyncError("");
		setSyncNotice("");
		props.onSourceChange(nextSource);
	}

	function selectSourceLine(source: string, line: number) {
		const lines = source.split("\n");
		if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) throw new Error("源码定位结果超出当前文件范围。");
		const editor = textareaRef.current;
		if (!editor) return;
		const start = lines.slice(0, line - 1).reduce((length, previous) => length + previous.length + 1, 0);
		editor.focus();
		editor.setSelectionRange(start, start + lines[line - 1].length);
		const mirror = document.createElement("div");
		const marker = document.createElement("span");
		const style = getComputedStyle(editor);
		Object.assign(mirror.style, {
			position: "fixed",
			visibility: "hidden",
			left: "-100000px",
			top: "0",
			width: `${editor.clientWidth}px`,
			boxSizing: "border-box",
			font: style.font,
			padding: style.padding,
			whiteSpace: "pre-wrap",
			overflowWrap: "anywhere",
			tabSize: style.tabSize,
		});
		mirror.append(document.createTextNode(source.slice(0, start)));
		marker.textContent = lines[line - 1] || " ";
		mirror.append(marker);
		document.body.append(mirror);
		editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 3);
		mirror.remove();
	}

	async function locate(query: SourceQuery) {
		const sync = props.sync;
		if (!sync) return;
		const requestId = ++locateRequestRef.current;
		const expectedSource = sourceRef.current;
		const expectedSyncKey = syncKey;
		setSyncError("");
		try {
			const response = await fetch(sync.endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: sync.sessionId, receiptId: sync.receiptId, ...query }),
			});
			const value = record(await response.json());
			if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `双向定位失败：HTTP ${response.status}`);
			if (
				requestId !== locateRequestRef.current ||
				sourceRef.current !== expectedSource ||
				syncKeyRef.current !== expectedSyncKey
			)
				return;
			if (value.receiptId !== sync.receiptId) throw new Error("定位结果对应了其他编译版本。");
			if ("line" in query) {
				if (!isForwardLocation(value)) throw new Error("PDF 定位结果无效。");
				setPdfLocation({ page: value.page, x: value.x, y: value.y, width: value.width, height: value.height, requestId });
				setSyncNotice(`已定位到 PDF 第 ${value.page} 页，黄色区域对应源码。`);
			} else {
				if (!isBackwardLocation(value, expectedSource)) throw new Error("源码定位结果无效。");
				selectSourceLine(expectedSource, value.line);
				setSyncNotice(`已定位并选中源码第 ${value.line} 行。`);
			}
		} catch (cause) {
			if (requestId === locateRequestRef.current) setSyncError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	function locateCursor() {
		const cursor = textareaRef.current?.selectionStart ?? 0;
		void locate({ line: sourceRef.current.slice(0, cursor).split("\n").length });
	}

	function handleSaveShortcut(event: KeyboardEvent<HTMLDivElement>) {
		if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
		event.preventDefault();
		props.onSaveShortcut();
	}

	return <div className="tex-source-pdf-editor" onKeyDown={handleSaveShortcut} aria-keyshortcuts="Control+S Meta+S">
		{syncError && <p role="alert" className="tex-source-sync-error">{syncError}</p>}
		{syncNotice && <p role="status" className="tex-source-sync-notice">{syncNotice}</p>}
		<div className="tex-source-preview-split">
			<section className="tex-source-pane" data-testid={props.sourcePaneTestId} aria-label={props.sourcePaneLabel}>
				{props.sourceBefore}
				<label className="tex-source-label">{props.sourceLabel}<textarea className="tex-source-textarea" ref={textareaRef} wrap="soft" aria-label={props.sourceLabel} spellCheck={false} disabled={props.disabled} value={props.source} onDoubleClick={locateCursor} onChange={(event) => invalidateForEdit(event.target.value)} /></label>
				{props.sourceAfter}
			</section>
			<section className="tex-pdf-pane" data-testid={props.pdfPaneTestId} aria-label={props.pdfPaneLabel}>
				{props.pdfUrl ? <PdfPreview key={props.pdfUrl} url={props.pdfUrl} title={props.pdfTitle} location={pdfLocation} onSourceLocate={props.sync ? (position) => void locate(position) : undefined} /> : props.pdfFallback}
			</section>
		</div>
		<style>{`.tex-source-pdf-editor{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}.tex-source-sync-error{color:#d06040}.tex-source-sync-notice{color:var(--text-muted)}.tex-source-preview-split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;overflow:hidden}.tex-source-pane,.tex-pdf-pane{min-width:0;min-height:0;overflow:auto;border:1px solid var(--border);background:color-mix(in srgb,var(--bg-panel) 76%,transparent);padding:12px;display:flex;flex-direction:column;gap:10px}.tex-source-pane label{display:flex;flex-direction:column;gap:5px;font-size:12px}.tex-source-label{flex:1;min-height:0}.tex-source-pane input,.tex-source-pane textarea{border:1px solid var(--border);background:var(--bg-panel);color:var(--text);font:inherit;padding:9px}.tex-source-textarea{flex:1;min-height:320px;resize:vertical;width:100%;min-width:0;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden;tab-size:2;font:13px/1.6 var(--font-mono)}.tex-source-pane details textarea{width:100%;min-height:120px;box-sizing:border-box}.tex-pdf-pane iframe{min-height:0;flex:1;width:100%;border:0}.tex-pdf-placeholder{margin:auto;max-width:34rem;padding:18px;color:var(--text-muted);font-size:13px;line-height:1.6}.tex-pdf-placeholder strong{color:var(--text)}.tex-pdf-placeholder ul{padding-left:20px}.tex-pdf-placeholder a{color:var(--accent)}@media(max-width:760px){.tex-source-preview-split{grid-template-columns:1fr;overflow:visible}.tex-source-pane,.tex-pdf-pane{min-height:420px}.tex-pdf-pane{height:560px}}`}</style>
	</div>;
}
