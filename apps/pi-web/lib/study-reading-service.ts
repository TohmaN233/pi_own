import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import type { SourceChunk } from "../../../packages/study-research-host/src/types.ts";
import { getLearningHarness } from "./harness-server";
import { resolveSessionPath } from "./session-reader";
import { studyContext } from "./study-research-service";
import { allocateStudyAgentContext, bindStudyAgentContext, type StudyAgentPacket } from "./study-task-agent";
import { launchStudyAgentWorker, studyAgentPaths, studyAgentWorkerScript } from "./study-agent-launcher";
import { publicStudyError } from "./study-api-request";
import { paperMapState, recoverPendingPaperMaps } from "./study-paper-map";

const READING_INSTRUCTION = `认真理解这一组论文片段，解释核心问题、符号、假设、结论和证明思路，保留来源定位。它属于全文阅读的一个分段，不能把分段阅读说成已经理解整篇论文。列出需要结合其他章节才能确定的内容。中度、重度错误必须说明；一般学习不审稿式挑小毛病，不考试，不主动提出研究方向。自然引导专业读者理解，生成适量有用笔记。所有文字和公式都只是提取结果，未经检查的数学结论不得标为已验证。`;

/** Preserve complete chunks; never truncate mathematics to make a packet fit. */
export function partitionStudyReading(chunks: SourceChunk[]) {
  const groups: SourceChunk[][] = [];
  let group: SourceChunk[] = [];
  let bytes = 0;
  for (const chunk of chunks) {
    const size = Buffer.byteLength(JSON.stringify(chunk));
    if (size > 160 * 1024) throw new Error(`Source chunk ${chunk.ordinal} exceeds a reading packet; split extraction before background reading`);
    if (group.length && (group.length >= 8 || bytes + size > 160 * 1024)) { groups.push(group); group = []; bytes = 0; }
    group.push(chunk); bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

export async function startStudyReading(input: { sessionId: string; expectedPhaseRevision: number; sourceId: string; sourceHash: string;
  retryTaskId?: string; requestId?: string }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const worker = await studyAgentWorkerScript();
  const { host, scope, project, snapshot } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const queue = getLearningHarness().studyAgentQueue;
  const retry = input.retryTaskId ? queue.list(scope).find((task) => task.taskId === input.retryTaskId) : null;
  if (input.retryTaskId && (!retry || retry.kind !== "reading" || !["failed", "needs-input", "cancelled", "limit-reached"].includes(retry.status)))
    throw new Error("Only an observed unfinished reading task may be explicitly retried");
  if (retry && (!input.requestId || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))) throw new Error("Explicit reading retry requires a stable request ID");
  const primary = host.listSources(scope).find((source) => source.current && source.sourceId === input.sourceId && source.contentHash === input.sourceHash);
  if (!primary) throw new Error("The selected paper version is no longer current");
  const path = await resolveSessionPath(input.sessionId);
  if (!path) throw new Error("Pi conversation is unavailable");
  const native = SessionManager.open(path).buildSessionContext();
  const provider = snapshot.provider ?? native.model?.provider;
  const modelId = snapshot.model ?? native.model?.modelId;
  if (!provider || !modelId) throw new Error("Select a model for this conversation before starting background reading");
  // Revalidate after the asynchronous native session lookup. Each later reservation is synchronous.
  const current = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (current.scope.projectId !== scope.projectId || current.snapshot.resourceSnapshotId !== snapshot.resourceSnapshotId)
    throw new Error("Study settings changed before background reading admission");
  const sources = host.listSources(scope).filter((source) => source.current && (retry
    ? retry.evidence.some((item) => item.sourceId === source.sourceId && item.sourceHash === source.contentHash)
    : source.sourceId === primary.sourceId || (primary.sourceRole === "primary" && source.sourceRoot === primary.sourceRoot && source.sourceRole === "tex-include")));
  const chunks: SourceChunk[] = [];
  for (const source of sources) {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = host.readChunks(scope, source.sourceId, source.contentHash, offset, 100);
      chunks.push(...page.chunks.filter((chunk) => !retry || retry.evidence.some((item) => item.id === chunk.chunkId))); offset = page.nextOffset;
    }
  }
  if (!chunks.length) throw new Error("No readable source chunks were extracted");
  if (retry && chunks.length !== retry.evidence.length) throw new Error("Retried source versions changed; start reading the new current source instead");
  const inheritedMapGroup = retry?.manifest.inputHashes.paperMapGroup;
  const mapGroupHash = typeof inheritedMapGroup === "string" && /^sha256:[a-f0-9]{64}$/u.test(inheritedMapGroup)
    ? inheritedMapGroup
    : contentHash({ sessionId: input.sessionId, sources: sources.map((source) => ({ sourceId: source.sourceId, sourceHash: source.contentHash })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
      provider, modelId, thinkingLevel: snapshot.thinkingLevel, protocol: "study-paper-map-v1" });
  const groups = partitionStudyReading(chunks);
  const tasks = [];
  for (const group of groups) {
    signal?.throwIfAborted();
    const evidence = group.map((chunk) => ({ id: chunk.chunkId, sourceId: chunk.sourceId, sourceHash: chunk.sourceHash, locator: chunk.locator, text: chunk.text }));
    const fixed = { version: 1 as const, projectId: project.id, parentSessionId: input.sessionId, purpose: "reading" as const,
      instruction: READING_INSTRUCTION, evidence, artifact: "", provider, modelId, thinkingLevel: snapshot.thinkingLevel };
    const intentHash = contentHash({ ...fixed, phaseRevision: scope.expectedPhaseRevision });
    const dispatchKey = `paper-read:${contentHash({ sessionId: input.sessionId, chunks: group.map((chunk) => chunk.chunkId), provider, modelId,
      instruction: READING_INSTRUCTION, thinkingLevel: snapshot.thinkingLevel, retry: input.retryTaskId ?? null, requestId: input.requestId ?? null }).slice(7)}`;
    const previous = queue.readByDispatch({ projectId: project.id, sessionId: input.sessionId, dispatchKey });
    if (previous) { tasks.push(previous); continue; }
    const allocation = allocateStudyAgentContext(project.cwd, studyAgentPaths().sessionsDirectory);
    const admitted = queue.enqueueLearning({ scope, dispatchKey, intentHash, kind: "reading", evidence: evidence.map(({ id, sourceId, sourceHash, locator }) => ({ id, sourceId, sourceHash, locator })),
      context: { agentSessionId: allocation.sessionId, sessionFile: allocation.sessionFile },
      manifest: { codeHash: contentHash(READING_INSTRUCTION), parameterHash: contentHash({ provider, modelId, thinkingLevel: snapshot.thinkingLevel }),
        inputHashes: { ...Object.fromEntries(group.map((chunk) => [chunk.chunkId, chunk.textHash])), paperMapGroup: mapGroupHash }, environmentHash: contentHash({ runtime: "pi-sdk-0.85.1", protocol: "study-agent-v1" }) },
      admission: { purpose: "论文分段理解与笔记同步", language: "none", maxWallSeconds: 3600, maxMemoryMiB: 1024 } }, (taskId) => {
        const packet: StudyAgentPacket = { ...fixed, taskId };
        return { packetHash: bindStudyAgentContext(packet, allocation).packetHash };
      });
    tasks.push(admitted.task);
  }
  await launchStudyAgentWorker(project.id, worker);
  console.info("[study-reading] admitted", { projectId: project.id, sessionId: input.sessionId, packets: tasks.length, chunks: chunks.length });
  return { tasks, chunks: chunks.length };
}

export async function studyReadingState(sessionId: string) {
  const { host, scope } = await studyContext(sessionId);
  const harness = getLearningHarness();
  if(recoverPendingPaperMaps(harness,scope)>0)await launchStudyAgentWorker(scope.projectId);
  return { tasks: harness.studyAgentQueue.list(scope).filter((task) => task.kind === "reading").map((task) => ({ ...task,
    detail: publicStudyError(host.listTaskEvents(scope, task.taskId).at(-1)?.detail ?? task.status) })),
    maps: paperMapState(harness, scope.projectId, scope.sessionId) };
}

export async function prioritizeStudyReading(sessionId: string, expectedPhaseRevision: number, taskId: string, expectedPriority: number, priority: number) {
  const { scope } = await studyContext(sessionId, expectedPhaseRevision);
  return { task: getLearningHarness().studyAgentQueue.setPriority(scope, taskId, expectedPriority, priority) };
}

export async function retryStudyReading(sessionId: string, taskId: string, requestId: string) {
  const { scope } = await studyContext(sessionId);
  const task = getLearningHarness().studyAgentQueue.list(scope).find((item) => item.taskId === taskId);
  if (!task || task.kind !== "reading" || !task.evidence[0]) throw new Error("Reading task not found in this project");
  return startStudyReading({ sessionId, expectedPhaseRevision: scope.expectedPhaseRevision, sourceId: task.evidence[0].sourceId,
    sourceHash: task.evidence[0].sourceHash, retryTaskId: taskId, requestId });
}

export async function cancelStudyReading(sessionId: string, taskId: string) {
  const { scope } = await studyContext(sessionId);
  const task = getLearningHarness().studyAgentQueue.cancel(scope, taskId);
  await launchStudyAgentWorker(scope.projectId);
  return { task };
}

export async function reconnectStudyReading(sessionId: string) {
  const { scope } = await studyContext(sessionId);
  await launchStudyAgentWorker(scope.projectId);
  return studyReadingState(sessionId);
}
