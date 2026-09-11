import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requireStudyRuntime, studyAgentCommand } from "./study-research-service";

export function createStudyResearchExtension(execute = studyAgentCommand, verify = requireStudyRuntime) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "study_research", label: "Study & Research",
      description: "Source-grounded paper/book/code study. Read schema and state, then read_source by id, startLine (1-based extracted text lines, not PDF pages), limit <=200. Before in-depth teaching save a roadmap with prerequisites, notation, contribution, proof/code explanations, checks and unresolved issues. Read a selected node with read_node. Save separate agent notes; never overwrite user notes. Research tools save proposals and experiment drafts only. No approvals, execution, installation or self-scored proof certification. Use actual sourceHash and quote anchors.",
      parameters: Type.Object({
        action: Type.Union(["schema", "state", "read_source", "read_node", "read_note", "read_experiment", "read_run", "save_roadmap", "save_note", "save_proposal", "save_experiment"].map((action) => Type.Literal(action))),
        id: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        draft: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Structured object exactly following schema. Revision zero creates; no authority/status fields." })),
      }),
      async execute(_id, params, signal, _update, ctx) {
        const sid = ctx.sessionManager.getSessionId();
        const admitted = await verify(sid);
        const assertActive = async () => {
          if (signal?.aborted) throw new Error("Study operation cancelled");
          const current = await verify(sid);
          if (current.wrapper !== admitted.wrapper || current.snapshotId !== admitted.snapshotId) throw new Error("Study Runtime changed during the operation");
        };
        const result = await execute(sid, params, assertActive);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      },
    });
  };
}
export default createStudyResearchExtension();
