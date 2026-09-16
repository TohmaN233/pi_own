import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	readStudyAssignmentRequest,
	saveStudyAssignmentDraft,
	studyAssignmentState,
} from "./study-assignment-service";

const assignmentDraft = Type.Object({
	overview: Type.String({ minLength: 1, maxLength: 50_000 }),
	tasks: Type.Array(Type.String({ minLength: 1, maxLength: 20_000 }), { maxItems: 200 }),
	deliverables: Type.Array(Type.String({ minLength: 1, maxLength: 20_000 }), { maxItems: 100 }),
	rubric: Type.Array(Type.String({ minLength: 1, maxLength: 20_000 }), { maxItems: 200 }),
	solutionNotes: Type.Array(Type.String({ minLength: 1, maxLength: 20_000 }), { maxItems: 200 }),
	materialIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
});

/**
 * Agent-side Study Assignment capability. The browser is the only place that
 * can create a request; this tool can inspect one and save a validated draft.
 * It has no approval, grading, progress-lock or request-minting action.
 */
export default function studyAssignmentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "study_assignment",
		label: "学习练习草稿",
		description:
			"Read Study/Research Assignment requests created by the same-origin browser and save a question draft against an observed request. The request must already exist; this tool cannot create requests, approve drafts, grade answers, impose completion, or switch phase. AssignmentDraft.tasks are questions, solutionNotes are aligned answer explanations, and materialIds carry only the explicitly selected Study source IDs.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("state"), Type.Literal("read-request"), Type.Literal("save-draft")]),
			expectedPhaseRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			expectedProjectRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			expectedRequestRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			expectedDraftRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			draft: Type.Optional(assignmentDraft),
		}),
		async execute(_toolCallId, params, signal, _update, context) {
			signal?.throwIfAborted();
			const sessionId = context.sessionManager.getSessionId();
			if (params.action === "state") {
				return { content: [{ type: "text" as const, text: JSON.stringify(await studyAssignmentState(sessionId)) }], details: {} };
			}
			if (!params.requestId || params.expectedPhaseRevision === undefined)
				throw new Error("An observed Assignment request ID and phase revision are required");
			if (params.action === "read-request") {
				const record = await readStudyAssignmentRequest({
					sessionId,
					expectedPhaseRevision: params.expectedPhaseRevision,
					requestId: params.requestId,
				});
				return { content: [{ type: "text" as const, text: JSON.stringify(record) }], details: {} };
			}
			if (
				params.expectedProjectRevision === undefined ||
				params.expectedRequestRevision === undefined ||
				params.expectedDraftRevision === undefined ||
				params.draft === undefined
			)
				throw new Error("Observed project, request and draft revisions plus a draft are required");
			const record = await saveStudyAssignmentDraft({
				sessionId,
				expectedPhaseRevision: params.expectedPhaseRevision,
				expectedProjectRevision: params.expectedProjectRevision,
				requestId: params.requestId,
				expectedRequestRevision: params.expectedRequestRevision,
				expectedDraftRevision: params.expectedDraftRevision,
				draft: params.draft,
			});
			return { content: [{ type: "text" as const, text: JSON.stringify(record) }], details: {} };
		},
	});
}
