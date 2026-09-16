import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import {
	readStudyAssignmentRequest,
	requestStudyAssignmentFromUser,
	studyAssignmentState,
} from "@/lib/study-assignment-service";
import { isStudyBrowserMutation } from "@/lib/study-user-action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function nullableText(value: unknown, label: string, max: number): string | null {
	if (value === undefined || value === null) return null;
	return studyText(value, label, max);
}

function queryInteger(value: string | null, label: string, min: number): number {
	if (value === null || value.trim() === "") throw new Error(`Invalid ${label}`);
	return studyInteger(Number(value), label, min);
}

function sourceRefs(value: unknown) {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64)
		throw new Error("Assignment sourceRefs must contain 1..64 entries");
	return value.map((entry, index) => {
		const source = record(entry, `Assignment sourceRefs[${index}]`);
		return {
			sourceId: studyText(source.sourceId, `sourceRefs[${index}].sourceId`, 128),
			sourceHash: studyText(source.sourceHash, `sourceRefs[${index}].sourceHash`, 80),
			locator: nullableText(source.locator, `sourceRefs[${index}].locator`, 4_000),
		};
	});
}

export async function GET(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		const query = new URL(request.url).searchParams;
		const sessionId = studyText(query.get("sessionId"), "sessionId");
		const action = query.get("action") ?? "state";
		if (action === "state")
			return Response.json(await studyAssignmentState(sessionId), { headers: { "cache-control": "no-store" } });
		if (action !== "read-request") throw new Error("Unknown Assignment read action");
		return Response.json(
			await readStudyAssignmentRequest({
				sessionId,
				expectedPhaseRevision: queryInteger(query.get("expectedPhaseRevision"), "expectedPhaseRevision", 1),
				requestId: studyText(query.get("requestId"), "requestId", 128),
			}),
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (error) {
		return studyApiError(error);
	}
}

/** Request creation is a same-origin browser action; the model tool has no request action. */
export async function POST(request: Request) {
	if (!isStudyBrowserMutation(request)) return Response.json({ error: "An explicit same-origin browser action is required" }, { status: 403 });
	try {
		const body = await readStudyRequest(request);
		const action = studyText(body.action, "action", 64);
		if (action !== "create" && action !== "request") throw new Error("Unknown Assignment mutation");
		return Response.json(
			await requestStudyAssignmentFromUser({
				sessionId: studyText(body.sessionId, "sessionId"),
				expectedPhaseRevision: studyInteger(body.expectedPhaseRevision, "expectedPhaseRevision", 1),
				expectedProjectRevision: studyInteger(body.expectedProjectRevision, "expectedProjectRevision", 0),
				goal: studyText(body.goal, "goal", 20_000),
				sourceRefs: sourceRefs(body.sourceRefs),
				count: body.count === undefined || body.count === null ? null : studyInteger(body.count, "count", 1, 200),
				difficulty: nullableText(body.difficulty, "difficulty", 256),
				purpose: nullableText(body.purpose, "purpose", 6_000),
			}),
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (error) {
		return studyApiError(error);
	}
}
