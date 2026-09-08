import { NextRequest } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { GET as readCourseExport } from "../course-builder/export/route";
import { GET as readWorkspaceFile } from "../files/[...path]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Preview transport must not look like a download to native download managers.
 * Reuse the existing authorized readers in-process; never fetch an arbitrary URL.
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const current = new URL(request.url);
    const file = current.searchParams.get("file");
    if (!file) return Response.json({ error: "Missing PDF source" }, { status: 400 });
    const source = new URL(file, current.origin);
    if (source.origin !== current.origin) return Response.json({ error: "Only local workspace PDFs may be previewed" }, { status: 400 });
    const headers = new Headers(request.headers); headers.delete("range");
    let response: Response;
    if (source.pathname === "/api/course-builder/export" && source.searchParams.get("kind") === "pdf") {
      response = await readCourseExport(new Request(source, { headers }));
    } else if (source.pathname.startsWith("/api/files/") && source.pathname.toLowerCase().endsWith(".pdf")) {
      source.searchParams.set("type", "read");
      const path = source.pathname.slice("/api/files/".length).split("/").map(decodeURIComponent);
      response = await readWorkspaceFile(new NextRequest(source, { headers }), { params: Promise.resolve({ path }) });
    } else return Response.json({ error: "Unsupported PDF source" }, { status: 400 });
    if (!response.ok) return Response.json({ error: `读取 PDF 失败：${(await response.text()).slice(0, 500)}` }, { status: response.status });
    if (response.headers.get("content-type") !== "application/pdf") throw new Error("PDF reader returned an unexpected content type");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("PDF source is empty");
    console.info("[pdf-preview] read content", { bytes: bytes.length, source: source.pathname.startsWith("/api/files/") ? "workspace" : "course" });
    return Response.json({ data: bytes.toString("base64"), byteLength: bytes.length }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    console.error("[pdf-preview] content failed", error);
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
