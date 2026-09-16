import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import {
	environmentPackageState,
	installEnvironmentPackagePlanFromUser,
	previewEnvironmentPackageChangesFromUser,
	reconcileEnvironmentPackageOperationFromUser,
} from "@/lib/study-environment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requests(value: unknown) {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("Choose one through 64 packages");
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Package request must be an object");
		const entry = item as Record<string, unknown>;
		return {
			name: studyText(entry.name, "package name", 128),
			version: entry.version === undefined || entry.version === null ? null : studyText(entry.version, "package version", 256),
		};
	});
}

export async function GET(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		const query = new URL(request.url).searchParams;
		return Response.json(await environmentPackageState({ sessionId: studyText(query.get("sessionId"), "sessionId") }), {
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		return studyApiError(error);
	}
}

/** Package mutation is only reachable from the same-origin browser guard; model tools cannot mint this action. */
export async function POST(request: Request) {
	if (!isStudyBrowserMutation(request)) return Response.json({ error: "An explicit same-origin browser action is required" }, { status: 403 });
	try {
		const body = await readStudyRequest(request);
		const action = studyText(body.action, "action", 64);
		const shared = {
			sessionId: studyText(body.sessionId, "sessionId"),
			expectedPhaseRevision: studyInteger(body.expectedPhaseRevision, "expectedPhaseRevision", 1),
		};
		if (action === "preview") {
			const language = studyText(body.language, "language", 16);
			if (language !== "python" && language !== "r") throw new Error("Unsupported package language");
			return Response.json(await previewEnvironmentPackageChangesFromUser({ ...shared, language, requests: requests(body.requests) }));
		}
		if (action === "install") {
			if (typeof body.acceptExistingChanges !== "boolean") throw new Error("acceptExistingChanges must be boolean");
			return Response.json(await installEnvironmentPackagePlanFromUser({
				...shared,
				planId: studyText(body.planId, "planId", 128),
				expectedPlanRevision: studyInteger(body.expectedPlanRevision, "expectedPlanRevision", 1),
				requestId: studyText(body.requestId, "requestId", 80),
				acceptExistingChanges: body.acceptExistingChanges,
			}));
		}
		if (action === "reconcile") {
			return Response.json(await reconcileEnvironmentPackageOperationFromUser({
				...shared,
				operationId: studyText(body.operationId, "operationId", 128),
			}));
		}
		throw new Error("Unknown environment package action");
	} catch (error) {
		return studyApiError(error);
	}
}
