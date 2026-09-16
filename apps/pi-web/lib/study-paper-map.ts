import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import type { LearningHarness } from "../../../packages/learning-harness/src/index.ts";
import type {
  Scope,
  SourceReference,
  StudyAgentQueueTask,
  StudyPaperMap,
  StudyPaperMapCoverage,
  StudyPaperMapReportReference,
} from "../../../packages/study-research-host/src/types.ts";
import { allocateStudyAgentContext, bindStudyAgentContext, inspectStudyAgentContext, type StudyAgentPaperMapPacket, type StudyAgentPaperMapSections, type StudyAgentPacket } from "./study-task-agent";
import { studyAgentPaths } from "./study-agent-launcher";

export const PAPER_MAP_ARTIFACT_KIND = "study-paper-map/v1";
export const PAPER_MAP_INSTRUCTION = "基于已完成的、带哈希的论文阅读报告，生成整篇论文学习地图。必须综合论证关系，不能拼接标题或把分段阅读说成通读。严格区分已阅读、数学上已验证和仍未解决的内容；没有报告支持的内容必须保留为不确定。输出五个结构化部分：问题、贡献、假设与符号、论证与依赖、限制与未解决问题。不要出题或提出研究方向。";

const MAX_REDUCTION_INPUT_BYTES = 140 * 1024;
const MAX_REDUCTION_INPUTS = 4;

type TerminalMapOmission = StudyPaperMapCoverage["unavailableReadingTasks"][number];

interface PaperMapInput {
  reference: StudyPaperMapReportReference;
  report: unknown;
}

export interface PaperMapPlan {
  mapGroupHash: string;
  rootInputHash: string;
  sourceScope: SourceReference[];
  coverage: StudyPaperMapCoverage;
  inputs: PaperMapInput[];
  ready: boolean;
  sourceCurrent: boolean;
}

interface PaperMapArtifact {
  kind: typeof PAPER_MAP_ARTIFACT_KIND;
  mapGroupHash: string;
  rootInputHash: string;
  level: number;
  final: boolean;
  sourceScope: SourceReference[];
  coverage: { totalReadingTasks: number; completedReadingTasks: number; unavailableReadingTasks: number };
  inputReports: Array<StudyPaperMapReportReference & { report: unknown }>;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function mapGroup(task: StudyAgentQueueTask): string | null {
  const value = task.manifest.inputHashes.paperMapGroup;
  return isHash(value) ? value : null;
}

function sourceKey(source: Pick<SourceReference, "sourceId" | "contentHash">): string {
  return `${source.sourceId}\0${source.contentHash}`;
}

function reportReference(task: StudyAgentQueueTask): StudyPaperMapReportReference {
  if (!task.report) throw new Error("Paper-map input report is missing");
  if (task.kind !== "reading" && task.kind !== "paper-map") throw new Error("Paper-map input task has an invalid kind");
  return { taskId: task.taskId, reportHash: task.report.reportHash, kind: task.kind };
}

function taskAfter(left: StudyAgentQueueTask, right: StudyAgentQueueTask): boolean {
  return left.updatedAt > right.updatedAt || (left.updatedAt === right.updatedAt && left.taskId > right.taskId);
}

function selectedReadingTasks(tasks: readonly StudyAgentQueueTask[], group: string): StudyAgentQueueTask[] {
  const selected = new Map<string, StudyAgentQueueTask>();
  for (const task of tasks) {
    if (task.kind !== "reading" || mapGroup(task) !== group) continue;
    for (const evidence of task.evidence) {
      const previous = selected.get(evidence.id);
      if (!previous || taskAfter(task, previous)) selected.set(evidence.id, task);
    }
  }
  return Array.from(new Map(Array.from(selected.values()).map((task) => [task.taskId, task])).values())
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function isTerminal(status: StudyAgentQueueTask["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(status);
}

function reportInput(task: StudyAgentQueueTask): PaperMapInput {
  if (!task.report) throw new Error("Paper-map input report is missing");
  return {
    reference: reportReference(task),
    report: {
      summary: task.report.summary,
      outcome: task.report.outcome,
      findings: task.report.findings,
      notes: task.report.notes,
      unresolved: task.report.unresolved,
      ...(task.report.paperMap ? { paperMap: task.report.paperMap.sections } : {}),
    },
  };
}

function fitsReductionInput(input: PaperMapInput): boolean {
  return Buffer.byteLength(JSON.stringify(input)) <= MAX_REDUCTION_INPUT_BYTES;
}

function currentScope(harness: LearningHarness, projectId: string, sessionId: string): Scope {
  const phase = harness.studyResearch.currentPhase(projectId, sessionId);
  if (!phase) throw new Error("Paper-map session is no longer bound to its project");
  return { projectId, sessionId, expectedPhaseRevision: phase.revision };
}

/**
 * Builds the exact current input snapshot without retaining source full text.
 * Failed, missing, and oversized reports remain in coverage rather than being
 * silently dropped from a partial map.
 */
export function buildPaperMapPlan(harness: LearningHarness, projectId: string, sessionId: string, group: string): PaperMapPlan {
  if (!isHash(group)) throw new Error("Paper-map group hash is invalid");
  const scope = currentScope(harness, projectId, sessionId);
  const allTasks = harness.studyAgentQueue.listProjectTasks(projectId, sessionId)
    .filter((task) => task.authorization.sessionId === sessionId);
  const reading = selectedReadingTasks(allTasks, group);
  const sources = new Map<string, SourceReference>();
  for (const task of reading) for (const evidence of task.evidence) {
    const source = { sourceId: evidence.sourceId, contentHash: evidence.sourceHash };
    sources.set(sourceKey(source), source);
  }
  const sourceScope = Array.from(sources.values()).sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.contentHash.localeCompare(right.contentHash));
  const current = harness.studyResearch.listSources(scope).filter((source) => source.current);
  const sourceCurrent = sourceScope.length > 0 && sourceScope.every((source) => current.some((candidate) => candidate.sourceId === source.sourceId && candidate.contentHash === source.contentHash));
  const completedReadingTaskIds: string[] = [];
  const unavailableReadingTasks: TerminalMapOmission[] = [];
  const inputs: PaperMapInput[] = [];
  let ready = reading.length > 0;
  for (const task of reading) {
    if (!isTerminal(task.status)) { ready = false; continue; }
    if (task.status !== "succeeded" || !task.report) {
      const status = task.status === "succeeded" ? "missing-report" : task.status;
      if (status !== "failed" && status !== "cancelled" && status !== "limit-reached" && status !== "needs-input" && status !== "missing-report") {
        throw new Error("Paper-map coverage has a non-terminal task");
      }
      unavailableReadingTasks.push({ taskId: task.taskId, status });
      continue;
    }
    const input = reportInput(task);
    if (!fitsReductionInput(input)) {
      unavailableReadingTasks.push({ taskId: task.taskId, status: "oversized-report" });
      continue;
    }
    completedReadingTaskIds.push(task.taskId);
    inputs.push(input);
  }
  const coverage: StudyPaperMapCoverage = {
    totalReadingTasks: reading.length,
    completedReadingTaskIds: completedReadingTaskIds.sort(),
    unavailableReadingTasks: unavailableReadingTasks.sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
  const rootInputHash = contentHash({
    mapGroupHash: group,
    sourceScope,
    reading: reading.map((task) => ({ taskId: task.taskId, status: task.status, reportHash: task.report?.reportHash ?? null })),
    coverage,
  });
  return { mapGroupHash: group, rootInputHash, sourceScope, coverage, inputs, ready, sourceCurrent };
}

function partition(inputs: readonly PaperMapInput[]): PaperMapInput[][] {
  const groups: PaperMapInput[][] = [];
  let group: PaperMapInput[] = [];
  let bytes = 0;
  for (const input of inputs) {
    const size = Buffer.byteLength(JSON.stringify(input));
    if (size > MAX_REDUCTION_INPUT_BYTES) throw new Error("Paper-map report exceeds the bounded reduction input size");
    if (group.length && (group.length >= MAX_REDUCTION_INPUTS || bytes + size > MAX_REDUCTION_INPUT_BYTES)) {
      groups.push(group); group = []; bytes = 0;
    }
    group.push(input); bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

export function parsePaperMapArtifact(value: string): PaperMapArtifact {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Paper-map artifact is invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Paper-map artifact must be an object");
  const artifact = parsed as PaperMapArtifact;
  if (artifact.kind !== PAPER_MAP_ARTIFACT_KIND || !isHash(artifact.mapGroupHash) || !isHash(artifact.rootInputHash) ||
    !Number.isSafeInteger(artifact.level) || artifact.level < 0 || artifact.level > 64 || typeof artifact.final !== "boolean" ||
    !Array.isArray(artifact.sourceScope) || artifact.sourceScope.length === 0 || !Array.isArray(artifact.inputReports) || artifact.inputReports.length === 0) {
    throw new Error("Paper-map artifact has an invalid shape");
  }
  for (const source of artifact.sourceScope) if (!source || typeof source.sourceId !== "string" || !isHash(source.contentHash)) throw new Error("Paper-map artifact has an invalid source scope");
  for (const input of artifact.inputReports) {
    if (!input || typeof input.taskId !== "string" || !isHash(input.reportHash) || (input.kind !== "reading" && input.kind !== "paper-map") || !("report" in input)) {
      throw new Error("Paper-map artifact has an invalid input report");
    }
  }
  return artifact;
}

function makeArtifact(plan: PaperMapPlan, level: number, final: boolean, inputs: readonly PaperMapInput[]): PaperMapArtifact {
  return {
    kind: PAPER_MAP_ARTIFACT_KIND,
    mapGroupHash: plan.mapGroupHash,
    rootInputHash: plan.rootInputHash,
    level,
    final,
    sourceScope: structuredClone(plan.sourceScope),
    coverage: {
      totalReadingTasks: plan.coverage.totalReadingTasks,
      completedReadingTasks: plan.coverage.completedReadingTaskIds.length,
      unavailableReadingTasks: plan.coverage.unavailableReadingTasks.length,
    },
    inputReports: inputs.map((input) => ({ ...input.reference, report: structuredClone(input.report) })),
  };
}

function mapTaskForArtifact(tasks: readonly StudyAgentQueueTask[], artifact: PaperMapArtifact): StudyAgentQueueTask | null {
  const key = dispatchKey(artifact);
  return tasks.find((task) => task.dispatchKey === key) ?? null;
}

function dispatchKey(artifact: PaperMapArtifact): string {
  return `paper-map:${contentHash({ rootInputHash: artifact.rootInputHash, level: artifact.level, final: artifact.final,
    inputs: artifact.inputReports.map(({ taskId, reportHash, kind }) => ({ taskId, reportHash, kind })) }).slice(7)}`;
}

function taskInput(task: StudyAgentQueueTask): PaperMapInput {
  if (task.kind !== "paper-map" || task.status !== "succeeded" || !task.report?.paperMap) throw new Error("Paper-map reduction output is unavailable");
  return reportInput(task);
}

function enqueueReduction(input: {
  harness: LearningHarness;
  scope: Scope;
  cwd: string;
  provider: string;
  modelId: string;
  thinkingLevel: StudyAgentPacket["thinkingLevel"];
  artifact: PaperMapArtifact;
}): StudyAgentQueueTask {
  const queue = input.harness.studyAgentQueue;
  const dispatch = dispatchKey(input.artifact);
  const existing = queue.readByDispatch({ projectId: input.scope.projectId, sessionId: input.scope.sessionId, dispatchKey: dispatch });
  if (existing) return existing;
  const allocation = allocateStudyAgentContext(input.cwd, studyAgentPaths().sessionsDirectory);
  const serializedArtifact = JSON.stringify(input.artifact);
  const fixed = {
    version: 2 as const,
    projectId: input.scope.projectId,
    parentSessionId: input.scope.sessionId,
    purpose: "paper-map" as const,
    instruction: PAPER_MAP_INSTRUCTION,
    evidence: [] as [],
    artifact: serializedArtifact,
    provider: input.provider,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel,
  };
  const admitted = queue.enqueueLearning({
    scope: input.scope,
    dispatchKey: dispatch,
    intentHash: contentHash({ fixed, phaseRevision: input.scope.expectedPhaseRevision }),
    kind: "paper-map",
    evidence: [],
    context: { agentSessionId: allocation.sessionId, sessionFile: allocation.sessionFile },
    manifest: {
      codeHash: contentHash(PAPER_MAP_INSTRUCTION),
      parameterHash: contentHash({ provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel }),
      inputHashes: { paperMapRoot: input.artifact.rootInputHash, paperMapArtifact: contentHash(serializedArtifact) },
      environmentHash: contentHash({ runtime: "pi-sdk-0.85.1", protocol: "study-paper-map-v1" }),
    },
    admission: { purpose: "论文全文学习地图综合", language: "none", maxWallSeconds: 3600, maxMemoryMiB: 1024 },
  }, (taskId) => {
    const packet: StudyAgentPaperMapPacket = { ...fixed, taskId };
    return { packetHash: bindStudyAgentContext(packet, allocation).packetHash };
  });
  return admitted.task;
}

/**
 * Idempotently add the next bounded reduction layer. It runs only in the
 * trusted worker after a report commit; the parent Pi conversation is never
 * prompted by this function.
 */
export function ensurePaperMap(input: {
  harness: LearningHarness;
  projectId: string;
  sessionId: string;
  cwd: string;
  packet: StudyAgentPacket;
  mapGroupHash?: string;
}): { plan: PaperMapPlan | null; enqueued: number } {
  const group = input.packet.version === 2 ? parsePaperMapArtifact(input.packet.artifact).mapGroupHash : input.mapGroupHash ?? null;
  const taskGroup = group;
  if (!taskGroup) return { plan: null, enqueued: 0 };
  const plan = buildPaperMapPlan(input.harness, input.projectId, input.sessionId, taskGroup);
  if (!plan.ready || !plan.sourceCurrent || plan.inputs.length === 0) return { plan, enqueued: 0 };
  const scope = currentScope(input.harness, input.projectId, input.sessionId);
  const provider = input.packet.provider, modelId = input.packet.modelId, thinkingLevel = input.packet.thinkingLevel;
  let units = plan.inputs;
  let level = 0;
  let enqueued = 0;
  for (;;) {
    const groups = partition(units);
    const currentTasks = input.harness.studyAgentQueue.listProjectTasks(input.projectId, input.sessionId);
    const outputs: StudyAgentQueueTask[] = [];
    for (const groupInputs of groups) {
      const artifact = makeArtifact(plan, level, groups.length === 1, groupInputs);
      const existing = mapTaskForArtifact(currentTasks, artifact);
      const task = existing ?? enqueueReduction({ harness: input.harness, scope, cwd: input.cwd, provider, modelId, thinkingLevel, artifact });
      if (!existing) enqueued++;
      outputs.push(task);
    }
    if (groups.length === 1) return { plan, enqueued };
    if (!outputs.every((task) => task.status === "succeeded" && task.report?.paperMap)) return { plan, enqueued };
    units = outputs.map(taskInput);
    level++;
  }
}

/** Attach trusted provenance to the model's five sections after the frozen reduction has been revalidated. */
export function completePaperMapReport(input: {
  harness: LearningHarness;
  packet: StudyAgentPacket;
  projectId: string;
  sessionId: string;
  sections: StudyAgentPaperMapSections;
}): StudyPaperMap {
  if (input.packet.version !== 2) throw new Error("Only a versioned paper-map packet can save a paper map");
  const artifact = parsePaperMapArtifact(input.packet.artifact);
  const plan = buildPaperMapPlan(input.harness, input.projectId, input.sessionId, artifact.mapGroupHash);
  if (!plan.ready || !plan.sourceCurrent || plan.rootInputHash !== artifact.rootInputHash) {
    throw new Error("Paper-map input is no longer current; a new reduction is required");
  }
  const tasks = input.harness.studyAgentQueue.listProjectTasks(input.projectId, input.sessionId);
  for (const reference of artifact.inputReports) {
    const task = tasks.find((candidate) => candidate.taskId === reference.taskId);
    if (!task || task.kind !== reference.kind || task.report?.reportHash !== reference.reportHash) {
      throw new Error("Paper-map reduction input report changed before completion");
    }
  }
  return {
    version: 1,
    mapGroupHash: artifact.mapGroupHash,
    rootInputHash: artifact.rootInputHash,
    level: artifact.level,
    final: artifact.final,
    sourceScope: structuredClone(plan.sourceScope),
    coverage: structuredClone(plan.coverage),
    inputReports: artifact.inputReports.map(({ taskId, reportHash, kind }) => ({ taskId, reportHash, kind })),
    sections: structuredClone(input.sections),
  };
}

export function paperMapState(harness: LearningHarness, projectId: string, sessionId: string) {
  const tasks = harness.studyAgentQueue.listProjectTasks(projectId, sessionId)
    .filter((task) => task.authorization.sessionId === sessionId);
  const groups = Array.from(new Set(tasks.filter((task) => task.kind === "reading").map(mapGroup).filter((value): value is string => value !== null)));
  return groups.map((group) => {
    const plan = buildPaperMapPlan(harness, projectId, sessionId, group);
    const finals = tasks.filter((task) => task.kind === "paper-map" && task.status === "succeeded" && task.report?.paperMap && task.report.paperMap.final && task.report.paperMap.mapGroupHash === group)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const map = finals.find((task) => task.report?.paperMap?.rootInputHash === plan.rootInputHash) ?? null;
    const historical = finals.filter((task) => task.report?.paperMap?.rootInputHash !== plan.rootInputHash)
      .map((task) => ({ task, paperMap: task.report?.paperMap ?? null }));
    const reductions = tasks.filter(task => task.kind === "paper-map" && task.manifest.inputHashes.paperMapRoot === plan.rootInputHash);
    return { map: map ? { task: map, paperMap: map.report?.paperMap ?? null } : null, historical, reductions, plan: {
      mapGroupHash: plan.mapGroupHash,
      rootInputHash: plan.rootInputHash,
      ready: plan.ready,
      sourceCurrent: plan.sourceCurrent,
      coverage: plan.coverage,
    } };
  });
}

/** Recover the commit-to-synthesis gap, including a last failed/cancelled reading, without rereading source. */
export function recoverPendingPaperMaps(harness:LearningHarness,scope:Scope):number {
  const tasks=harness.studyAgentQueue.listProjectTasks(scope.projectId,scope.sessionId);
  let enqueued=0;
  for(const state of paperMapState(harness,scope.projectId,scope.sessionId)) {
    if(state.map||!state.plan.ready||!state.plan.sourceCurrent)continue;
    const completed=tasks.find(task=>task.sessionId===scope.sessionId&&task.kind==="reading"&&task.status==="succeeded"&&task.manifest.inputHashes.paperMapGroup===state.plan.mapGroupHash);
    if(!completed)continue;
    const context=harness.studyAgentQueue.readCompletedReadingContextForTrustedSynthesis(scope,completed.taskId);
    const observed=inspectStudyAgentContext(context.sessionFile,{sessionId:context.agentSessionId,packetHash:completed.context.packetHash});
    if(observed.packet.taskId!==completed.taskId||observed.packet.projectId!==scope.projectId||observed.packet.parentSessionId!==scope.sessionId||observed.packet.purpose!=="reading")throw new Error("Paper-map recovery packet ownership mismatch");
    enqueued+=ensurePaperMap({harness,projectId:scope.projectId,sessionId:scope.sessionId,cwd:paperMapCwd(context.sessionFile),packet:observed.packet,mapGroupHash:state.plan.mapGroupHash}).enqueued;
  }
  return enqueued;
}

/** The worker supplies its frozen context CWD so map admission never receives a browser-controlled path. */
export function paperMapCwd(sessionFile: string): string {
  return SessionManager.open(sessionFile).getCwd();
}
