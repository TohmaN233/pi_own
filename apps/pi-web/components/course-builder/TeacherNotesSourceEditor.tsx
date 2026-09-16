"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TeacherNotes } from "../../../../packages/course-builder-host/src/teacher-notes.ts";
import { TexSourcePdfEditor } from "./TexSourcePdfEditor";

type LocalDraft = {
	notesId: string;
	title: string;
	source: string;
	revision: number;
	deckRevision: number;
};

type NotesResponse = {
	notes: TeacherNotes;
	currentDeckRevision: number;
	compilerEnabled: boolean;
	sourceSyncAvailable: boolean;
	compileReceipt: TeacherNotesCompileReceipt | null;
};

type TeacherNotesCompileDiagnostic = {
	code: string;
	severity: string;
	message: string;
};

type TeacherNotesCompileReceipt = {
	receiptId: string;
	notesId: string;
	notesRevision: number;
	sourceHash: string;
	succeeded: boolean;
	diagnostics: TeacherNotesCompileDiagnostic[];
	pageCount: number | null;
	logHash?: string;
	createdAt?: string;
};

function requireCompileReceipt(value: unknown): TeacherNotesCompileReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("教师讲稿编译响应缺少回执。");
	const receipt = value as Partial<TeacherNotesCompileReceipt>;
	if (typeof receipt.receiptId !== "string" || !receipt.receiptId.trim()) throw new Error("教师讲稿编译响应缺少 receiptId。");
	if (typeof receipt.notesId !== "string" || !receipt.notesId.trim()) throw new Error("教师讲稿编译响应缺少 notesId。");
	if (!Number.isSafeInteger(receipt.notesRevision) || (receipt.notesRevision as number) < 1) throw new Error("教师讲稿编译响应缺少有效 notesRevision。");
	if (typeof receipt.sourceHash !== "string" || !receipt.sourceHash.trim()) throw new Error("教师讲稿编译响应缺少 sourceHash。");
	if (typeof receipt.succeeded !== "boolean") throw new Error("教师讲稿编译响应缺少 succeeded。");
	if (receipt.pageCount !== null && receipt.pageCount !== undefined && (!Number.isSafeInteger(receipt.pageCount) || (receipt.pageCount as number) < 0)) throw new Error("教师讲稿编译响应缺少有效 pageCount。");
	const diagnostics = receipt.diagnostics ?? [];
	if (!Array.isArray(diagnostics)) throw new Error("教师讲稿编译响应缺少 diagnostics。");
	return {
		receiptId: receipt.receiptId,
		notesId: receipt.notesId,
		notesRevision: receipt.notesRevision as number,
		sourceHash: receipt.sourceHash,
		succeeded: receipt.succeeded,
		 diagnostics: diagnostics.map((item) => {
			const message = item && typeof item === "object" ? (item as Partial<TeacherNotesCompileDiagnostic>).message : undefined;
			if (typeof message !== "string") throw new Error("教师讲稿编译诊断格式错误。");
			const diagnostic = item as Partial<TeacherNotesCompileDiagnostic>;
			return { code: typeof diagnostic.code === "string" ? diagnostic.code : "TEX_ERROR", severity: typeof diagnostic.severity === "string" ? diagnostic.severity : "critical", message };
		}),
		pageCount: receipt.pageCount === undefined ? null : receipt.pageCount,
		...(typeof receipt.logHash === "string" ? { logHash: receipt.logHash } : {}),
		...(typeof receipt.createdAt === "string" ? { createdAt: receipt.createdAt } : {}),
	};
}

function matchingCompileReceipt(value: unknown, notes: TeacherNotes): TeacherNotesCompileReceipt | null {
	if (value === null || value === undefined) return null;
	const receipt = requireCompileReceipt(value);
	return receipt.notesId === notes.notesId && receipt.notesRevision === notes.revision && receipt.sourceHash === notes.sourceHash ? receipt : null;
}

function compileReceiptFromSnapshot(value: unknown, notes: TeacherNotes): TeacherNotesCompileReceipt | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const receipts = (value as { teacherNotesCompileReceipts?: unknown }).teacherNotesCompileReceipts;
	if (!Array.isArray(receipts)) return null;
	let latest: TeacherNotesCompileReceipt | null = null;
	for (const item of receipts) {
		const candidate = matchingCompileReceipt(item, notes);
		if (candidate && (!latest || (candidate.createdAt ?? "") >= (latest.createdAt ?? ""))) latest = candidate;
	}
	return latest;
}

function requireNotes(value: unknown): TeacherNotes {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("教师讲稿响应缺少记录。");
	const notes = value as Partial<TeacherNotes>;
	if (typeof notes.notesId !== "string" || !notes.notesId.trim()) throw new Error("教师讲稿响应缺少 notesId。");
	if (typeof notes.title !== "string" || !notes.title.trim()) throw new Error("教师讲稿响应缺少标题。");
	if (typeof notes.source !== "string" || !notes.source.trim()) throw new Error("教师讲稿响应缺少已保存的 TeX 源码；请重新打开核验。");
	if (!Number.isSafeInteger(notes.revision) || (notes.revision as number) < 1) throw new Error("教师讲稿响应缺少有效 revision。");
	if (!Number.isSafeInteger(notes.deckRevision) || (notes.deckRevision as number) < 1) throw new Error("教师讲稿响应缺少有效课件 revision。");
	return notes as TeacherNotes;
}

function requireCurrentDeckRevision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("教师讲稿响应缺少有效当前课件 revision；请重新打开核验。");
	return value as number;
}

function requireDraft(value: string, notesId: string): LocalDraft {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new Error(`本机暂存的教师讲稿格式损坏：${String(cause)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("本机暂存的教师讲稿格式损坏。");
	const draft = parsed as Partial<LocalDraft>;
	if (draft.notesId !== notesId || typeof draft.title !== "string" || typeof draft.source !== "string" || !Number.isSafeInteger(draft.revision) || (draft.revision as number) < 1 || !Number.isSafeInteger(draft.deckRevision) || (draft.deckRevision as number) < 1)
		throw new Error("本机暂存的教师讲稿格式损坏；请放弃本机草稿后继续。");
	return {
		notesId,
		title: draft.title,
		source: draft.source,
		revision: draft.revision as number,
		deckRevision: draft.deckRevision as number,
	};
}

export function TeacherNotesSourceEditor({ sessionId, notesId }: { sessionId: string; notesId: string }) {
	const storageKey = `pi-teacher-notes-edit:${sessionId}:${notesId}`;
	const [notes, setNotes] = useState<TeacherNotes | null>(null);
	const [serverNotes, setServerNotes] = useState<TeacherNotes | null>(null);
	const [source, setSource] = useState("");
	const [title, setTitle] = useState("");
	const [baseRevision, setBaseRevision] = useState(0);
	const [deckRevision, setDeckRevision] = useState(0);
	const [currentDeckRevision, setCurrentDeckRevision] = useState(0);
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [compilerEnabled, setCompilerEnabled] = useState(false);
	const [compileReceipt, setCompileReceipt] = useState<TeacherNotesCompileReceipt | null>(null);
	const [previewReceipt, setPreviewReceipt] = useState<TeacherNotesCompileReceipt | null>(null);
	const [sourceSyncAvailable, setSourceSyncAvailable] = useState(false);
	const sourceRef = useRef("");
	const titleRef = useRef("");
	const baselineSourceRef = useRef("");
	const baselineTitleRef = useRef("");
	const baselineDeckRevisionRef = useRef(0);
	const baseRevisionRef = useRef(0);
	const deckRevisionRef = useRef(0);
	const currentDeckRevisionRef = useRef(0);
	const serverCompileReceiptRef = useRef<TeacherNotesCompileReceipt | null>(null);
	const compileRequestRef = useRef(0);
	const dirty = !!notes && (source !== notes.source || title !== notes.title || deckRevision !== notes.deckRevision);
	const conflict = !!serverNotes && !!notes && serverNotes.revision !== baseRevision;

	function applyLoadedNotes(current: TeacherNotes, draft?: LocalDraft, observedDeckRevision = current.deckRevision, observedCompileReceipt: TeacherNotesCompileReceipt | null = null) {
		const nextSource = draft?.source ?? current.source;
		const nextTitle = draft?.title ?? current.title;
		const nextRevision = draft?.revision ?? current.revision;
		const nextDeckRevision = draft?.deckRevision ?? current.deckRevision;
		const matchingReceipt = matchingCompileReceipt(observedCompileReceipt, current);
		const hasDraftChanges = !!draft && (draft.source !== current.source || draft.title !== current.title || draft.deckRevision !== current.deckRevision);
		setNotes(current);
		setServerNotes(current);
		setSource(nextSource);
		setTitle(nextTitle);
		setBaseRevision(nextRevision);
		setDeckRevision(nextDeckRevision);
		setCurrentDeckRevision(observedDeckRevision);
		setCompileReceipt(hasDraftChanges ? null : matchingReceipt);
		if (matchingReceipt?.succeeded) setPreviewReceipt(matchingReceipt);
		sourceRef.current = nextSource;
		titleRef.current = nextTitle;
		baselineSourceRef.current = current.source;
		baselineTitleRef.current = current.title;
		baselineDeckRevisionRef.current = current.deckRevision;
		baseRevisionRef.current = nextRevision;
		deckRevisionRef.current = nextDeckRevision;
		currentDeckRevisionRef.current = observedDeckRevision;
		serverCompileReceiptRef.current = matchingReceipt;
	}

	const fetchNotes = useCallback(async (signal?: AbortSignal): Promise<NotesResponse> => {
		const response = await fetch(`/api/course-builder/teacher-notes?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(notesId)}`, { signal, cache: "no-store" });
		const value = await response.json() as { notes?: unknown; currentDeckRevision?: unknown; compilerEnabled?: unknown; compileReceipt?: unknown; sourceSyncAvailable?: boolean; error?: string };
		if (!response.ok) throw new Error(value.error ?? `无法读取教师讲稿：HTTP ${response.status}`);
		const notes = requireNotes(value.notes);
		const currentDeckRevision = requireCurrentDeckRevision(value.currentDeckRevision);
		const compilerEnabled = value.compilerEnabled === undefined ? false : value.compilerEnabled;
		if (typeof compilerEnabled !== "boolean") throw new Error("教师讲稿响应缺少有效编译器状态。");
		const compileReceipt = value.compileReceipt === null || value.compileReceipt === undefined ? null : matchingCompileReceipt(value.compileReceipt, notes);
		if (value.compileReceipt !== null && value.compileReceipt !== undefined && !compileReceipt) throw new Error("教师讲稿响应中的编译回执与当前源码不匹配；请重新打开核验。");
		return { notes, currentDeckRevision, compilerEnabled, compileReceipt, sourceSyncAvailable: value.sourceSyncAvailable === true };
	}, [sessionId, notesId]);

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			const response = await fetchNotes(controller.signal);
			if (controller.signal.aborted) return;
			let draft: LocalDraft | undefined;
			let draftError = "";
			try {
				const saved = localStorage.getItem(storageKey);
				if (saved) draft = requireDraft(saved, notesId);
			} catch (cause) {
				draftError = cause instanceof Error ? cause.message : String(cause);
			}
			setCompilerEnabled(response.compilerEnabled);
			setSourceSyncAvailable(response.sourceSyncAvailable);
			applyLoadedNotes(response.notes, draft, response.currentDeckRevision, response.compileReceipt);
			if (draftError) setError(draftError);
			setReady(true);
		})().catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => controller.abort();
		// The storage key is intentionally scoped to this session and notes identity.
	}, [sessionId, notesId, storageKey, fetchNotes]);

	useEffect(() => {
		if (!ready || !notes) return;
		try {
			if (dirty) localStorage.setItem(storageKey, JSON.stringify({ notesId, title, source, revision: baseRevision, deckRevision } satisfies LocalDraft));
			else localStorage.removeItem(storageKey);
		} catch (cause) {
			setError(`本机暂存失败，请及时保存：${String(cause)}`);
		}
	}, [ready, notes, dirty, storageKey, notesId, title, source, baseRevision, deckRevision]);

	useEffect(() => {
		if (!ready) return;
		let disposed = false;
		const poll = async () => {
			const observedCompileRequest = compileRequestRef.current;
			try {
				const response = await fetchNotes();
				const current = response.notes;
				if (disposed || observedCompileRequest !== compileRequestRef.current) return;
				// A poll issued before Save can finish after its newer response.
				// Append-only revisions must never move the editor backwards.
				if (current.revision < baseRevisionRef.current) return;
				setCompilerEnabled(response.compilerEnabled);
				setSourceSyncAvailable(response.sourceSyncAvailable);
				setServerNotes(current);
				setCurrentDeckRevision(response.currentDeckRevision);
				currentDeckRevisionRef.current = response.currentDeckRevision;
				const hasLocalChanges = sourceRef.current !== baselineSourceRef.current || titleRef.current !== baselineTitleRef.current || deckRevisionRef.current !== baselineDeckRevisionRef.current;
				if (!hasLocalChanges && current.revision !== baseRevisionRef.current) {
					applyLoadedNotes(current, undefined, response.currentDeckRevision, response.compileReceipt);
				} else if (current.revision !== baseRevisionRef.current) {
					setNotice(`服务器已有教师讲稿 revision ${current.revision}；当前修改基于 r${baseRevisionRef.current}，请保存或放弃本机草稿后再继续。`);
				} else if (!hasLocalChanges) {
					const matchingReceipt = response.compileReceipt;
					serverCompileReceiptRef.current = matchingReceipt;
					setCompileReceipt(matchingReceipt);
					if (matchingReceipt?.succeeded) setPreviewReceipt(matchingReceipt);
				}
			} catch (cause) {
				if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
			}
		};
		const timer = window.setInterval(() => { void poll(); }, 2500);
		return () => { disposed = true; window.clearInterval(timer); };
	}, [ready, fetchNotes]);

	function acknowledgeCurrentDeck() {
		if (!ready || busy || currentDeckRevision === deckRevision) return;
		const nextDeckRevision = currentDeckRevision;
		setDeckRevision(nextDeckRevision);
		deckRevisionRef.current = nextDeckRevision;
		setError("");
		setNotice(`已核对当前课件 r${nextDeckRevision}，以此版本保存讲稿。`);
	}

	async function compileRevision(targetNotes: TeacherNotes, requestId: number) {
		const expectedRevision = targetNotes.revision;
		const expectedSourceHash = targetNotes.sourceHash;
		const response = await fetch("/api/course-builder", {
			method: "POST",
			headers: { "content-type": "application/json", "x-course-builder-teacher": "1" },
			body: JSON.stringify({ sessionId, action: "compile_teacher_notes", id: notesId, expectedRevision }),
		});
		const value = await response.json() as { receipt?: unknown; snapshot?: unknown; compilerEnabled?: unknown; sourceSyncAvailable?: boolean; error?: string };
		if (!response.ok) throw new Error(value.error ?? `编译教师讲稿失败：HTTP ${response.status}`);
		if (requestId !== compileRequestRef.current || baseRevisionRef.current !== expectedRevision || sourceRef.current !== targetNotes.source)
			throw new Error("教师讲稿在编译期间发生变化；当前文字仍保留在编辑器中。");
		const receipt = value.receipt === undefined ? compileReceiptFromSnapshot(value.snapshot, targetNotes) : matchingCompileReceipt(value.receipt, targetNotes);
		if (!receipt || receipt.notesRevision !== expectedRevision || receipt.sourceHash !== expectedSourceHash)
			throw new Error("编译回执与当前教师讲稿 revision/sourceHash 不匹配；请重新打开核验。");
		if (typeof value.compilerEnabled === "boolean") setCompilerEnabled(value.compilerEnabled);
		setCompileReceipt(receipt);
		setSourceSyncAvailable(value.sourceSyncAvailable === true);
		serverCompileReceiptRef.current = receipt;
		if (!receipt.succeeded) throw new Error(`教师讲稿编译失败：${receipt.diagnostics.map((item) => item.message).join("；") || "请查看编译日志。"}`);
		setPreviewReceipt(receipt);
		setNotice(`教师讲稿编译成功${receipt.pageCount === null ? "" : ` · ${receipt.pageCount} 页`}。`);
	}

	async function save(compileAfter = false) {
		if (!notes || busy) return;
		if (!title.trim()) {
			setError("教师讲稿标题不能为空。");
			return;
		}
		if (!source.trim()) {
			setError("教师讲稿 TeX 源码不能为空。");
			return;
		}
		const requestId = ++compileRequestRef.current;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const response = await fetch("/api/course-builder", {
				method: "POST",
				headers: { "content-type": "application/json", "x-course-builder-teacher": "1" },
				body: JSON.stringify({ sessionId, action: "edit_teacher_notes", id: notesId, expectedRevision: baseRevision, deckRevision, title, source }),
			});
			const value = await response.json() as { notes?: unknown; currentDeckRevision?: unknown; error?: string };
			if (!response.ok) throw new Error(value.error ?? `保存教师讲稿失败：HTTP ${response.status}`);
			const saved = requireNotes(value.notes);
			if (saved.notesId !== notesId) throw new Error("保存响应返回了不同的教师讲稿；当前文本仍保留在编辑器中。");
			if (requestId !== compileRequestRef.current) return;
			const observedDeckRevision = requireCurrentDeckRevision(value.currentDeckRevision);
			applyLoadedNotes(saved, undefined, observedDeckRevision);
			if (compileAfter) await compileRevision(saved, requestId);
			else setNotice(`已保存教师讲稿 revision ${saved.revision}，PDF 仍显示上一次成功编译的版本。`);
		} catch (cause) {
			// Leave source/title/base revisions untouched on conflict or any failure.
			if (requestId === compileRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (requestId === compileRequestRef.current) { compileRequestRef.current += 1; setBusy(false); }
		}
	}

	async function compileSaved() {
		if (!notes || busy || !compilerEnabled || dirty || conflict) return;
		const requestId = ++compileRequestRef.current;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await compileRevision(notes, requestId);
		} catch (cause) {
			if (requestId === compileRequestRef.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (requestId === compileRequestRef.current) { compileRequestRef.current += 1; setBusy(false); }
		}
	}

	function discardLocalDraft() {
		if (!serverNotes || busy) return;
		try { localStorage.removeItem(storageKey); } catch (cause) { setError(`无法清理本机暂存：${String(cause)}`); return; }
		applyLoadedNotes(serverNotes, undefined, currentDeckRevisionRef.current, serverCompileReceiptRef.current);
		setError("");
		setNotice(`已放弃本机草稿，读取教师讲稿 revision ${serverNotes.revision}。`);
	}

	const currentReceipt = notes && compileReceipt && !dirty && compileReceipt.notesId === notes.notesId && compileReceipt.notesRevision === notes.revision && compileReceipt.sourceHash === notes.sourceHash ? compileReceipt : null;
	const pdfUrl = previewReceipt?.succeeded ? `/api/course-builder/export?sessionId=${encodeURIComponent(sessionId)}&kind=teacher-notes-pdf&id=${encodeURIComponent(previewReceipt.receiptId)}` : null;
	const logUrl = currentReceipt ? `/api/course-builder/export?sessionId=${encodeURIComponent(sessionId)}&kind=teacher-notes-log&id=${encodeURIComponent(currentReceipt.receiptId)}` : null;
	const previewOutdated = !!previewReceipt && (!!dirty || !notes || previewReceipt.notesRevision !== notes.revision || previewReceipt.sourceHash !== notes.sourceHash);
	const canLocate = !!pdfUrl && !!currentReceipt?.succeeded && currentReceipt.receiptId === previewReceipt?.receiptId && sourceSyncAvailable && !busy && !conflict;

	return <div className="teacher-notes-source-editor">
		{error && <p role="alert">{error}</p>}
		{notice && <p role="status">{notice}</p>}
		{!notes ? !error && <p>正在读取教师讲稿 TeX…</p> : <>
			<div className="teacher-notes-edit-controls"><strong>教师讲稿 TeX · r{baseRevision} · 来源课件 r{deckRevision}</strong><button type="button" disabled={busy || !ready || !dirty || conflict} onClick={() => void save()}>保存教师讲稿</button><button type="button" disabled={busy || !ready || dirty || conflict || !compilerEnabled} onClick={() => void compileSaved()}>编译已保存源码</button></div>
			<p>{dirty ? "有未保存修改 · 已在本机暂存；Ctrl+S 保存并重新编译。" : "已同步到服务器 · 修改后可按 Ctrl+S 保存并重新编译。"}</p>
			{previewOutdated && <p role="status">PDF 显示上一次成功编译的版本；当前源码尚未编译。</p>}
			{currentDeckRevision !== deckRevision && <><p role="status">已检测到当前课件 revision {currentDeckRevision}；当前讲稿仍记录来源课件 revision {deckRevision}。</p><button type="button" disabled={busy || !ready} onClick={acknowledgeCurrentDeck}>已核对当前课件 r{currentDeckRevision}，以此版本保存讲稿</button></>}
			{conflict && <p role="alert">服务器已有教师讲稿 revision {serverNotes?.revision}；当前修改基于 r{baseRevision}。请先保留需要的文字，再放弃本机草稿读取服务器版本。</p>}
			<button type="button" disabled={busy || !ready || !serverNotes} onClick={discardLocalDraft}>放弃本机草稿，读取服务器版本</button>
			<TexSourcePdfEditor source={source} onSourceChange={(nextSource) => { sourceRef.current = nextSource; setSource(nextSource); }} onSaveShortcut={() => { if (busy || !ready || conflict) return; if (dirty) void save(compilerEnabled); else if (compilerEnabled) void compileSaved(); }} disabled={busy || !ready} sourceLabel="编辑教师讲稿 TeX" sourcePaneLabel="教师讲稿 TeX 编辑区" pdfPaneLabel="教师讲稿 PDF 预览" pdfTitle="教师讲稿 PDF" pdfUrl={pdfUrl} sourcePaneTestId="teacher-notes-source-pane" pdfPaneTestId="teacher-notes-pdf-pane" sourceBefore={<label>教师讲稿标题<input aria-label="教师讲稿标题" disabled={busy || !ready} value={title} onChange={(event) => { titleRef.current = event.target.value; setTitle(event.target.value); }}/></label>} sync={canLocate && currentReceipt ? { endpoint: "/api/course-builder/teacher-notes/sync", sessionId, receiptId: currentReceipt.receiptId, revision: currentReceipt.notesRevision, sourceHash: currentReceipt.sourceHash } : undefined} pdfFallback={currentReceipt && !currentReceipt.succeeded ? <div className="tex-pdf-placeholder"><strong>教师讲稿编译失败</strong><ul>{currentReceipt.diagnostics.map((item, index) => <li key={`${item.code}-${index}`}>{item.code}：{item.message}</li>)}</ul>{logUrl && <a href={logUrl}>查看编译日志</a>}</div> : <div className="tex-pdf-placeholder" role="status">{compilerEnabled ? "尚未生成教师讲稿 PDF；可按 Ctrl+S 保存并编译。" : "编译器当前不可用；已保存的讲稿仍可编辑。"}</div>} />
		</>}
		<style>{`.teacher-notes-source-editor{flex:1;min-height:0;overflow:hidden;padding:16px;display:flex;flex-direction:column;gap:10px}.teacher-notes-source-editor p{margin:0;font-size:12px;line-height:1.5}.teacher-notes-source-editor [role=alert]{color:#d06040}.teacher-notes-edit-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.teacher-notes-source-editor button:disabled,.teacher-notes-source-editor input:disabled{opacity:.5;cursor:default}@media(max-width:760px){.teacher-notes-source-editor{overflow:auto}}`}</style>
	</div>;
}
