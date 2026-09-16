"use client";
import { useEffect, useRef } from "react";

export type PdfLocation = { page: number; x: number; y: number; width: number; height: number; requestId: number };

/** Render with the bundled PDF.js viewer, independent of native PDF/download preferences. */
export function PdfPreview({ url, title, location, onSourceLocate }: { url: string; title: string; location?: PdfLocation; onSourceLocate?: (position: { page: number; x: number; y: number }) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow || event.data?.file !== url) return;
      if (event.data.type === "pi-pdf-ready" && location) frame.current?.contentWindow?.postMessage({ type: "pi-pdf-jump", file: url, ...location }, window.location.origin);
      if (event.data.type === "pi-pdf-source-location" && Number.isSafeInteger(event.data.page) && event.data.page > 0 && Number.isFinite(event.data.x) && Number.isFinite(event.data.y)) onSourceLocate?.({ page: event.data.page, x: event.data.x, y: event.data.y });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [url, location, onSourceLocate]);
  useEffect(() => {
    if (location) frame.current?.contentWindow?.postMessage({ type: "pi-pdf-jump", file: url, ...location }, window.location.origin);
  }, [url, location]);
  return <iframe ref={frame} src={`/pdf-viewer.html?file=${encodeURIComponent(url)}${onSourceLocate ? "&sourceSync=1" : ""}`} title={title} style={{ width: "100%", height: "100%", flex: 1, minHeight: 0, border: 0, background: "#e8eaed" }}/>;
}
