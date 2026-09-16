import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import {
	confirmResearchAnalysisFromUser,
	editResearchAnalysisDraft,
	saveResearchAnalysisFromTerminalRun,
	saveResearchAnalysisFromTheoryPlan,
	studyResearchResultsState,
	type ResearchAnalysisDraftInput,
} from "@/lib/study-results-service";
import { isStudyBrowserMutation } from "@/lib/study-user-action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function analysisDraft(value: unknown): ResearchAnalysisDraftInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Analysis draft must be an object");
	const draft = value as Record<string, unknown>;
	if (draft.classification !== "positive" && draft.classification !== "negative" && draft.classification !== "inconclusive") {
		throw new Error("Invalid analysis classification");
	}
	const textList = (field: "limitations" | "claims") => {
		if (!Array.isArray(draft[field])) throw new Error(`Analysis ${field} must be an array`);
		return draft[field].map((entry) => studyText(entry, `analysis ${field}`, 20_000));
	};
	return {
		classification: draft.classification,
		summary: studyText(draft.summary, "analysis summary", 200_000),
		limitations: textList("limitations"),
		claims: textList("claims"),
	};
}

export async function GET(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		return Response.json(await studyResearchResultsState(studyText(new URL(request.url).searchParams.get("sessionId"), "sessionId")), {
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		return studyApiError(error);
	}
}

/** Formal confirmation is intentionally only a same-origin browser event, never a Pi tool action. */
export async function POST(request: Request) {
	if (!isStudyBrowserMutation(request)) return Response.json({ error: "Untrusted browser mutation" }, { status: 403 });
	try {
		const body = await readStudyRequest(request);
		const action = studyText(body.action, "action");
		const sessionId = studyText(body.sessionId, "sessionId");
		const expectedPhaseRevision = studyInteger(body.expectedPhaseRevision, "expectedPhaseRevision", 1);
		if (action === "confirm") {
			return Response.json(await confirmResearchAnalysisFromUser({
				sessionId,
				expectedPhaseRevision,
				resultId: studyText(body.resultId, "resultId"),
				expectedResultRevision: studyInteger(body.expectedResultRevision, "expectedResultRevision", 1),
			}));
		}
		if (action !== "save-analysis") throw new Error("Unknown Research result action");
		const common = {
			sessionId,
			expectedPhaseRevision,
			expectedProjectRevision: studyInteger(body.expectedProjectRevision, "expectedProjectRevision"),
			draft: analysisDraft(body.draft),
		};
		if (body.resultId !== undefined) {
			return Response.json(await editResearchAnalysisDraft({
				...common,
				resultId: studyText(body.resultId, "resultId"),
				expectedResultRevision: studyInteger(body.expectedResultRevision, "expectedResultRevision", 1),
			}));
		}
		if (body.originKind === "terminal-run") {
			return Response.json(await saveResearchAnalysisFromTerminalRun({
				...common,
				taskId: studyText(body.taskId, "taskId"),
				expectedTaskRevision: studyInteger(body.expectedTaskRevision, "expectedTaskRevision", 1),
			}));
		}
		if (body.originKind === "theory-plan") {
			return Response.json(await saveResearchAnalysisFromTheoryPlan({
				...common,
				planId: studyText(body.planId, "planId"),
				expectedPlanRevision: studyInteger(body.expectedPlanRevision, "expectedPlanRevision", 1),
			}));
		}
		throw new Error("Choose a terminal run or TheoryPlan origin");
	} catch (error) {
		return studyApiError(error);
	}
}
