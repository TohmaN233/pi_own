import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManuscriptOperation } from "../../../packages/study-research-host/src/index.ts";
import { draftStudyManuscriptPatch, studyManuscriptState } from "./study-manuscript-service";

const operation = Type.Union([
	Type.Object({
		kind: Type.Literal("add"),
		anchor: Type.String({ minLength: 1, maxLength: 20_000 }),
		position: Type.Union([Type.Literal("before"), Type.Literal("after")]),
		text: Type.String({ minLength: 1, maxLength: 20_000 }),
		reason: Type.String({ minLength: 1, maxLength: 20_000 }),
	}),
	Type.Object({
		kind: Type.Literal("replace"),
		oldText: Type.String({ minLength: 1, maxLength: 20_000 }),
		newText: Type.String({ minLength: 1, maxLength: 20_000 }),
		reason: Type.String({ minLength: 1, maxLength: 20_000 }),
	}),
	Type.Object({
		kind: Type.Literal("delete"),
		oldText: Type.String({ minLength: 1, maxLength: 20_000 }),
		reason: Type.String({ minLength: 1, maxLength: 20_000 }),
	}),
]);

/**
 * Research-only draft capability. It cannot create user authority, confirm a
 * candidate, recover a source, or accept arbitrary filesystem paths.
 */
export default function studyManuscriptExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "study_manuscript",
		label: "论文改稿候选",
		description: "Read explicit user manuscript-patch requests and create a TeX or DOCX candidate from exact, unique text operations. A request must already exist from the same-origin browser. This tool cannot request, confirm, write back, recover, or select filesystem paths. Do not modify equations or OMML.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("state"), Type.Literal("draft")]),
			expectedPhaseRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			patchId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			expectedPatchRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			operations: Type.Optional(Type.Array(operation, { minItems: 1, maxItems: 128 })),
		}),
		async execute(_toolCallId, params, signal, _update, context) {
			if (signal?.aborted) throw new Error("Manuscript patch operation cancelled");
			const sessionId = context.sessionManager.getSessionId();
			if (params.action === "state") {
				return { content: [{ type: "text" as const, text: JSON.stringify(await studyManuscriptState(sessionId)) }], details: {} };
			}
			if (
				params.expectedPhaseRevision === undefined ||
				!params.patchId ||
				params.expectedPatchRevision === undefined ||
				!params.operations
			) {
				throw new Error("Observed Research phase revision, manuscript patch ID, patch revision and operations are required");
			}
			const patch = await draftStudyManuscriptPatch({
				sessionId,
				expectedPhaseRevision: params.expectedPhaseRevision,
				patchId: params.patchId,
				expectedPatchRevision: params.expectedPatchRevision,
				operations: params.operations as ManuscriptOperation[],
			});
			return { content: [{ type: "text" as const, text: JSON.stringify(patch) }], details: {} };
		},
	});
}
