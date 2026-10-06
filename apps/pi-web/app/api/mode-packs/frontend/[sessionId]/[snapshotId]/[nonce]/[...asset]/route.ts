import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getLiveModePackSnapshot } from "@/lib/rpc-manager";
import { activePortableModePackageForSnapshot, portableModePackageDirectory } from "@/lib/portable-mode-pack-registry";

export const dynamic = "force-dynamic";
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".ico", "image/x-icon"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
  [".wasm", "application/wasm"],
]);
function contentType(path: string): string { return [...contentTypes].find(([suffix]) => path.toLocaleLowerCase("en-US").endsWith(suffix))?.[1] ?? "application/octet-stream"; }

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string; snapshotId: string; nonce: string; asset: string[] }> }) {
  try {
    const { sessionId, snapshotId, nonce, asset } = await params;
    if (!sessionId || !snapshotId || !nonce || asset.length === 0 || asset.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"))) throw new Error("Invalid mode frontend path");
    const snapshot = getLiveModePackSnapshot(sessionId);
    if (!snapshot || snapshot.resourceSnapshotId !== snapshotId || !snapshot.packageContentHash) throw new Error("Mode frontend snapshot is stale");
    const archive = activePortableModePackageForSnapshot(snapshot);
    if (!archive?.frontend) throw new Error("The active Mode Pack has no frontend");
    const path = asset.join("/"); const descriptor = archive.frontend.assets.find((item) => item.path === path); const file = archive.files.find((item) => item.path === path);
    if (!descriptor || !file || descriptor.contentHash !== file.contentHash || descriptor.bytes !== file.bytes) throw new Error("Unknown mode frontend asset");
    const headers: Record<string, string> = { "Content-Type": contentType(path), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "null", "Vary": "Origin" };
    if (descriptor.contentEncoding) headers["Content-Encoding"] = descriptor.contentEncoding;
    // The iframe sandbox is not present when a portable entry URL is opened
    // directly. Mirror its origin isolation at the response boundary while
    // still permitting the entry's original script/module graph to execute.
    // The iframe sandbox is necessary but not sufficient: a directly opened
    // portable SVG/HTML asset would otherwise run with the host origin. Apply
    // response sandboxing to every immutable frontend asset; it is inert for
    // script/style/image fetches and preserves the opaque document origin.
    headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-downloads";
    const bytes = typeof file.base64 === "string" ? Buffer.from(file.base64, "base64") : readFileSync(join(portableModePackageDirectory(archive.packageContentHash), file.path));
    if (bytes.byteLength !== file.bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.contentHash) throw new Error(`Mode frontend asset is tampered: ${path}`);
    return new NextResponse(bytes, { headers });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
