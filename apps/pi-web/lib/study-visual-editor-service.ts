import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { studyContext } from "./study-research-service";
import { studyVisualRuntimeIdentity } from "./study-visual-sandbox";

export async function saveStudyVisualization(input: {
  sessionId: string; expectedPhaseRevision: number; expectedProjectRevision: number;
  visualizationId?: string; expectedVisualizationRevision?: number;
  purpose: string; code: string; inputs: Record<string, unknown>;
}) {
  const { host, scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (JSON.stringify(input.inputs).length > 65536) throw new Error("可视化参数超过 64 KiB。");
  const creator = host.registerTrustedRunnerContext(scope, `pi-session:${scope.sessionId}`);
  const draft = { purpose: input.purpose, code: input.code, inputs: input.inputs, inputHashes: {},
    environmentHash: contentHash(studyVisualRuntimeIdentity()), creatorContextId: creator.contextId };
  if (!input.visualizationId) return host.createVisualizationDraft(scope, draft, input.expectedProjectRevision);
  if (input.expectedVisualizationRevision === undefined) throw new Error("修改可视化需要原始版本。");
  return host.reviseVisualizationDraft(scope, { visualizationId: input.visualizationId,
    expectedVisualizationRevision: input.expectedVisualizationRevision, expectedProjectRevision: input.expectedProjectRevision, draft });
}
