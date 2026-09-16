import { MAX_EXECUTION_INPUT_BYTES, MAX_EXECUTION_TOTAL_INPUT_BYTES, type FrozenExecutionInput } from "../../../packages/study-execution-host/src/execution-payloads.ts";
import { getLearningHarness } from "./harness-server";
import { studyContext } from "./study-research-service";
import { readExactStudySourceBytes } from "./study-source-bytes";

/** Freeze only registered source bytes selected by an immutable cell revision. No path comes from a model. */
export async function freezeStudyCellInputs(input: { sessionId: string; cellId: string; expectedCellRevision: number; expectedPhaseRevision: number }) {
  const context = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const cell = getLearningHarness().studyCells.get(context.scope, input.cellId, input.expectedCellRevision);
  const sources = context.host.listSources(context.scope).filter((source) => source.current);
  const frozen: FrozenExecutionInput[] = [];
  let totalBytes = 0;
  for (const binding of cell.inputs) {
    const source = sources.find((item) => item.sourceId === binding.sourceId && item.contentHash === binding.sourceHash);
    if (!source) throw new Error("Code cell input version is no longer current");
    const bytes = await readExactStudySourceBytes(source, MAX_EXECUTION_INPUT_BYTES);
    totalBytes += bytes.length;
    if (totalBytes > MAX_EXECUTION_TOTAL_INPUT_BYTES) throw new Error("Code cell inputs exceed the current 32 MiB aggregate snapshot limit");
    frozen.push({ name: binding.name, bytesBase64: bytes.toString("base64"), sha256: binding.sourceHash });
  }
  const latest = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (latest.scope.projectId !== context.scope.projectId) throw new Error("Conversation changed project while freezing inputs");
  const current = latest.host.listSources(latest.scope).filter((source) => source.current);
  if (cell.inputs.some((binding) => !current.some((source) => source.sourceId === binding.sourceId && source.contentHash === binding.sourceHash))) throw new Error("A source version changed while freezing execution inputs");
  return { cell, inputs: frozen, totalBytes, scope: latest.scope };
}
