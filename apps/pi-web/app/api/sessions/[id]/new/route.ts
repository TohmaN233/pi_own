import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveSessionPath } from "@/lib/session-reader";
import { createPersistedGenericSession, getRpcSession } from "@/lib/rpc-manager";

/** A fresh ordinary conversation shares only the working directory, never a mode or course binding. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const { id } = await params;
    const live = getRpcSession(id);
    const file = live?.sessionFile || await resolveSessionPath(id);
    if (!live && !file) return Response.json({ error: "Session not found" }, { status: 404 });
    const cwd = live?.cwd ?? SessionManager.open(file!).getCwd();
    const sessionId = createPersistedGenericSession(cwd, "");
    console.info("[pi-web] created ordinary conversation", { sessionId, sourceSessionId: id, cwd });
    return Response.json({ sessionId });
  } catch (error) {
    console.error("[pi-web] failed to create ordinary conversation", error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
