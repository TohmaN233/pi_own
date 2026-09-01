import { NextResponse } from "next/server";
import { getGenericModePackStatus } from "@/lib/rpc-manager";
import { ModePackStore, definitionToDraft } from "@/lib/mode-pack-store";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return value as number;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const sessionId = requiredString(params.get("sessionId"), "sessionId");
    const status = await getGenericModePackStatus(sessionId);
    return NextResponse.json({
      sessionId,
      cwd: status.runtime.cwd,
      packs: status.packs.map((item) => ({
        definition: item.definition,
        draft: definitionToDraft(item.definition),
        builtin: item.builtin,
        selectable: item.selectable,
        missingRequiredResources: item.missingRequiredResources,
        missingOptionalResources: item.missingOptionalResources,
        identityMismatches: item.identityMismatches,
      })),
      resources: status.resources,
      diagnostics: status.diagnostics,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
    const body = raw as Record<string, unknown>;
    const sessionId = requiredString(body.sessionId, "sessionId");
    const expectedRevision = nonNegativeInteger(body.expectedRevision, "expectedRevision");
    const status = await getGenericModePackStatus(sessionId);
    const definition = await new ModePackStore().saveDraft(body.draft, status.runtime.cwd, expectedRevision);
    return NextResponse.json({ definition, draft: definitionToDraft(definition) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /revision conflict/iu.test(message) ? 409 : 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const raw = await request.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
    const body = raw as Record<string, unknown>;
    const modePackId = requiredString(body.modePackId, "modePackId");
    const expectedRevision = nonNegativeInteger(body.expectedRevision, "expectedRevision");
    await new ModePackStore().deleteCustom(modePackId, expectedRevision);
    return NextResponse.json({ deleted: true, modePackId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /revision conflict/iu.test(message) ? 409 : 400 });
  }
}
