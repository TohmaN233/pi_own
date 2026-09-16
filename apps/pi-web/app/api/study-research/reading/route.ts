import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import { cancelStudyReading, prioritizeStudyReading, reconnectStudyReading, retryStudyReading, startStudyReading, studyReadingState } from "@/lib/study-reading-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const sessionId = studyText(new URL(request.url).searchParams.get("sessionId"), "sessionId");
    return Response.json(await studyReadingState(sessionId), { headers: { "cache-control": "no-store" } });
  } catch (error) { return studyApiError(error); }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const input = await readStudyRequest(request);
    const sessionId = studyText(input.sessionId, "sessionId");
    if (input.action === "start") return Response.json(await startStudyReading({ sessionId,
      expectedPhaseRevision: studyInteger(input.expectedPhaseRevision, "expectedPhaseRevision", 1),
      sourceId: studyText(input.sourceId, "sourceId"), sourceHash: studyText(input.sourceHash, "sourceHash") }));
    if (input.action === "cancel") return Response.json(await cancelStudyReading(sessionId, studyText(input.taskId, "taskId")));
    if (input.action === "priority") return Response.json(await prioritizeStudyReading(sessionId,
      studyInteger(input.expectedPhaseRevision, "expectedPhaseRevision", 1), studyText(input.taskId, "taskId"),
      studyInteger(input.expectedPriority, "expectedPriority", -100, 100), studyInteger(input.priority, "priority", -100, 100)));
    if (input.action === "retry") return Response.json(await retryStudyReading(sessionId, studyText(input.taskId, "taskId"), studyText(input.requestId, "requestId")));
    if (input.action === "reconnect") return Response.json(await reconnectStudyReading(sessionId));
    throw new Error("Unknown background reading action");
  } catch (error) { return studyApiError(error); }
}
