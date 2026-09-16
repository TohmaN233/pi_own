import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import {
	confirmStudyManuscriptPatch,
	readStudyManuscriptCandidate,
	recoverStudyManuscriptPatch,
	requestStudyManuscriptPatch,
	studyManuscriptState,
} from "@/lib/study-manuscript-service";
import { isStudyBrowserMutation } from "@/lib/study-user-action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		const query = new URL(request.url).searchParams;
		const sessionId = studyText(query.get("sessionId"), "sessionId");
		if ((query.get("action") ?? "state") === "candidate") {
			const candidate = await readStudyManuscriptCandidate({ sessionId, patchId: studyText(query.get("patchId"), "patchId") });
			const payload = candidate.bytes.buffer.slice(
				candidate.bytes.byteOffset,
				candidate.bytes.byteOffset + candidate.bytes.byteLength,
			) as ArrayBuffer;
			return new Response(payload, {
				headers: {
					"cache-control": "no-store",
					"content-type": candidate.kind === "tex" ? "text/x-tex; charset=utf-8" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					"content-disposition": `attachment; filename="${candidate.fileName}"`,
				},
			});
		}
		if ((query.get("action") ?? "state") !== "state") throw new Error("Unknown manuscript read action");
		return Response.json(await studyManuscriptState(sessionId), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return studyApiError(error);
	}
}

/** Only a same-origin browser event may issue a request, confirm writeback, or recover a source. */
export async function POST(request: Request) {
	if (!isStudyBrowserMutation(request)) return Response.json({ error: "Untrusted browser mutation" }, { status: 403 });
	try {
		const body = await readStudyRequest(request);
		const action = studyText(body.action, "action");
		const common = {
			sessionId: studyText(body.sessionId, "sessionId"),
			expectedPhaseRevision: studyInteger(body.expectedPhaseRevision, "expectedPhaseRevision", 1),
			patchId: body.patchId === undefined ? undefined : studyText(body.patchId, "patchId"),
			expectedPatchRevision: body.expectedPatchRevision === undefined ? undefined : studyInteger(body.expectedPatchRevision, "expectedPatchRevision", 1),
		};
		if (action === "request") {
			return Response.json(await requestStudyManuscriptPatch({
				sessionId: common.sessionId,
				expectedPhaseRevision: common.expectedPhaseRevision,
				expectedProjectRevision: studyInteger(body.expectedProjectRevision, "expectedProjectRevision"),
				sourceId: studyText(body.sourceId, "sourceId"),
				sourceHash: studyText(body.sourceHash, "sourceHash"),
				requestText: studyText(body.requestText, "requestText", 20_000),
			}));
		}
		if (!common.patchId || common.expectedPatchRevision === undefined) throw new Error("Manuscript patch identity and revision are required");
		if (body.confirmed !== true) throw new Error("Explicit confirmation is required");
		if (action === "confirm") {
			return Response.json(await confirmStudyManuscriptPatch({
				sessionId: common.sessionId,
				expectedPhaseRevision: common.expectedPhaseRevision,
				patchId: common.patchId,
				expectedPatchRevision: common.expectedPatchRevision,
			}));
		}
		if (action === "recover") {
			return Response.json(await recoverStudyManuscriptPatch({
				sessionId: common.sessionId,
				expectedPhaseRevision: common.expectedPhaseRevision,
				patchId: common.patchId,
				expectedPatchRevision: common.expectedPatchRevision,
			}));
		}
		throw new Error("Unknown manuscript mutation");
	} catch (error) {
		return studyApiError(error);
	}
}
