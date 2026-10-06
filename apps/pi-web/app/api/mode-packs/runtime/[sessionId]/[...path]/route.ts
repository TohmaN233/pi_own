import { getLiveModePackSnapshot } from "@/lib/rpc-manager";
import { activePortableModePackageForSnapshot } from "@/lib/portable-mode-pack-registry";
import { loadPortableModeRuntime } from "@/lib/portable-mode-runtime-loader";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

async function dispatch(request: Request, method: "GET" | "POST", parameters: Promise<{ sessionId: string; path: string[] }>): Promise<Response> {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const { sessionId, path } = await parameters;
    if (!sessionId || !Array.isArray(path) || path.length === 0 || path.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"))) {
      throw new Error("Invalid portable module route");
    }
    const querySession = new URL(request.url).searchParams.get("sessionId");
    if (querySession !== sessionId) throw new Error("Portable module route session does not match the active session");
    const snapshot = getLiveModePackSnapshot(sessionId);
    if (!snapshot?.packageContentHash) throw new Error("Portable module session is not active");
    const archive = activePortableModePackageForSnapshot(snapshot);
    if (!archive?.runtimeAssets?.length) throw new Error("Active module has no packaged runtime");
    const runtimeId = archive.runtimeAssets.find((item) => item.kind === "harness")?.id;
    if (path[0] !== runtimeId) throw new Error("Portable module route belongs to another package");
    const route = path.slice(1).join("/");
    const runtime = await loadPortableModeRuntime(archive);
    const handler = runtime.routes[route]?.[method];
    if (typeof handler !== "function") return Response.json({ error: `Portable module route is unavailable: ${method} ${route}` }, { status: 404 });
    const response = await handler(request);
    if (!(response instanceof Response)) throw new Error(`Portable module route did not return a Response: ${method} ${route}`);
    return response;
  } catch (error) {
    console.error("[mode-pack] package-owned route failed", { method, error: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export function GET(request: Request, context: { params: Promise<{ sessionId: string; path: string[] }> }) {
  return dispatch(request, "GET", context.params);
}
export function POST(request: Request, context: { params: Promise<{ sessionId: string; path: string[] }> }) {
  return dispatch(request, "POST", context.params);
}
