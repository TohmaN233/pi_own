"use client";

/** Render with the bundled PDF.js viewer, independent of native PDF/download preferences. */
export function PdfPreview({ url, title }: { url: string; title: string }) {
  return <iframe src={`/pdf-viewer.html?file=${encodeURIComponent(url)}`} title={title} style={{ width: "100%", height: "100%", flex: 1, minHeight: 0, border: 0, background: "#e8eaed" }}/>;
}
