import { NextResponse } from "next/server";
import { getLearningHarness, listCourseSummaries, listModePackComponents, selectedCourseVersion } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";
import { getHarnessRuntimeVerification } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    const current = sessionId ? getLearningHarness().findCurrentSession(sessionId) : null;
    const availability = current ? getLearningHarness().availableProfiles(current.sessionId) : [];
    return NextResponse.json({
      ready: true,
      activeCourseVersionId: selectedCourseVersion(request),
      courses: listCourseSummaries(),
      session: current ? {
        sessionId: current.sessionId,
        bindingId: current.binding.bindingId,
        courseVersionId: current.binding.courseVersionId,
        resourceSnapshotId: current.snapshot.resourceSnapshotId,
        profileId: current.snapshot.profileId,
			snapshot: current.snapshot,
			bindingRevision: current.binding.revision,
			pendingTransition: current.pendingProfileTransition ? {
				idempotencyKey: current.pendingProfileTransition.idempotencyKey,
				targetProfileId: current.pendingProfileTransition.targetProfileId,
				snapshotId: current.pendingProfileTransition.snapshot.resourceSnapshotId,
			} : null,
			runtime: getHarnessRuntimeVerification(current.sessionId, current.snapshot),
      } : null,
		availableProfiles: availability,
		modePackComponents: listModePackComponents(),
    });
  } catch (error) {
    logHarnessOperationalError("harness status", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: harnessHttpStatus(error) });
  }
}
