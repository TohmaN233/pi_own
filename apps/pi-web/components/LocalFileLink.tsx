"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

/** Shared local-file actions for Markdown and written-file lists. */
export function LocalFileLink({ filePath, onOpenFile, children, ...props }: ComponentProps<"a"> & {
  filePath: string;
  onOpenFile?: (filePath: string) => void;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setPosition(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPosition(null);
        linkRef.current?.focus();
      } else if (event.key === "Tab") setPosition(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [position]);

  const openMenu = (x: number, y: number) => {
    setError(null);
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - 248)), y: Math.max(8, Math.min(y, window.innerHeight - 150)) });
  };
  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams(window.location.search);
      const response = await fetch("/api/files/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath, sessionId: query.get("session") ?? query.get("sessionId") }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setPosition(null);
      linkRef.current?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return <>
    <a {...props} ref={linkRef} aria-haspopup="menu" onClick={event => {
      props.onClick?.(event);
      if (!onOpenFile || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (props.target && props.target !== "_self") return;
      event.preventDefault();
      onOpenFile(filePath);
    }} onContextMenu={event => {
      if (event.shiftKey) return; // Shift-right-click keeps the browser's native menu.
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(event.clientX || rect.left, event.clientY || rect.bottom);
    }} onKeyDown={event => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(rect.left, rect.bottom);
    }}>{children}</a>
    {position && createPortal(<div ref={menuRef} role="menu" aria-label={filePath} className="local-file-context-menu" style={{ left: position.x, top: position.y }}>
      <FileMenuContent busy={busy} error={error} onReveal={reveal} />
    </div>, document.body)}
  </>;
}

function FileMenuContent({ busy, error, onReveal }: { busy: boolean; error: string | null; onReveal: () => Promise<void> }) {
  const { t } = useI18n();
  return <>
    <button type="button" role="menuitem" disabled={busy} onClick={() => void onReveal()}>{busy ? t("file.revealing") : t("file.reveal")}</button>
    {error && <p role="alert">{error}</p>}
  </>;
}
