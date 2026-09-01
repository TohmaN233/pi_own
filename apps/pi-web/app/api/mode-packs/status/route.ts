import { NextResponse } from "next/server";
import { getLearningHarness } from "@/lib/harness-server";
import {
  getGenericModePackStatus,
  getHarnessRuntimeVerification,
  getRpcSession,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    const learner = getLearningHarness().findCurrentSession(sessionId);
    if (learner) {
      const live = getRpcSession(sessionId);
      const runtime = getHarnessRuntimeVerification(sessionId, learner.snapshot);
      return NextResponse.json({
        kind: "learning",
        sessionId,
        cwd: live?.cwd ?? null,
        currentModePackId: learner.snapshot.profileId,
        currentSnapshotId: learner.snapshot.resourceSnapshotId,
        live: runtime.live,
        busy: live?.isRunning() ?? false,
        verified: runtime.verified,
        activeTools: runtime.activeTools,
        expectedTools: runtime.expectedTools,
        diagnostic: runtime.diagnostic,
        packs: getLearningHarness().availableProfiles(sessionId).map((profile) => ({
          modePackId: profile.profileId,
          title: profile.title,
          description: profile.description,
          category: profile.category,
          builtin: profile.source === "builtin",
          revision: null,
          selectable: profile.selectable,
          missingRequiredResources: profile.missingRequiredResources,
          missingOptionalResources: profile.missingOptionalResources,
          identityMismatches: profile.identityMismatches,
        })),
        resources: learner.snapshot.resources,
        diagnostics: [],
      });
    }
    const generic = await getGenericModePackStatus(sessionId);
    return NextResponse.json({
      kind: "generic",
      sessionId,
      cwd: generic.runtime.cwd,
      currentModePackId: generic.runtime.binding?.snapshot.profileId ?? null,
      currentSnapshotId: generic.runtime.binding?.snapshot.resourceSnapshotId ?? null,
      live: generic.runtime.live,
      busy: generic.runtime.busy,
      verified: generic.runtime.verified,
      activeTools: generic.runtime.activeTools,
      expectedTools: generic.runtime.expectedTools,
      diagnostic: generic.runtime.diagnostic,
      packs: generic.packs.map((item) => ({
        modePackId: item.definition.modePackId,
        title: item.definition.title,
        description: item.definition.description,
        category: item.definition.category,
        builtin: item.builtin,
        revision: item.definition.revision,
        selectable: item.selectable,
        missingRequiredResources: item.missingRequiredResources,
        missingOptionalResources: item.missingOptionalResources,
        identityMismatches: item.identityMismatches,
      })),
      resources: generic.resources,
      diagnostics: generic.diagnostics,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
