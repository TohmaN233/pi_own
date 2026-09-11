import { isApiRequestAllowed } from "@/lib/request-security";
import { readCourseBuilderJson } from "@/lib/course-builder-request";
import { mathVisualizationContext, mathVisualizationHost, MATH_VISUAL_SCHEMA } from "@/lib/math-visualization-service";
import { identifier } from "../../../../../packages/study-research-host/src/index.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const url = new URL(request.url); const { scope } = await mathVisualizationContext(identifier(url.searchParams.get("sessionId")));
    const id = url.searchParams.get("id");
    return Response.json(id ? { artifact: mathVisualizationHost().get(scope, identifier(id)) } : { scope, artifacts: mathVisualizationHost().list(scope), schema: MATH_VISUAL_SCHEMA }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request) || request.headers.get("x-math-user") !== "1") return Response.json({ error: "Explicit local user action required" }, { status: 403 });
  try {
    const body = await readCourseBuilderJson(request); const { scope } = await mathVisualizationContext(identifier(body.sessionId));
    return Response.json({ artifact: mathVisualizationHost().create(scope, body.spec) });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
