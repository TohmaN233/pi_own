import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const { AuthStorage } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { StudyResearchHost, StudyAgentQueue } = await jiti.import("../../../packages/study-research-host/src/index.ts");
const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
const { runStudyAgentWorker } = await jiti.import("./study-agent-worker.ts");
const { allocateStudyAgentContext, bindStudyAgentContext, openStudyTaskAgent, inspectStudyAgentContext } = await jiti.import("./study-task-agent.ts");

test("durable reading uses native Pi reports, commits all source checkpoints, retains human notes and never repeats uncertain dispatch", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-reading-worker-"));
  const database = new DatabaseSync(join(directory, "state.sqlite"));
  database.exec("CREATE TABLE pi_project_workspace(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE pi_project_member(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL)");
  database.prepare("INSERT INTO pi_project_workspace VALUES(?,?)").run("p", JSON.stringify({ id: "p" }));
  database.prepare("INSERT INTO pi_project_member VALUES(?,?)").run("parent", "p");
  let now = Date.now();
  const host = new StudyResearchHost(database, { clock: () => new Date(now) });
  const queue = new StudyAgentQueue(database, host, { clock: () => new Date(now), leaseDurationMs: 1000 });
  host.bindSession("p", "parent");
  const scope = () => ({ projectId: "p", sessionId: "parent", expectedPhaseRevision: host.currentPhase("p", "parent").revision });
  const source = host.registerSources(scope(), [{ sourceRoot: directory, relativePath: "paper.tex", kind: "tex", sourceRole: "primary", diagnostics: [],
    contentHash: contentHash("paper"), parser: "fixture-v1", chunks: [{ ordinal: 1, locator: '{"line":1}', text: "X has a finite expectation." },
      { ordinal: 2, locator: '{"line":2}', text: "Finite expectation alone does not imply finite variance." }] }], 0).sources[0];
  const chunks = host.readChunks(scope(), source.sourceId, source.contentHash, 0, 10).chunks;
  const evidence = chunks.map((chunk) => ({ id: chunk.chunkId, sourceId: chunk.sourceId, sourceHash: chunk.sourceHash, locator: chunk.locator, text: chunk.text }));
  host.commitKnowledgeChange(scope(), { nodes: [], relations: [], notes: [{ author: "user", body: "My original observation", sourceId: source.sourceId, sourceHash: source.contentHash, nodeLocalKeys: [] }] }, host.projectRevision(scope()).revision);
  const human = host.getKnowledge(scope()).notes[0];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No paid provider or network allowed in this fixture"); };
  t.after(() => { globalThis.fetch = fetchBefore; database.close(); assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), "pi-reading-worker-"))); rmSync(directory, { recursive: true, force: true }); });
  const faux = createFauxCore({}), credentials = AuthStorage.inMemory();
  await credentials.modify("faux", async () => ({ type: "api_key", key: "offline" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: join(directory, "models.json"), allowModelNetwork: false });
  const model = faux.getModel(); runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
  const saved = new Map();
  const enqueue = (key) => {
    const allocation = allocateStudyAgentContext(directory, join(directory, "sessions"));
    const fixed = { version: 1, projectId: "p", parentSessionId: "parent", purpose: "reading", instruction: "Read these complete chunks", evidence,
      artifact: "", provider: model.provider, modelId: model.id, thinkingLevel: "off" };
    const result = queue.enqueueLearning({ scope: scope(), dispatchKey: key, intentHash: contentHash({ key, fixed }), kind: "reading",
      evidence: evidence.map(({ text, ...citation }) => citation), context: { agentSessionId: allocation.sessionId, sessionFile: allocation.sessionFile },
      manifest: { codeHash: contentHash(fixed.instruction), parameterHash: contentHash({ provider: fixed.provider, modelId: fixed.modelId, thinkingLevel: fixed.thinkingLevel }),
        inputHashes: Object.fromEntries(chunks.map((chunk) => [chunk.chunkId, chunk.textHash])), environmentHash: contentHash("faux") },
      admission: { purpose: "Read source-grounded fragments", language: "none", maxWallSeconds: 30, maxMemoryMiB: 128 } }, (taskId) => {
        const packet = { ...fixed, taskId };
        const bound = bindStudyAgentContext(packet, allocation);
        saved.set(taskId, { ...bound, packet }); return { packetHash: bound.packetHash };
      });
    return result.task;
  };
  const report = { summary: "The first and second moments are distinct.", status: "inconclusive", findings: [],
    notes: [{ title: "Moment assumptions", body: "Finite expectation alone does not establish finite variance.", evidenceIds: evidence.map((item) => item.id) }], unresolved: ["The later theorem's assumptions remain to be read."] };
  const respond = () => faux.setResponses([fauxAssistantMessage([fauxToolCall("study_task_report", report)], { stopReason: "toolUse" }), fauxAssistantMessage("Saved")]);
  const open = async (input) => { const agent = await openStudyTaskAgent(input); agent.session.agent.streamFunction = faux.stream; return agent; };
  const first = enqueue("first");
  host.setPhase(scope(), "research");
  respond();
  assert.deepEqual(await runStudyAgentWorker({ harness: { studyAgentQueue: queue }, projectId: "p", agentDir: directory, createRuntime: async () => runtime, openAgent: open }), { completed: 1, failed: 0 });
  assert.equal(queue.list(scope())[0].authorization.phase, "study");
  assert.equal(queue.list(scope())[0].report.outcome, "inconclusive");
  assert.equal(host.listReadCheckpoints(scope(), source.sourceId).filter((item) => item.kind === "read").length, 2);
  assert.deepEqual(host.getKnowledge(scope()).notes.find((item) => item.noteId === human.noteId), human);
  assert.equal(inspectStudyAgentContext(saved.get(first.taskId).sessionFile, { sessionId: saved.get(first.taskId).sessionId, packetHash: first.context.packetHash }).report.status, "inconclusive");

  const durable = enqueue("saved-report-before-crash");
  const oldClaim = queue.claim("p", durable.taskId, "report-worker");
  const oldKey = { projectId: "p", taskId: durable.taskId, workerId: oldClaim.workerId, claimToken: oldClaim.claimToken };
  queue.markLaunching(oldKey); queue.markRunning(oldKey);
  const raw = await openStudyTaskAgent({ sessionFile: saved.get(durable.taskId).sessionFile, expectedPacket: saved.get(durable.taskId).packet, agentDir: directory, modelRuntime: runtime });
  raw.session.agent.streamFunction = faux.stream; respond(); await raw.run(); raw.dispose(); now += 2000;
  assert.deepEqual(await runStudyAgentWorker({ harness: { studyAgentQueue: queue }, projectId: "p", agentDir: directory,
    createRuntime: async () => { throw new Error("A durable native report must reconcile without provider startup"); } }), { completed: 1, failed: 0 });
  assert.equal(queue.list(scope()).find((task) => task.taskId === durable.taskId).status, "succeeded");

  const interrupted = enqueue("interrupted");
  const claimed = queue.claim("p", interrupted.taskId, "dead-worker");
  const key = { projectId: "p", taskId: interrupted.taskId, workerId: claimed.workerId, claimToken: claimed.claimToken };
  queue.markLaunching(key); queue.markRunning(key); now += 2000;
  await runStudyAgentWorker({ harness: { studyAgentQueue: queue }, projectId: "p", agentDir: directory,
    createRuntime: async () => { throw new Error("Interrupted dispatch must never start another model runtime"); } });
  assert.equal(queue.list(scope()).find((task) => task.taskId === interrupted.taskId).status, "needs-input");

  const lostReply = enqueue("network-failure-after-launch");
  let calls = 0;
  await runStudyAgentWorker({ harness: { studyAgentQueue: queue }, projectId: "p", agentDir: directory, createRuntime: async () => runtime,
    openAgent: async (input) => { const agent = await open(input); agent.run = async () => { calls++; throw new Error("Provider reply lost after dispatch"); }; return agent; } });
  assert.equal(queue.list(scope()).find((task) => task.taskId === lostReply.taskId).status, "needs-input");
  await runStudyAgentWorker({ harness: { studyAgentQueue: queue }, projectId: "p", agentDir: directory,
    createRuntime: async () => { throw new Error("Unknown provider state cannot automatically repeat"); } });
  assert.equal(calls, 1);

  const reportThenError = enqueue("report-persisted-before-provider-error"); respond();
  const reconciled = await runStudyAgentWorker({ harness: { studyAgentQueue: queue }, projectId: "p", agentDir: directory, createRuntime: async () => runtime,
    openAgent: async (input) => { const agent = await open(input); const run = agent.run.bind(agent); agent.run = async (signal) => {
      await run(signal); throw new Error("Trailing provider response lost after fsynced native report");
    }; return agent; } });
  assert.deepEqual(reconciled, { completed: 1, failed: 0 });
  assert.equal(queue.list(scope()).find((task) => task.taskId === reportThenError.taskId).status, "succeeded");

  const cancelled = enqueue("cancelled-late"); respond();
  const knowledgeBefore = host.getKnowledge(scope());
  await runStudyAgentWorker({ harness: { studyAgentQueue: queue }, projectId: "p", agentDir: directory, createRuntime: async () => runtime,
    openAgent: async (input) => { const agent = await open(input); const run = agent.run.bind(agent); agent.run = async (signal) => {
      const value = await run(signal); queue.cancel(scope(), cancelled.taskId); return value;
    }; return agent; } });
  assert.equal(queue.list(scope()).find((task) => task.taskId === cancelled.taskId).status, "cancelled");
  assert.deepEqual(host.getKnowledge(scope()), knowledgeBefore, "late cancelled report cannot update product knowledge");
});
