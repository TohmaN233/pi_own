import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import { cancelStudyExecution, reconnectStudyExecutions, runStudyCodeCell, studyExecutionState } from "@/lib/study-execution-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    return Response.json(await studyExecutionState(studyText(new URL(request.url).searchParams.get("sessionId"), "sessionId")), { headers: { "cache-control": "no-store" } });
  } catch (error) { return studyApiError(error); }
}

/** User actions only. Model tools receive their own scoped admission service, never this action map. */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const body = await readStudyRequest(request);
    const sessionId = studyText(body.sessionId, "sessionId");
    if (body.action === "reconnect") return Response.json(await reconnectStudyExecutions(sessionId));
    const expectedPhaseRevision = studyInteger(body.expectedPhaseRevision, "expectedPhaseRevision", 1);
    if (body.action === "cancel") return Response.json(await cancelStudyExecution({ sessionId, expectedPhaseRevision, queueJobId: studyText(body.queueJobId, "queueJobId") }));
    if (body.action !== "run") throw new Error("Unknown execution action");
    if (!body.resources || typeof body.resources !== "object" || Array.isArray(body.resources)) throw new Error("Execution resources must be an object");
    const resources = body.resources as Record<string, unknown>;
    if (!Array.isArray(body.rPackages)) throw new Error("R package selection must be an array");
    return Response.json(await runStudyCodeCell({ sessionId, expectedPhaseRevision,
      cellId: studyText(body.cellId, "cellId"), expectedCellRevision: studyInteger(body.expectedCellRevision, "expectedCellRevision", 1),
      requestId: studyText(body.requestId, "requestId", 80), rPackages: body.rPackages.map((name) => studyText(name, "R package", 128)),
      resources: { cpuMilliCores: studyInteger(resources.cpuMilliCores, "cpuMilliCores", 1), memoryMiB: studyInteger(resources.memoryMiB, "memoryMiB", 1),
        wallTimeMs: studyInteger(resources.wallTimeMs, "wallTimeMs", 1), diskBytes: studyInteger(resources.diskBytes, "diskBytes", 1) } }));
  } catch (error) { return studyApiError(error); }
}
