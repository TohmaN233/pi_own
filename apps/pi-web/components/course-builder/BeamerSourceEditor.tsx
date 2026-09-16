"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BeamerCompileReceipt, BeamerDeck } from "../../../../packages/course-builder-host/src/types.ts";
import { ensureCourseBuilderRuntime } from "@/lib/course-builder-runtime-client";
import { notifySessionConfiguration } from "@/lib/session-configuration-events";
import { TexSourcePdfEditor } from "./TexSourcePdfEditor";

type LocalDraft = { source: string; outline: string; revision: number; parentRevision: number };
type DeckResponse = { deck: BeamerDeck; compileReceipt: BeamerCompileReceipt | null; compilerEnabled: boolean; sourceSyncAvailable: boolean };

function requireSource(deck: BeamerDeck | undefined): BeamerDeck {
	if (!deck || typeof deck.source !== "string" || !deck.source.trim()) throw new Error("课件响应缺少已保存的 TeX 源码；请重新打开核验。");
	return deck;
}

function matchingCompileReceipt(value: unknown, deck: BeamerDeck): BeamerCompileReceipt | null {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("课件编译回执格式无效；请重新打开核验。");
	const receipt = value as Partial<BeamerCompileReceipt>;
	if (
		typeof receipt.receiptId !== "string" ||
		receipt.deckId !== deck.deckId ||
		receipt.deckRevision !== deck.revision ||
		receipt.sourceHash !== deck.sourceHash ||
		typeof receipt.succeeded !== "boolean" ||
		!Array.isArray(receipt.diagnostics)
	)
		throw new Error("课件编译回执与当前 revision/sourceHash 不匹配；请重新打开核验。");
	return receipt as BeamerCompileReceipt;
}

function requireDraft(value: string): LocalDraft {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch (cause) { throw new Error(`暂存的 TeX 编辑格式损坏：${String(cause)}`); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("暂存的 TeX 编辑格式损坏；请读取已保存版本后继续。");
	const draft = parsed as Partial<LocalDraft>;
	if (typeof draft.source !== "string" || typeof draft.outline !== "string" || !Number.isSafeInteger(draft.revision) || !Number.isSafeInteger(draft.parentRevision))
		throw new Error("暂存的 TeX 编辑格式损坏；请读取已保存版本后继续。");
	return { source: draft.source, outline: draft.outline, revision: draft.revision as number, parentRevision: draft.parentRevision as number };
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
	const [compilerEnabled, setCompilerEnabled] = useState(false);
	const [compileReceipt, setCompileReceipt] = useState<BeamerCompileReceipt | null>(null);
	const [previewReceipt, setPreviewReceipt] = useState<BeamerCompileReceipt | null>(null);
	const [sourceSyncAvailable, setSourceSyncAvailable] = useState(false);
	const sourceRef = useRef("");
	const baseRevisionRef = useRef(0);
	const compileRequestRef = useRef(0);
	const dirty = !!deck && (source !== deck.source || outline !== deck.frameOutline.join("\n"));
	const conflict = !!deck && baseRevision !== deck.revision;

	const fetchDeck = useCallback(async (signal?: AbortSignal): Promise<DeckResponse> => {
		const response = await fetch(`/api/course-builder/deck?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(deckId)}`, { signal, cache: "no-store" });
		const value = await response.json() as { deck?: BeamerDeck; compileReceipt?: unknown; compilerEnabled?: unknown; sourceSyncAvailable?: unknown; error?: string };
		if (!response.ok) throw new Error(value.error ?? "无法读取课件。");
		const current = requireSource(value.deck);
		if (typeof value.compilerEnabled !== "boolean" || typeof value.sourceSyncAvailable !== "boolean") throw new Error("课件响应缺少有效编译状态；请重新打开核验。");
		return { deck: current, compileReceipt: matchingCompileReceipt(value.compileReceipt, current), compilerEnabled: value.compilerEnabled, sourceSyncAvailable: value.sourceSyncAvailable };
	}, [sessionId, deckId]);

	function applyServerDeck(current: BeamerDeck, receipt: BeamerCompileReceipt | null, sourceSync: boolean, draft?: LocalDraft) {
		const nextSource = draft?.source ?? current.source;
		const nextOutline = draft?.outline ?? current.frameOutline.join("\n");
		const nextRevision = draft?.revision ?? current.revision;
		const nextParentRevision = draft?.parentRevision ?? current.lessonPlanRevision;
		const hasLocalChanges = !!draft && (draft.source !== current.source || draft.outline !== current.frameOutline.join("\n") || draft.revision !== current.revision);
		setDeck(current); setSource(nextSource); setOutline(nextOutline); setBaseRevision(nextRevision); setParentRevision(nextParentRevision);
		setCompileReceipt(hasLocalChanges ? null : receipt); setSourceSyncAvailable(sourceSync);
		if (receipt?.succeeded) setPreviewReceipt(receipt);
		sourceRef.current = nextSource; baseRevisionRef.current = nextRevision;
	}

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			const response = await fetchDeck(controller.signal);
			if (controller.signal.aborted) return;
			let draft: LocalDraft | undefined;
			try { const saved = localStorage.getItem(storageKey); if (saved) draft = requireDraft(saved); }
			catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
			setCompilerEnabled(response.compilerEnabled);
			applyServerDeck(response.deck, response.compileReceipt, response.sourceSyncAvailable, draft);
			setReady(true);
		})().catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => controller.abort();
	}, [fetchDeck, storageKey]);

	useEffect(() => {
		if (!ready || !deck) return;
		try {
			if (dirty) localStorage.setItem(storageKey, JSON.stringify({ source, outline, revision: baseRevision, parentRevision } satisfies LocalDraft));
			else localStorage.removeItem(storageKey);
		} catch (cause) { setError(`本机暂存失败，请及时保存：${String(cause)}`); }
	}, [ready, deck, dirty, storageKey, source, outline, baseRevision, parentRevision]);

	async function submit(mode: "save" | "compile" | "save-compile") {
		if (!deck || busy) return;
		const requestId = ++compileRequestRef.current;
		const shouldSave = mode !== "compile";
		const shouldCompile = mode !== "save";
		if (!shouldSave && dirty) return;
		let targetDeck = deck;
		setBusy(true); setError(""); setNotice("");
		try {
			if (shouldSave) {
				const response = await fetch("/api/course-builder", {
					method: "POST", headers: { "content-type": "application/json", "x-course-builder-teacher": "1" },
					body: JSON.stringify({ sessionId, action: "edit_deck", id: deckId, expectedRevision: baseRevisionRef.current, parentRevision, source, frameOutline: outline.split("\n").map((line) => line.trim()).filter(Boolean) }),
				});
				const value = await response.json() as { deck?: BeamerDeck; error?: string };
				if (!response.ok) throw new Error(value.error ?? "保存课件失败。");
				if (requestId !== compileRequestRef.current) return;
				targetDeck = requireSource(value.deck);
				applyServerDeck(targetDeck, null, false);
			}
			if (shouldCompile) {
				await ensureCourseBuilderRuntime(sessionId);
				const expectedRevision = targetDeck.revision;
				const expectedSourceHash = targetDeck.sourceHash;
				const response = await fetch("/api/course-builder", {
					method: "POST", headers: { "content-type": "application/json", "x-course-builder-teacher": "1" },
					body: JSON.stringify({ sessionId, action: "command", command: { action: "compile", id: deckId, expectedRevision } }),
				});
				const value = await response.json() as { error?: string };
				if (!response.ok) throw new Error(value.error ?? "编译课件失败。");
				if (requestId !== compileRequestRef.current || baseRevisionRef.current !== expectedRevision || sourceRef.current !== targetDeck.source) throw new Error("编译期间课件版本已变化，请重新打开核验。");
				const fresh = await fetchDeck();
				if (requestId !== compileRequestRef.current || fresh.deck.revision !== expectedRevision || fresh.deck.sourceHash !== expectedSourceHash)
					throw new Error("编译回执与当前课件 revision/sourceHash 不匹配；请重新打开核验。");
				if (!fresh.compileReceipt) throw new Error("编译响应缺少当前课件回执；请重新打开核验。");
				applyServerDeck(fresh.deck, fresh.compileReceipt, fresh.sourceSyncAvailable);
				if (!fresh.compileReceipt.succeeded) throw new Error(`编译失败：${fresh.compileReceipt.diagnostics.map((item) => item.message).join("；") || "请在工作区查看编译日志"}`);
				setNotice(`编译成功 · ${fresh.compileReceipt.pageCount ?? ""} 页`);
			} else {
				setNotice(`已保存 TeX revision ${targetDeck.revision}，PDF 仍显示上一次成功编译的版本。`);
			}
			notifySessionConfiguration(sessionId);
		} catch (cause) { if (requestId === compileRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { if (requestId === compileRequestRef.current) { compileRequestRef.current += 1; setBusy(false); } }
	}

	const currentReceipt = deck && compileReceipt && !dirty && compileReceipt.deckId === deck.deckId && compileReceipt.deckRevision === deck.revision && compileReceipt.sourceHash === deck.sourceHash ? compileReceipt : null;
	const pdfUrl = previewReceipt?.succeeded ? `/api/course-builder/export?sessionId=${encodeURIComponent(sessionId)}&kind=pdf&id=${encodeURIComponent(previewReceipt.receiptId)}` : null;
	const previewOutdated = !!previewReceipt && (!!dirty || !deck || previewReceipt.deckRevision !== deck.revision || previewReceipt.sourceHash !== deck.sourceHash);
	const canLocate = !!pdfUrl && !!currentReceipt?.succeeded && currentReceipt.receiptId === previewReceipt?.receiptId && sourceSyncAvailable && !busy && !conflict;

	return <div className="beamer-source-editor">
		{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
		{!deck ? !error && <p>正在读取 TeX…</p> : <>
			<div className="beamer-edit-controls"><strong>TeX 源码 · r{baseRevision}</strong><button disabled={busy || !ready || !dirty || conflict} onClick={() => void submit("save")}>保存修改</button><button disabled={busy || !ready || dirty || conflict || !compilerEnabled} onClick={() => void submit("compile")}>编译已保存源码</button></div>
			<p>{dirty ? "有未保存编辑 · 本机暂存；Ctrl+S 保存并重新编译。" : "修改后可按 Ctrl+S 保存并重新编译。"}</p>
			{previewOutdated && <p role="status">PDF 显示上一次成功编译的版本；当前源码尚未编译。</p>}
			{conflict && <p role="alert">暂存基于 r{baseRevision}，课件已有 r{deck.revision}；请先保留需要的修改，再读取已保存版本。</p>}
			<button disabled={busy || !ready} onClick={() => { const restored = previewReceipt && previewReceipt.deckRevision === deck.revision && previewReceipt.sourceHash === deck.sourceHash ? previewReceipt : compileReceipt; applyServerDeck(deck, restored, sourceSyncAvailable); setError(""); setNotice("已放弃暂存，读取已保存版本。"); }}>放弃暂存，读取已保存版本</button>
			<TexSourcePdfEditor source={source} onSourceChange={(nextSource) => { sourceRef.current = nextSource; setSource(nextSource); }} onSaveShortcut={() => { if (busy || !ready || conflict) return; if (dirty) void submit(compilerEnabled ? "save-compile" : "save"); else if (compilerEnabled) void submit("compile"); }} disabled={busy || !ready} sourceLabel="编辑 TeX 源码" sourcePaneLabel="Beamer TeX 编辑区" pdfPaneLabel="Beamer PDF 预览" pdfTitle="编译后的 PDF" pdfUrl={pdfUrl} sourcePaneTestId="beamer-source-pane" pdfPaneTestId="beamer-pdf-pane" sourceAfter={<details><summary>同步修改 Frame 大纲（每行一项）</summary><textarea aria-label="Frame 大纲" value={outline} disabled={busy || !ready} onChange={(event) => { setOutline(event.target.value); }} /></details>} sync={canLocate && currentReceipt ? { endpoint: "/api/course-builder/deck/sync", sessionId, receiptId: currentReceipt.receiptId, revision: currentReceipt.deckRevision, sourceHash: currentReceipt.sourceHash } : undefined} pdfFallback={currentReceipt && !currentReceipt.succeeded ? <div className="tex-pdf-placeholder"><strong>课件编译失败</strong><ul>{currentReceipt.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}>{item.code}：{item.message}</li>)}</ul></div> : <div className="tex-pdf-placeholder" role="status">{compilerEnabled ? "尚未生成课件 PDF；可按 Ctrl+S 保存并编译。" : "编译器当前不可用；已保存的课件仍可编辑。"}</div>} />
		</>}
		<style>{`.beamer-source-editor{flex:1;min-height:0;overflow:hidden;padding:16px;display:flex;flex-direction:column;gap:10px}.beamer-source-editor p{margin:0;font-size:12px;line-height:1.5}.beamer-source-editor [role=alert]{color:#d06040}.beamer-edit-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.beamer-source-editor button:disabled{opacity:.5;cursor:default}@media(max-width:760px){.beamer-source-editor{overflow:auto}}`}</style>
	</div>;
}
