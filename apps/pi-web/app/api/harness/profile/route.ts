import { NextResponse } from "next/server";
import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";
import { warmSwitchHarnessProfile } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

/** Switch the already-bound learner session; course and role are derived server-side. */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
    const data = body as Record<string, unknown>;
    const sessionId = requireString(data, "sessionId");
    const targetProfileId = requireString(data, "targetProfileId");
    const expectedSnapshotId = requireString(data, "expectedSnapshotId");
    const idempotencyKey = requireString(data, "idempotencyKey");
    const harness = getLearningHarness();
    const prepared = harness.prepareProfileTransition({ sessionId, targetProfileId, expectedSnapshotId, idempotencyKey });
    const session = await warmSwitchHarnessProfile(sessionId, prepared);
    const current = harness.findCurrentSession(sessionId);
    if (!current) throw new Error("Profile transition committed without a durable Harness session.");
    return NextResponse.json({
      sessionId: session.sessionId,
      profileId: current.snapshot.profileId,
      resourceSnapshotId: current.snapshot.resourceSnapshotId,
      bindingRevision: current.binding.revision,
    });
  } catch (error) {
    logHarnessOperationalError("profile switch", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: harnessHttpStatus(error) },
    );
  }
}
