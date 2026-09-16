"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AssignmentDraft } from "../../../../packages/course-builder-host/src/index.ts";
import type { StudyAssignmentRecord } from "../../../../packages/study-research-host/src/index.ts";
import styles from "@/app/study/Study.module.css";

interface StudyAssignmentSource {
	sourceId: string;
	sourceHash: string;
	kind: string;
	relativePath: string;
	version: number;
}

interface StudyAssignmentState {
	phase: { phase: "study" | "research"; revision: number };
	projectRevision: number;
	sources: StudyAssignmentSource[];
	assignments: StudyAssignmentRecord[];
}

export interface StudyAssignmentProps {
	sessionId: string;
	phaseRevision: number;
	projectRevision: number;
	onChanged?: () => void;
	onAsk: (prompt: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
	if (isRecord(value) && typeof value.error === "string") return value.error;
	return value instanceof Error ? value.message : String(value);
}

async function readResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function shortHash(value: string): string {
	return value.length > 18 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
}

function assignmentCount(record: StudyAssignmentRecord): string {
	const count = record.request.count;
	return count === null ? "自定数量" : `${count} 题`;
}

function askPrompt(record: StudyAssignmentRecord): string {
	return [
		"用户明确要求根据已保存的 Study Assignment 请求生成练习草稿。",
		"请先调用 study_assignment action=read-request 读取这个请求，然后仅根据其中冻结的来源身份生成草稿；不要创建请求、批准、评分或要求用户完成。",
		`requestId: ${record.request.requestId}`,
		`requestRevision: ${record.request.revision}`,
		`phaseRevision: ${record.request.phaseRevision}`,
		`projectRevision: ${record.request.projectRevision}`,
		"生成后调用 study_assignment action=save-draft，并原样使用 AssignmentDraft 字段：overview、tasks、deliverables、rubric、solutionNotes、materialIds。tasks 是问题，solutionNotes 按相同顺序提供答案解释，materialIds 只能填写请求中的 Study sourceId。",
	].join("\n");
}

export function StudyAssignment({
	sessionId,
	phaseRevision,
	projectRevision,
	onChanged,
	onAsk,
}: StudyAssignmentProps) {
	const [state, setState] = useState<StudyAssignmentState | null>(null);
	const [goal, setGoal] = useState("");
	const [count, setCount] = useState("");
	const [difficulty, setDifficulty] = useState("");
	const [purpose, setPurpose] = useState("");
	const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
	const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(Boolean(sessionId));
	const [refreshRevision, setRefreshRevision] = useState(0);
	const [error, setError] = useState<string | null>(null);

	const currentPhaseRevision = state?.phase.revision ?? phaseRevision;
	const currentProjectRevision = state?.projectRevision ?? projectRevision;
	const selectedSources = useMemo(
		() => (state?.sources ?? []).filter((source) => selectedSourceIds.includes(source.sourceId)),
		[state?.sources, selectedSourceIds],
	);

	useEffect(() => {
		if (!sessionId) {
			setState(null);
			setLoading(false);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		void fetch(`/api/study-research/assignment?${new URLSearchParams({ sessionId })}`, {
			cache: "no-store",
			signal: controller.signal,
		})
			.then(async (response) => {
				const value = await readResponse(response);
				if (!response.ok) throw new Error(errorMessage(value));
				if (!isRecord(value) || !isRecord(value.phase) || !Array.isArray(value.sources) || !Array.isArray(value.assignments))
					throw new Error("学习练习响应格式无效");
				setState(value as unknown as StudyAssignmentState);
				setError(null);
			})
			.catch((value: unknown) => {
				if (!controller.signal.aborted) setError(errorMessage(value));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [sessionId, phaseRevision, projectRevision, refreshRevision]);

	async function createRequest(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (!goal.trim() || selectedSources.length === 0) {
			setError("请填写学习目标并至少选择一个当前来源。");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/study-research/assignment", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "create",
					sessionId,
					expectedPhaseRevision: currentPhaseRevision,
					expectedProjectRevision: currentProjectRevision,
					goal: goal.trim(),
					sourceRefs: selectedSources.map((source) => ({ sourceId: source.sourceId, sourceHash: source.sourceHash })),
					count: count.trim() ? Number(count) : null,
					difficulty: difficulty.trim() || null,
					purpose: purpose.trim() || null,
				}),
			});
			const value = await readResponse(response);
			if (!response.ok) throw new Error(errorMessage(value));
			setGoal("");
			setCount("");
			setDifficulty("");
			setPurpose("");
			setSelectedSourceIds([]);
			if (state && isRecord(value)) {
				setState((current) => current ? { ...current, assignments: [value as unknown as StudyAssignmentRecord, ...current.assignments] } : current);
			}
			onChanged?.();
		} catch (value) {
			setError(errorMessage(value));
		} finally {
			setBusy(false);
		}
	}

	function toggleAnswer(key: string): void {
		setRevealed((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	if (!sessionId) return null;

	return (
		<section aria-label="Study Assignment 学习练习">
			<header className={styles.sectionHeader}>
				<h3>按要求生成练习</h3>
				<button className={styles.button} type="button" disabled={loading} onClick={() => setRefreshRevision(value => value + 1)}>刷新练习草稿</button>
				<p>Study 默认用于理解论文，不会自动出题。这里的请求必须由你明确提交。</p>
			</header>
		<form className={styles.form} onSubmit={(event) => void createRequest(event)}>
			<label className={styles.field}>
				<span>学习目标</span>
				<textarea value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={20_000} rows={3} placeholder="例如：根据定义和主要推导生成几道理解题" />
			</label>
			<label className={styles.field}>
				<span>来源（选择当前版本）</span>
				<select
					aria-label="来源（选择当前版本）"
					multiple
					value={selectedSourceIds}
					onChange={(event) => setSelectedSourceIds(Array.from(event.target.selectedOptions, (option) => option.value))}
					disabled={loading || (state?.sources.length ?? 0) === 0}
				>
					{(state?.sources ?? []).map((source) => <option key={source.sourceId} value={source.sourceId}>{source.relativePath} · v{source.version}</option>)}
				</select>
			</label>
			<label className={styles.field}>
				<span>题数（可选）</span>
				<input type="number" min={1} max={200} value={count} onChange={(event) => setCount(event.target.value)} />
			</label>
			<label className={styles.field}>
				<span>难度（可选）</span>
				<input value={difficulty} onChange={(event) => setDifficulty(event.target.value)} maxLength={256} placeholder="例如：基础理解" />
			</label>
			<label className={styles.field}>
				<span>用途（可选）</span>
				<input value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={6_000} placeholder="例如：准备组会讨论" />
			</label>
			<button className={styles.buttonPrimary} type="submit" disabled={busy || loading}>{busy ? "提交中…" : "提交明确请求"}</button>
		</form>
		{error && <p role="alert">{error}</p>}
		<div aria-live="polite">
			{(state?.assignments ?? []).map((record) => {
				const draft = record.draft?.draft;
				return (
					<article className={styles.note} key={record.request.requestId}>
						<header>
							<h4>{record.request.goal}</h4>
							<p>{record.request.status === "draft" ? "已有练习草稿" : "等待 Agent 根据请求生成草稿"} · {assignmentCount(record)}</p>
						</header>
						<p>来源：{record.originSources.map((source) => `${source.sourceId} (${shortHash(source.sourceHash)})`).join("、")}</p>
						<button className={styles.button} type="button" onClick={() => onAsk(askPrompt(record))}>请 Agent 生成或更新草稿</button>
						{draft && <AssignmentQuestions draft={draft} revealed={revealed} onToggle={toggleAnswer} />}
						<details>
							<summary>查看请求版本</summary>
							<p>request {record.request.requestId} · r{record.request.revision} · draft r{record.request.draftRevision}</p>
						</details>
					</article>
				);
			})}
			{!loading && (state?.assignments.length ?? 0) === 0 && <p>还没有明确提交的练习请求。</p>}
		</div>
		</section>
	);
}

function AssignmentQuestions({
	draft,
	revealed,
	onToggle,
}: {
	draft: AssignmentDraft;
	revealed: Set<string>;
	onToggle: (key: string) => void;
}) {
	return (
		<div>
			<p>{draft.overview}</p>
			<ol>
				{draft.tasks.map((question, index) => {
					const key = `${index}:${question}`;
					const answer = draft.solutionNotes[index];
					return (
						<li key={key}>
							<p>{question}</p>
							{answer && <button className={styles.button} type="button" onClick={() => onToggle(key)}>{revealed.has(key) ? "隐藏答案" : "显示答案"}</button>}
							{answer && revealed.has(key) && <p>{answer}</p>}
						</li>
					);
				})}
			</ol>
			<p>来源身份：{draft.materialIds.join("、")}</p>
		</div>
	);
}
