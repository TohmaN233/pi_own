import { isApiRequestAllowed } from "@/lib/request-security";
import { studyApiError, studyText } from "@/lib/study-api-request";
import { readRegisteredStudyPdf } from "@/lib/study-source-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const query = new URL(request.url).searchParams;
    const bytes = await readRegisteredStudyPdf(studyText(query.get("sessionId"), "sessionId"), studyText(query.get("sourceId"), "sourceId"), studyText(query.get("sourceHash"), "sourceHash"));
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/pdf", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return studyApiError(error); }
}
