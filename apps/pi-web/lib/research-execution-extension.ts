import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResearchPlanInput } from "../../../packages/study-research-host/src/index.ts";
import { studyContext } from "./study-research-service";
import { getLearningHarness } from "./harness-server";
import { researchExecutionState, runResearchCellWithinScope } from "./research-execution-service";

export default function researchExecutionExtension(pi: ExtensionAPI) {
  const text = Type.String({ minLength: 1, maxLength: 20000 });
  const strings = Type.Array(text, { maxItems: 200 });
  pi.registerTool({
    name: "research_run",
    label: "范围内研究执行",
    description: "Inspect existing plans, code cells, execution limits, approved scopes and actual run output; enqueue a frozen R/Python cell within a user-approved scope, or a bounded smoke plan. This tool cannot grant, enlarge or revoke authorization or confirm scientific results. Preserve requestId when retrying an uncertain submission. New scientific changes require a revised plan and renewed user approval.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("state"), Type.Literal("run")]),
      expectedPhaseRevision: Type.Integer({ minimum: 1 }),
      cellId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), expectedCellRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      planId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), expectedPlanRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      scopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      requestId: Type.Optional(Type.String({ minLength: 16, maxLength: 80 })),
      changeNote: Type.Optional(Type.String({ minLength: 1, maxLength: 6000 })),
      rPackages: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 })),
      resources: Type.Optional(Type.Object({ cpuMilliCores: Type.Integer({ minimum: 1 }), memoryMiB: Type.Integer({ minimum: 1 }), wallTimeMs: Type.Integer({ minimum: 1 }), diskBytes: Type.Integer({ minimum: 1 }) })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const sessionId = ctx.sessionManager.getSessionId();
      let result: unknown;
      if (params.action === "state") {
        const { scope, phase } = await studyContext(sessionId, params.expectedPhaseRevision);
        if (phase.phase !== "research") throw new Error("Research requires an explicit mode change by the user");
        result = { ...await researchExecutionState(sessionId), cells: getLearningHarness().studyCells.list(scope) };
      } else {
        if (!params.cellId || params.expectedCellRevision === undefined || !params.planId || params.expectedPlanRevision === undefined || !params.requestId || !params.changeNote || !params.resources)
          throw new Error("Run requires the observed cell, plan, resource limits, request ID and change note");
        result = await runResearchCellWithinScope({ sessionId, expectedPhaseRevision: params.expectedPhaseRevision, cellId: params.cellId,
          expectedCellRevision: params.expectedCellRevision, planId: params.planId, expectedPlanRevision: params.expectedPlanRevision,
          scopeId: params.scopeId, requestId: params.requestId, resources: params.resources, rPackages: params.rPackages ?? [], changeNote: params.changeNote }, signal);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  });
  pi.registerTool({
    name: "research_plan",
    label: "研究方案",
    description: "Read, create or revise a theory, smoke, formal experiment or exploration plan in the explicitly selected Research phase. Theory includes assumptions, propositions, proofSteps, counterexamples and openGaps. Formal experiments include hypotheses, datasetVersion, splitProtocol, primaryMetrics, method and stoppingConditions. These are proposals: saving a plan does not grant execution or confirm results. The user reviews scope through the workspace.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("revise")]),
      expectedPhaseRevision: Type.Integer({ minimum: 1 }),
      expectedProjectRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      planId: Type.Optional(Type.String()), expectedPlanRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      kind: Type.Optional(Type.Union([Type.Literal("theory"), Type.Literal("smoke"), Type.Literal("formal"), Type.Literal("exploration")])),
      detail: Type.Optional(Type.Union([
        Type.Object({ question: text, assumptions: strings, propositions: strings, proofSteps: strings, counterexamples: strings, openGaps: strings }),
        Type.Object({ question: text, method: text, evaluation: text, allowedChanges: strings }),
        Type.Object({ question: text, hypotheses: strings, datasetVersion: text, splitProtocol: text, primaryMetrics: strings, method: text, stoppingConditions: strings }),
        Type.Object({ question: text, direction: text, allowedChanges: strings, stoppingConditions: strings }),
      ])),
      sourceVersionHashes: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
      sourceReferences: Type.Optional(Type.Array(Type.Object({ sourceId: Type.String(), contentHash: Type.String() }), { maxItems: 128 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error("Research plan operation cancelled");
      const { host, scope, phase } = await studyContext(ctx.sessionManager.getSessionId(), params.expectedPhaseRevision);
      if (phase.phase !== "research") throw new Error("Research requires an explicit mode change by the user");
      let result: unknown;
      if (params.action === "list") result = host.listResearchPlans(scope);
      else {
        if (!params.kind || !params.detail || params.expectedProjectRevision === undefined) throw new Error("Plan kind, detail and observed project revision are required");
        // Host validates the entire discriminated plan before writing any field.
        const plan: ResearchPlanInput = { kind: params.kind, detail: params.detail, sourceVersionHashes: params.sourceVersionHashes ?? [], sourceReferences: params.sourceReferences };
        if (params.action === "create") result = host.createResearchPlan(scope, { plan, expectedProjectRevision: params.expectedProjectRevision });
        else {
          if (!params.planId || params.expectedPlanRevision === undefined) throw new Error("Observed plan ID and revision are required");
          result = host.reviseResearchPlan(scope, { plan, planId: params.planId, expectedPlanRevision: params.expectedPlanRevision, expectedProjectRevision: params.expectedProjectRevision });
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  });
}
