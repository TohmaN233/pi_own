"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type {
	KnowledgeNode,
	KnowledgeNote,
	KnowledgeRelation,
	PhaseBinding,
	ReadCheckpoint,
	ResearchPlan,
	SourceChunk,
	SourceDiagnostic,
	SourceVersion,
	SourceUpdateProposal,
	StudyTask,
	VisualizationDraft,
} from "../../../../packages/study-research-host/src/types.ts";
import { PdfPreview } from "@/components/PdfPreview";
import { SessionModePackOverlay, type ModePackStatusKind } from "@/components/mode-packs/ModePackOverlay";
import { StudyVisualization } from "@/components/study/StudyVisualization";
import { StudyVisualEditor } from "@/components/study/StudyVisualEditor";
import { StudyConversation } from "@/components/study/StudyConversation";
import { StudySourceUpdates } from "@/components/study/StudySourceUpdates";
import { StudyCodeCells } from "@/components/study/StudyCodeCells";
import { StudyBackgroundReading } from "@/components/study/StudyBackgroundReading";
import { StudyResearchPlans } from "@/components/study/StudyResearchPlans";
import { StudyVisualReview } from "@/components/study/StudyVisualReview";
import { StudyVisualValidation } from "@/components/study/StudyVisualValidation";
import { StudyEnvironmentPackages } from "@/components/study/StudyEnvironmentPackages";
import { StudyResearchResults } from "@/components/study/StudyResearchResults";
import { StudyManuscript } from "@/components/study/StudyManuscript";
import { StudyAssignment } from "@/components/study/StudyAssignment";
import { StudyVisualInteraction } from "@/components/study/StudyVisualInteraction";
import { StudyTeachingTransfer } from "@/components/study/StudyTeachingTransfer";
import { StudyExternalReferences } from "@/components/study/StudyExternalReferences";
import type { StudyCodeCell } from "../../../../packages/study-execution-host/src/code-cells.ts";
import { subscribeSessionConfiguration } from "@/lib/session-configuration-events";
import type { PublicStudyTask } from "@/lib/study-research-service";
import styles from "@/app/study/Study.module.css";

type KnowledgeSnapshot = {
	notes: KnowledgeNote[];
	nodes: KnowledgeNode[];
	relations: KnowledgeRelation[];
};

type StudyProject = {
	id: string;
	title: string;
	cwd: string;
};

type WorkspaceData = {
	project: StudyProject;
	phase: PhaseBinding;
	snapshotId: string;
	revision: number;
	sources: SourceVersion[];
	knowledge: KnowledgeSnapshot;
	tasks: PublicStudyTask[];
	checkpoints: ReadCheckpoint[];
	visualizations: VisualizationDraft[];
	plans: ResearchPlan[];
	sourceUpdates: SourceUpdateProposal[];
	cells: StudyCodeCell[];
};

type ReadState = {
	chunks: SourceChunk[];
	nextOffset: number | null;
	busy: boolean;
	error: string | null;
};

type SourceSelection = {
	sourceId: string;
	sourceHash: string;
	chunkId: string;
	locator: string;
	startOffset: number;
	endOffset: number;
	quote: string;
	truncated: boolean;
};

type VisualInputState = {
	revision: number;
	text: string;
	inputs: Record<string, unknown> | null;
	error: string | null;
};

const INITIAL_READ_STATE: ReadState = { chunks: [], nextOffset: 0, busy: false, error: null };
const SOURCE_SELECTION_LIMIT = 4000;
const KNOWLEDGE_PAGE_SIZE = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`Study 工作区响应缺少有效的 ${field}。`);
	return value;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Study 工作区响应缺少有效的 ${field}。`);
	return value;
}

function arrayField<T>(value: unknown, field: string): T[] {
	if (!Array.isArray(value)) throw new Error(`Study 工作区响应缺少有效的 ${field} 列表。`);
	return value as T[];
}

function normalizeWorkspace(value: unknown): WorkspaceData {
	if (!isRecord(value)) throw new Error("Study 工作区响应格式无效。");
	const projectValue = value.project;
	if (!isRecord(projectValue)) throw new Error("Study 工作区响应缺少项目身份。");
	const phaseValue = value.phase;
	if (!isRecord(phaseValue)) throw new Error("Study 工作区响应缺少阶段绑定。");
	const phaseName = phaseValue.phase;
	if (phaseName !== "study" && phaseName !== "research") throw new Error("Study 工作区响应包含未知阶段。");
	const knowledgeValue = value.knowledge;
	if (!isRecord(knowledgeValue)) throw new Error("Study 工作区响应缺少知识快照。");
	const visualizations = arrayField<VisualizationDraft>(value.visualizations, "visualizations");
	const plans = arrayField<ResearchPlan>(value.plans, "plans");
	return {
		project: {
			id: requiredString(projectValue.id, "project.id"),
			title: requiredString(projectValue.title, "project.title"),
			cwd: requiredString(projectValue.cwd, "project.cwd"),
		},
		phase: {
			projectId: requiredString(phaseValue.projectId, "phase.projectId"),
			sessionId: requiredString(phaseValue.sessionId, "phase.sessionId"),
			phase: phaseName,
			revision: requiredNumber(phaseValue.revision, "phase.revision"),
			changedAt: requiredString(phaseValue.changedAt, "phase.changedAt"),
		},
		snapshotId: requiredString(value.snapshotId, "snapshotId"),
		revision: requiredNumber(value.revision, "revision"),
		sources: arrayField<SourceVersion>(value.sources, "sources"),
		knowledge: {
			notes: arrayField<KnowledgeNote>(knowledgeValue.notes, "knowledge.notes"),
			nodes: arrayField<KnowledgeNode>(knowledgeValue.nodes, "knowledge.nodes"),
			relations: arrayField<KnowledgeRelation>(knowledgeValue.relations, "knowledge.relations"),
		},
		tasks: arrayField<PublicStudyTask>(value.tasks, "tasks"),
		checkpoints: arrayField<ReadCheckpoint>(value.checkpoints, "checkpoints"),
		visualizations,
		plans,
		sourceUpdates: arrayField<SourceUpdateProposal>(value.sourceUpdates, "sourceUpdates"),
		cells: arrayField<StudyCodeCell>(value.cells, "cells"),
	};
}

function responseError(value: unknown, fallback: string): string {
	if (isRecord(value) && typeof value.error === "string" && value.error.trim()) return value.error;
	return fallback;
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

async function jsonRequest(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	const body = await readJson(response);
	if (!response.ok) throw new Error(responseError(body, `Study 请求失败（HTTP ${response.status}）。`));
	return body;
}

function readableError(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

function selectionOffset(element: HTMLElement, container: Node, offset: number): number | null {
	if (!element.contains(container)) return null;
	try {
		const prefix = document.createRange();
		prefix.selectNodeContents(element);
		prefix.setEnd(container, offset);
		return prefix.toString().length;
	} catch (error) {
		console.error("[study] failed to calculate source selection offset", { error });
		return null;
	}
}

function buildSourceQuestionPrompt(source: SourceVersion, selection: SourceSelection, question: string): string {
	const truncation = selection.truncated ? `（原选择超过 ${SOURCE_SELECTION_LIMIT} 字符，已保留开头）` : "";
	return [
		"请只根据下面这段 Study 来源摘录回答问题。摘录不足以判断时，请明确说明，不要把它扩展成整篇论文的摘要。",
		`来源：${source.relativePath}`,
		`sourceVersion: ${source.version}`,
		`sourceId: ${selection.sourceId}`,
		`sourceHash: ${selection.sourceHash}`,
		`chunkId: ${selection.chunkId}`,
		`locator: ${selection.locator}`,
		`selectedOffset: ${selection.startOffset}-${selection.endOffset}`,
		`引用${truncation}：`,
		selection.quote,
		"",
		`问题：${question.trim()}`,
	].join("\n");
}

async function dispatchForegroundPrompt(message: string): Promise<void> {
	const conversation = document.querySelector<HTMLElement>('[aria-label="学习与研究对话"]');
	const textarea = conversation?.querySelector<HTMLTextAreaElement>("textarea");
	if (!textarea) throw new Error("原始 Pi 对话输入框尚未连接，请稍后重试。");
	if (textarea.value.trim()) throw new Error("原始 Pi 对话输入框已有未发送文字，请先处理后再发送来源问题。");
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) throw new Error("无法连接原始 Pi 对话输入框。");
	setter.call(textarea, message);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	if (!textarea.isConnected) throw new Error("原始 Pi 对话输入框已重新加载，请重试来源问题。");
	textarea.focus();
	const mobile = window.matchMedia?.("(max-width: 640px)").matches ?? false;
	textarea.dispatchEvent(new KeyboardEvent("keydown", {
		key: "Enter",
		code: "Enter",
		ctrlKey: mobile,
		bubbles: true,
		cancelable: true,
	}));
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	if (!textarea.isConnected) throw new Error("原始 Pi 对话输入框已重新加载，请检查输入框状态后重试。");
	if (textarea.value === message) throw new Error("原始 Pi 对话没有接受来源问题，请检查输入框状态后重试。");
}

function formatDate(value: string): string {
	const time = new Date(value);
	return Number.isNaN(time.valueOf()) ? value : time.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function shortHash(value: string): string {
	return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function phaseLabel(phase: PhaseBinding["phase"]): string {
	return phase === "study" ? "Study 学习" : "Research 研究";
}

function sourceKindLabel(kind: SourceVersion["kind"]): string {
	const labels: Record<SourceVersion["kind"], string> = {
		pdf: "PDF",
		tex: "TeX",
		docx: "Word",
		text: "文本",
		code: "代码",
		asset: "资源",
	};
	return labels[kind];
}

function sourceRoleLabel(role: SourceVersion["sourceRole"]): string {
	const labels: Record<SourceVersion["sourceRole"], string> = {
		primary: "主论文",
		"tex-include": "TeX include",
		"linked-pdf": "关联 PDF",
		reference: "参考资料",
		supplement: "补充资料",
		code: "代码",
	};
	return labels[role];
}

function taskStatusLabel(status: StudyTask["status"]): string {
	const labels: Record<StudyTask["status"], string> = {
		queued: "排队中",
		admitted: "已准入",
		launching: "启动中",
		running: "运行中",
		succeeded: "已完成",
		failed: "失败",
		cancelled: "已取消",
		"limit-reached": "达到限制",
		reconciling: "核对中",
		"needs-input": "需要输入",
	};
	return labels[status];
}

function taskKindLabel(kind: StudyTask["kind"]): string {
	const labels: Record<StudyTask["kind"], string> = {
		reading: "阅读",
		"paper-map": "全文地图",
		execution: "执行",
		validation: "验证",
		review: "审阅",
		explanation: "解释",
	};
	return labels[kind];
}

function coverageLabel(kind: ReadCheckpoint["kind"]): string {
	const labels: Record<ReadCheckpoint["kind"], string> = {
		extracted: "已提取",
		read: "已阅读",
		checked: "已核对",
	};
	return labels[kind];
}

function severityLabel(severity: SourceDiagnostic["severity"]): string {
	return severity === "error" ? "错误" : severity === "warning" ? "警告" : "提示";
}

function severityClass(severity: SourceDiagnostic["severity"]): string {
	return severity === "error" ? styles.severityError : severity === "warning" ? styles.severityWarning : styles.severityInfo;
}

function locatorLabel(locator: string | null): string {
	if (!locator) return "未提供定位";
	try {
		const parsed: unknown = JSON.parse(locator);
		if (isRecord(parsed) && parsed.kind === "tex-lines" && typeof parsed.startLine === "number" && typeof parsed.endLine === "number") {
			return parsed.startLine === parsed.endLine ? `TeX 第 ${parsed.startLine} 行` : `TeX 第 ${parsed.startLine}–${parsed.endLine} 行`;
		}
		if (isRecord(parsed) && parsed.kind === "pdf-page" && typeof parsed.page === "number") return `PDF 第 ${parsed.page} 页`;
		if (isRecord(parsed) && parsed.kind === "docx-paragraph" && typeof parsed.paragraph === "number") return `Word 第 ${parsed.paragraph} 段`;
	} catch {
		// A forward-compatible locator can remain visible as its original string.
	}
	return locator;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "无法显示该结构化数据。";
	} catch (error) {
		console.error("[study] failed to serialize JSON value", error);
		return "无法显示该结构化数据。";
	}
}

function EmptySection({ children }: { children: ReactNode }) {
	return <div className={styles.empty}><p>{children}</p></div>;
}

function KnowledgePagination({ label, page, pageCount, onChange }: {
	label: string;
	page: number;
	pageCount: number;
	onChange: (page: number) => void;
}) {
	if (pageCount <= 1) return null;
	return <nav className={styles.pagination} aria-label={`${label}分页`}>
		<button className={styles.button} type="button" disabled={page <= 0} onClick={() => onChange(page - 1)}>上一页</button>
		<span className={styles.paginationStatus} aria-live="polite">{label} · 第 {page + 1} / {pageCount} 页</span>
		<button className={styles.button} type="button" disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>下一页</button>
	</nav>;
}

function SourceDiagnostics({ source }: { source: SourceVersion }) {
	if (source.diagnostics.length === 0) return <p className={styles.dim}>该来源没有解析诊断。</p>;
	return <ul className={styles.diagnosticList} aria-label={`${source.relativePath} 诊断`}>
		{source.diagnostics.map((diagnostic, index) => <li className={styles.diagnostic} data-severity={diagnostic.severity} key={`${diagnostic.code}:${index}`}>
			<strong className={severityClass(diagnostic.severity)}>{severityLabel(diagnostic.severity)} · {diagnostic.code}</strong>
			<p>{diagnostic.message}</p>
			{(diagnostic.path || diagnostic.locator) && <p>{diagnostic.path ?? ""}{diagnostic.locator ? ` · ${locatorLabel(diagnostic.locator)}` : ""}</p>}
			{diagnostic.requiresPdfInspection && <p className={styles.severityWarning}>需要打开原始 PDF 做视觉与数学检查。</p>}
		</li>)}
	</ul>;
}

function Checkpoints({ source, checkpoints }: { source: SourceVersion; checkpoints: ReadCheckpoint[] }) {
	const items = checkpoints.filter((item) => item.sourceId === source.sourceId && item.sourceHash === source.contentHash);
	return <div>
		<h5 className={styles.readerTitle}>阅读记录</h5>
		{items.length === 0 ? <p className={styles.dim}>当前版本还没有读取标记。</p> : <ul className={styles.checkpointList}>
			{items.map((item) => <li className={styles.checkpoint} key={item.checkpointId}>
				<div className={styles.checkpointMeta}><span>{coverageLabel(item.kind)}</span><span>{locatorLabel(item.locator)}</span><span>{formatDate(item.createdAt)}</span></div>
				<p>{item.note}</p>
			</li>)}
		</ul>}
	</div>;
}

function StudyHeader({ data, sessionId, setModeKind, onRefresh, loading }: {
	data: WorkspaceData | null;
	sessionId: string;
	setModeKind: (kind: ModePackStatusKind) => void;
	onRefresh: () => void;
	loading: boolean;
}) {
	return <>
		{sessionId && <div className={styles.modeOverlaySpacer} aria-hidden="true" />}
		{sessionId && <SessionModePackOverlay sessionId={sessionId} onStatusKind={setModeKind} />}
		<header className={styles.header}>
			<div className={styles.headerInner}>
				<Link className={styles.backLink} href={sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/"}>← 返回 Pi</Link>
				<div className={styles.titleBlock}>
					<p className={styles.eyebrow}>SOURCE FIRST · STUDY</p>
					<h1 className={styles.title}>Study 论文工作区</h1>
				</div>
				{data && <>
					<span className={styles.phaseBadge}>当前阶段 · {phaseLabel(data.phase.phase)}</span>
				</>}
				<div className={styles.headerActions}>
					{sessionId && <Link className={styles.headerLink} href={`/projects?sessionId=${encodeURIComponent(sessionId)}`}>项目与对话</Link>}
					<button className={styles.button} type="button" disabled={loading} onClick={onRefresh}>刷新</button>
				</div>
			</div>
		</header>
	</>;
}

export function StudyWorkspace() {
	const searchParams = useSearchParams();
	const sessionId = searchParams.get("sessionId")?.trim() ?? "";
	const [data, setData] = useState<WorkspaceData | null>(null);
	const [loading, setLoading] = useState(Boolean(sessionId));
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [retryKey, setRetryKey] = useState(0);
	const [busy, setBusy] = useState(false);
	const [rootPath, setRootPath] = useState("");
	const [entryPath, setEntryPath] = useState("main.tex");
	const [noteTitle, setNoteTitle] = useState("");
	const [noteBody, setNoteBody] = useState("");
	const [selectedSourceId, setSelectedSourceId] = useState("");
	const [readState, setReadState] = useState<ReadState>(INITIAL_READ_STATE);
	const [sourceSelection, setSourceSelection] = useState<SourceSelection | null>(null);
	const [selectionQuestion, setSelectionQuestion] = useState("");
	const [selectionError, setSelectionError] = useState<string | null>(null);
	const [selectionAskBusy, setSelectionAskBusy] = useState(false);
	const [knowledgeNotePage, setKnowledgeNotePage] = useState(0);
	const [knowledgeNodePage, setKnowledgeNodePage] = useState(0);
	const [previewPdf, setPreviewPdf] = useState(false);
	const [visualInputs, setVisualInputs] = useState<Record<string, VisualInputState>>({});
	const [, setModeKind] = useState<ModePackStatusKind>(null);
	const refreshRequest = useRef<AbortController | null>(null);
	const mutationRequest = useRef<AbortController | null>(null);
	const refreshSerial = useRef(0);
	const readRequest = useRef<AbortController | null>(null);
	const readSerial = useRef(0);
	const operation = useRef(false);

	const refresh = useCallback(async () => {
		refreshRequest.current?.abort();
		mutationRequest.current?.abort();
		const controller = new AbortController();
		refreshRequest.current = controller;
		const serial = ++refreshSerial.current;
		if (!sessionId) {
			setData(null);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		try {
			const response = await fetch(`/api/study-research?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store", signal: controller.signal });
			const value = await readJson(response);
			if (!response.ok) throw new Error(responseError(value, `无法读取 Study 工作区（HTTP ${response.status}）。`));
			if (controller.signal.aborted || serial !== refreshSerial.current) return;
			setData(normalizeWorkspace(value));
			setError(null);
		} catch (value) {
			if (controller.signal.aborted || serial !== refreshSerial.current) return;
			console.error("[study] workspace read failed", { sessionId, error: value });
			setError(readableError(value));
		} finally {
			if (!controller.signal.aborted && serial === refreshSerial.current) setLoading(false);
		}
	}, [sessionId]);

	useEffect(() => {
		setModeKind(null);
		setSelectedSourceId("");
		setData(null);
		setError(null);
		setNotice(null);
		setReadState(INITIAL_READ_STATE);
		setSourceSelection(null);
		setSelectionQuestion("");
		setSelectionError(null);
		setKnowledgeNotePage(0);
		setKnowledgeNodePage(0);
		void refresh();
		return () => {
			refreshRequest.current?.abort();
			mutationRequest.current?.abort();
			readRequest.current?.abort();
		};
	}, [refresh, retryKey]);

	useEffect(() => {
		if (!sessionId) return;
		return subscribeSessionConfiguration(sessionId, () => { void refresh(); });
	}, [refresh, sessionId]);

	useEffect(() => {
		if (!data) return;
		setSelectedSourceId((current) => data.sources.some((source) => source.sourceId === current)
			? current
			: (data.sources.find((source) => source.sourceRole === "primary") ?? data.sources[0])?.sourceId ?? "");
	}, [data]);

	const selectedSource = useMemo(
		() => data?.sources.find((source) => source.sourceId === selectedSourceId) ?? null,
		[data?.sources, selectedSourceId],
	);
	const selectedSourceKey = selectedSource?.sourceId ?? "";
	const selectedSourceHash = selectedSource?.contentHash ?? "";
	const reviewSources = selectedSource ? readState.chunks.filter((chunk) => chunk.sourceId === selectedSource.sourceId && chunk.sourceHash === selectedSource.contentHash).map((chunk, offset) => ({ sourceId: selectedSource.sourceId, sourceHash: selectedSource.contentHash, chunkId: chunk.chunkId, offset, label: `${selectedSource.relativePath} · #${chunk.ordinal}` })) : [];
	const notePageCount = data ? Math.max(1, Math.ceil(data.knowledge.notes.length / KNOWLEDGE_PAGE_SIZE)) : 1;
	const nodePageCount = data ? Math.max(1, Math.ceil(data.knowledge.nodes.length / KNOWLEDGE_PAGE_SIZE)) : 1;
	const visibleKnowledgeNotes = data
		? data.knowledge.notes.slice(knowledgeNotePage * KNOWLEDGE_PAGE_SIZE, (knowledgeNotePage + 1) * KNOWLEDGE_PAGE_SIZE)
		: [];
	const visibleKnowledgeNodes = data
		? data.knowledge.nodes.slice(knowledgeNodePage * KNOWLEDGE_PAGE_SIZE, (knowledgeNodePage + 1) * KNOWLEDGE_PAGE_SIZE)
		: [];

	useEffect(() => {
		setKnowledgeNotePage((page) => Math.min(page, notePageCount - 1));
		setKnowledgeNodePage((page) => Math.min(page, nodePageCount - 1));
	}, [notePageCount, nodePageCount]);

	useEffect(() => {
		setKnowledgeNotePage(0);
		setKnowledgeNodePage(0);
	}, [data?.revision]);

	const readSource = useCallback(async (sourceId: string, sourceHash: string, offset: number, replace: boolean) => {
		if (!sessionId || !sourceId || !sourceHash) return;
		readRequest.current?.abort();
		const controller = new AbortController();
		readRequest.current = controller;
		const serial = ++readSerial.current;
		setReadState((current) => ({ ...current, busy: true, error: null }));
		try {
			const url = `/api/study-research?sessionId=${encodeURIComponent(sessionId)}&action=read&sourceId=${encodeURIComponent(sourceId)}&sourceHash=${encodeURIComponent(sourceHash)}&offset=${offset}&limit=3`;
			const value = await jsonRequest(url, { cache: "no-store", signal: controller.signal });
			if (!isRecord(value) || !Array.isArray(value.chunks)) throw new Error("Study 分块响应格式无效。");
			const nextOffset = value.nextOffset === null ? null : requiredNumber(value.nextOffset, "nextOffset");
			const chunks = value.chunks as SourceChunk[];
			if (controller.signal.aborted || serial !== readSerial.current) return;
			setReadState((current) => {
				const combined = replace ? chunks : [...current.chunks, ...chunks.filter((chunk) => !current.chunks.some((existing) => existing.chunkId === chunk.chunkId))];
				return { chunks: combined, nextOffset, busy: false, error: null };
			});
		} catch (value) {
			if (controller.signal.aborted || serial !== readSerial.current) return;
			console.error("[study] bounded source read failed", { sessionId, sourceId, sourceHash, offset, error: value });
			setReadState((current) => ({ ...current, busy: false, error: readableError(value) }));
		}
	}, [sessionId]);

	useEffect(() => {
		readRequest.current?.abort();
		++readSerial.current;
		setPreviewPdf(false);
		setReadState(INITIAL_READ_STATE);
		setSourceSelection(null);
		setSelectionQuestion("");
		setSelectionError(null);
		if (selectedSourceKey && selectedSourceHash) void readSource(selectedSourceKey, selectedSourceHash, 0, true);
	}, [readSource, selectedSourceHash, selectedSourceKey]);

	useEffect(() => {
		if (!sourceSelection) return;
		const currentChunk = readState.chunks.find((chunk) => chunk.chunkId === sourceSelection.chunkId);
		if (
			!currentChunk
			|| currentChunk.sourceId !== selectedSourceKey
			|| currentChunk.sourceHash !== selectedSourceHash
			|| sourceSelection.sourceId !== selectedSourceKey
			|| sourceSelection.sourceHash !== selectedSourceHash
		) {
			setSourceSelection(null);
			setSelectionQuestion("");
			setSelectionError(null);
		}
	}, [readState.chunks, selectedSourceHash, selectedSourceKey, sourceSelection]);

	const captureChunkSelection = useCallback((element: HTMLElement, chunk: SourceChunk) => {
		const browserSelection = window.getSelection();
		if (!browserSelection || browserSelection.rangeCount === 0 || browserSelection.isCollapsed) return;
		const range = browserSelection.getRangeAt(0);
		if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
			setSourceSelection(null);
			setSelectionQuestion("");
			setSelectionError("请在同一个阅读分块内选择来源文字。");
			return;
		}
		const startOffset = selectionOffset(element, range.startContainer, range.startOffset);
		const endOffset = selectionOffset(element, range.endContainer, range.endOffset);
		const quote = range.toString();
		if (startOffset === null || endOffset === null || endOffset <= startOffset || !quote.trim()) return;
		const boundedQuote = quote.slice(0, SOURCE_SELECTION_LIMIT);
		const next: SourceSelection = {
			sourceId: chunk.sourceId,
			sourceHash: chunk.sourceHash,
			chunkId: chunk.chunkId,
			locator: chunk.locator,
			startOffset,
			endOffset: startOffset + boundedQuote.length,
			quote: boundedQuote,
			truncated: boundedQuote.length < quote.length,
		};
		setSourceSelection(next);
		setSelectionQuestion("");
		setSelectionError(null);
	}, []);

	const addSelectionToNote = useCallback(() => {
		if (!sourceSelection || !selectedSource) return;
		const excerpt = `[${locatorLabel(sourceSelection.locator)} · ${sourceSelection.sourceHash}]\n${sourceSelection.quote}`;
		setNoteTitle((current) => current.trim() ? current : `摘录 · ${selectedSource.relativePath} · ${locatorLabel(sourceSelection.locator)}`);
		setNoteBody((current) => current.trim() ? `${current.trim()}\n\n${excerpt}` : excerpt);
		setNotice("已将带来源版本和定位的摘录放入笔记编辑框，请补充理解后保存。");
	}, [selectedSource, sourceSelection]);

	const sendSelectionQuestion = useCallback(async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!sourceSelection || !selectedSource) {
			setSelectionError("来源选择已失效，请重新选择一个阅读分块。");
			return;
		}
		const currentChunk = readState.chunks.find((chunk) => chunk.chunkId === sourceSelection.chunkId);
		if (
			!currentChunk
			|| currentChunk.sourceId !== selectedSource.sourceId
			|| currentChunk.sourceHash !== selectedSource.contentHash
			|| sourceSelection.sourceId !== selectedSource.sourceId
			|| sourceSelection.sourceHash !== selectedSource.contentHash
		) {
			setSourceSelection(null);
			setSelectionQuestion("");
			setSelectionError("来源版本或阅读分块已变化，请重新选择来源文字。");
			return;
		}
		const question = selectionQuestion.trim();
		if (!question) {
			setSelectionError("请先输入问题。");
			return;
		}
		setSelectionAskBusy(true);
		setSelectionError(null);
		try {
			await dispatchForegroundPrompt(buildSourceQuestionPrompt(selectedSource, sourceSelection, question));
			setSelectionQuestion("");
			setNotice("问题已发送到当前原始 Pi 对话；来源版本、分块和定位随提示词保留。");
		} catch (value) {
			console.error("[study] source question dispatch failed", { sessionId, error: value });
			setSelectionError(readableError(value));
		} finally {
			setSelectionAskBusy(false);
		}
	}, [readState.chunks, selectedSource, selectionQuestion, sessionId, sourceSelection]);

	const postWorkspaceAction = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
		if (!data) throw new Error("Study 工作区尚未加载完成。");
		refreshRequest.current?.abort();
		mutationRequest.current?.abort();
		const controller = new AbortController();
		mutationRequest.current = controller;
		const serial = ++refreshSerial.current;
		try {
			const value = await jsonRequest("/api/study-research", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...body,
					sessionId,
					expectedPhaseRevision: data.phase.revision,
					expectedProjectRevision: data.revision,
				}),
				signal: controller.signal,
			});
			if (controller.signal.aborted || serial !== refreshSerial.current) return false;
			const next = normalizeWorkspace(value);
			setData(next);
			if (body.action === "import") setSelectedSourceId(next.sources[0]?.sourceId ?? "");
			return true;
		} catch (value) {
			if (controller.signal.aborted || serial !== refreshSerial.current) return false;
			throw value;
		} finally {
			if (mutationRequest.current === controller) mutationRequest.current = null;
		}
	}, [data, sessionId]);

	const perform = useCallback(async (action: () => Promise<void>) => {
		if (operation.current) return;
		operation.current = true;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await action();
		} catch (value) {
			console.error("[study] workspace action failed", { sessionId, error: value });
			setError(readableError(value));
		} finally {
			operation.current = false;
			setBusy(false);
		}
	}, [sessionId]);

	const submitImport = useCallback(async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const root = rootPath.trim();
		const entry = entryPath.trim();
		if (!root || !entry) {
			setError("请填写资料根目录和入口文件路径。");
			return;
		}
		await perform(async () => {
			const applied = await postWorkspaceAction({ action: "import", rootPath: root, entryPath: entry });
			if (!applied) return;
			setNotice(`已导入入口 ${entry}；来源清单与解析诊断已更新。`);
		});
	}, [entryPath, perform, postWorkspaceAction, rootPath]);

	const submitNote = useCallback(async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!selectedSource) {
			setError("请先选择一份来源，再保存笔记。");
			return;
		}
		const title = noteTitle.trim();
		const body = noteBody.trim();
		if (!title || !body) {
			setError("请填写笔记标题和正文。");
			return;
		}
		await perform(async () => {
			const applied = await postWorkspaceAction({ action: "note", sourceId: selectedSource.sourceId, sourceHash: selectedSource.contentHash, title, body });
			if (!applied) return;
			setNoteTitle("");
			setNoteBody("");
			setNotice("笔记已保存，并保留了来源版本身份。`stale` 状态会在来源更新后明确显示。" );
		});
	}, [noteBody, noteTitle, perform, postWorkspaceAction, selectedSource]);

	const refreshAfterAgent = useCallback(() => {
		if (!operation.current) void refresh();
	}, [refresh]);

	if (!sessionId) {
		return <main className={styles.page}>
			<StudyHeader data={null} sessionId="" setModeKind={setModeKind} onRefresh={() => setRetryKey((value) => value + 1)} loading={false} />
			<div className={styles.content}><div className={styles.empty}><h2>打开一个 Study 会话</h2><p>Study 工作区绑定已有 Pi 会话，用它的项目与原始对话继续阅读和整理。</p><p><Link className={styles.buttonPrimary} href="/projects">前往项目与对话</Link></p></div></div>
		</main>;
	}

	return <main className={styles.page}>
		<StudyHeader data={data} sessionId={sessionId} setModeKind={setModeKind} onRefresh={() => setRetryKey((value) => value + 1)} loading={loading} />
		<div className={styles.layout}>
			<section className={styles.workspace} aria-label="Study 工作区">
				<div className={styles.content}>
					{data && <>
						<div className={styles.intro}>
							<div>
								<h2>{data.project.title}</h2>
								<p>先确认来源版本，再按定位阅读有限片段，把理解写成带来源身份的笔记。图示和研究计划保留版本信息，方便回到原始依据。</p>
							</div>
						</div>
						<details className={styles.debugDetails}><summary>查看工作区版本信息</summary><p className={styles.revision}>项目 revision {data.revision} · 阶段 revision {data.phase.revision} · 快照 {shortHash(data.snapshotId)}</p><p className={styles.taskId} title={sessionId}>当前对话 {sessionId}</p></details>
					</>}
					{error && <div className={styles.error} role="alert"><strong>Study 工作区操作未完成</strong><p>{error}</p><button className={styles.buttonPrimary} type="button" onClick={() => setRetryKey((value) => value + 1)}>重新读取工作区</button></div>}
					{notice && <div className={styles.notice} role="status"><p>{notice}</p></div>}
					{loading && !data && <div className={styles.loading} role="status"><span className={styles.spinner}/><strong>正在读取已保存的 Study 工作区…</strong></div>}
					{!loading && !data && !error && <div className={styles.empty}><p>当前会话还没有可显示的 Study 工作区。</p></div>}
					{data && <>
						<nav className={styles.sectionNav} aria-label="Study 工作区导航">
							<span className={styles.sectionNavLabel}>工作区目录</span>
							<div className={styles.sectionNavLinks}><a href="#sources">来源与阅读</a><a href="#notes">知识与笔记</a><a href="#tasks">任务状态</a>{data.visualizations.length > 0 && <a href="#visuals">可视化</a>}{(data.phase.phase === "research" || data.plans.length > 0) && <a href="#research-execution">研究计划</a>}</div>
						</nav>
						<div className={styles.sections}>
							<StudySourceUpdates sessionId={sessionId} proposals={data.sourceUpdates} busy={busy} onDecision={(proposal, decision) => perform(async () => {
								const applied = await postWorkspaceAction({ action: "source-update-decision", proposalId: proposal.proposalId, candidateHash: proposal.candidateHash, decision });
								if (applied) setNotice(decision === "accept" ? "候选更新已采纳，本次临时备份已清理。" : "已拒绝候选，恢复原记录并保留待核对标记。");
							})} />
							<section className={styles.section} id="sources" tabIndex={-1}>
								<div className={styles.sectionHeader}><div><h3>来源与阅读</h3><p>已注册来源只读展示；每次打开 3 个阅读片段，可继续查看后续内容，版本与定位随时可查。</p></div><span className={styles.statusBadge}>{data.sources.length} 份当前来源</span></div>
								{data.sources.length === 0 ? <EmptySection>尚未导入论文。请在下方选择资料根目录与明确入口文件。</EmptySection> : <div className={styles.sourceList}>
									{data.sources.map((source) => <article className={styles.sourceCard} data-selected={source.sourceId === selectedSourceId} key={source.sourceId}>
										<button className={styles.sourceButton} type="button" onClick={() => setSelectedSourceId(source.sourceId)} aria-pressed={source.sourceId === selectedSourceId}>
											<div className={styles.sourceHeader}><div><h4>{source.relativePath}</h4><p>{sourceKindLabel(source.kind)} · {sourceRoleLabel(source.sourceRole)} · {source.parser}</p></div><span className={styles.sourceKind}>{source.current ? "当前" : "旧版本"}</span></div>
											<div className={styles.sourceMeta}><span className={styles.sourcePath} title={source.sourceRoot}>{source.sourceRoot}</span><span>v{source.version}</span><span>{formatDate(source.createdAt)}</span></div>
											<div className={styles.sourceMeta}><span>{source.diagnostics.length} 条诊断</span></div>
										</button>
										<details className={styles.debugDetails}><summary>查看来源版本身份</summary><div className={styles.sourceMeta}><span className={styles.taskId}>sourceId {source.sourceId}</span><span className={styles.sourceHash}>Hash {source.contentHash}</span></div></details>
									</article>)}
								</div>}
								<form className={styles.form} onSubmit={(event) => void submitImport(event)}>
										<div className={styles.row}><h4>导入论文</h4><span className={styles.formHint}>选择论文资料位置，建立只读来源版本</span></div>
									<label className={styles.field}><span>资料根目录</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="例如：D:\\papers\\curve-band-depth" autoComplete="off" /></label>
									<label className={styles.field}><span>入口文件</span><input value={entryPath} onChange={(event) => setEntryPath(event.target.value)} placeholder="例如：main.tex 或 paper.pdf" autoComplete="off" /></label>
									<div className={styles.formFooter}><p className={styles.formHint}>系统会记录来源版本与解析提示；页面不会改动原始文件。</p><button className={styles.buttonPrimary} type="submit" disabled={busy || !rootPath.trim() || !entryPath.trim()}>导入并建立来源清单</button></div>
								</form>
								<StudyBackgroundReading key={sessionId} sessionId={sessionId} phaseRevision={data.phase.revision} source={selectedSource} onChanged={refreshAfterAgent} />
								<StudyExternalReferences key={`references:${sessionId}`} sessionId={sessionId} phaseRevision={data.phase.revision} onChanged={refreshAfterAgent} />
								{selectedSource && <div className={styles.sourceReader}>
									<aside className={styles.sourceReaderSidebar}>
										<h4 className={styles.readerTitle}>当前来源</h4>
										<p className={styles.sourcePath}>{selectedSource.relativePath}</p><p className={styles.muted}>{sourceKindLabel(selectedSource.kind)} · v{selectedSource.version}</p>
										<details className={styles.debugDetails}><summary>查看来源版本身份</summary><p className={styles.sourceHash} title={selectedSource.contentHash}>{selectedSource.contentHash}</p><p className={styles.taskId}>{selectedSource.sourceId}</p></details>
										<div className={styles.readerButtons}><button className={styles.buttonPrimary} type="button" disabled={readState.busy} onClick={() => void readSource(selectedSource.sourceId, selectedSource.contentHash, 0, true)}>{readState.busy ? "读取中…" : "重新读取前 3 个分块"}</button>{readState.nextOffset !== null && <button className={styles.button} type="button" disabled={readState.busy} onClick={() => void readSource(selectedSource.sourceId, selectedSource.contentHash, readState.nextOffset ?? 0, false)}>继续读取</button>}{selectedSource.kind === "pdf" && <button className={styles.button} type="button" onClick={() => setPreviewPdf((current) => !current)}>{previewPdf ? "收起原始 PDF" : "预览原始 PDF"}</button>}</div>
										{readState.error && <p className={styles.error} role="alert">{readState.error}</p>}
										<Checkpoints source={selectedSource} checkpoints={data.checkpoints} />
									</aside>
																	<div className={styles.sourceReaderBody}>
																		<h4 className={styles.readerTitle}>阅读片段 · {readState.chunks.length} 个分块</h4>
																		{readState.chunks.length === 0 && !readState.busy ? <p className={styles.dim}>点击来源后会读取前 3 个分块，可继续打开后续片段。</p> : <ol className={styles.chunkList}>{readState.chunks.map((chunk) => <li className={styles.chunk} key={chunk.chunkId}><div className={styles.locator}><strong>#{chunk.ordinal}</strong><span>{locatorLabel(chunk.locator)}</span></div><pre
																							 tabIndex={0}
																							 aria-label={`选择 ${selectedSource.relativePath} 的第 ${chunk.ordinal} 个阅读分块`}
																							 onMouseUp={(event) => captureChunkSelection(event.currentTarget, chunk)}
																							 onKeyUp={(event) => captureChunkSelection(event.currentTarget, chunk)}
																							 onSelect={(event) => captureChunkSelection(event.currentTarget, chunk)}
																							 data-selection-source-id={chunk.sourceId}
																							 data-selection-source-hash={chunk.sourceHash}
																							 data-selection-chunk-id={chunk.chunkId}
																				>{chunk.text}</pre><details className={styles.debugDetails}><summary>查看片段身份</summary><p className={styles.taskId}>{chunk.chunkId}</p><p className={styles.sourceHash}>{chunk.textHash}</p></details></li>)}</ol>}
																				{selectionError && !sourceSelection && <p className={styles.error} role="alert">{selectionError}</p>}
																				{sourceSelection && <section className={styles.selectionPanel} aria-label="已选择来源片段">
																			<div className={styles.selectionHeader}><div><h4>已选择来源片段</h4><p>{locatorLabel(sourceSelection.locator)} · {sourceSelection.quote.length} 个字符{sourceSelection.truncated ? `（已限制为 ${SOURCE_SELECTION_LIMIT} 个字符）` : ""}</p></div><span className={styles.selectionBadge}>版本已绑定</span></div>
																			<pre className={styles.selectionQuote}>{sourceSelection.quote}</pre>
																			<p className={styles.selectionIdentity}>sourceHash {sourceSelection.sourceHash} · chunk {sourceSelection.chunkId} · locator {sourceSelection.locator}</p>
																			<form className={styles.selectionForm} onSubmit={(event) => void sendSelectionQuestion(event)}>
																				<label className={styles.field}><span>针对选中内容提问</span><textarea value={selectionQuestion} onChange={(event) => setSelectionQuestion(event.target.value)} maxLength={2000} rows={3} placeholder="例如：这段定义依赖哪些前提？" /></label>
																				<div className={styles.formFooter}><p className={styles.formHint}>发送到当前原始 Pi 对话，仅携带这段摘录和精确来源定位。</p><div className={styles.readerButtons}><button className={styles.button} type="button" disabled={selectionAskBusy} onClick={addSelectionToNote}>加入笔记</button><button className={styles.buttonPrimary} type="submit" disabled={selectionAskBusy || !selectionQuestion.trim()}>{selectionAskBusy ? "发送中…" : "发送到当前对话"}</button></div></div>
																			</form>
																			{selectionError && <p className={styles.error} role="alert">{selectionError}</p>}
																		</section>}
																		{previewPdf && selectedSource.kind === "pdf" && <div className={styles.pdfPreview}><PdfPreview url={`/api/study-research/source?sessionId=${encodeURIComponent(sessionId)}&sourceId=${encodeURIComponent(selectedSource.sourceId)}&sourceHash=${encodeURIComponent(selectedSource.contentHash)}`} title={`${selectedSource.relativePath} 原始 PDF`} /></div>}
																	</div>
								</div>}
								{selectedSource && <div className={styles.form}><h4>来源诊断</h4><SourceDiagnostics source={selectedSource} /></div>}
								{data.sources.some((source) => source.diagnostics.length > 0) && <details className={styles.debugDetails}><summary>查看全部来源诊断（{data.sources.reduce((sum, source) => sum + source.diagnostics.length, 0)} 条）</summary><ul className={styles.diagnosticList}>{data.sources.flatMap((source) => source.diagnostics.map((diagnostic, index) => <li className={styles.diagnostic} data-severity={diagnostic.severity} key={`${source.sourceId}:${diagnostic.code}:${index}`}><strong>{source.relativePath} · {severityLabel(diagnostic.severity)} · {diagnostic.code}</strong><p>{diagnostic.message}</p>{diagnostic.locator && <p>{locatorLabel(diagnostic.locator)}</p>}</li>))}</ul></details>}
							</section>

							<section className={styles.section} id="notes" tabIndex={-1}>
								<div className={styles.sectionHeader}><div><h3>知识与笔记</h3><p>笔记是主要工作面；每条记录保留来源版本身份，来源更新后会明确标记 stale。</p></div><span className={styles.statusBadge}>{data.knowledge.notes.length} 条笔记</span></div>
								{data.knowledge.notes.length === 0 ? <EmptySection>还没有笔记。先选择来源，在这里保存带定位上下文的理解。</EmptySection> : <><ul className={styles.noteList}>{visibleKnowledgeNotes.map((note) => { const titleNode = data.knowledge.nodes.find((node) => note.nodeIds.includes(node.nodeId)); const noteSource = note.sourceId ? data.sources.find((source) => source.sourceId === note.sourceId) : undefined; return <li className={styles.note} key={note.noteId}><div className={styles.row}><h4>{titleNode?.title ?? (note.nodeIds.length > 0 ? "来源笔记" : "笔记")}</h4>{note.stale && <span className={styles.stale}>已过期 · 来源版本已变化</span>}</div><p>{note.body}</p><div className={styles.sourceMeta}><span>{note.author === "user" ? "用户" : "Agent"}</span><span>{formatDate(note.updatedAt)}</span>{note.sourceId && <span>{noteSource?.relativePath ?? "已关联来源"}</span>}</div>{note.sourceId && <details className={styles.debugDetails}><summary>查看来源版本身份</summary><p className={styles.taskId}>{note.sourceId}</p>{note.sourceHash && <p className={styles.sourceHash}>{note.sourceHash}</p>}</details>}</li>; })}</ul><KnowledgePagination label="笔记" page={knowledgeNotePage} pageCount={notePageCount} onChange={setKnowledgeNotePage} /></>}
								<div className={styles.readerButtons}><a className={styles.button} href={`/api/study-research/export?sessionId=${encodeURIComponent(sessionId)}&format=markdown`} download="study-notes.md">导出笔记 Markdown</a><a className={styles.button} href={`/api/study-research/export?sessionId=${encodeURIComponent(sessionId)}&format=graph`} download="study-graph.json">导出图谱 JSON</a></div>
								<form className={styles.form} id="study-note-form" onSubmit={(event) => void submitNote(event)}>
									<a className={styles.button} href={`/api/study-research/export?sessionId=${encodeURIComponent(sessionId)}&format=project`} download="study-project.zip">导出项目与实验目录 ZIP</a>
									<h4>保存一条来源笔记</h4>
									<label className={styles.field}><span>关联来源</span><select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)} disabled={data.sources.length === 0}><option value="">请选择来源…</option>{data.sources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.relativePath} · 当前版本</option>)}</select></label>
									<label className={styles.field}><span>标题</span><input id="study-note-title" value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} maxLength={2000} placeholder="例如：这一节的核心定义" /></label>
									<label className={styles.field}><span>正文</span><textarea id="study-note-body" value={noteBody} onChange={(event) => setNoteBody(event.target.value)} maxLength={20000} rows={5} placeholder="记录你的理解、疑问或与其他来源的关系…" /></label>
									<div className={styles.formFooter}><p className={styles.formHint}>{selectedSource ? `将绑定 ${selectedSource.relativePath} 的当前版本` : "保存前必须选择来源"}</p><button className={styles.buttonPrimary} type="submit" disabled={busy || !selectedSource || !noteTitle.trim() || !noteBody.trim()}>保存笔记</button></div>
								</form>
								<details className={styles.debugDetails}><summary>知识图谱摘要（可选）</summary><div className={styles.dataGrid}><div className={styles.dataTile}><small>节点</small><strong>{data.knowledge.nodes.length}</strong></div><div className={styles.dataTile}><small>关系</small><strong>{data.knowledge.relations.length}</strong></div></div>{data.knowledge.nodes.length > 0 && <><ul className={styles.noteList}>{visibleKnowledgeNodes.map((node) => <li className={styles.note} key={node.nodeId}><div className={styles.row}><strong>{node.title}</strong>{node.stale && <span className={styles.stale}>stale</span>}</div><p>{node.statement}</p><div className={styles.sourceMeta}><span>{node.kind}</span><span>{node.scope}</span>{node.sourceHash && <span className={styles.sourceHash}>{shortHash(node.sourceHash)}</span>}</div></li>)}</ul><KnowledgePagination label="节点" page={knowledgeNodePage} pageCount={nodePageCount} onChange={setKnowledgeNodePage} /></>}</details>
							</section>

							<StudyCodeCells sessionId={sessionId} phaseRevision={data.phase.revision} cells={data.cells} sources={data.sources} busy={busy} save={async (body) => {
								let saved = false; await perform(async () => { saved = await postWorkspaceAction(body); }); return saved;
							}} />
							<details className={styles.section}><summary>准备 R / Python 所需的包</summary><StudyEnvironmentPackages key={sessionId} sessionId={sessionId} phaseRevision={data.phase.revision} /></details>
							<section className={styles.section} id="tasks" tabIndex={-1}>
								<div className={styles.sectionHeader}><div><h3>任务状态</h3><p>任务状态来自持久化账本；授权阶段和版本只读显示，页面不会把渲染成功当成研究验证。</p></div><span className={styles.statusBadge}>{data.tasks.length} 个任务</span></div>
								{data.tasks.length === 0 ? <EmptySection>当前还没有 Study 任务。</EmptySection> : <ul className={styles.taskList}>{data.tasks.map((task) => <li className={styles.sourceCard} key={task.taskId}>
									<div className={styles.row}><strong>{taskKindLabel(task.kind)} · {taskStatusLabel(task.status)}</strong><span className={styles.taskStatus}>r{task.revision}</span></div>
									<div className={styles.taskMeta}><span>{task.authorization.kind === "learning" ? "学习任务" : "研究任务"} · {task.authorization.phase === "study" ? "Study" : "Research"}</span><span>{formatDate(task.updatedAt)}</span></div>
									<details className={styles.debugDetails}><summary>查看任务身份</summary><p className={styles.taskId}>{task.taskId}</p><pre className={styles.planDetail}>{safeJson({ dispatchKey: task.dispatchKey, target: task.target, authorization: task.authorization, manifest: task.manifest })}</pre></details>
								</li>)}</ul>}
								</section>

							<StudyVisualEditor key={`visual-editor:${sessionId}`} sessionId={sessionId} phaseRevision={data.phase.revision} projectRevision={data.revision} visualizations={data.visualizations} onChanged={refreshAfterAgent} />

							{data.visualizations.length > 0 && <section className={styles.section} id="visuals" tabIndex={-1}>
								<div className={styles.sectionHeader}><div><h3>可视化草稿</h3><p>这里展示 Agent 生成的持久化草稿，也允许本地编辑 inputs 重新预览。预览状态不构成验证、审阅或发布结论。</p></div><span className={styles.statusBadge}>{data.visualizations.length} 个草稿</span></div>
								<div className={styles.visualList}>{data.visualizations.map((draft) => {
									const state = visualInputs[draft.visualizationId];
									const current = state?.revision === draft.revision ? state : null;
									const effectiveInputs = current?.inputs ?? draft.inputs;
									const inputText = current?.text ?? safeJson(draft.inputs);
									return <article className={styles.visualCard} key={draft.visualizationId}>
										<div className={styles.visualHeader}><div><h4>{draft.purpose}</h4><p>{draft.owner === "study" ? "Study" : "Research"} · 持久化 r{draft.revision} · {formatDate(draft.updatedAt)}</p></div><span className={styles.owner}>{draft.owner}</span></div>
										<div className={styles.visualBody}><div className={styles.visualToolbar}>{current?.inputs && <span className={styles.localPreview}>本地预览 · 未写回持久化版本</span>}</div>
											<label className={styles.field}><span>Inputs JSON（仅当前浏览器预览）</span><textarea aria-label="Inputs JSON（仅当前浏览器预览）" className={styles.jsonEditor} value={inputText} onChange={(event) => setVisualInputs((previous) => ({ ...previous, [draft.visualizationId]: { revision: draft.revision, text: event.target.value, inputs: null, error: null } }))} rows={8} spellCheck={false} /></label>
											<div className={styles.visualToolbar}><button className={styles.button} type="button" onClick={() => {
												try {
													const parsed: unknown = JSON.parse(inputText);
													if (!isRecord(parsed)) throw new Error("Inputs 必须是 JSON 对象。");
													setVisualInputs((previous) => ({ ...previous, [draft.visualizationId]: { revision: draft.revision, text: inputText, inputs: parsed, error: null } }));
												} catch (value) {
													setVisualInputs((previous) => ({ ...previous, [draft.visualizationId]: { revision: draft.revision, text: inputText, inputs: null, error: readableError(value) } }));
												}
											}}>应用本地预览</button>{current?.error && <span className={styles.severityError} role="alert">{current.error}</span>}</div>
											<StudyVisualization title={draft.purpose} code={draft.code} inputs={effectiveInputs} revision={draft.revision} validationLabel={current?.inputs ? "本地预览；尚未写回持久化草稿，也不代表验证结论。" : "持久化草稿渲染；渲染状态仅供查看，不代表验证或发布结论。"} />
											<details><summary>验证数值与边界</summary><StudyVisualValidation key={`${sessionId}:${draft.contentHash}`} sessionId={sessionId} phase={data.phase.phase} phaseRevision={data.phase.revision} projectRevision={data.revision} visualization={draft} sources={data.sources.filter((source) => source.current).map(({ sourceId, contentHash, relativePath }) => ({ sourceId, contentHash, relativePath }))} onChanged={refreshAfterAgent} /></details>
											<details><summary>检查浏览器交互与正式使用状态</summary><StudyVisualInteraction key={`interaction:${sessionId}:${draft.contentHash}`} sessionId={sessionId} phaseRevision={data.phase.revision} projectRevision={data.revision} visualization={draft} onChanged={refreshAfterAgent} /></details>
											<StudyVisualReview key={`review:${sessionId}:${draft.contentHash}`} sessionId={sessionId} phaseRevision={data.phase.revision} visualization={draft} sources={reviewSources} />
											<details className={styles.debugDetails}><summary>查看源码与版本身份</summary><pre className={styles.codeBlock}>{draft.code}</pre><pre className={styles.planDetail}>{safeJson({ visualizationId: draft.visualizationId, revision: draft.revision, inputHash: draft.inputHash, inputHashes: draft.inputHashes, environmentHash: draft.environmentHash, contentHash: draft.contentHash })}</pre></details>
										</div>
									</article>;
								})}</div>
							</section>}

							{(data.phase.phase === "research" || data.plans.length > 0) && <StudyResearchPlans sessionId={sessionId} phase={data.phase.phase} phaseRevision={data.phase.revision} projectRevision={data.revision} plans={data.plans} sources={data.sources} cells={data.cells} onChanged={refreshAfterAgent} />}
							{(data.phase.phase === "research" || data.plans.length > 0) && <StudyResearchResults key={`results:${sessionId}`} sessionId={sessionId} phase={data.phase.phase} phaseRevision={data.phase.revision} projectRevision={data.revision} sources={reviewSources} onChanged={refreshAfterAgent} onLearn={({ prompt }) => { void perform(async () => { await dispatchForegroundPrompt(prompt); setNotice("已在当前对话中开始理解这次实验。"); }); }} />}
							<details className={styles.section}><summary>按需出题或准备 Assignment</summary><StudyAssignment sessionId={sessionId} phaseRevision={data.phase.revision} projectRevision={data.revision} onChanged={refreshAfterAgent} onAsk={(prompt) => { void perform(() => dispatchForegroundPrompt(prompt)); }} /></details>
							<StudyManuscript sessionId={sessionId} phase={data.phase.phase} phaseRevision={data.phase.revision} projectRevision={data.revision} onChanged={refreshAfterAgent} onAsk={dispatchForegroundPrompt} />
							<StudyTeachingTransfer sessionId={sessionId} phaseRevision={data.phase.revision} projectRevision={data.revision} />
						</div>
					</>}
				</div>
			</section>
			<StudyConversation key={sessionId} sessionId={sessionId} onAgentEnd={refreshAfterAgent} />
		</div>
	</main>;
}
