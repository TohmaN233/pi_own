import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import JSZip from "jszip";

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fixtureRoot = join(process.cwd(), ".artifacts", "study-research", "manuscript-fixes", "service-fixtures");

async function minimalDocx() {
	const zip = new JSZip();
	zip.file("[Content_Types].xml", "<Types/>");
	zip.file("word/document.xml", "<w:document xmlns:w=\"w\"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:body></w:document>");
	zip.file("word/unrelated.xml", "<unrelated>preserved</unrelated>");
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

test("manuscript route requires a browser request and only confirms a Research extension candidate", async (t) => {
	mkdirSync(fixtureRoot, { recursive: true });
	const root = mkdtempSync(join(fixtureRoot, "pi-study-manuscript-service-"));
	const cwd = join(root, "paper");
	mkdirSync(cwd);
	const original = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\nOld. Anchor. Remove.\n\\end{document}\n");
	writeFileSync(join(cwd, "main.tex"), original);
	const environment = {
		PI_LEARNING_HARNESS_DIR: join(root, "data"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
		PI_MODE_PACK_STORE_PATH: join(root, "packs.json"),
	};
	const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	t.after(async () => {
		for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
		globalThis.__piLearningHarness?.close();
		globalThis.__piLearningHarness = undefined;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const { GET, POST } = await jiti.import("../app/api/study-research/manuscript/route.ts");
	const { getLearningHarness } = await jiti.import("./harness-server.ts");
	const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
	const rpc = await jiti.import("./rpc-manager.ts");
	const { studyContext } = await jiti.import("./study-research-service.ts");
	const extension = (await jiti.import("./study-manuscript-extension.ts")).default;

	const snapshot = (await new ModePackStore().resolve("study-research.research", cwd)).snapshot;
	const sessionId = rpc.createPersistedGenericSession(cwd, "Manuscript browser fixture", snapshot);
	const harness = getLearningHarness();
	harness.projectWorkspaces.create({ id: "manuscript-project", title: "Manuscript", cwd, defaults: snapshot, courseProjectId: null });
	harness.projectWorkspaces.move(sessionId, "manuscript-project");
	const context = await studyContext(sessionId);
	const source = context.host.registerSource(
		context.scope,
		{
			sourceRoot: cwd,
			relativePath: "main.tex",
			kind: "tex",
			sourceRole: "primary",
			contentHash: sha256(original),
			parser: "fixture/v1",
			diagnostics: [],
			chunks: [{ ordinal: 1, locator: JSON.stringify({ fixture: true }), text: new TextDecoder().decode(original) }],
		},
		0,
	);
	const url = "http://127.0.0.1:30141/api/study-research/manuscript";
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
	assert.equal(current.phase, "research");
	const rejected = await POST(
		new Request(url, {
			method: "POST",
			headers: { host: headers.host, "content-type": "application/json" },
			body: JSON.stringify({
				action: "request",
				sessionId,
				expectedPhaseRevision: current.phaseRevision,
				expectedProjectRevision: current.projectRevision,
				sourceId: source.sourceId,
				sourceHash: source.contentHash,
				requestText: "Revise the claim.",
			}),
		}),
	);
	assert.equal(rejected.status, 403);
	assert.equal((await state()).patches.length, 0);

	const requested = await post({
		action: "request",
		expectedPhaseRevision: current.phaseRevision,
		expectedProjectRevision: current.projectRevision,
		sourceId: source.sourceId,
		sourceHash: source.contentHash,
		requestText: "Replace the overclaim, add a transition, and delete the obsolete sentence.",
	});
	assert.equal(requested.status, "requested");

	let tool;
	extension({ registerTool(value) { tool = value; } });
	assert.equal(tool.name, "study_manuscript");
	await assert.rejects(
		tool.execute("call", { action: "draft" }, undefined, undefined, { sessionManager: { getSessionId: () => sessionId } }),
		/Observed Research phase revision/i,
	);
	const draftResult = await tool.execute(
		"call",
		{
			action: "draft",
			expectedPhaseRevision: current.phaseRevision,
			patchId: requested.patchId,
			expectedPatchRevision: requested.revision,
			operations: [
				{ kind: "replace", oldText: "Old", newText: "Cautious", reason: "Avoid an overclaim." },
				{ kind: "add", anchor: "Anchor", position: "after", text: " transition", reason: "Connect the argument." },
				{ kind: "delete", oldText: "Remove", reason: "Obsolete sentence." },
			],
		},
		undefined,
		undefined,
		{ sessionManager: { getSessionId: () => sessionId } },
	);
	const draft = JSON.parse(draftResult.content[0].text);
	assert.equal(draft.status, "draft");
	assert.deepEqual(new Uint8Array(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "main.tex")))), original);

	const candidateResponse = await GET(
		new Request(`${url}?${new URLSearchParams({ sessionId, action: "candidate", patchId: draft.patchId })}`, { headers }),
	);
	assert.equal(candidateResponse.status, 200);
	assert.match(new TextDecoder().decode(await candidateResponse.arrayBuffer()), /ManuscriptRewritten/);
	await post({
		action: "confirm",
		expectedPhaseRevision: current.phaseRevision,
		patchId: draft.patchId,
		expectedPatchRevision: draft.revision,
		confirmed: false,
	}, 400);
	const confirmed = await post({
		action: "confirm",
		expectedPhaseRevision: current.phaseRevision,
		patchId: draft.patchId,
		expectedPatchRevision: draft.revision,
		confirmed: true,
	});
	assert.equal(confirmed.status, "confirmed");
	assert.match(new TextDecoder().decode(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "main.tex")))), /Cautious\. Anchor transition\./);
	const recovered = await post({
		action: "recover",
		expectedPhaseRevision: current.phaseRevision,
		patchId: confirmed.patchId,
		expectedPatchRevision: confirmed.revision,
		confirmed: true,
	});
	assert.equal(recovered.status, "recovered");
	assert.deepEqual(new Uint8Array(await import("node:fs/promises").then(({ readFile }) => readFile(join(cwd, "main.tex")))), original);
});

test("manuscript DOCX adapter rejects compressed inflation before extracting entries", async () => {
	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const { studyManuscriptDocxAdapter } = await jiti.import("./study-manuscript-service.ts");
	const zip = new JSZip();
	zip.file("[Content_Types].xml", "<Types/>");
	zip.file("word/document.xml", "<w:document xmlns:w=\"w\"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:body></w:document>");
	zip.file("word/inflation.bin", "x".repeat(17 * 1024 * 1024));
	const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	await assert.rejects(
		studyManuscriptDocxAdapter(bytes, [{ kind: "replace", oldText: "Old", newText: "New", reason: "Fixture." }], "2026-09-12T00:00:00.000Z"),
		/inflation limit/i,
	);
});

test("manuscript DOCX adapter streams bounded entries after metadata validation without eager CRC inflation", async () => {
	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const { studyManuscriptDocxAdapter } = await jiti.import("./study-manuscript-service.ts");
	const bytes = await minimalDocx();
	const originalLoad = JSZip.loadAsync;
	const observedCrcOptions = [];
	JSZip.loadAsync = async (...args) => {
		observedCrcOptions.push(args[1]?.checkCRC32);
		const archive = await originalLoad(...args);
		for (const entry of Object.values(archive.files)) {
			entry.async = async () => { throw new Error("unbounded entry.async was used"); };
		}
		return archive;
	};
	try {
		const output = await studyManuscriptDocxAdapter(
			bytes,
			[{ kind: "replace", oldText: "Old", newText: "New", reason: "Fixture." }],
			"2026-09-12T00:00:00.000Z",
		);
		assert.ok(output.candidate.byteLength > 0);
		assert.ok(output.clean.byteLength > 0);
	} finally {
		JSZip.loadAsync = originalLoad;
	}
	assert.ok(observedCrcOptions.length >= 3, "input and generated DOCX archives are all reopened for bounded validation");
	assert.ok(observedCrcOptions.every((value) => value === false), "CRC validation must run during the bounded per-entry stream, never in JSZip.loadAsync");
});

test("manuscript DOCX adapter rejects a CRC mismatch discovered during bounded streaming", async () => {
	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const { studyManuscriptDocxAdapter } = await jiti.import("./study-manuscript-service.ts");
	const corrupted = new Uint8Array(await minimalDocx());
	const centralDirectory = new TextEncoder().encode("PK\x01\x02");
	let centralOffset = -1;
	for (let index = 0; index <= corrupted.length - centralDirectory.length; index++) {
		if (centralDirectory.every((byte, offset) => corrupted[index + offset] === byte)) {
			centralOffset = index;
			break;
		}
	}
	assert.notEqual(centralOffset, -1, "fixture must contain a ZIP central-directory entry");
	corrupted[centralOffset + 16] ^= 0xff;
	await assert.rejects(
		studyManuscriptDocxAdapter(
			corrupted,
			[{ kind: "replace", oldText: "Old", newText: "New", reason: "Fixture." }],
			"2026-09-12T00:00:00.000Z",
		),
		/CRC/i,
	);
});
