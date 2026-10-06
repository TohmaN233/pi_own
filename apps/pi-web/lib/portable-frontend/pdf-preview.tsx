"use client";
import { useEffect, useRef } from "react";

export type PdfLocation = { page: number; x: number; y: number; width: number; height: number; requestId: number };

export function PdfPreview({ url, title, location, onSourceLocate }: { url: string; title: string; location?: PdfLocation; onSourceLocate?: (position: { page: number; x: number; y: number }) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const file = url;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== "null" || event.source !== frame.current?.contentWindow || event.data?.file !== file) return;
      if (event.data.type === "pi-pdf-content-request" && typeof event.data.requestId === "string") {
        const requestId = event.data.requestId;
        void fetch(`/api/pdf-content?file=${encodeURIComponent(file)}`, { cache: "no-store" }).then(async (response) => {
          if (!response.ok) throw new Error(`PDF preview failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
          return response.json();
        }).then((payload) => frame.current?.contentWindow?.postMessage({ type: "pi-pdf-content-response", file, requestId, payload }, "*"))
          .catch((error) => frame.current?.contentWindow?.postMessage({ type: "pi-pdf-content-response", file, requestId, error: error instanceof Error ? error.message : String(error) }, "*"));
      }
      if (event.data.type === "pi-pdf-ready" && location) frame.current?.contentWindow?.postMessage({ type: "pi-pdf-jump", file, ...location }, "*");
      if (event.data.type === "pi-pdf-source-location" && Number.isSafeInteger(event.data.page) && event.data.page > 0 && Number.isFinite(event.data.x) && Number.isFinite(event.data.y)) onSourceLocate?.({ page: event.data.page, x: event.data.x, y: event.data.y });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [file, location, onSourceLocate]);
  useEffect(() => { if (location) frame.current?.contentWindow?.postMessage({ type: "pi-pdf-jump", file, ...location }, "*"); }, [file, location]);
  return <iframe ref={frame} src={`./pdf-viewer.html?file=${encodeURIComponent(file)}${onSourceLocate ? "&sourceSync=1" : ""}&parentOrigin=null`} title={title} style={{ width: "100%", height: "100%", flex: 1, minHeight: 0, border: 0, background: "#e8eaed" }} />;
}
