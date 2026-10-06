import type { ModePackDefinition, ModePackDraft, ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { studyModePhaseForSnapshot } from "./study-mode-policy";

export const LEARNING_WORKFLOW_CONTROL_MARKER = "Learning Workflow defaults: library-preferences/v2";
/** Execution guidance belongs only to the dedicated Study/Research Host. */
export const STUDY_WORKFLOW_EXECUTION_PROMPT = "Use /caw to open Workbench and caw route for compact matching enabled Ready Workflow metadata. All installed Workflows are selectable; modes supply editable saved defaults. For a question that benefits from a focused explanation Workflow, use study_workflow prepare with the current question and selected public sourceIds, then start its exact task to run study-explanation; use status/list/cancel to manage that bound task. Its child receives only frozen selected sources and the bounded question, never whole chat history or the Skill library. Other enabled Workflows use normal caw run and their own required capabilities. Enabling a Workflow does not grant missing domain tools or private resources. Keep ordinary questions direct. Approval, publication, private teacher resources and Assessment answer gates remain Host authorities.";
const PREVIOUS_STUDY_PROMPT_HASHES = new Set([
  "sha256:15b5a01cfe83832f36957a17a8b716f490648876212f3cf8f7f1664d54b05034",
  "sha256:54e4b8ea762cc8325c5a037ba6818f4fe1920d0d85722faf4ebf290e3371cd33",
  "sha256:cb094b60961b7e486d59cd013b842ddb6775bce348bf10d7d2dc7d3b925fd10f",
  "sha256:e0bf74ceea2083f43b239d93854aa555fbe8bcc0ac95c35f74d7b55d1990a848",
  "sha256:71028662d912cf0a2282fc318d67266407a97e9d763b0fee22bb51936d982b49",
]);
export function isPreviousStudyDefaultPrompt(prompt: string): boolean {
  return PREVIOUS_STUDY_PROMPT_HASHES.has(contentHash({ systemPrompt: prompt.trim() }));
}
export function needsLearningWorkflowDefaults(snapshot: Pick<ResourceSnapshot, "profileId" | "packageContentHash" | "instructions">): boolean {
  return Boolean(studyModePhaseForSnapshot(snapshot)) && !snapshot.instructions.includes(LEARNING_WORKFLOW_CONTROL_MARKER);
}
export function learningWorkflowDefaultsDraft(previous: ModePackDefinition, defaults: ModePackDraft): ModePackDraft {
  const { contentHash: _hash, ...draft } = previous;
  return { ...draft, revision: previous.revision + 1,
    systemPrompt: isPreviousStudyDefaultPrompt(previous.systemPrompt) ? defaults.systemPrompt : previous.systemPrompt,
    components: previous.components.map(({ version: _version, contentHash: _contentHash, ...component }) => component)
      .concat(previous.components.some(component => component.type === "skill" && component.id === "pi-caw") ? []
        : [{ type: "skill", id: "pi-caw", required: false, enabled: true, delivery: "native-skill" }]),
    instructions: [...previous.instructions, LEARNING_WORKFLOW_CONTROL_MARKER],
  };
}
