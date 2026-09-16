import type { ResearchPlanInput } from "../../../../../../packages/study-research-host/src/index.ts";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import {
	cancelResearchCellFromUser,
	createResearchPlanFromUser,
	grantResearchExecutionScopeFromUser,
	promoteLearningRunFromUser,
	reconnectResearchExecutionsFromUser,
	recordResearchRepairFromUser,
	researchExecutionState,
	revokeResearchExecutionScopeFromUser,
	reviseResearchPlanFromUser,
	runResearchCellWithinScope,
} from "@/lib/research-execution-service";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function resources(value: unknown) {
	const source = object(value, "Research resources");
	return {
		cpuMilliCores: studyInteger(source.cpuMilliCores, "cpuMilliCores", 1),
		memoryMiB: studyInteger(source.memoryMiB, "memoryMiB", 1),
		wallTimeMs: studyInteger(source.wallTimeMs, "wallTimeMs", 1),
		diskBytes: studyInteger(source.diskBytes, "diskBytes", 1),
	};
}

function quota(value: unknown, expiresAt: string) {
	const source = object(value, "Research quota");
	return {
		maxRuns: studyInteger(source.maxRuns, "maxRuns", 1, 10_000),
		maxCumulativeWallTimeMs: studyInteger(source.maxCumulativeWallTimeMs, "maxCumulativeWallTimeMs", 1, 31_536_000_000),
		maxCumulativeDiskBytes: studyInteger(source.maxCumulativeDiskBytes, "maxCumulativeDiskBytes", 1),
		expiresAt,
	};
}

function languages(value: unknown): Array<"python" | "r"> {
	if (!Array.isArray(value) || value.length === 0 || value.length > 2) throw new Error("Research languages must contain one or two values");
	return value.map((item) => {
		if (item !== "python" && item !== "r") throw new Error("Research language must be Python or R");
		return item;
	});
}

function inputBindings(value: unknown) {
	if (!Array.isArray(value) || value.length > 64) throw new Error("Research inputs must contain at most 64 source bindings");
	return value.map((item) => {
		const binding = object(item, "Research input binding");
		return { sourceId: studyText(binding.sourceId, "sourceId", 128), sourceHash: studyText(binding.sourceHash, "sourceHash", 80) };
	});
}

/** Host validation owns every discriminated scientific field; this route only bounds JSON transport. */
function plan(value: unknown): ResearchPlanInput {
	const source = object(value, "Research plan");
	if (source.kind !== "theory" && source.kind !== "smoke" && source.kind !== "formal" && source.kind !== "exploration")
		throw new Error("Research plan kind is invalid");
	const detail = object(source.detail, "Research plan detail");
	if (!Array.isArray(source.sourceVersionHashes) || source.sourceVersionHashes.length > 128)
		throw new Error("Research plan source hashes are invalid");
	if (source.sourceReferences !== undefined && (!Array.isArray(source.sourceReferences) || source.sourceReferences.length > 128))
		throw new Error("Research plan source references are invalid");
	const sourceReferences = source.sourceReferences === undefined ? undefined : source.sourceReferences.map((value) => {
		const reference = object(value, "Research plan source reference");
		return { sourceId: studyText(reference.sourceId, "sourceId", 128), contentHash: studyText(reference.contentHash, "contentHash", 80) };
	});
	return {
		kind: source.kind,
		detail: detail as unknown as ResearchPlanInput["detail"],
		sourceVersionHashes: source.sourceVersionHashes.map((hash) => studyText(hash, "sourceVersionHash", 80)),
		sourceReferences,
	};
}

function shared(body: Record<string, unknown>) {
	return {
		sessionId: studyText(body.sessionId, "sessionId"),
		expectedPhaseRevision: studyInteger(body.expectedPhaseRevision, "expectedPhaseRevision", 1),
	};
}

export async function GET(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		return Response.json(await researchExecutionState(studyText(new URL(request.url).searchParams.get("sessionId"), "sessionId")), {
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		return studyApiError(error);
	}
}

/** This route is only for browser user actions. Pi tools do not receive this approval or execution surface. */
export async function POST(request: Request) {
	if (!isStudyBrowserMutation(request)) return Response.json({ error: "An explicit same-origin browser action is required" }, { status: 403 });
	try {
		const body = await readStudyRequest(request);
		const action = studyText(body.action, "action", 64);
		if (action === "reconnect") return Response.json(await reconnectResearchExecutionsFromUser(studyText(body.sessionId, "sessionId")));
		if (action === "revoke") return Response.json(await revokeResearchExecutionScopeFromUser({
			sessionId: studyText(body.sessionId, "sessionId"), scopeId: studyText(body.scopeId, "scopeId", 128),
		}));
		if (action === "cancel") return Response.json(await cancelResearchCellFromUser({
			sessionId: studyText(body.sessionId, "sessionId"), queueJobId: studyText(body.queueJobId, "queueJobId", 128),
		}));
		const current = shared(body);
		if (action === "create-plan") return Response.json(await createResearchPlanFromUser({
			...current, expectedProjectRevision: studyInteger(body.expectedProjectRevision, "expectedProjectRevision"), plan: plan(body.plan),
		}));
		if (action === "revise-plan") return Response.json(await reviseResearchPlanFromUser({
			...current, expectedProjectRevision: studyInteger(body.expectedProjectRevision, "expectedProjectRevision"),
			planId: studyText(body.planId, "planId", 128), expectedPlanRevision: studyInteger(body.expectedPlanRevision, "expectedPlanRevision", 1), plan: plan(body.plan),
		}));
		if (action === "grant") {
			const expiresAt = studyText(body.expiresAt, "expiresAt", 64);
			return Response.json(await grantResearchExecutionScopeFromUser({
				...current, planId: studyText(body.planId, "planId", 128), expectedPlanRevision: studyInteger(body.expectedPlanRevision, "expectedPlanRevision", 1),
				expiresAt, allowedLanguages: languages(body.allowedLanguages), allowedInputs: inputBindings(body.allowedInputs),
				maxResources: resources(body.maxResources), quota: quota(body.quota, expiresAt), changeBoundary: studyText(body.changeBoundary, "changeBoundary", 6000),
			}));
		}
		if (action === "run") {
			if (!Array.isArray(body.rPackages)) throw new Error("R package selection must be an array");
			return Response.json(await runResearchCellWithinScope({
				...current, cellId: studyText(body.cellId, "cellId", 128), expectedCellRevision: studyInteger(body.expectedCellRevision, "expectedCellRevision", 1),
				requestId: studyText(body.requestId, "requestId", 80), resources: resources(body.resources),
				rPackages: body.rPackages.map((name) => studyText(name, "R package", 128)), planId: studyText(body.planId, "planId", 128),
				expectedPlanRevision: studyInteger(body.expectedPlanRevision, "expectedPlanRevision", 1),
				scopeId: body.scopeId === undefined ? undefined : studyText(body.scopeId, "scopeId", 128),
				changeNote: studyText(body.changeNote, "changeNote", 6000),
			}));
		}
		if (action === "promote") return Response.json(await promoteLearningRunFromUser({
			...current, expectedProjectRevision: studyInteger(body.expectedProjectRevision, "expectedProjectRevision"),
			sourceTaskId: studyText(body.sourceTaskId, "sourceTaskId", 128), plan: plan(body.plan),
		}));
		if (action === "repair") return Response.json(await recordResearchRepairFromUser({
			...current, failedTaskId: studyText(body.failedTaskId, "failedTaskId", 128), repairCellId: studyText(body.repairCellId, "repairCellId", 128),
			repairCellRevision: studyInteger(body.repairCellRevision, "repairCellRevision", 1), planId: studyText(body.planId, "planId", 128),
			expectedPlanRevision: studyInteger(body.expectedPlanRevision, "expectedPlanRevision", 1), changeReason: studyText(body.changeReason, "changeReason", 6000),
		}));
		throw new Error("Unknown Research execution action");
	} catch (error) {
		return studyApiError(error);
	}
}
