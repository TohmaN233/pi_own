import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { installLocalSkills } from "@/lib/local-skill-install";

export const dynamic = "force-dynamic";

// The server owns the destination: the configured pi_own/skills library.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { package?: unknown };
    if (typeof body.package !== "string" || !body.package.trim()) return NextResponse.json({ error: "package required" }, { status: 400 });
    return NextResponse.json(await installLocalSkills(body.package));
  } catch (error) {
    console.error("[skills/install] request failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}