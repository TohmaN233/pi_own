import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import { searchExternalStudyReferences } from "@/lib/study-external-references";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!isStudyBrowserMutation(request)) return Response.json({error:"Untrusted browser mutation"},{status:403});
  try { const input = await readStudyRequest(request);
    return Response.json(await searchExternalStudyReferences({sessionId:studyText(input.sessionId,"sessionId"),
      expectedPhaseRevision:studyInteger(input.expectedPhaseRevision,"expectedPhaseRevision",1),query:studyText(input.query,"query",160)},request.signal));
  } catch(error) { return studyApiError(error); }
}
