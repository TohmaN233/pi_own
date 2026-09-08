const CHANNEL = "pi-session-configuration-v1";
const EVENT = "pi-session-configuration";

/** Invalidations carry identity only. Every consumer rereads authoritative server state. */
export function notifySessionConfiguration(sessionId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: sessionId }));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(sessionId);
    channel.close();
  }
}

export function subscribeSessionConfiguration(sessionId: string, refresh: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const local = (event: Event) => { if ((event as CustomEvent<unknown>).detail === sessionId) refresh(); };
  const visible = () => { if (document.visibilityState === "visible") refresh(); };
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  if (channel) channel.onmessage = (event) => { if (event.data === sessionId) refresh(); };
  window.addEventListener(EVENT, local);
  window.addEventListener("focus", visible);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener(EVENT, local);
    window.removeEventListener("focus", visible);
    document.removeEventListener("visibilitychange", visible);
    channel?.close();
  };
}
