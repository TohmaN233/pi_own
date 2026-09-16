"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatWindow } from "@/components/ChatWindow";
import { ProjectConversations } from "@/components/projects/ProjectConversations";
import { SkillsConfig } from "@/components/SkillsConfig";
import { notifySessionConfiguration } from "@/lib/session-configuration-events";
import type { SessionInfo } from "@/lib/types";
import styles from "@/app/study/Study.module.css";

interface Props {
	 sessionId: string;
	 onAgentEnd?: () => void;
}

function responseError(value: unknown, fallback: string): string {
	if (typeof value === "object" && value !== null && "error" in value) {
		const message = (value as { error?: unknown }).error;
		if (typeof message === "string" && message.trim()) return message;
	}
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

/** The right pane always resumes the supplied Pi session; it never creates a Study-only session. */
export function StudyConversation({ sessionId, onAgentEnd }: Props) {
	const [session, setSession] = useState<SessionInfo | null>(null);
	const [loading, setLoading] = useState(Boolean(sessionId));
	const [error, setError] = useState<string | null>(null);
	const [retryKey, setRetryKey] = useState(0);
	const [tab, setTab] = useState<"chat" | "settings">("chat");

	const loadSession = useCallback(async (signal: AbortSignal) => {
		if (!sessionId) {
			setSession(null);
			setLoading(false);
			setError(null);
			return;
		}

		setLoading(true);
		setError(null);
		setSession(null);
		const runtimeResponse = await fetch("/api/study-research/session", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId }),
			signal,
		});
		const runtimeBody = await readJson(runtimeResponse);
		if (!runtimeResponse.ok) {
			throw new Error(responseError(runtimeBody, `原始 Pi 会话启动失败（HTTP ${runtimeResponse.status}）。`));
		}
		if (typeof runtimeBody !== "object" || runtimeBody === null || !("sessionId" in runtimeBody)
			|| runtimeBody.sessionId !== sessionId || !("verified" in runtimeBody) || runtimeBody.verified !== true) {
			throw new Error("原始 Pi 会话资源没有通过核验。");
		}

		const infoResponse = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
			cache: "no-store",
			signal,
		});
		const infoBody = await readJson(infoResponse);
		if (!infoResponse.ok) {
			throw new Error(responseError(infoBody, `无法读取原始 Pi 会话（HTTP ${infoResponse.status}）。`));
		}
		if (typeof infoBody !== "object" || infoBody === null || !("info" in infoBody)) {
			throw new Error("原始 Pi 会话响应缺少会话信息。");
		}
		const info = (infoBody as { info?: unknown }).info;
		if (typeof info !== "object" || info === null) {
			throw new Error("原始 Pi 会话信息格式无效。");
		}
		if (signal.aborted) return;
		setSession(info as SessionInfo);
		notifySessionConfiguration(sessionId);
		setLoading(false);
	}, [sessionId]);

	useEffect(() => {
		const controller = new AbortController();
		void loadSession(controller.signal).catch((value: unknown) => {
			if (controller.signal.aborted) return;
			console.error("[study] original Pi session startup failed", { sessionId, error: value });
			setError(value instanceof Error ? value.message : String(value));
			setLoading(false);
		});
		return () => controller.abort();
	}, [loadSession, retryKey, sessionId]);

	if (!sessionId) return null;

	return (
		<aside className={styles.conversation} aria-label="学习与研究对话">
			<header className={styles.conversationHeader}>
				<div>
					<strong>学习与研究对话</strong>
					<small title={sessionId}>继续当前对话</small>
				</div>
				<div className={styles.conversationTabs} role="tablist" aria-label="对话设置">
					<button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>对话</button>
					<button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>Skills 与提示词</button>
				</div>
			</header>
			<div className={styles.conversationProject}>
				<ProjectConversations sessionId={sessionId} />
			</div>
			<div className={styles.conversationBody}>
				{error && (
					<div className={styles.conversationError} role="alert">
						<p><strong>学习与研究对话暂时不可用</strong></p>
						<p>{error}</p>
						<button className={styles.buttonPrimary} type="button" onClick={() => setRetryKey((value) => value + 1)}>重新连接</button>
						<p>已保存的 Study 工作区仍可使用；连接恢复后可继续同一会话。</p>
					</div>
				)}
				{loading && !error && <div className={styles.conversationLoading} role="status">正在恢复原始 Pi 会话…</div>}
				{session && tab === "chat" && (
					<div className={styles.conversationBody}>
						<ChatWindow
							key={session.id}
							session={session}
							newSessionCwd={null}
							newSessionDraftKey={null}
							onAgentEnd={onAgentEnd}
							soundEnabled={false}
						/>
					</div>
				)}
				{session && tab === "settings" && (
					<div className={styles.settingsBody}>
						<SkillsConfig sessionId={session.id} cwd={session.cwd} embedded section="all" onClose={() => setTab("chat")} />
					</div>
				)}
			</div>
		</aside>
	);
}
