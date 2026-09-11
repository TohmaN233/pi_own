"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  activateModePack,
  getModePackStatus,
  type ModePackStatusResponse,
} from "@/lib/mode-pack-client";
import styles from "./ModePackOverlay.module.css";
import { subscribeSessionConfiguration } from "@/lib/session-configuration-events";

export type ModePackStatusKind = ModePackStatusResponse["kind"] | null;

export function ModePackOverlay({ onStatusKind }: { onStatusKind?: (kind: ModePackStatusKind) => void }) {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  return <SessionModePackOverlay key={sessionId} sessionId={sessionId} onStatusKind={onStatusKind} />;
}

function SessionModePackOverlay({ sessionId, onStatusKind }: {
  sessionId: string;
  onStatusKind?: (kind: ModePackStatusKind) => void;
}) {
  const [status, setStatus] = useState<ModePackStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      if (!request.signal.aborted) setBusy(false);
      if (activationRequest.current === request) activationRequest.current = null;
    }
  };

  if (!sessionId || !status || status.sessionId !== sessionId) return <div className={styles.overlay}><a className={styles.link} href="/projects">项目与对话</a><a className={styles.workspaceLink} href="/course-builder">备课 · 继续已有课程</a><a className={styles.link} href="/study-research">Study &amp; Research</a></div>;
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
              ...pack.identityMismatches.map((item) => `changed ${item}`),
            ].join(", ") || pack.description}
          >
            {pack.title} · {pack.modePackId}
          </option>
        ))}
      </select>
      <a className={styles.link} href={`/mode-packs?sessionId=${encodeURIComponent(sessionId)}`}>Customize</a>
      <a
        className={`${styles.link} ${styles.workspaceLink}`}
        href={`/course-builder?sessionId=${encodeURIComponent(sessionId)}`}
        aria-label="打开备课工作区"
        title={status.live ? "打开教师备课工作区" : "恢复当前会话并打开教师备课工作区"}
      >
        打开备课工作区
      </a>
      <a className={styles.link} href="/study-research">Study &amp; Research</a>
      {(error || status.diagnostic) && (
        <span className={styles.warning} title={error ?? status.diagnostic ?? undefined}>
          {error ?? status.diagnostic}
        </span>
      )}
      {selectable.length === 0 && <span className={styles.warning}>No selectable Mode Packs</span>}
    </div>
  );
}
