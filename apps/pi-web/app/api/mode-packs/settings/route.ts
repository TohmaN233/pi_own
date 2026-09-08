import { getSessionModeSettings, updateSessionModeSettings } from "@/lib/mode-settings-service";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
function field(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}
function failure(error: unknown) {
  console.error("[mode-settings] request failed", error);
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message }, { status: /conflict|changed before|wait|in progress/i.test(message) ? 409 : 400 });
}
export async function GET(request: Request) {
  try { return Response.json(await getSessionModeSettings(field(new URL(request.url).searchParams.get("sessionId"), "sessionId"))); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const body = await request.json();
    return Response.json(await updateSessionModeSettings({ sessionId: field(body.sessionId, "sessionId"), expectedSnapshotId: field(body.expectedSnapshotId, "expectedSnapshotId"), idempotencyKey: field(body.idempotencyKey, "idempotencyKey"), settingsPatch: body.settingsPatch }));
  } catch (error) { return failure(error); }
}
