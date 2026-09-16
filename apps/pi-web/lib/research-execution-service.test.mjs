import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("Research browser scope route creates and revokes a bounded user authorization without provider calls or private handles", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-research-execution-service-"));
	const cwd = join(root, "paper"); mkdirSync(cwd);
	const env = { PI_LEARNING_HARNESS_DIR: join(root, "data"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_MODE_PACK_STORE_PATH: join(root, "packs.json") };
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]])); Object.assign(process.env, env);
	const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No provider or network call is allowed in this service test"); };
	t.after(async () => {
		for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
		globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined;
		globalThis.fetch = fetch;
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const { GET, POST } = await jiti.import("../app/api/study-research/research/route.ts");
	const { getLearningHarness } = await jiti.import("./harness-server.ts");
	const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
	const rpc = await jiti.import("./rpc-manager.ts");
	const { studyContext } = await jiti.import("./study-research-service.ts");
	const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
	const { frozenEnvironmentDescriptorHash } = await jiti.import("../../../packages/study-execution-host/src/execution-payloads.ts");
	const snapshot = (await new ModePackStore().resolve("study-research.research", cwd)).snapshot;
	const sessionId = rpc.createPersistedGenericSession(cwd, "Research browser scope", snapshot);
	const host = getLearningHarness(); host.projectWorkspaces.create({ id: "research-project", title: "Research", cwd, defaults: snapshot, courseProjectId: null }); host.projectWorkspaces.move(sessionId, "research-project");
	const firstContext = await studyContext(sessionId);
	const sourceText = "fixture source"; const sourceHash = `sha256:${createHash("sha256").update(sourceText).digest("hex")}`;
	const source = firstContext.host.registerSource(firstContext.scope, { sourceRoot: cwd, relativePath: "main.tex", kind: "tex", sourceRole: "primary", diagnostics: [], contentHash: sourceHash, parser: "fixture/1", chunks: [{ ordinal: 1, locator: JSON.stringify({ kind: "tex-lines", startLine: 1, endLine: 1 }), text: sourceText }] }, 0);
	const url = "http://127.0.0.1:30141/api/study-research/research";
	const headers = { host: "127.0.0.1:30141", "content-type": "application/json", origin: "http://127.0.0.1:30141", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
	async function get(expected = 200) {
		const response = await GET(new Request(`${url}?${new URLSearchParams({ sessionId })}`, { headers })); const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
	}
	async function post(body, expected = 200) {
		const response = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify({ sessionId, ...body }) })); const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
	}
	let state = await get(); assert.equal(state.phase, "research"); assert.equal(state.plans.length, 0);
	const plan = { kind: "theory", detail: { question: "Does the browser approve an explicit scope?", assumptions: [], propositions: ["The scope must be explicit."], proofSteps: [], counterexamples: [], openGaps: [] }, sourceVersionHashes: [source.contentHash], sourceReferences: [{ sourceId: source.sourceId, contentHash: source.contentHash }] };
	await post({ action: "create-plan", expectedPhaseRevision: state.phaseRevision, expectedProjectRevision: state.projectRevision, plan });
	state = await get(); assert.equal(state.plans.length, 1); const created = state.plans[0];
	const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); const resources = state.capacity.defaults;
	const headerless = await POST(new Request(url, { method: "POST", headers: { host: headers.host, "content-type": "application/json" }, body: JSON.stringify({ action: "grant", sessionId }) }));
	assert.equal(headerless.status, 403);
	assert.equal((await get()).scopes.length, 0);
	await post({ action: "grant", expectedPhaseRevision: state.phaseRevision, planId: created.planId, expectedPlanRevision: created.revision, expiresAt,
		allowedLanguages: ["python"], allowedInputs: [{ sourceId: source.sourceId, sourceHash: source.contentHash }], maxResources: resources,
		quota: { maxRuns: 2, maxCumulativeWallTimeMs: resources.wallTimeMs * 2, maxCumulativeDiskBytes: resources.diskBytes * 2 }, changeBoundary: "Only repair implementation defects." });
	state = await get(); assert.equal(state.scopes.length, 1); assert.equal(state.scopes[0].allowedLanguages[0], "python");
	assert.equal(JSON.stringify(state).includes("userEventId"), false); assert.equal(JSON.stringify(state).includes(cwd), false);
	assert.equal(JSON.stringify(state).includes("grantId"), false);
	const frozenContext = await studyContext(sessionId);
	const cell = host.studyCells.save(frozenContext.scope, { draft: { title: "Route replay fixture", purpose: "Recover an already committed run", language: "python", code: "print(42)", parameters: {}, inputs: [] } });
	const approved = host.listResearchExecutionScopes(frozenContext.scope)[0];
	const runBody = { action: "run", expectedPhaseRevision: frozenContext.phase.revision, cellId: cell.cellId, expectedCellRevision: cell.revision,
		requestId: "research-route-replay-0001", resources, rPackages: [], planId: created.planId, expectedPlanRevision: created.revision, scopeId: approved.scopeId, changeNote: "Frozen original implementation" };
	const research = { mode: "grant", scopeId: approved.scopeId, planId: created.planId, grantId: approved.grantId, expectedPlanRevision: created.revision, changeNote: runBody.changeNote };
	const intentHash = contentHash({ cellId: cell.cellId, cellRevision: cell.revision, resources, rPackages: [], phaseRevision: runBody.expectedPhaseRevision, research, quota: approved.quota });
	const environmentBody = { adapterKind: "route-replay-fixture", executablePath: process.execPath, files: [{ absolutePath: process.execPath, sha256: contentHash("fixture executable") }] };
	const never = async () => { throw new Error("Replay must not launch any native process"); };
	const admitted = host.admitStudyCellExecution(frozenContext.scope, { cellId: cell.cellId, expectedCellRevision: cell.revision, dispatchKey: `cell-run:research:${runBody.requestId}`, intentHash, resources,
		environment: { ...environmentBody, descriptorHash: frozenEnvironmentDescriptorHash(environmentBody) }, inputs: [], quota: approved.quota, research,
		coordinatorOptions: { coordinatorId: "route-replay", artifactDirectory: join(root, "artifacts"), adapters: [{ kind: "route-replay-fixture", prepare: never, launch: never, poll: never, cancel: never, abandonPrepared: never }] } });
	host.studyExecution.requestCancellation(admitted.job.queueJobId);
	host.studyResearch.reviseResearchPlan(frozenContext.scope, { planId: created.planId, expectedPlanRevision: created.revision, expectedProjectRevision: host.studyResearch.projectRevision(frozenContext.scope).revision,
		plan: { ...plan, detail: { ...plan.detail, propositions: ["A new scientific claim"] } } });
	await rpc.activateGenericModePack({ sessionId, modePackId: "study-research.study", expectedSnapshotId: frozenContext.snapshot.resourceSnapshotId, idempotencyKey: "replay-after-mode-change" });
	const replay = await post(runBody);
	assert.equal(replay.replay, true); assert.equal(replay.job.queueJobId, admitted.job.queueJobId);
	assert.equal(host.studyExecution.listJobs(frozenContext.scope.projectId).length, 1);
	await post({ ...runBody, changeNote: "Changed intent cannot replay" }, 409);
	await post({ action: "revoke", scopeId: state.scopes[0].scopeId }); state = await get(); assert.ok(state.scopes[0].revokedAt);
	const untrusted = await POST(new Request(url, { method: "POST", headers: { ...headers, origin: "https://untrusted.example" }, body: JSON.stringify({ action: "reconnect", sessionId }) })); assert.equal(untrusted.status, 403);
});
