import { isApiRequestAllowed } from "@/lib/request-security";
import { getCourseBuilderHost } from "@/lib/course-builder-service";
import { requireCourseBuilderWorkspace, readCourseBuilderJson, builderString, builderError } from "@/lib/course-builder-request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const body = await readCourseBuilderJson(request);
    const sessionId = builderString(body.sessionId), receiptId = builderString(body.receiptId);
    await requireCourseBuilderWorkspace(sessionId);
    let query: { line: number } | { page: number; x: number; y: number };
    if (body.line !== undefined) {
      if (!Number.isSafeInteger(body.line) || (body.line as number) < 1 || body.page !== undefined || body.x !== undefined || body.y !== undefined) throw new Error("定位需要有效源码行号，不能同时指定 PDF 位置。");
      query = { line: body.line as number };
    } else {
      if (!Number.isSafeInteger(body.page) || (body.page as number) < 1 || typeof body.x !== "number" || typeof body.y !== "number" || ![body.x, body.y].every(value => Number.isFinite(value) && value >= 0 && value <= 100000)) throw new Error("定位需要有效 PDF 页码和坐标。");
      query = { page: body.page as number, x: body.x, y: body.y };
    }
    const location = await getCourseBuilderHost().locateTeacherNotes(sessionId, receiptId, query);
    console.info("[course-builder] teacher notes SyncTeX", { sessionId, receiptId, query, location });
    return Response.json({ receiptId, ...location }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return builderError(error); }
}
