import { isApiRequestAllowed } from "@/lib/request-security";
import { scanCourseBuilderDirectory } from "@/lib/course-builder-local-materials";
import { getCourseBuilderHost, courseBuilderState } from "@/lib/course-builder-service";
import {
	builderError,
	builderRevision,
	builderString,
	readCourseBuilderJson,
	requireCourseBuilderWorkspace,
} from "@/lib/course-builder-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		if (request.headers.get("x-course-builder-teacher") !== "1")
			return Response.json({ error: "Teacher workspace action required" }, { status: 403 });
		const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
		if (!sessionId) throw new Error("Session id is required");
		await requireCourseBuilderWorkspace(sessionId, true);
		const body = await readCourseBuilderJson(request);
		const directory = typeof body.path === "string" ? body.path.trim() : "";
		if (!directory || directory.length > 32_768) throw new Error("A valid local folder path is required");
		const host = getCourseBuilderHost();
		const assignmentId = body.assignmentId === undefined ? null : builderString(body.assignmentId);
		const assignment = assignmentId ? host.getAssignment(sessionId, assignmentId) : null;
		const materials = await scanCourseBuilderDirectory(
			directory,
			assignment
				? { kind: "assignment", assignmentId: assignment.assignmentId, assignmentTitle: assignment.title }
				: { kind: "course" },
		);
		const sourceRoot = materials[0]?.metadata?.sourceRoot;
		if (typeof sourceRoot !== "string") throw new Error("Local material scan did not return a canonical source root");
		const revision = builderRevision(body.expectedRevision);
		await requireCourseBuilderWorkspace(sessionId, true);
		if (assignment) host.syncAssignmentMaterials(sessionId, assignment.assignmentId, sourceRoot, materials, revision);
		else host.syncLocalMaterials(sessionId, sourceRoot, materials, revision);
		console.info("[course-builder] linked local material directory", {
			sessionId,
			directory,
			materialCount: materials.length,
			scope: assignment ? "assignment" : "course",
			assignmentId: assignment?.assignmentId,
		});
		return Response.json(courseBuilderState(sessionId));
	} catch (error) {
		console.error("[course-builder] failed to link local material directory", error);
		return builderError(error);
	}
}
