import type { StudyCellDraft } from "../../../packages/study-execution-host/src/code-cells.ts";
import { getLearningHarness } from "./harness-server";
import { studyContext, studyWorkspaceState } from "./study-research-service";

export async function saveStudyCodeCell(input: {
  sessionId: string;
  expectedPhaseRevision: number;
  cellId?: string;
  expectedCellRevision?: number;
  draft: StudyCellDraft;
}) {
  const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const cell = getLearningHarness().studyCells.save(scope, input);
  console.info("[study-cell] saved", { projectId: scope.projectId, sessionId: scope.sessionId, cellId: cell.cellId, revision: cell.revision, codeHash: cell.codeHash });
  return studyWorkspaceState(input.sessionId);
}
