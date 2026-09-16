import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import { startStudyIndependentReview, studyIndependentReviewState } from "@/lib/study-review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try { return Response.json(await studyIndependentReviewState(studyText(new URL(request.url).searchParams.get("sessionId"), "sessionId")), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return studyApiError(error); }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const input = await readStudyRequest(request);
    if (input.targetKind !== "visualization" && input.targetKind !== "result") throw new Error("Invalid review target kind");
    if (!Array.isArray(input.sources)) throw new Error("Review sources are required");
    const sources = input.sources.map((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source selection");
      const source = value as Record<string, unknown>;
      return { sourceId: studyText(source.sourceId, "sourceId"), sourceHash: studyText(source.sourceHash, "sourceHash"),
        chunkId: studyText(source.chunkId, "chunkId"), offset: studyInteger(source.offset, "offset") };
    });
    return Response.json(await startStudyIndependentReview({ sessionId: studyText(input.sessionId, "sessionId"),
      expectedPhaseRevision: studyInteger(input.expectedPhaseRevision, "expectedPhaseRevision", 1),
      target: { targetKind: input.targetKind, targetId: studyText(input.targetId, "targetId"), targetHash: studyText(input.targetHash, "targetHash"),
        targetRevision: studyInteger(input.targetRevision, "targetRevision", 1) }, scope: studyText(input.scope, "review scope", 6000),
      sources, requestId: studyText(input.requestId, "requestId"),
      model: input.provider !== undefined || input.modelId !== undefined ? { provider: studyText(input.provider, "provider"), modelId: studyText(input.modelId, "modelId") } : undefined }));
  } catch (error) { return studyApiError(error); }
}
