import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("Study API persists scoped source and additive notes in the original Pi conversation without model calls", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-study-api-"));
  const cwd = join(root, "paper"); mkdirSync(cwd);
  writeFileSync(join(cwd, "main.tex"), "\\section{Learning}\nThe sample mean is $\\bar X$.\n\\input{appendix}\n");
  writeFileSync(join(cwd, "appendix.tex"), "The variance depends on assumptions.\n");
  const env = { PI_LEARNING_HARNESS_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_MODE_PACK_STORE_PATH: join(root, "packs.json") };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])); Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No model/network calls allowed"); };
  t.after(() => {
    globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { GET, POST } = await jiti.import("../app/api/study-research/route.ts");
  const { getLearningHarness } = await jiti.import("./harness-server.ts");
  const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
  const rpc = await jiti.import("./rpc-manager.ts");
  const { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const snapshot = (await new ModePackStore().resolve("study-research.study", cwd)).snapshot;
  const host = getLearningHarness();
  const sessionId = rpc.createPersistedGenericSession(cwd, "Study original", snapshot);
  host.projectWorkspaces.create({ id: "study-a", title: "Paper", cwd, defaults: snapshot, courseProjectId: null });
  host.projectWorkspaces.move(sessionId, "study-a");
  const url = "http://127.0.0.1:30141/api/study-research";
  const headers = { host: "127.0.0.1:30141", "content-type": "application/json" };
  async function read(params = {}, expected = 200) {
    const response = await GET(new Request(`${url}?${new URLSearchParams({ sessionId, ...params })}`, { headers }));
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  async function write(body, expected = 200) {
    const response = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify({ sessionId, ...body }) }));
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  let state = await read(); assert.equal(state.revision, 0); assert.equal(state.phase.phase, "study");
  state = await write({ action: "import", rootPath: cwd, entryPath: "main.tex", expectedPhaseRevision: state.phase.revision, expectedProjectRevision: state.revision });
  assert.equal(state.sources.length, 2); assert.equal(state.revision, 1, "multi-source import is one atomic project revision");
  const source = state.sources.find((item) => item.relativePath === "main.tex");
  const page = await read({ action: "read", sourceId: source.sourceId, sourceHash: source.contentHash, limit: "1" });
  assert.match(page.chunks[0].text, /sample mean/); assert.match(page.chunks[0].locator, /startLine/);
  const note = { action: "note", sourceId: source.sourceId, sourceHash: source.contentHash, expectedPhaseRevision: state.phase.revision, title: "Sample mean", body: "My original explanation" };
  state = await write({ ...note, expectedProjectRevision: state.revision });
  const first = state.knowledge.notes[0];
  state = await write({ ...note, body: "A second observation", expectedProjectRevision: state.revision });
  assert.equal(state.knowledge.notes.length, 2);
  assert.deepEqual(state.knowledge.notes.find((item) => item.noteId === first.noteId), first, "second save preserves original user note and identity");
  await write({ ...note, expectedProjectRevision: 1 }, 409);
  await read({ action: "read", sourceId: "foreign", sourceHash: source.contentHash }, 400);
  assert.equal(rpc.getRpcSession(sessionId), undefined);
  assert.equal(SessionManager.open(await resolveSessionPath(sessionId)).buildSessionContext().messages.length, 0);
  const outsider = rpc.createPersistedGenericSession(cwd, "Same cwd is not membership", snapshot);
  await read({ sessionId: outsider }, 400);
  const denied = await POST(new Request(url, { method: "POST", headers: { ...headers, origin: "https://untrusted.example" }, body: JSON.stringify(note) }));
  assert.equal(denied.status, 403);
  const huge = await POST(new Request(url, { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) }));
  assert.equal(huge.status, 400); assert.match((await huge.json()).error, /exceeds/);
  assert.equal((await read()).knowledge.notes.length, 2);
  const cellDraft = { action: "save-cell", title: "Mean example", purpose: "Explain the arithmetic mean", language: "r", code: "mean(c(1, 2, 3))", parameters: {}, inputs: [] };
  state = await write({ ...cellDraft, expectedPhaseRevision: state.phase.revision, expectedProjectRevision: state.revision });
  const cell = state.cells[0]; assert.equal(cell.code, cellDraft.code); assert.equal(cell.revision, 1);
  const updatedCell = { ...cellDraft, cellId: cell.cellId, expectedCellRevision: 1, expectedPhaseRevision: state.phase.revision, expectedProjectRevision: state.revision, code: "mean(c(2, 4, 6))" };
  state = await write(updatedCell); assert.equal(state.cells[0].revision, 2);
  await write(updatedCell, 409); assert.equal((await read()).cells[0].code, updatedCell.code);
  assert.equal((await read()).tasks.length, 0, "saving code never pretends an execution occurred");
  const freeze = await jiti.import("./study-execution-inputs.ts");
  const boundCell = host.studyCells.save({ projectId: "study-a", sessionId, expectedPhaseRevision: state.phase.revision }, { draft: {
    title: "Read paper bytes", purpose: "Inspect an exact registered source", language: "python", code: "print(inputs)", parameters: {},
    inputs: [{ name: "paper.tex", sourceId: source.sourceId, sourceHash: source.contentHash }],
  } });
  const freezeRequest = { sessionId, cellId: boundCell.cellId, expectedCellRevision: 1, expectedPhaseRevision: state.phase.revision };
  const frozenInput = await freeze.freezeStudyCellInputs(freezeRequest);
  assert.equal(frozenInput.inputs.length, 1); assert.equal(frozenInput.inputs[0].sha256, source.contentHash);
  assert.match(Buffer.from(frozenInput.inputs[0].bytesBase64, "base64").toString(), /sample mean/);
  const { GET: exportFile } = await jiti.import("../app/api/study-research/export/route.ts");
  const exported = await exportFile(new Request(`${url}/export?${new URLSearchParams({ sessionId, format: "markdown" })}`, { headers }));
  assert.equal(exported.status, 200); assert.match(exported.headers.get("content-disposition"), /attachment/);
  const markdown = await exported.text(); assert.match(markdown, /My original explanation/); assert.match(markdown, /main\.tex/); assert.match(markdown, /未自动认定/);
  const graphResponse = await exportFile(new Request(`${url}/export?${new URLSearchParams({ sessionId, format: "graph" })}`, { headers }));
  const graph = await graphResponse.json(); assert.equal(graph.notes.length, 2); assert.equal(graph.sources[0].sourceRoot, undefined);
  // Only an explicit UI decision promotes a source/knowledge candidate, and
  // actual bytes are checked again at that last step.
  const updates = await jiti.import("./study-source-updates.ts");
  const replacementText = "\\section{Learning}\nThe sample mean needs finite expectation; variance additionally needs a second moment.\n\\input{appendix}\n";
  writeFileSync(join(cwd, "main.tex"), replacementText);
  await assert.rejects(freeze.freezeStudyCellInputs(freezeRequest), /changed since import/);
  assert.match(Buffer.from(frozenInput.inputs[0].bytesBase64, "base64").toString(), /sample mean/);
  const changed = await read({ action: "source-change", sourceId: source.sourceId, sourceHash: source.contentHash });
  assert.equal(changed.changed, true); assert.notEqual(changed.candidateHash, source.contentHash);
  assert.equal((await read()).sources.find((item) => item.sourceId === source.sourceId).contentHash, source.contentHash);
  const prepared = await updates.prepareStudySourceUpdate({ sessionId, sourceId: source.sourceId, sourceHash: source.contentHash,
    candidateHash: changed.candidateHash, expectedPhaseRevision: changed.phaseRevision, expectedProjectRevision: changed.projectRevision,
    changeSummary: "The source now distinguishes first and second moment assumptions; preserve existing user notes.",
    knowledge: { nodes: [{ localKey: "moment", kind: "assumption", title: "Moment conditions", statement: "Finite mean and finite variance are different assumptions.", scope: "main", sourceId: source.sourceId, sourceHash: changed.candidateHash, manuallyEdited: false }],
      notes: [{ author: "agent", body: "Updated source distinguishes finite first and second moments.", sourceId: source.sourceId, sourceHash: changed.candidateHash, nodeLocalKeys: ["moment"] }], relations: [] } });
  assert.equal(prepared.proposal.status, "pending"); state = await read(); assert.equal(state.sourceUpdates.length, 1);
  const details = await read({ action: "source-update", proposalId: prepared.proposal.proposalId }); assert.equal(details.affected.notes.length, 2);
  const decision = { action: "source-update-decision", proposalId: prepared.proposal.proposalId, candidateHash: changed.candidateHash,
    decision: "accept", expectedPhaseRevision: state.phase.revision, expectedProjectRevision: state.revision };
  writeFileSync(join(cwd, "main.tex"), replacementText + "A concurrent source edit.\n");
  await write(decision, 409);
  writeFileSync(join(cwd, "main.tex"), replacementText);
  state = await write(decision);
  assert.equal(state.sources.find((item) => item.sourceId === source.sourceId).contentHash, changed.candidateHash);
  await assert.rejects(freeze.freezeStudyCellInputs(freezeRequest), /no longer current/);
  assert.equal(state.knowledge.notes.find((item) => item.noteId === first.noteId).body, first.body);
  assert.equal(state.knowledge.notes.find((item) => item.noteId === first.noteId).stale, true);
  assert.ok(state.knowledge.notes.some((item) => item.body.includes("Updated source distinguishes")));
  await write({ ...decision, expectedProjectRevision: state.revision }, 409);
  // User-selected supplementary code follows the same immutable source/update boundary.
  writeFileSync(join(cwd, "sample.R"), "print(1)\n");
  const supplementInput = { action: "import-supplement", sessionId, rootPath: cwd, entryPath: "sample.R", expectedPhaseRevision: state.phase.revision, expectedProjectRevision: state.revision };
  const supplementDenied = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify(supplementInput) }));
  assert.equal(supplementDenied.status, 403);
  const supplementResponse = await POST(new Request(url, { method: "POST", headers: { ...headers, origin: "http://127.0.0.1:30141", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, body: JSON.stringify(supplementInput) }));
  assert.equal(supplementResponse.status, 200); state = await supplementResponse.json();
  const supplementary = state.sources.find(item => item.relativePath === "sample.R");
  assert.equal(supplementary.kind, "code");
  writeFileSync(join(cwd, "sample.R"), "print(2)\n");
  const changedSupplement = await updates.inspectStudySourceChange({ sessionId, sourceId: supplementary.sourceId, sourceHash: supplementary.contentHash });
  assert.equal(changedSupplement.changed, true); assert.equal(changedSupplement.chunks[0].text, "print(2)\n");
  const publicScope = { projectId: "study-a", sessionId, expectedPhaseRevision: state.phase.revision };
  const privateProducer = host.studyResearch.registerTrustedRunnerContext(publicScope, "private-producer-identity");
  host.studyResearch.reserveStudyTask(publicScope, { dispatchKey: "public-task-view", kind: "reading", producerContextId: privateProducer.contextId,
    manifest: host.studyCells.manifest(cell, source.contentHash), admission: { purpose: "Read the registered source", language: "none", maxWallSeconds: 30, maxMemoryMiB: 128 } });
  const publicState = await read();
  assert.equal(publicState.tasks.length, 1);
  assert.equal(publicState.tasks[0].authorization.kind, "learning");
  assert.equal(JSON.stringify(publicState).includes(privateProducer.contextId), false);
  assert.equal(JSON.stringify(publicState).includes(privateProducer.producerIdentity), false);
  const executionRoute = await jiti.import("../app/api/study-research/execution/route.ts");
  const executionUrl = `${url}/execution`;
  const executionStateResponse = await executionRoute.GET(new Request(`${executionUrl}?sessionId=${sessionId}`, { headers }));
  const executionState = await executionStateResponse.json();
  assert.equal(executionStateResponse.status, 200); assert.deepEqual(executionState.runs, []);
  assert.ok(executionState.capacity.defaults.memoryMiB <= executionState.capacity.maximum.memoryMiB);
  const invalidRun = await executionRoute.POST(new Request(executionUrl, { method: "POST", headers, body: JSON.stringify({ action: "run", sessionId,
    expectedPhaseRevision: state.phase.revision, cellId: cell.cellId, expectedCellRevision: 1, requestId: "invalid-resource-request-001", rPackages: [],
    resources: { ...executionState.capacity.defaults, memoryMiB: Number.MAX_SAFE_INTEGER } }) }));
  assert.equal(invalidRun.status, 400); assert.match((await invalidRun.json()).error, /memoryMiB/);
  assert.equal(host.studyExecution.listJobs("study-a").length, 0, "invalid resources cannot admit or start a job");
  const executionDenied = await executionRoute.GET(new Request(`${executionUrl}?sessionId=${sessionId}`, { headers: { ...headers, origin: "https://untrusted.example" } }));
  assert.equal(executionDenied.status, 403);
  const { runStudyCodeCell } = await jiti.import("./study-execution-service.ts");
  const abortedRun = new AbortController();
  const pendingAdmission = runStudyCodeCell({ sessionId, expectedPhaseRevision: state.phase.revision, cellId: cell.cellId,
    expectedCellRevision: 1, requestId: "cancel-before-admission-fixture", rPackages: [], resources: executionState.capacity.defaults }, abortedRun.signal);
  abortedRun.abort(new Error("Stopped learning calculation during asynchronous admission"));
  await assert.rejects(pendingAdmission, /Stopped learning calculation/);
  assert.equal(host.studyExecution.listJobs("study-a").length, 0);
  // A missing workspace is a capacity error, but must not remove saved run history or leak its local path.
  const { publicStudyError, studyApiError } = await jiti.import("./study-api-request.ts");
  const privateError = new Error('cannot read "C:\\private-study\\runtime\\config.json" token=private-test-value');
  assert.equal(publicStudyError(privateError).includes("private-study"), false);
  const publicError = await (await studyApiError(privateError)).json();
  assert.equal(publicError.error.includes("private-test-value"), false);
  rmSync(cwd, { recursive: true, force: true });
  const missingCapacity = await executionRoute.GET(new Request(`${executionUrl}?sessionId=${sessionId}`, { headers }));
  assert.equal(missingCapacity.status, 200);
  const missingState = await missingCapacity.json();
  assert.equal(missingState.capacity, null); assert.deepEqual(missingState.runs, []);
  assert.ok(missingState.capacityError); assert.equal(missingState.capacityError.includes(root), false);
  const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
  const { frozenEnvironmentDescriptorHash } = await jiti.import("../../../packages/study-execution-host/src/execution-payloads.ts");
  const forbidden = async () => { throw new Error("API sharing fixture must never execute code"); };
  const adapter = { kind: "api-sharing-fixture", prepare: forbidden, launch: forbidden, poll: forbidden, cancel: forbidden, abandonPrepared: forbidden };
  const environmentBody = { adapterKind: adapter.kind, executablePath: process.execPath, files: [{ absolutePath: process.execPath, sha256: contentHash("non-executed fixture") }] };
  const admitted = host.admitStudyCellExecution(publicScope, { cellId: cell.cellId, expectedCellRevision: 1, dispatchKey: "cell-run:shared-project-fixture",
    resources: { cpuMilliCores: 500, memoryMiB: 256, wallTimeMs: 10000, diskBytes: 1024 },
    quota: { maxRuns: 2, maxCumulativeWallTimeMs: 20000, maxCumulativeDiskBytes: 4096, expiresAt: null },
    environment: { ...environmentBody, descriptorHash: frozenEnvironmentDescriptorHash(environmentBody) }, inputs: [],
    coordinatorOptions: { adapters: [adapter], artifactDirectory: join(root, "observations") } });
  const secondSession = rpc.createPersistedGenericSession(cwd, "Project shared history", snapshot);
  host.projectWorkspaces.move(secondSession, "study-a");
  const { studyContext } = await jiti.import("./study-research-service.ts");
  const second = await studyContext(secondSession);
  const sharedResponse = await executionRoute.GET(new Request(`${executionUrl}?sessionId=${secondSession}`, { headers }));
  assert.equal(sharedResponse.status, 200);
  const shared = await sharedResponse.json(); assert.equal(shared.runs.length, 1);
  assert.equal(shared.runs[0].queueJobId, admitted.job.queueJobId); assert.equal(shared.runs[0].sessionId, undefined);
  const cancelledShared = await executionRoute.POST(new Request(executionUrl, { method: "POST", headers, body: JSON.stringify({ action: "cancel",
    sessionId: secondSession, expectedPhaseRevision: second.scope.expectedPhaseRevision, queueJobId: admitted.job.queueJobId }) }));
  assert.equal(cancelledShared.status, 200); assert.equal((await cancelledShared.json()).job.status, "cancelled");
});
