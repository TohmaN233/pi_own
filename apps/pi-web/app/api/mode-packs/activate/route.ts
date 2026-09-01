import { NextResponse } from "next/server";
import { getLearningHarness } from "@/lib/harness-server";
import {
  activateGenericModePack,
  warmSwitchHarnessProfile,
} from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
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
    const modePackId = requiredString(body.modePackId, "modePackId");
    const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
    const expectedSnapshotId = nullableString(body.expectedSnapshotId, "expectedSnapshotId");
    const learner = getLearningHarness().findCurrentSession(sessionId);
    if (learner) {
      if (expectedSnapshotId === null) throw new Error("Learning Mode Pack activation requires the active snapshot id");
      const wasReplay = learner.profileTransitionHistory.some((item) => item.idempotencyKey === idempotencyKey);
      const prepared = getLearningHarness().prepareProfileTransition({
        sessionId,
        targetProfileId: modePackId,
        expectedSnapshotId,
        idempotencyKey,
        ...(body.modePackDraft === undefined ? {} : { modePackDraft: body.modePackDraft }),
      });
      const session = await warmSwitchHarnessProfile(sessionId, prepared);
      const current = getLearningHarness().getCurrentSession(sessionId);
      return NextResponse.json({
        kind: "learning",
        sessionId: session.sessionId,
        modePackId: current.snapshot.profileId,
        resourceSnapshotId: current.snapshot.resourceSnapshotId,
        bindingRevision: current.binding.revision,
        replay: wasReplay,
      });
    }
    const activated = await activateGenericModePack({
      sessionId,
      modePackId,
      expectedSnapshotId,
      idempotencyKey,
    });
    return NextResponse.json({
      kind: "generic",
      sessionId: activated.sessionId,
      modePackId: activated.binding.snapshot.profileId,
      resourceSnapshotId: activated.binding.snapshot.resourceSnapshotId,
      bindingRevision: activated.binding.revision,
      replay: activated.replay,
      verified: activated.runtime.verified,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found|unknown mode pack/iu.test(message)
      ? 404
      : /conflict|changed before|already in progress|wait for/iu.test(message)
        ? 409
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
