import { isApiRequestAllowed } from "@/lib/request-security";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { getCourseBuilderHost } from "@/lib/course-builder-service";
import { saveChatAttachment } from "@/lib/chat-attachments";
import { resolve } from "node:path";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing attachment body");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 26 * 1024 * 1024) { await reader.cancel(); throw new Error("附件请求超过 26 MiB。"); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    const cwd = form.get("cwd"), rawSession = form.get("sessionId");
    if (typeof cwd !== "string" || !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Select an allowed project directory before attaching files");
    const sessionId = typeof rawSession === "string" && rawSession ? rawSession : null;
    if (sessionId) {
      const path = await resolveSessionPath(sessionId), header = path ? readSessionHeader(path) : null;
      if (!header || resolve(header.cwd) !== resolve(cwd)) throw new Error("Attachment conversation/directory mismatch");
    }
    const host = getCourseBuilderHost();
    const assignmentId = sessionId && host.getProjectForSession(sessionId) ? host.getAgentAssignmentScope(sessionId) : null;
    const files = form.getAll("files");
    if (!files.length || files.length > 10 || files.some((file) => !(file instanceof File)) || files.reduce((size, file) => size + (file as File).size, 0) > 25 * 1024 * 1024) throw new Error("每次可附加 1–10 个文件，总大小不超过 25 MiB。");
    const attachments = [];
    for (const file of files) attachments.push(await saveChatAttachment(cwd, file as File, { sessionId, assignmentId }));
    console.info("[chat-attachments] saved", { sessionId, assignmentId, ids: attachments.map((item) => item.id) });
    return Response.json({ attachments });
  } catch (error) {
    console.error("[chat-attachments] upload failed", error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
