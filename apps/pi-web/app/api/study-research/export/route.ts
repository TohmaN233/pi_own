import { isApiRequestAllowed } from "@/lib/request-security";
import { studyApiError, studyText } from "@/lib/study-api-request";
import { studyWorkspaceState } from "@/lib/study-research-service";
import { exportStudyGraph, exportStudyNotes } from "@/lib/study-export";
import { exportStudyProject } from "@/lib/study-project-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const query = new URL(request.url).searchParams;
    const sessionId = studyText(query.get("sessionId"), "sessionId");
    const format = query.get("format");
    if (format === "project") {
      const archive = await exportStudyProject(sessionId, query.has("queueJobId") ? studyText(query.get("queueJobId"), "queueJobId") : undefined);
      return new Response(new Uint8Array(archive), {headers:{"content-type":"application/zip", "content-disposition":"attachment; filename=study-project.zip", "cache-control":"no-store", "x-content-type-options":"nosniff"}});
    }
    const state = await studyWorkspaceState(sessionId);
    if (format !== "markdown" && format !== "graph") throw new Error("Choose markdown or graph export");
    const body = format === "markdown" ? exportStudyNotes(state) : `${JSON.stringify(exportStudyGraph(state), null, 2)}\n`;
    return new Response(body, { headers: {
      "content-type": format === "markdown" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${format === "markdown" ? "study-notes.md" : "study-graph.json"}"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
    } });
  } catch (error) { return studyApiError(error); }
}
