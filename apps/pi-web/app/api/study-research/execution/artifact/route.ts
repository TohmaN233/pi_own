import { isApiRequestAllowed } from "@/lib/request-security";
import { studyApiError, studyText } from "@/lib/study-api-request";
import { readStudyExecutionArtifact, studyExecutionArtifacts } from "@/lib/study-execution-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const query = new URL(request.url).searchParams;
    const sessionId = studyText(query.get("sessionId"), "sessionId");
    const queueJobId = studyText(query.get("queueJobId"), "queueJobId");
    const mode = query.get("mode") ?? "list";
    if (mode === "list") return Response.json({ artifacts: await studyExecutionArtifacts(sessionId, queueJobId) }, { headers: { "cache-control": "no-store" } });
    if (mode !== "preview" && mode !== "download") throw new Error("Unknown output read mode");
    const artifact = await readStudyExecutionArtifact({ sessionId, queueJobId, path: studyText(query.get("path"), "artifact path", 4096), sha256: studyText(query.get("sha256"), "artifact hash") });
    if (mode === "preview") {
      if (!["image/png", "image/jpeg", "application/pdf"].includes(artifact.descriptor.mediaType)) throw new Error("This artifact is available as a download");
      return Response.json({ ...artifact.descriptor, base64: Buffer.from(artifact.bytes).toString("base64") }, { headers: { "cache-control": "no-store" } });
    }
    const filename = artifact.descriptor.path.split(/[\\/]/u).at(-1) ?? "output.bin";
    return new Response(new Uint8Array(artifact.bytes), { headers: { "content-type": "application/octet-stream", "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/gu, "%27")}`, "cache-control": "no-store" } });
  } catch (error) { return studyApiError(error); }
}
