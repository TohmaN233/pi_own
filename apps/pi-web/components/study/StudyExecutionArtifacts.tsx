"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { PdfPreview } from "@/components/PdfPreview";
import type { NativeCellOutputArtifactDescriptor } from "../../../../packages/study-execution-host/src/cell-native-adapters.ts";
import styles from "@/app/study/Study.module.css";

export function StudyExecutionArtifacts({ sessionId, queueJobId }: { sessionId: string; queueJobId: string }) {
  const [artifacts, setArtifacts] = useState<NativeCellOutputArtifactDescriptor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; src: string; pdf: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const base = `/api/study-research/execution/artifact?${new URLSearchParams({ sessionId, queueJobId })}`;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(base, { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok || !Array.isArray(value.artifacts)) throw new Error(value.error || "无法读取运行产物");
        if (!controller.signal.aborted) setArtifacts(value.artifacts);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    })();
    return () => controller.abort();
  }, [base]);

  return <div>
    {artifacts.map((artifact) => {
      const url = `${base}&${new URLSearchParams({ path: artifact.path, sha256: artifact.sha256 })}`;
      const previewable = ["image/png", "image/jpeg", "application/pdf"].includes(artifact.mediaType);
      return <div className={styles.readerButtons} key={artifact.path}>
        <span>{artifact.path} · {artifact.bytes} 字节</span>
        {previewable && <button type="button" className={styles.button} disabled={loading} onClick={async () => {
          setError(null);
          if (artifact.mediaType === "application/pdf") { setPreview({ path: artifact.path, src: url, pdf: true }); return; }
          setLoading(true);
          try {
            const response = await fetch(`${url}&mode=preview`, { cache: "no-store" });
            const value = await response.json();
            if (!response.ok || value.sha256 !== artifact.sha256 || !["image/png", "image/jpeg"].includes(value.mediaType) || typeof value.base64 !== "string") throw new Error(value.error || "图片内容校验失败");
            setPreview({ path: artifact.path, src: `data:${value.mediaType};base64,${value.base64}`, pdf: false });
          } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
          finally { setLoading(false); }
        }}>查看</button>}
        <a className={styles.button} href={`${url}&mode=download`} download>下载</a>
      </div>;
    })}
    {preview && <div><button className={styles.button} type="button" onClick={() => setPreview(null)}>收起 {preview.path}</button>
      {preview.pdf ? <div style={{ height: 600 }}><PdfPreview url={preview.src} title={preview.path} /></div>
        : <Image unoptimized src={preview.src} alt={preview.path} width={1200} height={800} style={{ width: "100%", height: "auto", objectFit: "contain" }} />}</div>}
    {error && <p role="alert" className={styles.severityError}>{error}</p>}
  </div>;
}
