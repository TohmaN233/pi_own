import { isApiRequestAllowed } from "@/lib/request-security";
import { requireCourseBuilderWorkspace, builderError, builderString } from "@/lib/course-builder-request";
import {
	listAssignmentAssets,
	readAssignmentAssetBytes,
	readAssignmentSource,
	saveAssignmentSource,
} from "@/lib/course-builder-assignment-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		const query = new URL(request.url).searchParams;
		const sessionId = builderString(query.get("sessionId"));
		const assignmentId = builderString(query.get("assignmentId"));
		await requireCourseBuilderWorkspace(sessionId);
		const path = query.get("path");
		if (!path) return Response.json(await listAssignmentAssets(sessionId, assignmentId), { headers: { "cache-control": "no-store" } });
		if (query.get("type") === "pdf") {
			const bytes = await readAssignmentAssetBytes(sessionId, assignmentId, path);
			return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${encodeURIComponent(path.split("/").at(-1) ?? "assignment.pdf")}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
		}
		return Response.json(await readAssignmentSource(sessionId, assignmentId, path), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return builderError(error);
	}
}

export async function POST(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		if (request.headers.get("x-course-builder-teacher") !== "1") return Response.json({ error: "Teacher workspace action required" }, { status: 403 });
		const body = await request.json() as Record<string, unknown>;
		const sessionId = builderString(body.sessionId);
		const assignmentId = builderString(body.assignmentId);
		const relativePath = builderString(body.path);
		if (typeof body.source !== "string") throw new Error("Assignment source must be text");
		const source = body.source;
		const expectedHash = builderString(body.expectedHash);
		if (body.compile !== undefined && typeof body.compile !== "boolean") throw new Error("compile must be boolean");
		await requireCourseBuilderWorkspace(sessionId, true);
		const saved = await saveAssignmentSource({ sessionId, assignmentId, relativePath, source, expectedHash, compile: body.compile === true });
		console.info("[course-builder] teacher saved Assignment source", { sessionId, assignmentId, relativePath, compiled: body.compile === true, compileSucceeded: saved.compile?.succeeded ?? null });
		return Response.json(saved, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return builderError(error);
	}
}
