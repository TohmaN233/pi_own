import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
// Both npm scripts and bin/pi-web.js run Next from this host package directory.
// These are deployed data files, not JS imports for webpack to rewrite.
const root = join(process.cwd(), "node_modules", "pdfjs-dist");
const allowed = /^(?:build\/pdf(?:\.worker)?\.min\.mjs|cmaps\/[\w.-]+\.bcmap|standard_fonts\/[\w.-]+\.(?:pfb|ttf)|wasm\/[\w.-]+\.(?:wasm|js)|iccs\/[\w.-]+\.icc)$/;

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (!isApiRequestAllowed(request)) return new Response("Untrusted request", { status: 403 });
  const path = (await context.params).path.join("/");
  if (!allowed.test(path)) return new Response("Unknown PDF renderer asset", { status: 404 });
  try {
    const bytes = await readFile(join(root, path));
    const type = /\.(mjs|js)$/.test(path) ? "text/javascript" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" } });
  } catch (error) {
    console.error("[pdf-preview] renderer asset failed", { path, error });
    return new Response("PDF renderer asset unavailable", { status: 500 });
  }
}
