import { portableFrontendApiUrl } from "./routes";

const CHANNEL = "pi-own-mode-pack";
const parameters = new URLSearchParams(window.location.search);
const context = {
  sessionId: parameters.get("sessionId") ?? "",
  snapshotId: parameters.get("snapshotId") ?? "",
  nonce: parameters.get("nonce") ?? "",
  parentOrigin: parameters.get("parentOrigin") ?? "",
};
if (!context.sessionId || !context.snapshotId || !context.nonce || !context.parentOrigin) {
  throw new Error("Portable frontend has no active host binding");
}

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const requests = new Map<string, PendingRequest>();
const streams = new Map<string, PortableEventSource>();
const nativeFetch = window.fetch.bind(window);
let initializeStorage: ((value: { local: [string, string][]; session: [string, string][] }) => void) | null = null;
let rejectStorage: ((error: Error) => void) | null = null;

function storage(kind: "local" | "session", entries: [string, string][]): Storage {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    clear() { values.clear(); post({ type: "storage-change", kind, operation: "clear" }); },
    getItem(key: string) { return values.get(String(key)) ?? null; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    removeItem(key: string) { values.delete(String(key)); post({ type: "storage-change", kind, operation: "remove", key: String(key) }); },
    setItem(key: string, value: string) { values.set(String(key), String(value)); post({ type: "storage-change", kind, operation: "set", key: String(key), value: String(value) }); },
  };
}

function post(value: Record<string, unknown>, transfer: Transferable[] = []): void {
  window.parent.postMessage({ channel: CHANNEL, sessionId: context.sessionId, snapshotId: context.snapshotId, nonce: context.nonce, ...value }, context.parentOrigin, transfer);
}

function sameBinding(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.channel === CHANNEL && data.sessionId === context.sessionId && data.snapshotId === context.snapshotId && data.nonce === context.nonce;
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== context.parentOrigin || !sameBinding(event.data)) return;
  const data = event.data;
  if (data.type === "storage-init") {
    if (!Array.isArray(data.local) || !Array.isArray(data.session)
      || ![...data.local, ...data.session].every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"))) {
      rejectStorage?.(new Error("Portable storage initialization is invalid")); return;
    }
    initializeStorage?.({ local: data.local as [string, string][], session: data.session as [string, string][] });
    return;
  }
  if (data.type === "storage-error") { rejectStorage?.(new Error(typeof data.error === "string" ? data.error : "Portable storage is unavailable")); return; }
  if (data.type === "download-error") {
    const message = document.getElementById("portable-download-error") ?? document.createElement("p");
    message.id = "portable-download-error";
    message.setAttribute("role", "alert");
    message.textContent = typeof data.error === "string" ? data.error : "Portable download failed";
    document.body.prepend(message);
    return;
  }
  if (data.type === "api-response" && typeof data.requestId === "string") {
    const pending = requests.get(data.requestId);
    if (!pending) return;
    requests.delete(data.requestId);
    clearTimeout(pending.timer);
    if (typeof data.error === "string") { pending.reject(new Error(data.error)); return; }
    if (typeof data.status !== "number" || !Array.isArray(data.headers) || !(data.body instanceof ArrayBuffer)) {
      pending.reject(new Error("Portable API bridge returned an invalid response")); return;
    }
    try { pending.resolve(new Response(data.status === 204 || data.status === 205 || data.status === 304 ? null : data.body, { status: data.status, statusText: typeof data.statusText === "string" ? data.statusText : "", headers: data.headers as [string, string][] })); }
    catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
  }
  if ((data.type === "sse-message" || data.type === "sse-error") && typeof data.streamId === "string") {
    streams.get(data.streamId)?.receive(data.type, typeof data.payload === "string" ? data.payload : "");
  }
});

/** An opaque iframe has no ambient authority over the Pi host. Every local
 * API call is bound to its selected package/snapshot and delegated through the
 * parent, which owns the user's origin and checks the destination. */
export async function installPortableFrontendBridge(): Promise<void> {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    const original = target.getAttribute("href");
    if (!original || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const routed = portableFrontendApiUrl(original);
    if (routed === original) return;
    // The opaque frame cannot navigate directly to a protected package route.
    // Ask the verified parent to fetch and download on its own origin.
    event.preventDefault();
    post({ type: "download-request", url: original, filename: target.download || null });
  }, { capture: true });
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== context.parentOrigin || !url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
    const requestId = crypto.randomUUID();
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        const pending = requests.get(requestId);
        if (!pending) return;
        requests.delete(requestId);
        clearTimeout(pending.timer);
        post({ type: "api-abort", requestId });
        reject(request.signal.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        requests.delete(requestId);
        post({ type: "api-abort", requestId });
        reject(new Error(`Portable API request timed out: ${url.pathname}`));
      }, 120_000);
      requests.set(requestId, { resolve: (response) => { request.signal.removeEventListener("abort", abort); resolve(response); }, reject: (error) => { request.signal.removeEventListener("abort", abort); reject(error); }, timer });
      request.signal.addEventListener("abort", abort, { once: true });
      post({ type: "api-request", requestId, url: `${url.pathname}${url.search}`, method: request.method, headers: [...request.headers], body }, body ? [body] : []);
    });
  };
  window.EventSource = PortableEventSource as unknown as typeof EventSource;
  const initial = new Promise<{ local: [string, string][]; session: [string, string][] }>((resolve, reject) => {
    initializeStorage = resolve;
    rejectStorage = reject;
  });
  post({ type: "ready" });
  const timeout = setTimeout(() => rejectStorage?.(new Error("Portable storage initialization timed out")), 10_000);
  try {
    const value = await initial;
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage("local", value.local) });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage("session", value.session) });
  } finally {
    clearTimeout(timeout);
    initializeStorage = null;
    rejectStorage = null;
  }
}

class PortableEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly id = crypto.randomUUID();

  constructor(url: string | URL) {
    const resolved = new URL(String(url), window.location.href);
    if (resolved.origin !== context.parentOrigin || !resolved.pathname.startsWith(`/api/agent/${encodeURIComponent(context.sessionId)}/events`)) {
      throw new Error(`Portable event stream is outside the active session: ${resolved.pathname}`);
    }
    this.url = resolved.href;
    streams.set(this.id, this);
    post({ type: "sse-open", streamId: this.id, url: `${resolved.pathname}${resolved.search}` });
  }

  receive(type: string, payload: string): void {
    if (this.readyState === 2) return;
    if (type === "sse-message") {
      this.readyState = 1;
      this.onmessage?.(new MessageEvent("message", { data: payload }));
    } else {
      this.readyState = 0;
      this.onerror?.(new Event("error"));
    }
  }

  close(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
    streams.delete(this.id);
    post({ type: "sse-close", streamId: this.id });
  }
}

export function navigatePortableHost(href: string): void {
  post({ type: "navigate", href });
}
