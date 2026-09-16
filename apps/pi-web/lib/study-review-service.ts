import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import type { StudyAgentReportTarget } from "../../../packages/study-research-host/src/types.ts";
import { getLearningHarness } from "./harness-server";
import { resolveSessionPath } from "./session-reader";
import { studyContext } from "./study-research-service";
import { allocateStudyAgentContext, bindStudyAgentContext, type StudyAgentEvidence, type StudyAgentPacket } from "./study-task-agent";
import { launchStudyAgentWorker, studyAgentPaths, studyAgentWorkerScript } from "./study-agent-launcher";
import { studyVisualRuntimeIdentity } from "./study-visual-sandbox";

export interface StudyReviewSourceSelection {
  sourceId: string;
  sourceHash: string;
  chunkId: string;
  offset: number;
}

export interface StartStudyReviewInput {
  sessionId: string;
  expectedPhaseRevision: number;
  target: StudyAgentReportTarget;
  scope: string;
  sources: StudyReviewSourceSelection[];
  requestId: string;
  /** Optional reviewer selection; this never changes the parent conversation's model. */
  model?: { provider: string; modelId: string };
}

/** One fresh Pi context, exact artifact version, explicit source scope, no creator transcript. */
export async function startStudyIndependentReview(input: StartStudyReviewInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw new Error("Review requires a stable request ID");
  if (!input.scope.trim() || input.scope.length > 6000) throw new Error("State the bounded review scope");
  if (!Array.isArray(input.sources) || input.sources.length > 20 || (input.sources.length === 0 && input.target.targetKind !== "result")) throw new Error("Select 1–20 located source fragments, or review a result with its exact frozen origin");
  const worker = await studyAgentWorkerScript();
  const initial = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const path = await resolveSessionPath(input.sessionId);
  if (!path) throw new Error("Original Pi conversation is unavailable");
  const native = SessionManager.open(path).buildSessionContext();
  const provider = input.model?.provider ?? initial.snapshot.provider ?? native.model?.provider;
  const modelId = input.model?.modelId ?? initial.snapshot.model ?? native.model?.modelId;
  if (!provider?.trim() || !modelId?.trim() || provider.length > 256 || modelId.length > 256) throw new Error("Select an available independent review model");
  const { host, scope, project, snapshot } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (project.id !== initial.project.id || snapshot.resourceSnapshotId !== initial.snapshot.resourceSnapshotId)
    throw new Error("Conversation configuration changed during review preparation");
  const artifact = input.target.targetKind === "visualization" ? host.getVisualizationDraft(scope, input.target.targetId)
    : input.target.targetKind === "result" ? host.getResult(scope, input.target.targetId) : null;
  if (!artifact || artifact.contentHash !== input.target.targetHash || artifact.revision !== input.target.targetRevision)
    throw new Error("Review target changed; select its current version");
  const currentSources = host.listSources(scope).filter((source) => source.current);
  const evidence: StudyAgentEvidence[] = input.sources.map((selection) => {
    if (!Number.isSafeInteger(selection.offset) || selection.offset < 0 || !currentSources.some((source) => source.sourceId === selection.sourceId && source.contentHash === selection.sourceHash))
      throw new Error("Review source is not a current project source");
    const chunk = host.readChunks(scope, selection.sourceId, selection.sourceHash, selection.offset, 1).chunks[0];
    if (!chunk || chunk.chunkId !== selection.chunkId) throw new Error("Review fragment does not match its observed location");
    return { id: chunk.chunkId, sourceId: chunk.sourceId, sourceHash: chunk.sourceHash, locator: chunk.locator, text: chunk.text };
  });
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) throw new Error("Review fragments must be unique");
  host.assertStudyAgentReviewEvidence(scope, evidence.map(({ id, sourceId, sourceHash, locator }) => ({ id, sourceId, sourceHash, locator })), input.target);
  const resultEvidence = evidence.length === 0 && input.target.targetKind === "result"
    ? { resultId: input.target.targetId, revision: input.target.targetRevision, contentHash: input.target.targetHash } : undefined;
  const checks = host.listValidations(scope, input.target);
  const browserChecks = input.target.targetKind === "visualization" ? getLearningHarness().studyTeaching.visualGate(scope,input.target.targetId,contentHash(studyVisualRuntimeIdentity())).interactions : [];
  const artifactText = JSON.stringify({ target: input.target, artifact, programmaticChecks: checks,
    browserChecks,
    limitations: "Only the explicitly supplied source fragments are in this review. Missing validation, omitted context and unresolved assumptions must remain visible; model agreement is not proof." });
  const instruction = `独立审查这一精确版本，范围：${input.scope}。核对原文、数学含义、适用假设、数值验证的独立性和误导风险。中度/重度缺陷必须说明；未知不能标为通过。没有实际程序检查不能替它编造通过结果。只报告范围内结论，不发布、不代替用户确认，不将模型一致当作证明。`;
  const fixed = { version: 1 as const, projectId: project.id, parentSessionId: input.sessionId, purpose: "review" as const,
    instruction, artifact: artifactText, evidence, ...(resultEvidence ? { resultEvidence } : {}), provider, modelId, thinkingLevel: snapshot.thinkingLevel };
  // Leave room for Host task identity and packet serialization; never truncate code or mathematical sources.
  if (Buffer.byteLength(JSON.stringify(fixed)) > 240 * 1024) throw new Error("Review packet exceeds its bound; narrow source scope or split the artifact before review");
  const queue = getLearningHarness().studyAgentQueue;
  const dispatchKey = `independent-review:${input.requestId}`;
  const intentHash = contentHash({ ...fixed, target: input.target, phaseRevision: scope.expectedPhaseRevision });
  const previous = queue.readByDispatch({ projectId: project.id, sessionId: input.sessionId, dispatchKey });
  if (previous) {
    if (previous.intentHash !== intentHash) throw new Error("Review request ID was reused with changed content");
    await launchStudyAgentWorker(project.id, worker);
    return { task: previous, replay: true };
  }
  signal?.throwIfAborted();
  const allocation = allocateStudyAgentContext(project.cwd, studyAgentPaths().sessionsDirectory);
  const result = queue.enqueueLearning({ scope, dispatchKey, intentHash, kind: "review", target: input.target,
    evidence: evidence.map(({ id, sourceId, sourceHash, locator }) => ({ id, sourceId, sourceHash, locator })),
    context: { sessionFile: allocation.sessionFile, agentSessionId: allocation.sessionId },
    manifest: { codeHash: contentHash(instruction), parameterHash: contentHash({ provider, modelId, thinkingLevel: snapshot.thinkingLevel, target: input.target }),
      inputHashes: { artifact: contentHash(artifactText), ...(input.target.targetKind === "visualization" ? { visualEvidence: contentHash({ programmaticChecks: checks, browserChecks }) } : {}), ...Object.fromEntries(evidence.map((item) => [item.id, contentHash(item.text)])) },
      environmentHash: contentHash({ runtime: "pi-sdk-0.85.1", protocol: "study-independent-review-v1" }) },
    admission: { purpose: "指定论文成果的独立审查", language: "none", maxWallSeconds: 3600, maxMemoryMiB: 1024 } }, (taskId) => {
      const packet: StudyAgentPacket = { ...fixed, taskId };
      return { packetHash: bindStudyAgentContext(packet, allocation).packetHash };
    });
  await launchStudyAgentWorker(project.id, worker);
  console.info("[study-review] admitted", { projectId: project.id, taskId: result.task.taskId, target: input.target, model: { provider, modelId } });
  return result;
}

export async function studyIndependentReviewState(sessionId: string) {
  const { host, scope } = await studyContext(sessionId);
  return { tasks: getLearningHarness().studyAgentQueue.list(scope).filter((task) => task.kind === "review"),
    reviews: host.listIndependentReviews(scope) };
}
