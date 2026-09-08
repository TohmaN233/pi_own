import { isApiRequestAllowed } from "@/lib/request-security";
import { createProjectConversation, createProjectFolder, moveProjectConversation, projectWorkspaceList, saveProjectDefaults } from "@/lib/project-workspaces-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be nonempty text (up to ${max} characters)`);
  return value.trim();
}
function failure(error: unknown) {
  console.error("[projects] request failed", error);
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message }, { status: /conflict|changed before/i.test(message) ? 409 : 400 });
}
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try { return Response.json(await projectWorkspaceList(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object");
    switch (body.action) {
      case "create": return Response.json(await createProjectFolder({ id: `project_${text(body.requestId, "requestId", 128)}`, title: text(body.title, "title", 200), cwd: text(body.cwd, "cwd", 4096), ...(body.sourceSessionId ? { sourceSessionId: text(body.sourceSessionId, "sourceSessionId") } : {}) }));
      case "new_conversation": return Response.json(await createProjectConversation({ projectId: text(body.projectId, "projectId"), title: text(body.title, "title", 200), requestId: text(body.requestId, "requestId", 128) }));
      case "save_defaults": {
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("Expected project revision is required");
        return Response.json(await saveProjectDefaults(text(body.projectId, "projectId"), text(body.sessionId, "sessionId"), body.expectedRevision));
      }
      case "move": await moveProjectConversation(text(body.sessionId, "sessionId"), body.projectId === null ? null : text(body.projectId, "projectId")); return Response.json({ success: true });
      default: throw new Error("Unknown project action");
    }
  } catch (error) { return failure(error); }
}
