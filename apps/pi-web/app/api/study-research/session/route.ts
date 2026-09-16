import { readStudyRequest, studyApiError, studyText } from "@/lib/study-api-request";
import { ensureStudySessionRuntime } from "@/lib/study-session-runtime";
import { isStudyBrowserMutation } from "@/lib/study-user-action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isStudyBrowserMutation(request)) return Response.json({ error: "Untrusted browser mutation" }, { status: 403 });
  try {
    const body = await readStudyRequest(request);
    return Response.json(await ensureStudySessionRuntime(studyText(body.sessionId, "sessionId")));
  } catch (error) { return studyApiError(error); }
}
