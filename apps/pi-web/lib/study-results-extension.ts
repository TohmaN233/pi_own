import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	editResearchAnalysisDraft,
	saveResearchAnalysisFromTerminalRun,
	saveResearchAnalysisFromTheoryPlan,
	studyResearchResultsState,
} from "./study-results-service";
import { compactSavedResearchResult, compactStudyResearchResultsState, readStudyResultField } from "./study-result-reading";

const analysisDraft = Type.Object({
	classification: Type.Union([Type.Literal("positive"), Type.Literal("negative"), Type.Literal("inconclusive")]),
	summary: Type.String({ minLength: 1, maxLength: 200_000 }),
	limitations: Type.Array(Type.String({ minLength: 1, maxLength: 20_000 }), { maxItems: 1_000 }),
	claims: Type.Array(Type.String({ minLength: 1, maxLength: 20_000 }), { maxItems: 1_000 }),
});

/**
 * Research-only analysis capability. It can inspect and save a draft against a
 * server-observed frozen origin, but never confirm, publish, approve a scope,
 * or manufacture a terminal execution result.
 */
export default function studyResearchResultsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "study_results",
		label: "研究结果草稿",
		description: "Read frozen terminal Research runs, TheoryPlan results and analysis drafts; save a draft only against an observed terminal run or exact current TheoryPlan revision. This tool cannot confirm formal claims, publish, approve scope, switch phase, or treat process completion as a scientific conclusion.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("state"), Type.Literal("read_result"), Type.Literal("save_analysis")]),
			expectedPhaseRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			expectedProjectRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			resultId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			expectedResultRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			originKind: Type.Optional(Type.Union([Type.Literal("terminal-run"), Type.Literal("theory-plan")])),
			taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			expectedTaskRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			planId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			expectedPlanRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			field: Type.Optional(Type.Union([Type.Literal("code"), Type.Literal("parameters"), Type.Literal("plan"), Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("error"), Type.Literal("analysis")])),
			textOffset: Type.Optional(Type.Integer({ minimum: 0 })),
			textLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
			fieldHash: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			draft: Type.Optional(analysisDraft),
		}),
		async execute(_toolCallId, params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Research analysis operation cancelled");
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "state") {
				const state = await studyResearchResultsState(sessionId);
				return { content: [{ type: "text" as const, text: JSON.stringify(compactStudyResearchResultsState(state, params.offset ?? 0)) }], details: {} };
			}
			if (params.action === "read_result") {
				if (!params.field) throw new Error("A result field is required");
				const result = await readStudyResultField({
					sessionId,
					expectedPhaseRevision: params.expectedPhaseRevision,
					resultId: params.resultId,
					expectedResultRevision: params.expectedResultRevision,
					taskId: params.taskId,
					expectedTaskRevision: params.expectedTaskRevision,
					field: params.field,
					textOffset: params.textOffset,
					textLimit: params.textLimit,
					fieldHash: params.fieldHash,
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
			}
			if (
				params.expectedPhaseRevision === undefined ||
				params.expectedProjectRevision === undefined ||
				params.draft === undefined
			) {
				throw new Error("Observed phase revision, project revision and analysis draft are required");
			}
			let result: unknown;
			if (params.resultId !== undefined) {
				if (params.expectedResultRevision === undefined) throw new Error("Observed result revision is required for an edit");
				result = compactSavedResearchResult(await editResearchAnalysisDraft({
					sessionId,
					expectedPhaseRevision: params.expectedPhaseRevision,
					expectedProjectRevision: params.expectedProjectRevision,
					resultId: params.resultId,
					expectedResultRevision: params.expectedResultRevision,
					draft: params.draft,
				}));
			} else if (params.originKind === "terminal-run") {
				if (!params.taskId || params.expectedTaskRevision === undefined) {
					throw new Error("Observed terminal task ID and revision are required");
				}
				result = compactSavedResearchResult(await saveResearchAnalysisFromTerminalRun({
					sessionId,
					expectedPhaseRevision: params.expectedPhaseRevision,
					expectedProjectRevision: params.expectedProjectRevision,
					taskId: params.taskId,
					expectedTaskRevision: params.expectedTaskRevision,
					draft: params.draft,
				}));
			} else if (params.originKind === "theory-plan") {
				if (!params.planId || params.expectedPlanRevision === undefined) {
					throw new Error("Observed TheoryPlan ID and revision are required");
				}
				result = compactSavedResearchResult(await saveResearchAnalysisFromTheoryPlan({
					sessionId,
					expectedPhaseRevision: params.expectedPhaseRevision,
					expectedProjectRevision: params.expectedProjectRevision,
					planId: params.planId,
					expectedPlanRevision: params.expectedPlanRevision,
					draft: params.draft,
				}));
			} else {
				throw new Error("Choose an observed terminal run or exact TheoryPlan origin");
			}
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
		},
	});
}
