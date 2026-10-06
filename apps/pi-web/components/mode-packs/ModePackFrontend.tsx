"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { notifySessionConfiguration } from "@/lib/session-configuration-events";
import { modePackFrontendApiTarget } from "@/lib/mode-pack-frontend-api";
import {
  MODE_PACK_FRONTEND_CHANNEL,
  frontendContextKey,
  isOpaqueModePackMessage,
  modePackFrontendUrl,
  specKitFrontendPresentation,
  type ModePackFrontendContext,
  type SpecKitFrontendStatus,
} from "@/lib/mode-pack-frontend-bridge";

interface FrontendState { message: string | null; pending: boolean }
interface SpecKitResponse extends SpecKitFrontendStatus { error?: string; snapshotId?: string }

function postToFrontend(source: Window | null, context: ModePackFrontendContext, value: Record<string, unknown>, transfer: Transferable[] = []): void {
  source?.postMessage({ channel: MODE_PACK_FRONTEND_CHANNEL, sessionId: context.sessionId, snapshotId: context.snapshotId, nonce: context.nonce, ...value }, "*", transfer);
}

export function ModePackFrontend({ sessionId, packageContentHash, snapshotId, entry, runtimeId = null, presentation = "panel", projectCapabilities = [] }: {
  sessionId: string;
  packageContentHash: string | null | undefined;
  snapshotId: string | null;
  entry: string | null | undefined;
  runtimeId?: string | null;
  presentation?: "panel" | "workspace";
  projectCapabilities?: readonly string[];
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initializingContext = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FrontendState>({ message: null, pending: false });
  const [parentOrigin, setParentOrigin] = useState<string | null>(null);
  useEffect(() => { setParentOrigin(window.location.origin); }, []);
  const context = useMemo<ModePackFrontendContext | null>(() => {
    if (!packageContentHash || !snapshotId || !entry || !parentOrigin) return null;
    return { sessionId, packageContentHash, snapshotId, entry, parentOrigin, nonce: crypto.randomUUID(), ...(runtimeId ? { runtimeId } : {}) };
  }, [entry, packageContentHash, parentOrigin, runtimeId, sessionId, snapshotId]);
  const contextKey = context ? frontendContextKey(context) : null;
  const supportsSpecKit = projectCapabilities.includes("spec-kit");

  // A new package/snapshot gets a new opaque frame. Do not leave a previous
  // capability result beside it while its own status request is pending.
  useEffect(() => { setState({ message: null, pending: false }); }, [contextKey]);

  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    const apiRequests = new Map<string, AbortController>();
    const eventStreams = new Map<string, EventSource>();
    let current = true;
    const isCurrent = (source: Window | null) => current && !controller.signal.aborted && frame.current?.contentWindow === source;
    const storageFor = (kind: string): Storage => {
      if (kind === "local") return window.localStorage;
      if (kind === "session") return window.sessionStorage;
      throw new Error(`Unknown portable storage scope: ${kind}`);
    };
    const storagePrefix = (kind: string) => `pi-own:portable:${context.packageContentHash}:${kind}:`;
    const readStorage = (kind: "local" | "session"): [string, string][] => {
      const source = storageFor(kind);
      const prefix = storagePrefix(kind);
      const entries: [string, string][] = [];
      for (let index = 0; index < source.length; index++) {
        const key = source.key(index);
        if (key?.startsWith(prefix)) entries.push([key.slice(prefix.length), source.getItem(key) ?? ""]);
      }
      return entries;
    };
    const updateStorage = (data: Record<string, unknown>) => {
      const source = storageFor(data.kind as string);
      const prefix = storagePrefix(data.kind as string);
      if (data.operation === "clear") {
        for (const [key] of readStorage(data.kind as "local" | "session")) source.removeItem(`${prefix}${key}`);
        return;
      }
      if (typeof data.key !== "string" || data.key.length > 256) throw new Error("Portable storage key is invalid");
      if (data.operation === "remove") source.removeItem(`${prefix}${data.key}`);
      else if (data.operation === "set" && typeof data.value === "string" && data.value.length <= 2 * 1024 * 1024) source.setItem(`${prefix}${data.key}`, data.value);
      else throw new Error("Portable storage change is invalid");
    };
    const publishSpecKitStatus = async (source: Window | null) => {
      if (initializingContext.current === contextKey) return;
      try {
        const response = await fetch(`/api/mode-packs/spec-kit?sessionId=${encodeURIComponent(context.sessionId)}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as SpecKitResponse;
        if (!response.ok) throw new Error(body.error ?? "Mode capability is unavailable");
        if (!isCurrent(source)) return;
        const presentation = specKitFrontendPresentation(body);
        setState({ message: presentation.message, pending: false });
        postToFrontend(source, context, { type: "status", ...presentation, pending: false, state: body.state });
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(source)) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ message, pending: false });
        postToFrontend(source, context, { type: "status", message, canInitialize: false, pending: false, state: "error" });
      }
    };
    const initializeSpecKit = async (source: Window | null) => {
      if (!supportsSpecKit || !isCurrent(source) || initializingContext.current === contextKey) return;
      initializingContext.current = contextKey;
      setState({ message: "Initializing Spec Kit…", pending: true });
      postToFrontend(source, context, { type: "status", message: "Initializing Spec Kit…", canInitialize: false, pending: true, state: "pending" });
      try {
        const response = await fetch("/api/mode-packs/spec-kit", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ sessionId: context.sessionId, expectedSnapshotId: context.snapshotId }) });
        const body = await response.json() as SpecKitResponse;
        if (!response.ok) throw new Error(body.error ?? "Spec Kit initialization failed");
        if (!isCurrent(source)) return;
        setState({ message: "Spec Kit initialized", pending: false });
        postToFrontend(source, context, { type: "status", message: "Spec Kit initialized", canInitialize: false, pending: false, state: "ready" });
        // Every consumer rereads the authoritative binding, which rotates the
        // iframe nonce and exposes newly native Pi slash commands.
        notifySessionConfiguration(context.sessionId);
      } catch (error) {
        if (controller.signal.aborted || !isCurrent(source)) return;
        const failure = error instanceof Error ? error.message : String(error);
        try {
          const response = await fetch(`/api/mode-packs/spec-kit?sessionId=${encodeURIComponent(context.sessionId)}`, { cache: "no-store", signal: controller.signal });
          const body = await response.json() as SpecKitResponse;
          if (!response.ok) throw new Error(body.error ?? "Mode capability is unavailable");
          if (!isCurrent(source)) return;
          const presentation = specKitFrontendPresentation(body);
          const message = `${failure} ${presentation.message}`;
          setState({ message, pending: false });
          postToFrontend(source, context, { type: "status", message, canInitialize: presentation.canInitialize, pending: false, state: body.state });
        } catch (statusError) {
          if (controller.signal.aborted || !isCurrent(source)) return;
          const message = `${failure} ${statusError instanceof Error ? statusError.message : String(statusError)}`;
          setState({ message, pending: false });
          postToFrontend(source, context, { type: "status", message, canInitialize: false, pending: false, state: "error" });
        }
      } finally {
        if (initializingContext.current === contextKey) initializingContext.current = null;
      }
    };
    const forwardRequest = async (source: Window | null, data: Record<string, unknown>) => {
      const requestId = data.requestId;
      if (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/iu.test(requestId) || apiRequests.has(requestId)) return;
      const request = new AbortController();
      apiRequests.set(requestId, request);
      try {
        if (typeof data.url !== "string" || (data.method !== "GET" && data.method !== "POST") || !Array.isArray(data.headers)
          || (data.body !== null && !(data.body instanceof ArrayBuffer))) throw new Error("Invalid portable API request");
        if (data.body instanceof ArrayBuffer && data.body.byteLength > 128 * 1024 * 1024) throw new Error("Portable API request exceeds 128 MiB");
        const target = modePackFrontendApiTarget({ url: data.url, method: data.method, sessionId: context.sessionId, runtimeId, projectCapabilities });
        const headers = new Headers();
        for (const pair of data.headers) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") throw new Error("Invalid portable API header");
          if (/^(?:authorization|cookie|host|origin|proxy-|sec-)/iu.test(pair[0])) continue;
          headers.append(pair[0], pair[1]);
        }
        const response = await fetch(target, { method: data.method, headers, ...(data.body instanceof ArrayBuffer ? { body: data.body } : {}), signal: request.signal, credentials: "same-origin", redirect: "error", cache: "no-store" });
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > 128 * 1024 * 1024) throw new Error("Portable API response exceeds 128 MiB");
        const body = await response.arrayBuffer();
        if (body.byteLength > 128 * 1024 * 1024) throw new Error("Portable API response exceeds 128 MiB");
        if (isCurrent(source)) postToFrontend(source, context, { type: "api-response", requestId, status: response.status, statusText: response.statusText, headers: [...response.headers], body }, [body]);
      } catch (error) {
        if (isCurrent(source) && !request.signal.aborted) postToFrontend(source, context, { type: "api-response", requestId, error: error instanceof Error ? error.message : String(error) });
      } finally { apiRequests.delete(requestId); }
    };
    const forwardDownload = async (source: Window | null, data: Record<string, unknown>) => {
      try {
        if (typeof data.url !== "string" || !runtimeId || typeof data.filename !== "string" && data.filename !== null) throw new Error("Invalid portable download request");
        const target = modePackFrontendApiTarget({ url: data.url, method: "GET", sessionId: context.sessionId, runtimeId, projectCapabilities });
        const prefix = `/api/mode-packs/runtime/${encodeURIComponent(context.sessionId)}/${encodeURIComponent(runtimeId)}/`;
        if (!target.startsWith(prefix)) throw new Error("Portable download is outside the active package");
        const response = await fetch(target, { credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Portable download failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > 128 * 1024 * 1024) throw new Error("Portable download exceeds 128 MiB");
        const blob = await response.blob();
        if (blob.size > 128 * 1024 * 1024) throw new Error("Portable download exceeds 128 MiB");
        if (!isCurrent(source)) return;
        const disposition = response.headers.get("content-disposition") ?? "";
        const encoded = disposition.match(/(?:filename\*=UTF-8''|filename=)"?([^";]+)/iu)?.[1];
        const name = (data.filename || (encoded ? decodeURIComponent(encoded) : "module-export")).split(/[\\/]/u).at(-1) || "module-export";
        const href = URL.createObjectURL(blob);
        try {
          const link = document.createElement("a");
          link.href = href;
          link.download = name;
          link.style.display = "none";
          document.body.append(link);
          link.click();
          link.remove();
        } finally { setTimeout(() => URL.revokeObjectURL(href), 30_000); }
      } catch (error) {
        if (!isCurrent(source)) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error("[mode-pack] portable download failed", { packageContentHash: context.packageContentHash, message });
        setState({ message, pending: false });
        postToFrontend(source, context, { type: "download-error", error: message });
      }
    };
    const receive = (event: MessageEvent) => {
      const source = frame.current?.contentWindow ?? null;
      if (!isOpaqueModePackMessage(event, source, context)) return;
      if (event.data.type === "ready") {
        try { postToFrontend(source, context, { type: "storage-init", local: readStorage("local"), session: readStorage("session") }); }
        catch (error) { postToFrontend(source, context, { type: "storage-error", error: error instanceof Error ? error.message : String(error) }); }
        if (supportsSpecKit) void publishSpecKitStatus(source);
        else if (!runtimeId) postToFrontend(source, context, { type: "status", message: "No host project capability is enabled.", canInitialize: false, pending: false, state: "unavailable" });
        return;
      }
      if (event.data.type === "spec-kit-initialize") void initializeSpecKit(source);
      if (event.data.type === "storage-change") {
        try { updateStorage(event.data); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[mode-pack] portable frontend storage failed", { packageContentHash: context.packageContentHash, message });
          setState({ message, pending: false });
        }
      }
      if (event.data.type === "api-request") void forwardRequest(source, event.data);
      if (event.data.type === "download-request") void forwardDownload(source, event.data);
      if (event.data.type === "api-abort" && typeof event.data.requestId === "string") apiRequests.get(event.data.requestId)?.abort();
      if (event.data.type === "sse-open" && typeof event.data.streamId === "string" && typeof event.data.url === "string") {
        try {
          if (eventStreams.has(event.data.streamId)) throw new Error("Event stream ID was reused");
          const target = modePackFrontendApiTarget({ url: event.data.url, method: "GET", sessionId: context.sessionId, runtimeId, projectCapabilities });
          if (target !== `/api/agent/${encodeURIComponent(context.sessionId)}/events`) throw new Error("Event stream is outside this session");
          const stream = new EventSource(target);
          eventStreams.set(event.data.streamId, stream);
          stream.onmessage = (message) => { if (isCurrent(source)) postToFrontend(source, context, { type: "sse-message", streamId: event.data.streamId, payload: message.data }); };
          stream.onerror = () => { if (isCurrent(source)) postToFrontend(source, context, { type: "sse-error", streamId: event.data.streamId }); };
        } catch (error) { if (isCurrent(source)) postToFrontend(source, context, { type: "sse-error", streamId: event.data.streamId, payload: error instanceof Error ? error.message : String(error) }); }
      }
      if (event.data.type === "sse-close" && typeof event.data.streamId === "string") { eventStreams.get(event.data.streamId)?.close(); eventStreams.delete(event.data.streamId); }
      if (event.data.type === "navigate" && typeof event.data.href === "string") {
        const destination = new URL(event.data.href, window.location.href);
        if (destination.origin === window.location.origin && ["/projects", "/mode-packs", "/"].includes(destination.pathname)) window.location.assign(destination.href);
      }
    };
    addEventListener("message", receive);
    return () => { current = false; controller.abort(); for (const request of apiRequests.values()) request.abort(); for (const stream of eventStreams.values()) stream.close(); if (initializingContext.current === contextKey) initializingContext.current = null; removeEventListener("message", receive); };
  }, [context, contextKey, runtimeId, supportsSpecKit, projectCapabilities]);

  if (!context) return null;
  const workspace = presentation === "workspace";
  return <aside aria-label={workspace ? "工作模块" : "Mode Pack panel"}>
    <button type="button" onClick={() => setOpen((value) => !value)} style={{ marginRight: 8 }}>{open ? (workspace ? "关闭工作区" : "Close mode panel") : (workspace ? "打开工作区" : "Open mode panel")}</button>
    {open && <div role="dialog" aria-label={workspace ? "工作模块工作区" : "Mode Pack panel"} style={workspace
      ? { position: "fixed", zIndex: 410, inset: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }
      : { position: "fixed", zIndex: 410, right: 12, top: 52, width: "min(420px, calc(100vw - 24px))", height: "min(440px, calc(100vh - 64px))", border: "1px solid var(--border)", background: "var(--bg-panel)", boxShadow: "0 16px 40px #0008" }}>
      {workspace && <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 12px", borderBottom: "1px solid var(--border)" }}><button type="button" onClick={() => setOpen(false)}>关闭工作区</button></div>}
      <iframe key={contextKey} ref={frame} title={workspace ? "工作模块工作区" : "Mode Pack"} sandbox="allow-scripts allow-forms allow-downloads" src={modePackFrontendUrl(context)} style={{ border: 0, width: "100%", height: workspace ? undefined : "100%", flex: 1, minHeight: 0 }} />
    </div>}
    {state.message && <span role="status" aria-busy={state.pending}>{state.message}</span>}
  </aside>;
}
