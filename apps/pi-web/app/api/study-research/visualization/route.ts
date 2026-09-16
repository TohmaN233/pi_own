import { isStudyBrowserMutation } from "@/lib/study-user-action";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import { saveStudyVisualization } from "@/lib/study-visual-editor-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isStudyBrowserMutation(request)) return Response.json({ error: "需要同一页面的保存操作。" }, { status: 403 });
  try {
    const value = await readStudyRequest(request);
    if (!value.inputs || typeof value.inputs !== "object" || Array.isArray(value.inputs)) throw new Error("参数必须是 JSON 对象。");
    const visualization = await saveStudyVisualization({
      sessionId: studyText(value.sessionId, "sessionId"), expectedPhaseRevision: studyInteger(value.expectedPhaseRevision, "expectedPhaseRevision", 1),
      expectedProjectRevision: studyInteger(value.expectedProjectRevision, "expectedProjectRevision"),
      visualizationId: value.visualizationId === undefined ? undefined : studyText(value.visualizationId, "visualizationId"),
      expectedVisualizationRevision: value.expectedVisualizationRevision === undefined ? undefined : studyInteger(value.expectedVisualizationRevision, "expectedVisualizationRevision", 1),
      purpose: studyText(value.purpose, "purpose", 20000), code: studyText(value.code, "code", 131072), inputs: value.inputs as Record<string, unknown>,
    });
    return Response.json({ visualization });
  } catch (error) { return studyApiError(error); }
}
