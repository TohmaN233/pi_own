import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { identifier } from "../../../packages/study-research-host/src/index.ts";
import { mathVisualizationContext, mathVisualizationHost, MATH_VISUAL_SCHEMA } from "./math-visualization-service";

export function createMathVisualizationExtension(context = mathVisualizationContext, host = mathVisualizationHost) {
  return (pi: ExtensionAPI) => pi.registerTool({
    name: "math_visualization", label: "Shared Math Visualization",
    description: "Read schema, then create/get/list fixed deterministic 2D/3D math artifacts in the current course/Assignment or Study project. The workspace renders with local Plotly. Numeric specs only, no executable HTML/JS. Explain what to predict, manipulate and observe; visuals do not prove general theorems.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("schema"), Type.Literal("create"), Type.Literal("get"), Type.Literal("list")]), id: Type.Optional(Type.String()), spec: Type.Optional(Type.Object({}, { additionalProperties: true })) }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Math visualization cancelled");
      const sessionId = ctx.sessionManager.getSessionId();
      const active = await context(sessionId, true);
      if (signal?.aborted) throw new Error("Math visualization cancelled");
      const result = params.action === "schema" ? MATH_VISUAL_SCHEMA : params.action === "list" ? host().list(active.scope) : params.action === "get" ? host().get(active.scope, identifier(params.id)) : host().create(active.scope, params.spec);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  });
}
export default createMathVisualizationExtension();
