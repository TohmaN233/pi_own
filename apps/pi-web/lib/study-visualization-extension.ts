import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { studyContext } from "./study-research-service";
import { saveStudyVisualization } from "./study-visual-editor-service";

export default function studyVisualizationExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "study_visual",
    label: "学习可视化草稿",
    description: "Create, read or revise a project-owned custom visualization draft. Code is a JavaScript function body with inputs, returning {elements:[{tag,attrs,text?}],summary}. Use SVG path/circle/ellipse/line/rect/polyline/polygon/text in an 800x500 scene; no HTML, URLs or DOM. Creating or rendering a draft does not validate its mathematics or approve it for teaching.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("create"), Type.Literal("read"), Type.Literal("revise")]),
      id: Type.Optional(Type.String()),
      expectedPhaseRevision: Type.Integer({ minimum: 1 }),
      expectedProjectRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      expectedVisualizationRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      purpose: Type.Optional(Type.String({ maxLength: 20000 })),
      code: Type.Optional(Type.String({ maxLength: 131072 })),
      inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Visualization operation cancelled");
      const { host, scope } = await studyContext(ctx.sessionManager.getSessionId(), params.expectedPhaseRevision);
      let result: unknown;
      if (params.action === "read") {
        if (!params.id) throw new Error("Visualization ID is required");
        result = host.getVisualizationDraft(scope, params.id);
      } else {
        if (!params.purpose || !params.code || params.expectedProjectRevision === undefined) throw new Error("Purpose, code and observed project revision are required");
        if (params.action === "revise" && (!params.id || params.expectedVisualizationRevision === undefined)) throw new Error("Observed visualization identity and revision are required");
        result = await saveStudyVisualization({ sessionId: scope.sessionId, expectedPhaseRevision: params.expectedPhaseRevision,
          expectedProjectRevision: params.expectedProjectRevision, visualizationId: params.action === "revise" ? params.id : undefined,
          expectedVisualizationRevision: params.expectedVisualizationRevision, purpose: params.purpose, code: params.code, inputs: params.inputs ?? {} });
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  });
}
