import { contentHash } from "../../../packages/harness-core/src/index.ts";
import type { BrowserVisualObservation } from "../../../packages/study-research-host/src/study-teaching-host.ts";
import { getLearningHarness } from "./harness-server";
import { studyContext } from "./study-research-service";
import { studyVisualRuntimeIdentity } from "./study-visual-sandbox";
import { visualValidationState } from "./study-visual-validation-service";

export async function studyVisualInteractionState(sessionId:string,visualizationId:string) {
  const {scope}=await studyContext(sessionId),harness=getLearningHarness();
  return {gate:harness.studyTeaching.visualGate(scope,visualizationId,contentHash(studyVisualRuntimeIdentity())),specifications:harness.listVisualValidationSpecifications(scope,visualizationId).map((item)=>({...item,browserCases:item.specification.cases.map((entry)=>({caseId:entry.id,inputHash:contentHash(entry.inputs)}))}))};
}
export async function recordStudyVisualInteraction(input:{sessionId:string;expectedPhaseRevision:number;visualizationId:string;revision:number;targetHash:string;specificationId:string;specificationRevision:number;observations:BrowserVisualObservation[]}) {
  const {scope}=await studyContext(input.sessionId,input.expectedPhaseRevision),harness=getLearningHarness();
  const specification=harness.listVisualValidationSpecifications(scope,input.visualizationId).find((item)=>item.specificationId===input.specificationId&&item.revision===input.specificationRevision);
  if(!specification || specification.target.visualizationHash!==input.targetHash || specification.target.visualizationRevision!==input.revision)throw new Error("Validation specification changed before browser interaction was saved");
  const numerical=(await visualValidationState({sessionId:input.sessionId,visualizationId:input.visualizationId})).runs.find(run=>run.specificationHash===specification.specificationHash&&run.currentStatus==="passed");
  if(!numerical)throw new Error("Finish native numerical validation of this exact specification before recording browser interaction");
  const current=await studyContext(input.sessionId,input.expectedPhaseRevision);
  if(current.scope.projectId!==scope.projectId)throw new Error("Project changed during browser validation");
  return harness.studyTeaching.recordBrowserInteraction(current.scope,{visualizationId:input.visualizationId,revision:input.revision,targetHash:input.targetHash,runtimeHash:contentHash(studyVisualRuntimeIdentity()),numericalTaskId:numerical.taskId,specification:specification.specification,observations:input.observations});
}
