import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fixtureRoot = join(process.cwd(), ".artifacts", "study-research", "assignment", "service-fixtures");

test("Assignment request creation is browser-only while the model tool only reads and saves drafts", async (t) => {
	mkdirSync(fixtureRoot, { recursive: true });
	const root = mkdtempSync(join(fixtureRoot, "pi-study-assignment-service-"));
	const cwd = join(root, "paper");
	mkdirSync(cwd);
	const sourceBytes = new TextEncoder().encode("A source for explicit learning.");
	writeFileSync(join(cwd, "main.tex"), sourceBytes);
	const environment = {
		PI_LEARNING_HARNESS_DIR: join(root, "data"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
		PI_MODE_PACK_STORE_PATH: join(root, "packs.json"),
	};
	const savedEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	t.after(async () => {
		for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
		globalThis.__piLearningHarness?.close();
		globalThis.__piLearningHarness = undefined;
		for (const [key, value] of Object.entries(savedEnvironment)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const { GET, POST } = await jiti.import("../app/api/study-research/assignment/route.ts");
	const { getLearningHarness } = await jiti.import("./harness-server.ts");
	const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
	const rpc = await jiti.import("./rpc-manager.ts");
	const { studyContext } = await jiti.import("./study-research-service.ts");
	const extension = (await jiti.import("./study-assignment-extension.ts")).default;

	const snapshot = (await new ModePackStore().resolve("study-research.study", cwd)).snapshot;
	const sessionId = rpc.createPersistedGenericSession(cwd, "Study Assignment browser fixture", snapshot);
	const harness = getLearningHarness();
	harness.projectWorkspaces.create({ id: "assignment-project", title: "Assignment", cwd, defaults: snapshot, courseProjectId: null });
	harness.projectWorkspaces.move(sessionId, "assignment-project");
	const context = await studyContext(sessionId);
	const source = context.host.registerSource(context.scope, {
		sourceRoot: cwd,
		relativePath: "main.tex",
		kind: "tex",
		sourceRole: "primary",
		contentHash: hash(sourceBytes),
		parser: "fixture/v1",
		diagnostics: [],
		chunks: [{ ordinal: 1, locator: JSON.stringify({ fixture: true }), text: new TextDecoder().decode(sourceBytes) }],
	}, 0);
	const url = "http://127.0.0.1:30141/api/study-research/assignment";
	const headers = {
		host: "127.0.0.1:30141",
		"content-type": "application/json",
		origin: "http://127.0.0.1:30141",
		"sec-fetch-site": "same-origin",
		"sec-fetch-mode": "cors",
	};
	async function state() {
		const response = await GET(new Request(`${url}?${new URLSearchParams({ sessionId })}`, { headers }));
		const value = await response.json();
		assert.equal(response.status, 200, JSON.stringify(value));
		return value;
	}
	async function post(body, expected = 200) {
		const response = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify({ sessionId, ...body }) }));
		const value = await response.json();
		assert.equal(response.status, expected, JSON.stringify(value));
		return value;
	}

	let current = await state();
	assert.equal(current.phase.phase, "study");
	assert.equal(current.assignments.length, 0);
	const rejected = await POST(new Request(url, {
		method: "POST",
		headers: { host: headers.host, "content-type": headers["content-type"] },
		body: JSON.stringify({
			action: "create",
			sessionId,
			expectedPhaseRevision: current.phase.revision,
			expectedProjectRevision: current.projectRevision,
			goal: "Should be rejected without browser metadata",
			sourceRefs: [{ sourceId: source.sourceId, sourceHash: source.contentHash }],
		}),
	}));
	assert.equal(rejected.status, 403);
	assert.equal((await state()).assignments.length, 0);

	const requested = await post({
		action: "create",
		expectedPhaseRevision: current.phase.revision,
		expectedProjectRevision: current.projectRevision,
		goal: "理解当前来源的核心定义",
		sourceRefs: [{ sourceId: source.sourceId, sourceHash: source.contentHash, locator: "definition" }],
		count: 1,
		difficulty: "基础",
		purpose: "准备讨论",
	});
	assert.equal(requested.request.status, "requested");
	assert.equal(requested.draft, null);

	let tool;
	extension({ registerTool(value) { tool = value; } });
	assert.equal(tool.name, "study_assignment");
	await assert.rejects(
		tool.execute("call", { action: "create" }, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } }),
		/observed Assignment request ID/i,
	);
	const toolStateResult = await tool.execute("call", { action: "state" }, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } });
	const toolState = JSON.parse(toolStateResult.content[0].text);
	assert.equal(toolState.assignments.length, 1);

	const readResult = await tool.execute("call", {
		action: "read-request",
		expectedPhaseRevision: current.phase.revision,
		requestId: requested.request.requestId,
	}, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } });
	const read = JSON.parse(readResult.content[0].text);
	assert.equal(read.request.requestId, requested.request.requestId);

	const saved = await tool.execute("call", {
		action: "save-draft",
		expectedPhaseRevision: current.phase.revision,
		expectedProjectRevision: current.projectRevision,
		requestId: requested.request.requestId,
		expectedRequestRevision: requested.request.revision,
		expectedDraftRevision: 0,
		draft: {
			overview: "围绕当前来源做局部练习。",
			tasks: ["这段来源中的核心定义解决了什么问题？"],
			deliverables: [],
			rubric: [],
			solutionNotes: ["它把需要理解的对象固定为一个可追踪的定义。"],
			materialIds: [source.sourceId],
		},
	}, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } });
	const savedRecord = JSON.parse(saved.content[0].text);
	assert.equal(savedRecord.request.status, "draft");
	assert.equal(savedRecord.draft.draft.tasks.length, 1);
	current = await state();
	assert.equal(current.assignments[0].draft.draft.solutionNotes.length, 1);
	assert.equal(Object.hasOwn(current.assignments[0], "completed"), false);
});
