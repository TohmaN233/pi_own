import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AuthStorage } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href);
const { StudyResearchHost, StudyAgentQueue } = await jiti.import("../../../packages/study-research-host/src/index.ts");
const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
const { completePaperMapReport, ensurePaperMap, paperMapState, parsePaperMapArtifact, buildPaperMapPlan, recoverPendingPaperMaps } = await jiti.import("./study-paper-map.ts");
const { inspectStudyAgentContext, openStudyTaskAgent, prepareStudyAgentContext, allocateStudyAgentContext, bindStudyAgentContext } = await jiti.import("./study-task-agent.ts");

const sections = {
  problem: "Estimate the mean while distinguishing it from stronger moment conditions.",
  contributions: "The reports connect the sample construction to its stated conditions.",
  assumptionsNotation: "X denotes the random variable; finite variance is not inferred from finite mean.",
  argumentDependencies: "The conclusion depends on the listed moment condition and the preceding estimator definition.",
  limitationsUnresolved: "This map records what was read. It does not mathematically verify the later theorem.",
};

test("paper-map reductions preserve report hashes, explicit partial coverage, and stale-source status", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-paper-map-"));
  const oldHarnessDirectory = process.env.PI_LEARNING_HARNESS_DIR;
  process.env.PI_LEARNING_HARNESS_DIR = directory;
  const database = new DatabaseSync(join(directory, "state.sqlite"));
  database.exec("CREATE TABLE pi_project_workspace(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE pi_project_member(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL)");
  database.prepare("INSERT INTO pi_project_workspace VALUES(?,?)").run("paper", JSON.stringify({ id: "paper" }));
  database.prepare("INSERT INTO pi_project_member VALUES(?,?)").run("parent", "paper");
  const host = new StudyResearchHost(database);
  const queue = new StudyAgentQueue(database, host);
  const harness = { studyResearch: host, studyAgentQueue: queue };
  host.bindSession("paper", "parent");
  const scope = () => ({ projectId: "paper", sessionId: "parent", expectedPhaseRevision: host.currentPhase("paper", "parent").revision });
  const chunks = Array.from({ length: 9 }, (_, index) => ({ ordinal: index + 1, locator: JSON.stringify({ line: index + 1 }), text: `Report ${index + 1}: finite mean does not establish finite variance.` }));
  const source = host.registerSources(scope(), [{ sourceRoot: directory, relativePath: "paper.tex", kind: "tex", sourceRole: "primary", diagnostics: [],
    contentHash: contentHash("paper-map-v1"), parser: "paper-map-fixture", chunks }], 0).sources[0];
  const frozenChunks = host.readChunks(scope(), source.sourceId, source.contentHash, 0, 20).chunks;
  const mapGroup = contentHash({ fixture: "paper-map", sourceId: source.sourceId, sourceHash: source.contentHash });
  const reading = frozenChunks.map((chunk, index) => {
    const allocation = allocateStudyAgentContext(directory, join(directory, "reading-sessions"));
    return queue.enqueueLearning({
    scope: scope(), dispatchKey: `reading-${index}`, intentHash: contentHash({ index, mapGroup }), kind: "reading",
    evidence: [{ id: chunk.chunkId, sourceId: chunk.sourceId, sourceHash: chunk.sourceHash, locator: chunk.locator }],
    context: { agentSessionId: allocation.sessionId, sessionFile: allocation.sessionFile },
    manifest: { codeHash: contentHash("read"), parameterHash: contentHash("model"), inputHashes: { [chunk.chunkId]: chunk.textHash, paperMapGroup: mapGroup }, environmentHash: contentHash("fixture") },
    admission: { purpose: "Read one labelled chunk", language: "none", maxWallSeconds: 30, maxMemoryMiB: 128 },
  }, (taskId) => ({ packetHash: bindStudyAgentContext({ version: 1, taskId, projectId: "paper", parentSessionId: "parent", purpose: "reading", instruction: "Read one exact fixture chunk", evidence: [{ id: chunk.chunkId, sourceId: chunk.sourceId, sourceHash: chunk.sourceHash, locator: chunk.locator, text: chunk.text }], artifact: "", provider: "faux", modelId: "faux-model", thinkingLevel: "off" }, allocation).packetHash })).task;
  });
  const completeReading = (task, unavailable = false) => {
    const claim = queue.claim("paper", task.taskId, `reader-worker-${task.taskId}`);
    assert.ok(claim); const key = { projectId: "paper", taskId: task.taskId, workerId: claim.workerId, claimToken: claim.claimToken };
    queue.markLaunching(key); queue.markRunning(key);
    if (unavailable) { queue.fail(key, "Synthetic labelled source report failed"); return; }
    queue.complete({ ...key, report: { summary: `Reading report for chunk ${task.taskId}.`, outcome: "inconclusive", findings: [], notes: [],
      unresolved: ["The final proof step is not established by this isolated chunk."], target: null } });
  };
  try {
    for (const task of reading.slice(0, 8)) completeReading(task);
    assert.equal(recoverPendingPaperMaps(harness, scope()), 0, "unfinished reading never admits a partial premature map");
    completeReading(reading[8], true);
    const readingPacket = { version: 1, taskId: reading[0].taskId, projectId: "paper", parentSessionId: "parent", purpose: "reading",
      instruction: "Read", evidence: [{ id: frozenChunks[0].chunkId, sourceId: source.sourceId, sourceHash: source.contentHash, locator: frozenChunks[0].locator, text: frozenChunks[0].text }],
      artifact: "", provider: "faux", modelId: "faux-model", thinkingLevel: "off" };
    const restarted = { studyResearch: host, studyAgentQueue: new StudyAgentQueue(database, host) };
    assert.equal(recoverPendingPaperMaps(restarted, scope()), 2, "recovery after the last reading failed closes the report-to-synthesis crash gap");
    assert.equal(recoverPendingPaperMaps(restarted, scope()), 0, "recovery never repeats admitted reductions or source reading");
    assert.throws(() => queue.readCompletedReadingContextForTrustedSynthesis({ ...scope(), sessionId: "foreign" }, reading[0].taskId), /membership|bound|belong|project|scope/i);
    const first = ensurePaperMap({ harness, projectId: "paper", sessionId: "parent", cwd: directory, packet: readingPacket, mapGroupHash: mapGroup });
    assert.equal(first.plan.ready, true);
    assert.equal(first.plan.coverage.unavailableReadingTasks.length, 1);
    assert.equal(first.enqueued, 0, "recovered reductions retain their dispatch identities");
    const completeMap = (mapTask, workerId) => {
      const mapClaim = queue.claim("paper", mapTask.taskId, workerId);
      assert.ok(mapClaim);
      const mapKey = { projectId: "paper", taskId: mapTask.taskId, workerId: mapClaim.workerId, claimToken: mapClaim.claimToken };
      const context = queue.readContext(mapKey);
      const packet = inspectStudyAgentContext(context.sessionFile, { sessionId: context.agentSessionId, packetHash: mapTask.context.packetHash }).packet;
      const artifact = parsePaperMapArtifact(packet.artifact);
      queue.markLaunching(mapKey); queue.markRunning(mapKey);
      const paperMap = completePaperMapReport({ harness, packet, projectId: "paper", sessionId: "parent", sections });
      queue.complete({ ...mapKey, report: { summary: "A partial whole-paper map.", outcome: "inconclusive", findings: [], notes: [],
        unresolved: ["One labelled report failed and remains outside the synthesis."], target: null, paperMap } });
      return { packet, artifact, paperMap };
    };
    const levelZero = queue.listProjectTasks("paper", "parent").filter((task) => task.kind === "paper-map");
    assert.equal(levelZero.length, 2);
    const completedZero = levelZero.map((task, index) => completeMap(task, `map-worker-${index}`));
    assert.equal(completedZero[0].artifact.inputReports.length, 4);
    assert.equal(completedZero[1].artifact.inputReports.length, 4);
    const second = ensurePaperMap({ harness, projectId: "paper", sessionId: "parent", cwd: directory, packet: completedZero[0].packet });
    assert.equal(second.enqueued, 1, "completed lower reductions admit one final map");
    const finalTask = queue.listProjectTasks("paper", "parent").find((task) => task.kind === "paper-map" && task.status === "queued");
    assert.ok(finalTask);
    const completedFinal = completeMap(finalTask, "map-worker-final");
    assert.equal(completedFinal.paperMap.final, true);
    assert.equal(completedFinal.paperMap.coverage.unavailableReadingTasks[0].status, "failed");
    const state = paperMapState(harness, "paper", "parent");
    assert.equal(state[0].map.paperMap.sections.problem, sections.problem);
    assert.equal(state[0].map.paperMap.coverage.completedReadingTaskIds.length, 8);
    assert.equal(state[0].plan.sourceCurrent, true);
    const planBeforeTamper = buildPaperMapPlan(harness, "paper", "parent", mapGroup);
    const originalReportHash = queue.listProjectTasks("paper", "parent").find((task) => task.taskId === reading[0].taskId)?.report?.reportHash;
    assert.ok(originalReportHash);
    database.prepare("UPDATE pi_study_agent_queue SET report_hash = ? WHERE task_id = ?").run(contentHash("forged report hash"), reading[0].taskId);
    assert.throws(() => buildPaperMapPlan(harness, "paper", "parent", mapGroup), /report failed its integrity check/);
    database.prepare("UPDATE pi_study_agent_queue SET report_hash = ? WHERE task_id = ?").run(originalReportHash, reading[0].taskId);
    assert.equal(buildPaperMapPlan(harness, "paper", "parent", mapGroup).rootInputHash, planBeforeTamper.rootInputHash);
    const retriedChunk = frozenChunks[8];
    const retry = queue.enqueueLearning({ scope: scope(), dispatchKey: "reading-retry-8", intentHash: contentHash({ retry: true, mapGroup }), kind: "reading",
      evidence: [{ id: retriedChunk.chunkId, sourceId: retriedChunk.sourceId, sourceHash: retriedChunk.sourceHash, locator: retriedChunk.locator }],
      context: { agentSessionId: "reader-retry-8", sessionFile: join(directory, "reader-retry-8.jsonl") },
      manifest: { codeHash: contentHash("read"), parameterHash: contentHash("model"), inputHashes: { [retriedChunk.chunkId]: retriedChunk.textHash, paperMapGroup: mapGroup }, environmentHash: contentHash("fixture") },
      admission: { purpose: "Explicit retry of the failed labelled chunk", language: "none", maxWallSeconds: 30, maxMemoryMiB: 128 },
    }, (taskId) => ({ packetHash: contentHash({ taskId, retry: true }) })).task;
    completeReading(retry);
    const retriedPlan = buildPaperMapPlan(harness, "paper", "parent", mapGroup);
    assert.equal(retriedPlan.coverage.unavailableReadingTasks.length, 0, "the latest successful retry replaces the failed chunk in current coverage");
    assert.notEqual(retriedPlan.rootInputHash, planBeforeTamper.rootInputHash);
    const retryMaps = ensurePaperMap({ harness, projectId: "paper", sessionId: "parent", cwd: directory, packet: readingPacket, mapGroupHash: mapGroup });
    assert.equal(retryMaps.enqueued, 3);
    assert.equal(ensurePaperMap({ harness, projectId: "paper", sessionId: "parent", cwd: directory, packet: readingPacket, mapGroupHash: mapGroup }).enqueued, 0, "same map snapshot is idempotent");
    const restartedHarness = { studyResearch: host, studyAgentQueue: new StudyAgentQueue(database, host) };
    assert.equal(buildPaperMapPlan(restartedHarness, "paper", "parent", mapGroup).rootInputHash, retriedPlan.rootInputHash, "restart preserves the exact map input snapshot");
    const candidate = { sourceRoot: source.sourceRoot, relativePath: source.relativePath, kind: source.kind, sourceRole: source.sourceRole, diagnostics: source.diagnostics,
      contentHash: contentHash("paper-map-v2"), parser: "paper-map-fixture-v2", chunks };
    const proposal = host.proposeSourceUpdate(scope(), { sourceId: source.sourceId, candidate, knowledge: { nodes: [], notes: [], relations: [] },
      changeSummary: "The source version changed.", expectedProjectRevision: host.projectRevision(scope()).revision });
    host.acceptSourceUpdate(scope(), proposal.proposalId, host.projectRevision(scope()).revision);
    const stale = paperMapState(harness, "paper", "parent");
    assert.equal(stale[0].plan.sourceCurrent, false, "an old map remains auditable but cannot claim the current source version");
  } finally {
    database.close();
    if (oldHarnessDirectory === undefined) delete process.env.PI_LEARNING_HARNESS_DIR;
    else process.env.PI_LEARNING_HARNESS_DIR = oldHarnessDirectory;
    assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), "pi-paper-map-")));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("versioned paper-map packet accepts only the exact five-section faux report", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-paper-map-agent-"));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("The paper-map protocol fixture has no network or paid provider"); };
  t.after(() => { globalThis.fetch = oldFetch; assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), "pi-paper-map-agent-"))); rmSync(directory, { recursive: true, force: true }); });
  const faux = createFauxCore({}), credentials = AuthStorage.inMemory();
  await credentials.modify("faux", async () => ({ type: "api_key", key: "offline" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: join(directory, "models.json"), allowModelNetwork: false });
  const model = faux.getModel(); runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
  const artifact = { kind: "study-paper-map/v1", mapGroupHash: contentHash("group"), rootInputHash: contentHash("root"), level: 0, final: true,
    sourceScope: [{ sourceId: "source", contentHash: contentHash("source") }], coverage: { totalReadingTasks: 1, completedReadingTasks: 1, unavailableReadingTasks: 0 },
    inputReports: [{ taskId: "reading", reportHash: contentHash("reading report"), kind: "reading", report: { summary: "A bounded reading report.", outcome: "inconclusive", findings: [], notes: [], unresolved: ["Not a proof."] } }] };
  const packet = { version: 2, taskId: "map-1", projectId: "paper", parentSessionId: "parent", purpose: "paper-map", instruction: "Synthesize a map.", evidence: [],
    artifact: JSON.stringify(artifact), provider: model.provider, modelId: model.id, thinkingLevel: "off" };
  const context = prepareStudyAgentContext(packet, directory, join(directory, "sessions"));
  const task = await openStudyTaskAgent({ sessionFile: context.sessionFile, expectedPacket: packet, agentDir: directory, modelRuntime: runtime });
  t.after(() => task.dispose());
  task.session.agent.streamFunction = faux.stream;
  const valid = { summary: "The paper map is partial and source-grounded.", status: "inconclusive", findings: [], notes: [], unresolved: ["The report does not verify the final theorem."], paperMap: sections };
  const call = (report) => fauxAssistantMessage([fauxToolCall("study_task_report", report)], { stopReason: "toolUse" });
  faux.setResponses([call({ ...valid, paperMap: { ...sections, problem: "" } }), call(valid), fauxAssistantMessage("Saved")]);
  assert.deepEqual(await task.run(), valid);
  assert.deepEqual(inspectStudyAgentContext(context.sessionFile, { sessionId: context.sessionId, packetHash: context.packetHash }).report, valid);
});
