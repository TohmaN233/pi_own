/** The opaque package frame can request only its own packaged API and a small
 * set of host session services. The parent owns the origin and credentials. */
export function modePackFrontendApiTarget(options: {
  url: string;
  method: string;
  sessionId: string;
  runtimeId: string | null;
  projectCapabilities?: readonly string[];
}): string {
  const { url, method, sessionId, runtimeId, projectCapabilities = [] } = options;
  if (!url.startsWith("/api/") || url.startsWith("//") || /[\\\r\n]/u.test(url)) throw new Error("Portable API request must use a local API path");
  const parsed = new URL(url, "http://pi-own.invalid");
  if (parsed.origin !== "http://pi-own.invalid") throw new Error("Portable API request changed origin");
  if (parsed.searchParams.has("sessionId") && parsed.searchParams.get("sessionId") !== sessionId) throw new Error("Portable API request targets another session");
  if (method === "GET" && parsed.pathname === "/api/pdf-content" && projectCapabilities.includes("host-api:pdf-preview@1")) {
    const file = parsed.searchParams.get("file");
    if (!file || !runtimeId) throw new Error("Portable PDF request has no active source");
    const source = new URL(file, "http://pi-own.invalid");
    if (source.origin !== "http://pi-own.invalid" || !source.pathname.startsWith(`/api/${runtimeId}/`)) throw new Error("Portable PDF source is outside the active package");
    const routed = modePackFrontendApiTarget({ url: `${source.pathname}${source.search}`, method: "GET", sessionId, runtimeId, projectCapabilities });
    return `/api/pdf-content?file=${encodeURIComponent(routed)}`;
  }
  if (runtimeId && (parsed.pathname === `/api/${runtimeId}` || parsed.pathname.startsWith(`/api/${runtimeId}/`))) {
    const suffix = parsed.pathname.slice(`/api/${runtimeId}`.length);
    parsed.searchParams.set("sessionId", sessionId);
    return `/api/mode-packs/runtime/${encodeURIComponent(sessionId)}/${encodeURIComponent(runtimeId)}${suffix}?${parsed.searchParams}`;
  }
  const sessionAgent = `/api/agent/${encodeURIComponent(sessionId)}`;
  const sessionInfo = `/api/sessions/${encodeURIComponent(sessionId)}`;
  if (parsed.pathname === sessionAgent || parsed.pathname.startsWith(`${sessionAgent}/`)
    || parsed.pathname === sessionInfo || parsed.pathname.startsWith(`${sessionInfo}/`)) {
    return `${parsed.pathname}${parsed.search}`;
  }
  if (method === "GET" && [
    "/api/models", "/api/app-update", "/api/projects", "/api/mode-packs/status",
  ].some((prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))) {
    if (parsed.pathname === "/api/mode-packs/status") parsed.searchParams.set("sessionId", sessionId);
    return `${parsed.pathname}${parsed.search}`;
  }
  if (method === "GET" && parsed.pathname === "/api/cwd/browse" && projectCapabilities.includes("host-api:cwd-browse@1")) {
    return `${parsed.pathname}${parsed.search}`;
  }
  throw new Error(`Portable API capability is not granted: ${method} ${parsed.pathname}`);
}
