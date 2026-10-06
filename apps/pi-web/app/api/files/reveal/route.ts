import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "Expected JSON" }, { status: 415 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.filePath !== "string" || !isAbsolute(body.filePath) || /[\x00-\x1f]/.test(body.filePath)) {
    return Response.json({ error: "Expected an absolute file path" }, { status: 400 });
  }
  const filePath = resolve(body.filePath);
  try {
    const roots = await getAllowedFileRoots();
    const allowedByRoot = isFilePathAllowed(filePath, roots);
    const allowedByReference = !allowedByRoot && await isFilePathReferencedBySession(filePath, typeof body.sessionId === "string" ? body.sessionId : null);
    if (!allowedByRoot && !allowedByReference) return Response.json({ error: "Access denied" }, { status: 403 });
    let stat;
    try { stat = statSync(filePath); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return Response.json({ error: "File not found" }, { status: 404 });
      throw cause;
    }
    if (!allowedByReference && !isExistingFilePathAllowed(filePath, roots)) return Response.json({ error: "Access denied" }, { status: 403 });
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? [stat.isDirectory() ? filePath : `/select,${filePath}`]
      : process.platform === "darwin" ? ["-R", filePath] : [stat.isDirectory() ? filePath : dirname(filePath)];
    await new Promise<void>((accept, reject) => {
      const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); accept(); });
      child.once("exit", code => {
        // Explorer delegates to the desktop process and may exit with 1 after success.
        if (code !== 0 && !(process.platform === "win32" && code === 1)) console.error("[files] file-manager exit", { filePath, command, code });
      });
    });
    console.info("[files] reveal requested", { filePath, command });
    return Response.json({ requested: true });
  } catch (cause) {
    console.error("[files] reveal failed", { filePath, cause });
    return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 });
  }
}
