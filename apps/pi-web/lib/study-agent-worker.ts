import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LearningHarness } from "../../../packages/learning-harness/src/index.ts";
import type { StudyAgentClaim, StudyAgentWorkerClaimInput } from "../../../packages/study-research-host/src/types.ts";
import { inspectStudyAgentContext, openStudyTaskAgent, type StudyTaskAgent } from "./study-task-agent";
import { publicStudyError } from "./study-api-request";
import { contentHash, sha256Hex } from "../../../packages/harness-core/src/index.ts";
import { completePaperMapReport, ensurePaperMap, paperMapCwd, parsePaperMapArtifact, recoverPendingPaperMaps } from "./study-paper-map";

export interface StudyAgentWorkerOptions {
  harness: LearningHarness;
  projectId: string;
  agentDir: string;
  workerId?: string;
  /** In-process test seam. Production always uses the configured native Pi runtime. */
  createRuntime?: () => Promise<ModelRuntime>;
  openAgent?: typeof openStudyTaskAgent;
}

/** Drain durable tasks independently of the page and interactive Pi AgentSession. */
export async function runStudyAgentWorker(options: StudyAgentWorkerOptions) {
  const workerId = options.workerId ?? `pi-study-worker:${process.pid}:${randomUUID()}`;
  const queue = options.harness.studyAgentQueue;
  let runtime: ModelRuntime | null = null;
  let completed = 0;
  let failed = 0;
  const execute = async (initial: StudyAgentClaim) => {
    const key: StudyAgentWorkerClaimInput = { projectId: initial.task.projectId, taskId: initial.task.taskId, workerId, claimToken: initial.claimToken };
    const abort = new AbortController();
    let lease = initial;
    let heartbeatFailure: unknown = null;
    let task: StudyTaskAgent | null = null;
    let dispatched = initial.task.status === "reconciling";
    let completionAttempted = false;
    let nativeContext: { sessionFile: string; agentSessionId: string } | null = null;
    let observedPacket: ReturnType<typeof inspectStudyAgentContext>["packet"] | null = null;
    const commitReport = (report: NonNullable<ReturnType<typeof inspectStudyAgentContext>["report"]>) => {
      completionAttempted = true;
      const paperMap = observedPacket?.version === 2
        ? completePaperMapReport({ harness: options.harness, packet: observedPacket, projectId: key.projectId, sessionId: initial.task.sessionId,
          sections: "paperMap" in report ? report.paperMap : (() => { throw new Error("Paper-map report is missing its five sections"); })() })
        : undefined;
      queue.complete({ ...key, report: { summary: report.summary, outcome: report.status, findings: report.findings,
        notes: report.notes, unresolved: report.unresolved, target: initial.task.target, ...(paperMap ? { paperMap } : {}) } });
      completed++;
      console.info("[study-agent] report committed", { taskId: key.taskId, projectId: key.projectId, academicOutcome: report.status });
      if (nativeContext && (initial.task.kind === "reading" || initial.task.kind === "paper-map")) {
        try {
          const map = ensurePaperMap({ harness: options.harness, projectId: key.projectId, sessionId: initial.task.sessionId,
            cwd: paperMapCwd(nativeContext.sessionFile), packet: observedPacket ?? (() => { throw new Error("Study worker lost its observed packet"); })(),
            mapGroupHash: initial.task.manifest.inputHashes.paperMapGroup });
          if (map.enqueued) console.info("[study-agent] paper-map reductions admitted", { projectId: key.projectId, sessionId: initial.task.sessionId, count: map.enqueued });
        } catch (error) {
          // The completed source report remains durable. This diagnostic is explicit so a later worker/UI read can surface the blocked synthesis.
          console.error("[study-agent] paper-map admission failed after a durable report", { taskId: key.taskId, projectId: key.projectId, error });
        }
      }
    };
    const heartbeat = () => {
      try {
        lease = queue.heartbeat(key);
        if (lease.task.cancelRequestedAt) abort.abort(new Error("Study reading cancelled"));
      } catch (error) { heartbeatFailure = error; abort.abort(error); }
    };
    heartbeat();
    const timer = setInterval(heartbeat, 3000);
    const seconds = initial.task.authorization.kind === "learning" ? initial.task.authorization.admission.maxWallSeconds : 3600;
    const deadline = setTimeout(() => abort.abort(new Error("Study reading exceeded its wall-clock limit")), seconds * 1000);
    try {
      if (heartbeatFailure) throw heartbeatFailure;
      if (lease.task.cancelRequestedAt) { queue.acknowledgeCancellation(key, "Cancellation observed before model turn"); return; }
      const context = queue.readContext(key);
      nativeContext = context;
      const observation = inspectStudyAgentContext(context.sessionFile, { sessionId: context.agentSessionId, packetHash: initial.task.context.packetHash });
      observedPacket = observation.packet;
      if (observation.packet.taskId !== key.taskId || observation.packet.projectId !== key.projectId || observation.packet.parentSessionId !== initial.task.sessionId)
        throw new Error("Study worker packet ownership mismatch");
      const citations = observation.packet.evidence.map(({ id, sourceId, sourceHash, locator }) => ({ id, sourceId, sourceHash, locator }));
      if (contentHash(citations) !== contentHash(initial.task.evidence)) throw new Error("Study worker packet evidence differs from its admitted sources");
      if (observation.packet.purpose !== initial.task.kind) throw new Error("Study worker packet purpose differs from its admitted task");
      if (initial.task.kind === "reading") {
        const hashes = Object.fromEntries(observation.packet.evidence.map((item) => [item.id, `sha256:${sha256Hex(item.text)}`]));
        const mapGroup = initial.task.manifest.inputHashes.paperMapGroup;
        if (mapGroup !== undefined) {
          if (!/^sha256:[a-f0-9]{64}$/u.test(mapGroup)) throw new Error("Study reading map group is invalid");
          hashes.paperMapGroup = mapGroup;
        }
        if (contentHash(hashes) !== contentHash(initial.task.manifest.inputHashes) || contentHash(observation.packet.instruction) !== initial.task.manifest.codeHash ||
          contentHash({ provider: observation.packet.provider, modelId: observation.packet.modelId, thinkingLevel: observation.packet.thinkingLevel }) !== initial.task.manifest.parameterHash)
          throw new Error("Study reading packet text or model differs from its frozen manifest");
      }
      if (initial.task.kind === "review") {
        const hashes:Record<string,string> = { artifact: contentHash(observation.packet.artifact), ...Object.fromEntries(observation.packet.evidence.map((item) => [item.id, contentHash(item.text)])) };
        if (initial.task.manifest.inputHashes.visualEvidence !== undefined) {
          const artifact:unknown=JSON.parse(observation.packet.artifact);
          if(initial.task.target?.targetKind!=="visualization"||!artifact||typeof artifact!=="object"||!("programmaticChecks" in artifact)||!("browserChecks" in artifact)||!Array.isArray(artifact.programmaticChecks)||!Array.isArray(artifact.browserChecks))throw new Error("Visual review evidence binding is invalid");
          hashes.visualEvidence=contentHash({programmaticChecks:artifact.programmaticChecks,browserChecks:artifact.browserChecks});
        }
        if (contentHash(hashes) !== contentHash(initial.task.manifest.inputHashes) || contentHash(observation.packet.instruction) !== initial.task.manifest.codeHash ||
          contentHash({ provider: observation.packet.provider, modelId: observation.packet.modelId, thinkingLevel: observation.packet.thinkingLevel, target: initial.task.target }) !== initial.task.manifest.parameterHash)
          throw new Error("Independent review packet differs from its frozen artifact, source scope or model");
      }
      if (initial.task.kind === "paper-map") {
        if (observation.packet.version !== 2 || observation.packet.evidence.length !== 0) throw new Error("Paper-map packet has the wrong protocol");
        const artifact = parsePaperMapArtifact(observation.packet.artifact);
        if (contentHash(observation.packet.artifact) !== initial.task.manifest.inputHashes.paperMapArtifact ||
          artifact.rootInputHash !== initial.task.manifest.inputHashes.paperMapRoot || contentHash(observation.packet.instruction) !== initial.task.manifest.codeHash ||
          contentHash({ provider: observation.packet.provider, modelId: observation.packet.modelId, thinkingLevel: observation.packet.thinkingLevel }) !== initial.task.manifest.parameterHash) {
          throw new Error("Paper-map packet differs from its frozen reduction inputs or model");
        }
      }
      if (initial.task.status === "reconciling" && !observation.report) {
        queue.reconcile(key, { status: "needs-input", detail: "Previous model dispatch has no durable report; no automatic repeat was issued" });
        return;
      }
      let report = observation.report;
      if (!report) {
        if (observation.hasStartedTurn) {
          queue.markLaunching(key);
          dispatched = true;
          queue.markNeedsInput(key, "Native Pi context contains an unfinished turn; explicit new task is required");
          return;
        }
        if (!runtime) runtime = await (options.createRuntime?.() ?? ModelRuntime.create({ authPath: join(options.agentDir, "auth.json"), modelsPath: join(options.agentDir, "models.json") }));
        abort.signal.throwIfAborted();
        task = await (options.openAgent ?? openStudyTaskAgent)({ sessionFile: context.sessionFile, expectedPacket: observation.packet, agentDir: options.agentDir, modelRuntime: runtime });
        abort.signal.throwIfAborted();
        // Persist the dispatch fence BEFORE any prompt; recovery cannot mistake a lost reply for an unstarted task.
        queue.markLaunching(key);
        dispatched = true;
        queue.markRunning(key);
        report = await task.run(abort.signal);
      }
      heartbeat();
      if (heartbeatFailure) throw heartbeatFailure;
      if (lease.task.cancelRequestedAt) { queue.acknowledgeCancellation(key, "Cancellation acknowledged; any native report remains unaccepted"); return; }
      abort.signal.throwIfAborted();
      commitReport(report);
    } catch (error) {
      console.error("[study-agent] task failed", { taskId: key.taskId, projectId: key.projectId, error });
      if (heartbeatFailure) throw new AggregateError([error, heartbeatFailure], "Study worker lost its lease; product state was not changed by this worker");
      heartbeat();
      if (heartbeatFailure) throw new AggregateError([error, heartbeatFailure], "Study worker could not attest failure under its lease");
      if (lease.task.cancelRequestedAt) queue.acknowledgeCancellation(key, "Model turn stopped after cancellation");
      else if (dispatched) {
        let detail = publicStudyError(error);
        // A failed trailing provider response may follow a fsynced report. Inspect
        // the original context only; never issue another prompt to recover it.
        if (nativeContext && !completionAttempted && !abort.signal.aborted) {
          try {
            const recovered = inspectStudyAgentContext(nativeContext.sessionFile, { sessionId: nativeContext.agentSessionId, packetHash: initial.task.context.packetHash });
            if (recovered.report) { commitReport(recovered.report); return; }
          } catch (recoveryError) {
            console.error("[study-agent] native report reconciliation failed", { taskId: key.taskId, error: recoveryError });
            detail += `; reconciliation: ${publicStudyError(recoveryError)}`;
          }
        }
        queue.markNeedsInput(key, `Model dispatch requires reconciliation; no repeat was issued. ${detail}`);
      } else queue.fail(key, publicStudyError(error));
      failed++;
    } finally {
      clearInterval(timer); clearTimeout(deadline); task?.dispose();
      if(initial.task.kind==="reading"&&initial.task.manifest.inputHashes.paperMapGroup){
        const phase=options.harness.studyResearch.currentPhase(key.projectId,initial.task.sessionId);
        if(phase)recoverPendingPaperMaps(options.harness,{projectId:key.projectId,sessionId:initial.task.sessionId,expectedPhaseRevision:phase.revision});
      }
    }
  };
  for (;;) {
    // The slot is machine-wide, so its owner must drain all already-authorized projects.
    // Otherwise a worker for B could exit behind A and leave B's queue stranded.
    const candidates = queue.listClaimable();
    if (candidates.length === 0) break;
    const candidate = candidates[0];
    const claim = queue.claim(candidate.projectId, candidate.taskId, workerId);
    if (!claim) break; // Another live worker owns the global one-task slot and drains the queue.
    await execute(claim);
  }
  return { completed, failed };
}
