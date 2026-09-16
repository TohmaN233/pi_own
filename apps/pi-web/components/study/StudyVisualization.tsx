"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createStudyVisualFrame, isStudyVisualMessage } from "@/lib/study-visual-sandbox";

export interface StudyVisualizationProps {
  title: string;
  code: string;
  inputs: Record<string, unknown>;
  revision: number;
  validationLabel: string;
  onObservation?: (value: { elements: Array<{ tag: string; attrs: Record<string, string>; text?: string }> }) => void;
}

/** Shared by learning and teaching. Host acceptance is separate from renderer status. */
export function StudyVisualization(props: StudyVisualizationProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [status, setStatus] = useState("等待渲染");
  const observer = useRef(props.onObservation);
  useEffect(() => { observer.current = props.onObservation; }, [props.onObservation]);
  useEffect(() => { setChannel(crypto.randomUUID()); }, [props.code, props.inputs, props.revision]);
  const document = useMemo(() => {
    if (!channel) return { html: "", error: null };
    try { return { html: createStudyVisualFrame({ code: props.code, inputs: props.inputs, channel }), error: null }; }
    catch (error) { return { html: "", error: error instanceof Error ? error.message : String(error) }; }
  }, [channel, props.code, props.inputs]);
  useEffect(() => {
    if (!channel) return;
    const receive = (event: MessageEvent) => {
      if (isStudyVisualMessage(event, frame.current?.contentWindow ?? null, channel)) {
        setStatus(event.data.message);
        if (event.data.type === "rendered" && event.data.observation && Array.isArray(event.data.observation.elements)) observer.current?.(event.data.observation);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel]);
  return <section aria-label={props.title}>
    <h3>{props.title} · r{props.revision}</h3>
    <p>{props.validationLabel}</p>
    {document.error ? <p role="alert">{document.error}</p> : <iframe
      key={channel}
      ref={frame}
      title={props.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document.html}
      style={{ width: "100%", minHeight: 440, border: "1px solid var(--border)" }}
    />}
    <p role="status">{status}</p>
  </section>;
}
