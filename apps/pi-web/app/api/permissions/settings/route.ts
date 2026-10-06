import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPermissionSettings, writePermissionSettings } from "@/lib/permission-settings";
import type { PermissionScope } from "@/lib/permission-policy";

export const dynamic = "force-dynamic";
function scopeOf(value: unknown): PermissionScope {
  if (value !== "global" && value !== "project") throw new Error("scope must be global or project");
  return value;
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[pi-web] permission settings failed", { error: message });
  return NextResponse.json({ error: message }, { status: /changed; reload/.test(message) ? 409 : 400 });
}
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const query = new URL(req.url).searchParams;
    return NextResponse.json(await readPermissionSettings(scopeOf(query.get("scope") ?? "global"), query.get("sessionId") ?? undefined));
  } catch (error) { return failure(error); }
}
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.source !== "string" || typeof body.expectedContentHash !== "string" || (body.sessionId !== undefined && typeof body.sessionId !== "string")) throw new Error("Invalid permission settings request");
    return NextResponse.json(await writePermissionSettings(scopeOf(body.scope), body.sessionId, body.source, body.expectedContentHash));
  } catch (error) { return failure(error); }
}
