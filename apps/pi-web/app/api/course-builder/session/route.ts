import { allowFileRoot } from "@/lib/file-access";
import { randomUUID } from "node:crypto";
import { assertCourseBuilderSession } from "@/lib/course-builder-service";
import { builderError, builderString, readCourseBuilderJson } from "@/lib/course-builder-request";
import { activateGenericModePack, getGenericModePackStatus } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { hasSessionSettings } from "../../../../../../packages/profile-resource-host/src/index.ts";
import { COURSE_BUILDER_DRAFT } from "@/lib/course-builder-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		const body = await readCourseBuilderJson(request);
		const sourceSessionId = builderString(body.sourceSessionId);
		assertCourseBuilderSession(sourceSessionId);
		const source = await getGenericModePackStatus(sourceSessionId);
		const cwd = source.runtime.cwd;
		if (!cwd) throw new Error("The original Pi session has no working directory");
		const activeSnapshot = source.runtime.binding?.snapshot;
		const upToDate = activeSnapshot && (hasSessionSettings(activeSnapshot) || activeSnapshot.profileRevision >= COURSE_BUILDER_DRAFT.revision);
		const ready = source.runtime.live && source.runtime.verified && activeSnapshot?.profileId === "course-builder" && upToDate;
		if (!ready && source.runtime.busy) throw new Error("Pi 正在处理消息，请等待当前回复完成。");
		const created = ready
			? { binding: source.runtime.binding! }
			: await activateGenericModePack({
				sessionId: sourceSessionId,
				modePackId: "course-builder",
				expectedSnapshotId: source.runtime.binding?.snapshot.resourceSnapshotId ?? null,
				idempotencyKey: randomUUID(),
			});
		allowFileRoot(cwd);
		invalidateSessionListCache();
		const current = await getGenericModePackStatus(sourceSessionId);
		if (!current.runtime.verified || current.runtime.binding?.snapshot.profileId !== "course-builder") {
			throw new Error(current.runtime.diagnostic ?? "The Course Builder runtime failed verification");
		}
		console.info("[course-builder] activated existing session", { sessionId: sourceSessionId, resourceSnapshotId: created.binding.snapshot.resourceSnapshotId });
		return Response.json({
			sourceSessionId,
			sessionId: sourceSessionId,
			resourceSnapshotId: created.binding.snapshot.resourceSnapshotId,
			verified: true,
		});
	} catch (error) {
		console.error("[course-builder] failed to activate the existing teacher session", error);
		return builderError(error);
	}
}
