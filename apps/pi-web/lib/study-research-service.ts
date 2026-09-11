import { randomUUID } from "node:crypto";
import { contentHash, sha256Hex } from "../../../packages/harness-core/src/index.ts";
import { identifier, integer, readStudyFile, runStudyCode, scanStudyDirectory, StudyError, text, type ExperimentPlan } from "../../../packages/study-research-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { activateGenericModePack, createPersistedGenericSession, getGenericModePackStatus, getRpcSession } from "./rpc-manager";
import { resolveSessionPath, invalidateSessionListCache } from "./session-reader";
import { extractCourseBuilderMaterial } from "./course-builder-import";
import { allowFileRoot } from "./file-access";
import { ModePackStore } from "./mode-pack-store";
import { STUDY_RESEARCH_DRAFT } from "./study-research-pack";

export const getStudyHost = () => getLearningHarness().studyResearch;
export async function requireStudyWorkspace(sessionId: string, idle = false) {
  identifier(sessionId, "sessionId");
  const harness = getLearningHarness();
  if (harness.findCurrentSession(sessionId) || harness.courseBuilder.getProjectForSession(sessionId)) throw new StudyError("SESSION_BOUND", "Use a separate ordinary Pi conversation, not a course-bound session");
  const live = getRpcSession(sessionId);
  if (!live?.isAlive() && !await resolveSessionPath(sessionId)) throw new StudyError("SESSION_NOT_FOUND", "Native Pi session not found");
  if (idle && live?.isRunning()) throw new StudyError("BUSY", "Wait for the current model turn before changing workspace state");
  return live;
}
export async function requireStudyRuntime(sessionId: string, idle = false) {
  await requireStudyWorkspace(sessionId, idle);
  const status = await getGenericModePackStatus(sessionId); const wrapper = getRpcSession(sessionId);
  if (!wrapper?.isAlive() || !status.runtime.verified || status.runtime.binding?.snapshot.profileId !== "study-research") throw new StudyError("RUNTIME_REQUIRED", "Activate the real Study & Research Mode Pack first");
  return { wrapper, snapshotId: status.runtime.binding.snapshot.resourceSnapshotId };
}
export async function activateStudyRuntime(sessionId: string) {
  await requireStudyWorkspace(sessionId);
  const source = await getGenericModePackStatus(sessionId);
  const active = source.runtime.binding?.snapshot;
  const ready = source.runtime.live && source.runtime.verified && active?.profileId === "study-research" && active.profileRevision >= STUDY_RESEARCH_DRAFT.revision;
  if (!ready) {
    if (source.runtime.busy) throw new StudyError("BUSY", "Current Pi turn is still running");
    await activateGenericModePack({ sessionId, modePackId: "study-research", expectedSnapshotId: active?.resourceSnapshotId ?? null, idempotencyKey: randomUUID() });
  }
  await requireStudyRuntime(sessionId);
  return { sessionId, verified: true };
}
export async function createStudyWorkspace(requestId: string, title: string, directory: string) {
  identifier(requestId); text(title, "title", 300);
  const scan = await scanStudyDirectory(directory);
  const harness = getLearningHarness();
  const snapshot = (await new ModePackStore().resolve("study-research", scan.root)).snapshot;
  const project = harness.studyResearch.createProject(requestId, title, scan.root, scan.sources);
  harness.projectWorkspaces.create({ id: project.id, title: project.title, cwd: scan.root, defaults: snapshot, courseProjectId: null });
  const sessionId = harness.projectWorkspaces.createSession(project.id, requestId, contentHash({ title, root: scan.root }), () => createPersistedGenericSession(scan.root, `Study · ${title}`, snapshot));
  harness.studyResearch.bindSession(sessionId, project.id);
  allowFileRoot(scan.root); invalidateSessionListCache();
  return { sessionId, project, omitted: scan.omitted };
}
export async function studyWorkspaceList() {
  const host = getStudyHost(); const available = [];
  for (const bound of host.bindings()) if (await resolveSessionPath(bound.sessionId)) available.push(bound);
  return { projects: host.listProjects(), bindings: available, codeEnabled: process.env.PI_STUDY_TRUSTED_CODE === "1" };
}
export async function readStudySource(sessionId: string, sourceId: string, startLine = 1, limit = 80, assertActive?: () => Promise<void>) {
  const host = getStudyHost(); const project = host.projectForSession(sessionId);
  const source = project.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new StudyError("SOURCE_NOT_FOUND", "Source not in this project manifest");
  const bytes = await readStudyFile(project.root, source);
  const extracted = await extractCourseBuilderMaterial(bytes, source.path);
  if (extracted.metadata?.extraction === "unavailable" || extracted.metadata?.extraction === "image-asset") throw new StudyError("EXTRACTION_UNAVAILABLE", "No reliable text adapter for this source; use its original viewer or provide text");
  // An async extractor must not write after a mode/session change.
  await assertActive?.();
  host.recordSource(sessionId, source.id, project.manifestVersion, sha256Hex(bytes), extracted.extractedText, String(extracted.metadata?.extraction ?? "text"));
  allowFileRoot(project.root);
  return host.readSource(sessionId, sourceId, startLine, limit);
}
export async function reindexStudy(sessionId: string, expectedRevision: number) {
  const host = getStudyHost(); const project = host.projectForSession(sessionId);
  const scan = await scanStudyDirectory(project.root);
  await requireStudyWorkspace(sessionId, true);
  return { project: host.reindex(sessionId, expectedRevision, scan.sources), omitted: scan.omitted };
}
export async function verifyStudySources(sessionId: string) {
  const host = getStudyHost(); const state = host.state(sessionId);
  for (const value of state.sources) {
    const row = value as { sourceId: string; sourceHash: string };
    const source = state.project.sources.find((entry) => entry.id === row.sourceId);
    if (!source || sha256Hex(await readStudyFile(state.project.root, source)) !== row.sourceHash) throw new StudyError("SOURCE_CHANGED", "A read source changed; reindex and revise the plan before execution");
  }
  if (host.projectForSession(sessionId).manifestVersion !== state.project.manifestVersion) throw new StudyError("STALE_SOURCE", "Sources changed during verification");
}
export async function runApprovedStudyExperiment(sessionId: string, experimentId: string, revision: number, signal: AbortSignal) {
  if (process.env.PI_STUDY_TRUSTED_CODE !== "1") throw new StudyError("CODE_DISABLED", "Set PI_STUDY_TRUSTED_CODE=1 only after accepting trusted-local-code execution");
  await verifyStudySources(sessionId);
  await requireStudyWorkspace(sessionId, true);
  const host = getStudyHost(); const plan = host.document<ExperimentPlan>(sessionId, "experiment", experimentId);
  if (plan.revision !== revision) throw new StudyError("REVISION_CONFLICT", "Experiment changed");
  const receipt = host.beginRun(sessionId, experimentId, revision);
  try {
    const result = await runStudyCode(plan.data, { trusted: true, signal, python: process.env.PI_STUDY_PYTHON_PATH, node: process.execPath });
    return host.finishRun(sessionId, receipt.id, result);
  } catch (error) {
    host.finishRun(sessionId, receipt.id, { status: "failed", exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: 0 });
    throw error;
  }
}
export async function studyAgentCommand(sessionId: string, command: Record<string, unknown>, assertActive: () => Promise<void>) {
  if (command.action === "read_source") return readStudySource(sessionId, identifier(command.id), command.startLine === undefined ? 1 : integer(command.startLine, "startLine", 1), command.limit === undefined ? 80 : integer(command.limit, "limit", 1, 200), assertActive);
  await assertActive();
  return getStudyHost().agentCommand(sessionId, command);
}
