"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  activateModePack,
  getModePackStatus,
  type ModePackStatusResponse,
} from "@/lib/mode-pack-client";
import styles from "./ModePackOverlay.module.css";

export type ModePackStatusKind = ModePackStatusResponse["kind"] | null;

export function ModePackOverlay({ onStatusKind }: { onStatusKind?: (kind: ModePackStatusKind) => void }) {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  const [status, setStatus] = useState<ModePackStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationKeys = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setStatus(null);
      onStatusKind?.(null);
      return;
    }
    try {
      const next = await getModePackStatus(sessionId);
      setStatus(next);
      onStatusKind?.(next.kind);
      setError(null);
    } catch (value) {
      setStatus(null);
      onStatusKind?.(null);
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [onStatusKind, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectable = useMemo(
    () => status?.packs.filter((pack) => pack.selectable) ?? [],
    [status],
  );

  const activate = async (modePackId: string) => {
    if (!status || !sessionId || !modePackId || modePackId === status.currentModePackId) return;
    const operation = `${status.currentSnapshotId ?? "none"}\0${modePackId}`;
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
      operationKeys.current.delete(operation);
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  if (!sessionId || !status || status.kind !== "generic") return null;
  const canSwitch = status.live && !status.busy && !busy && (status.currentSnapshotId === null || status.verified);
  return (
    <div className={styles.overlay} aria-label="Active Mode Pack">
      <strong className={styles.brand}>Pi Own</strong>
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
      {(error || status.diagnostic) && (
        <span className={styles.warning} title={error ?? status.diagnostic ?? undefined}>
          {error ?? status.diagnostic}
        </span>
      )}
      {selectable.length === 0 && <span className={styles.warning}>No selectable Mode Packs</span>}
    </div>
  );
}
