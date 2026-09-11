import { isApiRequestAllowed } from "@/lib/request-security";
import { readCourseBuilderJson } from "@/lib/course-builder-request";
import { activateStudyRuntime, createStudyWorkspace, getStudyHost, readStudySource, reindexStudy, requireStudyRuntime, requireStudyWorkspace, runApprovedStudyExperiment, studyWorkspaceList, verifyStudySources } from "@/lib/study-research-service";
import { identifier, integer, text } from "../../../../../packages/study-research-host/src/index.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[study-research] request failed", message);
  return Response.json({ error: message }, { status: /revision|stale|changed|busy/i.test(message) ? 409 : 400 });
}
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const sid = new URL(request.url).searchParams.get("sessionId");
    if (sid) { await requireStudyWorkspace(sid); return Response.json({ state: getStudyHost().state(sid), codeEnabled: process.env.PI_STUDY_TRUSTED_CODE === "1" }, { headers: { "Cache-Control": "no-store" } }); }
    return Response.json(await studyWorkspaceList(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request) || request.headers.get("x-study-user") !== "1") return Response.json({ error: "Explicit local user workspace action required" }, { status: 403 });
  try {
    const body = await readCourseBuilderJson(request); const action = text(body.action, "action", 80);
    if (action === "create") return Response.json(await createStudyWorkspace(identifier(body.requestId), text(body.title, "title", 300), text(body.directory, "directory", 4096)));
    const sid = identifier(body.sessionId, "sessionId");
    await requireStudyWorkspace(sid, !["read_source", "activate"].includes(action));
    const host = getStudyHost();
    if (action === "activate") return Response.json(await activateStudyRuntime(sid));
    if (action === "reindex") return Response.json(await reindexStudy(sid, integer(body.expectedRevision, "expectedRevision", 1)));
    if (action === "read_source") return Response.json(await readStudySource(sid, identifier(body.id), body.startLine === undefined ? 1 : integer(body.startLine, "startLine", 1), 80));
    if (action === "save_note") return Response.json(host.saveNote(sid, "user", body.id ? identifier(body.id) : null, integer(body.expectedRevision, "expectedRevision"), body.draft));
    if (action === "progress") return Response.json(host.recordProgress(sid, identifier(body.nodeId), integer(body.roadmapRevision, "roadmapRevision", 1), body.stage, body.attempt));
    if (action === "save_experiment") return Response.json(host.saveExperiment(sid, body.id ? identifier(body.id) : null, integer(body.expectedRevision, "expectedRevision"), body.draft));
    if (action === "approve_experiment") {
      if (body.confirmed !== true) throw new Error("Read the exact plan and code before approving");
      await verifyStudySources(sid);
      await requireStudyWorkspace(sid, true);
      host.approveExperiment(sid, identifier(body.id), integer(body.expectedRevision, "expectedRevision", 1));
      return Response.json({ approved: true });
    }
    if (action === "run") {
      if (body.confirmed !== true) throw new Error("An explicit human run confirmation is required");
      return Response.json(await runApprovedStudyExperiment(sid, identifier(body.id), integer(body.expectedRevision, "expectedRevision", 1), request.signal));
    }
    if (action === "prompt") {
      const { wrapper } = await requireStudyRuntime(sid, true);
      const message = text(body.message, "message", 20000);
      return Response.json({ queued: true, result: await wrapper.send({ type: "prompt", message }) });
    }
    throw new Error("Unknown user action");
  } catch (error) { return failure(error); }
}
