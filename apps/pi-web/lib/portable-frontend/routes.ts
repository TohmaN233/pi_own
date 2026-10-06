/** Package-owned browser navigation must use the same session-bound route as
 * fetch. It is used for downloads and PDF URLs, which bypass the fetch bridge. */
export function portableFrontendApiUrl(input: string): string {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId");
  const runtimeId = params.get("runtimeId");
  if (!sessionId || !runtimeId || !/^[a-z][a-z0-9-]*$/u.test(runtimeId)) return input;
  const url = new URL(input, window.location.href);
  if (url.origin !== new URL(window.location.href).origin) return input;
  const prefix = `/api/${runtimeId}`;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return input;
  url.pathname = `/api/mode-packs/runtime/${encodeURIComponent(sessionId)}/${encodeURIComponent(runtimeId)}${url.pathname.slice(prefix.length)}`;
  url.searchParams.set("sessionId", sessionId);
  return `${url.pathname}${url.search}${url.hash}`;
}
