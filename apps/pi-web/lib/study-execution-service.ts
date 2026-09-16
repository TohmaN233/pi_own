import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { createNativeWindowsNodeAdapter } from "../../../packages/study-execution-host/src/coordinator.ts";
import { createNativeWindowsCellAdapters, describeNativeCellOutputArtifacts, readNativeCellOutputArtifact } from "../../../packages/study-execution-host/src/cell-native-adapters.ts";
import { createProjectPythonEnvironment, discoverProjectPythonEnvironment, discoverRGlobalLibraryEnvironment } from "../../../packages/study-execution-host/src/environments.ts";
import type { ExecutionQueueJob, ExecutionResourceRequest } from "../../../packages/study-execution-host/src/execution-queue.ts";
import { getLearningHarness } from "./harness-server";
import { freezeStudyCellInputs } from "./study-execution-inputs";
import { studyExecutionResources, validateStudyExecutionResources } from "./study-execution-resources";
import { studyContext } from "./study-research-service";
import { publicStudyError } from "./study-api-request";

export const terminalStudyExecution = (status: string) => ["succeeded", "failed", "cancelled", "limit-reached", "needs-input"].includes(status);

function executionPaths() {
  const dataDirectory = resolve(process.env.PI_LEARNING_HARNESS_DIR || join(getAgentDir(), "learning-harness"));
  return { runRootDirectory: join(dataDirectory, "study-executions"), artifactDirectory: join(dataDirectory, "study-execution-observations") };
}

function coordinatorOptions() {
  const paths = executionPaths();
  return { ...paths, adapters: [createNativeWindowsNodeAdapter({ ...paths, cpuRatePercent: 100 }),
    ...createNativeWindowsCellAdapters({ ...paths, cpuRatePercent: 100 })] };
}

/** Resolve only a pi-web package root; the package ships a relocatable worker with its own native assets. */
async function workerScript() {
  const roots = [resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.cwd()];
  for (const root of roots) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
      if (manifest.name !== "@agegr/pi-web") continue;
      const script = join(root, "runtime", "packages", "study-execution-host", "src", "study-execution-coordinator.mjs");
      await access(script); return script;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Packaged Study execution worker is missing. Run the Study worker packaging step before starting Pi Web.");
}

async function ensureWorker() {
  const paths = executionPaths();
  await mkdir(paths.runRootDirectory, { recursive: true });
  const worker = await getLearningHarness().ensureStudyExecutionCoordinator({ ...paths, scriptPath: await workerScript(), intervalMs: 1000 });
  return { requested: true, status: worker.status };
}

function publicJob(job: ExecutionQueueJob) {
  return { queueJobId: job.queueJobId, taskId: job.taskId, mode: job.mode, status: job.status,
    resources: job.resources, actualUsage: job.actualUsage, createdAt: job.createdAt, updatedAt: job.updatedAt,
    cancellationRequestedAt: job.cancellationRequestedAt,
    failure: job.admissionFailure ? { code: job.admissionFailure.code, message: publicStudyError(job.admissionFailure.message) } : null };
}

export async function studyExecutionState(sessionId: string) {
  const { scope, project } = await studyContext(sessionId);
  const harness = getLearningHarness();
  const jobs = harness.studyExecution.listJobs(scope.projectId).filter((job) => job.dispatchKey.startsWith("cell-run:"));
  const worker = jobs.some(job => !terminalStudyExecution(job.status)) ? await ensureWorker() : null;
  const coordinator = harness.createStudyExecutionCoordinator(coordinatorOptions());
  const runs = jobs.map((job) => {
    const snapshot = harness.studyCells.readRun(scope, job.taskId);
    return { ...publicJob(job), cellId: snapshot.cell.cellId, cellRevision: snapshot.cell.revision, title: snapshot.cell.title,
      language: snapshot.cell.language, result: coordinator.getPublicResult(job.queueJobId) };
  });
  let capacity: ReturnType<typeof studyExecutionResources> | null = null;
  let capacityError: string | null = null;
  try { capacity = studyExecutionResources(project.cwd); }
  catch (error) { console.error("[study-execution] capacity discovery failed", error); capacityError = publicStudyError(error); }
  // Resource pressure blocks new admission while preserving history, output and cancellation controls.
  return { runs, capacity, capacityError, worker, policy: harness.studyExecution.getPolicy() };
}

export type StudyExecutionState = Awaited<ReturnType<typeof studyExecutionState>>;
export type StudyExecutionRun = StudyExecutionState["runs"][number];

export async function runStudyCodeCell(input: {
  sessionId: string; expectedPhaseRevision: number; cellId: string; expectedCellRevision: number;
  requestId: string; resources: ExecutionResourceRequest; rPackages: string[];
}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9-]{16,80}$/u.test(input.requestId)) throw new Error("Invalid execution request ID");
  if (input.rPackages.length > 128 || input.rPackages.some((name) => !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(name))) throw new Error("Invalid R package selection");
  const current = await studyContext(input.sessionId);
  const harness = getLearningHarness();
  const intentHash = contentHash({ cellId: input.cellId, cellRevision: input.expectedCellRevision, resources: input.resources,
    rPackages: [...new Set(input.rPackages)].sort(), phaseRevision: input.expectedPhaseRevision });
  const dispatchKey = `cell-run:${input.requestId}`;
  const replay = harness.replayStudyCellExecution(current.scope, dispatchKey, intentHash);
  if (replay) return { job: publicJob(replay), replay: true, worker: terminalStudyExecution(replay.status) ? null : await ensureWorker() };
  const { scope, project } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const cell = harness.studyCells.get(scope, input.cellId, input.expectedCellRevision);
  if (cell.language === "python" && input.rPackages.length > 0) throw new Error("R package selection does not apply to a Python cell");
  const capacity = studyExecutionResources(project.cwd);
  const resources = validateStudyExecutionResources(input.resources, capacity);
  if (!harness.studyExecution.getPolicy()) harness.studyExecution.configureTrustedPolicy({ maxConcurrentRuns: 1,
    maxCpuMilliCores: capacity.maximum.cpuMilliCores, maxMemoryMiB: capacity.maximum.memoryMiB, leaseDurationMs: 60_000 }, 0);
  const policy = harness.studyExecution.getPolicy();
  if (!policy || resources.cpuMilliCores > policy.maxCpuMilliCores || resources.memoryMiB > policy.maxMemoryMiB) throw new Error("Requested resources exceed the configured shared execution capacity");
  signal?.throwIfAborted();
  const environment = cell.language === "r" ? (await discoverRGlobalLibraryEnvironment({ packageNames: input.rPackages })).environment
    : (await ensureProjectPythonEnvironment(project.cwd)).environment;
  signal?.throwIfAborted();
  const frozen = await freezeStudyCellInputs(input);
  if (frozen.scope.projectId !== scope.projectId) throw new Error("Conversation changed project while preparing execution");
  // Cancellation before this synchronous transaction prevents admission. Once committed,
  // a chat abort cannot silently revoke or kill the independent background run.
  signal?.throwIfAborted();
  const admission = harness.admitStudyCellExecution(frozen.scope, { cellId: cell.cellId, expectedCellRevision: cell.revision,
    dispatchKey, intentHash, resources, environment, inputs: frozen.inputs, coordinatorOptions: coordinatorOptions(),
    // Learning examples have per-run hardware limits and cumulative accounting, but no hidden count/cost budget.
    quota: { maxRuns: Number.MAX_SAFE_INTEGER, maxCumulativeWallTimeMs: Number.MAX_SAFE_INTEGER,
      maxCumulativeDiskBytes: Number.MAX_SAFE_INTEGER, expiresAt: null } });
  console.info("[study-execution] cell admitted", { projectId: scope.projectId, taskId: admission.job.taskId,
    queueJobId: admission.job.queueJobId, cellId: cell.cellId, revision: cell.revision, environmentHash: environment.descriptorHash });
  return { job: publicJob(admission.job), replay: admission.replay, worker: await ensureWorker() };
}

/**
 * Research uses the same frozen cell payload and detached native worker as a
 * learning calculation. Its scoped authorization is checked synchronously by
 * the Harness in the same transaction that reserves the queue job and binds the
 * immutable cell snapshot; callers cannot turn this into a generic shell path.
 */
export async function runResearchCodeCell(input: {
  sessionId: string; expectedPhaseRevision: number; cellId: string; expectedCellRevision: number;
  requestId: string; resources: ExecutionResourceRequest; rPackages: string[];
  quota: { maxRuns: number; maxCumulativeWallTimeMs: number; maxCumulativeDiskBytes: number; expiresAt: string | null };
  research:
    | { mode: "grant"; scopeId: string; planId: string; grantId: string; expectedPlanRevision: number; changeNote: string }
    | { mode: "smoke-learning"; planId: string; expectedPlanRevision: number; changeNote: string };
}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9-]{16,80}$/u.test(input.requestId)) throw new Error("Invalid execution request ID");
  if (input.rPackages.length > 128 || input.rPackages.some((name) => !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(name))) throw new Error("Invalid R package selection");
  if (!input.research.changeNote.trim() || input.research.changeNote.length > 6000) throw new Error("A bounded Research change note is required");
  const current = await studyContext(input.sessionId);
  const harness = getLearningHarness();
  const intentHash = contentHash({ cellId: input.cellId, cellRevision: input.expectedCellRevision, resources: input.resources,
    rPackages: [...new Set(input.rPackages)].sort(), phaseRevision: input.expectedPhaseRevision, research: input.research, quota: input.quota });
  const dispatchKey = `cell-run:research:${input.requestId}`;
  const replay = harness.replayStudyCellExecution(current.scope, dispatchKey, intentHash);
  if (replay) return { job: publicJob(replay), replay: true, worker: terminalStudyExecution(replay.status) ? null : await ensureWorker() };
  const { scope, project, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  if (phase.phase !== "research") throw new Error("Research execution requires the explicitly selected Research phase");
  const cell = harness.studyCells.get(scope, input.cellId, input.expectedCellRevision);
  if (cell.language === "python" && input.rPackages.length > 0) throw new Error("R package selection does not apply to a Python cell");
  const capacity = studyExecutionResources(project.cwd);
  const resources = validateStudyExecutionResources(input.resources, capacity);
  if (input.research.mode === "smoke-learning" && (Object.keys(resources) as Array<keyof ExecutionResourceRequest>).some((key) => resources[key] > capacity.defaults[key]))
    throw new Error("Smoke without an approved scope must stay within the detected small-run defaults; approve a scope for larger resource limits");
  if (!harness.studyExecution.getPolicy()) harness.studyExecution.configureTrustedPolicy({ maxConcurrentRuns: 1,
    maxCpuMilliCores: capacity.maximum.cpuMilliCores, maxMemoryMiB: capacity.maximum.memoryMiB, leaseDurationMs: 60_000 }, 0);
  const policy = harness.studyExecution.getPolicy();
  if (!policy || resources.cpuMilliCores > policy.maxCpuMilliCores || resources.memoryMiB > policy.maxMemoryMiB) throw new Error("Requested resources exceed the configured shared execution capacity");
  signal?.throwIfAborted();
  const environment = cell.language === "r" ? (await discoverRGlobalLibraryEnvironment({ packageNames: input.rPackages })).environment
    : (await ensureProjectPythonEnvironment(project.cwd)).environment;
  signal?.throwIfAborted();
  const frozen = await freezeStudyCellInputs(input);
  if (frozen.scope.projectId !== scope.projectId) throw new Error("Conversation changed project while preparing execution");
  signal?.throwIfAborted();
  const admission = harness.admitStudyCellExecution(frozen.scope, { cellId: cell.cellId, expectedCellRevision: cell.revision,
    dispatchKey, intentHash, resources, environment, inputs: frozen.inputs, coordinatorOptions: coordinatorOptions(), quota: input.quota,
    research: input.research });
  console.info("[study-execution] research cell admitted", { projectId: scope.projectId, taskId: admission.job.taskId,
    queueJobId: admission.job.queueJobId, cellId: cell.cellId, revision: cell.revision, planId: input.research.planId,
    mode: input.research.mode, environmentHash: environment.descriptorHash });
  return { job: publicJob(admission.job), replay: admission.replay, worker: await ensureWorker() };
}

async function ensureProjectPythonEnvironment(projectDirectory: string) {
  const venvDirectory = join(projectDirectory, ".study-python-venv");
  try { await access(venvDirectory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createProjectPythonEnvironment({ projectDirectory });
  }
  return discoverProjectPythonEnvironment({ projectDirectory, venvDirectory });
}

export async function cancelStudyExecution(input: { sessionId: string; expectedPhaseRevision: number; queueJobId: string }) {
  const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
  const harness = getLearningHarness();
  const job = harness.studyExecution.listJobs(scope.projectId).find((item) => item.queueJobId === input.queueJobId && item.dispatchKey.startsWith("cell-run:"));
  if (!job) throw new Error("Execution was not found in this project");
  harness.studyCells.readRun(scope, job.taskId);
  const cancelled = harness.studyExecution.requestCancellation(job.queueJobId);
  return { job: publicJob(cancelled), worker: terminalStudyExecution(cancelled.status) ? null : await ensureWorker() };
}

/** Reconnect a user request or persisted-work watchdog; it never reserves a new scientific run. */
export async function reconnectStudyExecutions(sessionId: string) {
  await studyContext(sessionId);
  return ensureWorker();
}

export async function studyExecutionArtifacts(sessionId: string, queueJobId: string) {
  const { scope } = await studyContext(sessionId);
  const harness = getLearningHarness();
  const job = harness.studyExecution.listJobs(scope.projectId).find((item) => item.queueJobId === queueJobId && item.dispatchKey.startsWith("cell-run:"));
  if (!job) throw new Error("Cell execution was not found in this project");
  harness.studyCells.readRun(scope, job.taskId);
  const handle = harness.studyExecution.getTerminalHandleForTrustedRead(scope, queueJobId);
  if (!handle || handle.publicSummary.preparationPending === true) return [];
  const artifacts = await describeNativeCellOutputArtifacts(handle);
  const latest = await studyContext(sessionId, scope.expectedPhaseRevision);
  if (latest.scope.projectId !== scope.projectId) throw new Error("Conversation changed project while listing output");
  return artifacts;
}

export async function readStudyExecutionArtifact(input: { sessionId: string; queueJobId: string; path: string; sha256: string }) {
  const { scope } = await studyContext(input.sessionId);
  const harness = getLearningHarness();
  const job = harness.studyExecution.listJobs(scope.projectId).find((item) => item.queueJobId === input.queueJobId && item.dispatchKey.startsWith("cell-run:"));
  if (!job) throw new Error("Cell execution was not found in this project");
  harness.studyCells.readRun(scope, job.taskId);
  const handle = harness.studyExecution.getTerminalHandleForTrustedRead(scope, input.queueJobId);
  if (!handle || handle.publicSummary.preparationPending === true) throw new Error("This run has no output artifacts");
  const entries = await describeNativeCellOutputArtifacts(handle);
  const descriptor = entries.find((entry) => entry.path === input.path && entry.sha256 === input.sha256);
  if (!descriptor) throw new Error("Output artifact changed or was not found in this execution");
  const artifact = await readNativeCellOutputArtifact(handle, descriptor);
  const latest = await studyContext(input.sessionId, scope.expectedPhaseRevision);
  if (latest.scope.projectId !== scope.projectId) throw new Error("Conversation changed project while reading output");
  return artifact;
}
