"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  activateModePack,
  getModePackStatus,
  importModePackArchive,
  importModePackBundle,
  PortableModePackImportError,
  sendPortableImportPrompt,
  type ModePackStatusResponse,
} from "@/lib/mode-pack-client";
import styles from "./ModePackOverlay.module.css";
import { subscribeSessionConfiguration } from "@/lib/session-configuration-events";
import { studyModePhase } from "@/lib/study-mode-phase";
import { ModePackFrontend } from "./ModePackFrontend";
import { projectAction } from "@/lib/project-workspaces-client";

export type ModePackStatusKind = ModePackStatusResponse["kind"] | null;

export function ModePackOverlay({ onStatusKind }: { onStatusKind?: (kind: ModePackStatusKind) => void }) {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  return <SessionModePackOverlay key={sessionId} sessionId={sessionId} onStatusKind={onStatusKind} />;
}

export function SessionModePackOverlay({ sessionId, onStatusKind }: {
  sessionId: string;
  onStatusKind?: (kind: ModePackStatusKind) => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ModePackStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const operationKeys = useRef(new Map<string, string>());
  const refreshRequest = useRef<AbortController | null>(null);
  const activationRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshRequest.current?.abort();
    const request = new AbortController();
    refreshRequest.current = request;
    if (!sessionId) {
      setStatus(null);
      onStatusKind?.(null);
      return;
    }
    try {
      const next = await getModePackStatus(sessionId);
      if (request.signal.aborted) return;
      if (next.sessionId !== sessionId) throw new Error("Mode Pack status belongs to another session.");
      setStatus(next);
      onStatusKind?.(next.kind);
      setError(null);
    } catch (value) {
      if (request.signal.aborted) return;
      setStatus(null);
      onStatusKind?.(null);
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [onStatusKind, sessionId]);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeSessionConfiguration(sessionId, () => { void refresh(); });
    return () => { unsubscribe(); refreshRequest.current?.abort(); };
  }, [refresh, sessionId]);

  useEffect(() => () => { activationRequest.current?.abort(); }, []);

  const selectable = useMemo(
    () => status?.packs.filter((pack) => pack.selectable) ?? [],
    [status],
  );

  const activate = async (modePackId: string) => {
    if (busy || !status || status.sessionId !== sessionId || !sessionId || !modePackId || modePackId === status.currentModePackId) return;
    if (activationRequest.current && !activationRequest.current.signal.aborted) return;
    const request = new AbortController();
    activationRequest.current = request;
    refreshRequest.current?.abort();
    const operation = `${sessionId}\0${status.currentSnapshotId ?? "none"}\0${modePackId}`;
    const idempotencyKey = operationKeys.current.get(operation) ?? crypto.randomUUID();
    operationKeys.current.set(operation, idempotencyKey);
    setBusy(true);
    setSwitchingTo(status.packs.find((pack) => pack.modePackId === modePackId)?.title ?? modePackId);
    setError(null);
    try {
      await activateModePack({
        sessionId,
        modePackId,
        expectedSnapshotId: status.currentSnapshotId,
        idempotencyKey,
      });
      if (request.signal.aborted) return;
      operationKeys.current.delete(operation);
      await refresh();
    } catch (value) {
      if (!request.signal.aborted) {
        setError(value instanceof Error ? value.message : String(value));
      }
    } finally {
      if (!request.signal.aborted) { setBusy(false); setSwitchingTo(null); }
      if (activationRequest.current === request) activationRequest.current = null;
    }
  };

  const importWorkModule = async (file: File) => {
    if (busy || !status || status.sessionId !== sessionId) return;
    setError(null);
    setPendingAgentPrompt(null);
    const binary = file.name.toLocaleLowerCase("en-US").endsWith(".mode-pack.tar") || file.name.toLocaleLowerCase("en-US").endsWith(".tar");
    let archive: unknown = null;
    if (!binary) {
      try { archive = JSON.parse(await file.text()); }
      catch (cause) { setError(`工作模块文件不是有效 JSON：${cause instanceof Error ? cause.message : String(cause)}`); return; }
    }
    const sourceId = (archive as { moduleId?: unknown; definition?: { modePackId?: unknown } } | null)?.moduleId
      ?? (archive as { definition?: { modePackId?: unknown } } | null)?.definition?.modePackId;
    const sourceName = binary ? file.name.replace(/(?:\.mode-pack)?\.tar$/iu, "") : sourceId;
    const suggestedId = typeof sourceName === "string" && sourceName.trim()
      ? `custom.${sourceName.replace(/^custom\./u, "").replace(/[^a-z0-9.-]+/giu, "-").replace(/^-+|-+$/gu, "").toLocaleLowerCase("en-US")}`
      : "custom.imported-mode";
    const newModePackId = window.prompt("导入后的工作模块 ID（以 custom. 开头）", suggestedId)?.trim();
    if (!newModePackId) return;
    setBusy(true);
    try {
      if (binary) await importModePackBundle({ sessionId, file, newModePackId });
      else await importModePackArchive({ sessionId, archive, newModePackId });
      await refresh();
    } catch (cause) {
      if (cause instanceof PortableModePackImportError) {
        setError(`${cause.message}${cause.details.agentDelivery === "accepted" ? "\n诊断已发送给 Pi agent。" : cause.details.agentDeliveryError ? `\nPi agent 未收到诊断：${cause.details.agentDeliveryError}` : ""}`);
        if (cause.details.agentDelivery !== "accepted") setPendingAgentPrompt(cause.details.agentPrompt ?? null);
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const sendConflictToPi = async () => {
    if (!pendingAgentPrompt || busy) return;
    setBusy(true);
    try {
      await sendPortableImportPrompt(sessionId, pendingAgentPrompt);
      setPendingAgentPrompt(null);
      setError("导入预检诊断已发送给 Pi agent；工作模块仍未安装。");
    } catch (cause) {
      setError(`Pi agent 未收到诊断：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const createInCurrentMode = async () => {
    if (busy || !sessionId || !status?.currentModePackId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await projectAction({ action: "new_from_session", sourceSessionId: sessionId, requestId: crypto.randomUUID() });
      if (!result.href) throw new Error("新对话已创建，但没有返回入口。");
      router.push(result.href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId || !status || status.sessionId !== sessionId) return <div className={styles.overlay}>
    <a className={styles.link} href="/projects">项目与对话</a>
    <a className={styles.workspaceLink} href="/course-builder">备课 · 继续已有课程</a>
    {error && <><span className={styles.warning} role="alert">{error}</span><button className={styles.link} type="button" onClick={() => void refresh()}>重试加载模式</button></>}
  </div>;
  if (status.kind !== "generic") return null;
  const canSwitch = !status.busy && !busy;
  return (
    <div className={styles.overlay} aria-label="Active Mode Pack">
      <strong className={styles.brand}>Pi Own</strong>
      <a className={styles.link} href="/projects">项目与对话</a>
      <select
        className={styles.select}
        aria-label="Active Mode Pack"
        aria-busy={busy}
        value={status.currentModePackId ?? ""}
        disabled={!canSwitch}
        onChange={(event) => void activate(event.target.value)}
      >
        <option value="">Choose Mode Pack</option>
        {status.packs.map((pack) => (
          <option
            key={pack.modePackId}
            value={pack.modePackId}
            disabled={!pack.selectable}
            title={[
              ...pack.missingRequiredResources.map((item) => `missing ${item}`),
              ...(!pack.selectable ? pack.identityMismatches.map((item) => `changed ${item}`) : []),
              ...(pack.packageError ? [pack.packageError] : []),
            ].join(", ") || pack.description}
          >
            {pack.title} · {pack.modePackId}
          </option>
        ))}
      </select>
      {switchingTo && <span className={styles.progress} role="status" title="首次加载新版本可能需要安装组件；完成后会显示已生效的模式。">正在切换到 {switchingTo}…</span>}
      <button className={styles.link} type="button" disabled={busy || !status.currentModePackId} onClick={() => void createInCurrentMode()}>新建此模式对话</button>
      <input ref={importInput} type="file" accept=".tar,.json,application/json,application/vnd.pi-own.mode-pack+tar" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importWorkModule(file); }} />
      <button className={styles.link} type="button" disabled={busy} onClick={() => importInput.current?.click()}>导入工作模块</button>
      <a className={styles.link} href={`/mode-packs?sessionId=${encodeURIComponent(sessionId)}`}>Customize</a>
      {status.frontend?.presentation !== "workspace" && studyModePhase(status.currentModePackId ?? "") && <a className={`${styles.link} ${styles.workspaceLink}`} href={`/study?sessionId=${encodeURIComponent(sessionId)}`}>打开学习与研究工作区</a>}
      {status.frontend?.presentation !== "workspace" && <a
        className={`${styles.link} ${styles.workspaceLink}`}
        href={`/course-builder?sessionId=${encodeURIComponent(sessionId)}`}
        aria-label="打开备课工作区"
        title={status.live ? "打开教师备课工作区" : "恢复当前会话并打开教师备课工作区"}
      >
        打开备课工作区
      </a>}
      {(error || status.diagnostic) && (
        <span className={styles.warning} role="alert" title={error ?? status.diagnostic ?? undefined}>
          {error ?? status.diagnostic}
        </span>
      )}
      {pendingAgentPrompt && <button className={styles.link} type="button" disabled={busy} onClick={() => void sendConflictToPi()}>交给 Pi agent 处理</button>}
      {selectable.length === 0 && <span className={styles.warning}>No selectable Mode Packs</span>}
      <ModePackFrontend sessionId={sessionId} packageContentHash={status.packageContentHash} snapshotId={status.currentSnapshotId} entry={status.frontend?.entry ?? status.frontendEntry} runtimeId={status.runtimeId} presentation={status.frontend?.presentation} projectCapabilities={status.projectCapabilities} />
    </div>
  );
}
