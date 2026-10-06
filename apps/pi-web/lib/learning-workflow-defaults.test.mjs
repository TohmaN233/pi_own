import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
const { STUDY_RESEARCH_DRAFTS } = await jiti.import("./study-research-pack.ts");
const defaults = await jiti.import("./learning-workflow-defaults.ts");
const { compileModePackDraft, resolveModePackSnapshot } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");

function isolate(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-learning-defaults-")), cwd = join(root, "work"), agent = join(root, "agent"), storePath = join(root, "packs.json");
  mkdirSync(cwd); mkdirSync(agent);
  const env = { PI_CODING_AGENT_DIR: agent, PI_MODE_PACK_STORE_PATH: storePath, PI_LEARNING_HARNESS_DIR: join(root, "data"), ANTHROPIC_API_KEY: "offline-learning-default-fixture" };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  writeFileSync(join(agent, "host-plugins.json"), JSON.stringify({ "@eko24ive/pi-ask": false, "pi-context-usage": false }));
  const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No model/network calls allowed"); };
  t.after(async () => {
    for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
    globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined;
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, storePath, store: new ModePackStore(storePath) };
}
async function legacy(fixture, customized = false) {
  const draft = STUDY_RESEARCH_DRAFTS[0], fresh = await fixture.store.resolve(draft.modePackId, fixture.cwd);
  const oldPrompt = draft.systemPrompt.split("\n\n").filter(block => block !== defaults.STUDY_WORKFLOW_EXECUTION_PROMPT).join("\n\n");
  assert.equal(defaults.isPreviousStudyDefaultPrompt(oldPrompt), true, "fixture is the attested previous default prompt");
  const old = { ...draft, revision: 3, instructions: [], components: draft.components.filter(item => item.id !== "pi-caw"),
    systemPrompt: customized ? "My personal study instructions." : oldPrompt,
    provider: customized ? "anthropic" : null, model: customized ? "claude-sonnet-4-5" : null, tools: ["codemode"] };
  const definition = compileModePackDraft(old, fresh.inventory.catalog);
  writeFileSync(fixture.storePath, JSON.stringify({ version: 1, histories: { [definition.modePackId]: [definition] }, retainedSharedPackageHashes: [], retainedSnapshotPackageHashes: [] }));
  return { definition, snapshot: resolveModePackSnapshot({ pack: definition, catalog: fresh.inventory.catalog, courseVersionId: null }) };
}

test("previous Study defaults adopt scoped routing while personal settings stay intact", { concurrency: false }, async t => {
  const fixture = isolate(t), old = await legacy(fixture);
  const frozen = structuredClone(old.definition), current = await fixture.store.resolve(old.definition.modePackId, fixture.cwd);
  assert.equal(current.definition.revision, 4); assert.equal(current.definition.systemPrompt, STUDY_RESEARCH_DRAFTS[0].systemPrompt);
  assert.ok(current.snapshot.resources.some(item => item.id === "pi-caw" && item.enabled && item.delivery === "native-skill"));
  assert.ok(current.snapshot.resources.some(item => item.id === "study.paper-learning" && item.required));
  assert.deepEqual(old.definition, frozen);
  assert.equal((await fixture.store.resolve(old.definition.modePackId, fixture.cwd)).definition.contentHash, current.definition.contentHash);
  const rpc = await jiti.import("./rpc-manager.ts");
  const rebound = await rpc.resolveSavedModeSettings(old.snapshot, undefined, fixture.cwd, undefined, current.definition);
  assert.equal(rebound.snapshot.instructions[2], STUDY_RESEARCH_DRAFTS[0].systemPrompt);
  assert.ok(rebound.snapshot.resources.some(item => item.id === "pi-caw" && item.enabled));
  const personal = await legacy(fixture, true), migrated = await fixture.store.resolve(personal.definition.modePackId, fixture.cwd);
  for (const field of ["provider", "model", "tools", "systemPrompt"]) assert.deepEqual(migrated.definition[field], personal.definition[field]);
});

test("dormant Study defaults append a verified runtime binding without changing transcript or personal settings", { concurrency: false, timeout: 90000 }, async t => {
  const fixture = isolate(t), old = await legacy(fixture, true), rpc = await jiti.import("./rpc-manager.ts");
  const { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const sid = rpc.createPersistedGenericSession(fixture.cwd, "Dormant Study", old.snapshot), path = await resolveSessionPath(sid), bytes = readFileSync(path, "utf8");
  const { getLearningHarness } = await jiti.import("./harness-server.ts");
  const projects = getLearningHarness().projectWorkspaces;
  projects.create({ id: "dormant-paper", title: "Dormant paper", cwd: fixture.cwd, defaults: old.snapshot, courseProjectId: null });
  projects.move(sid, "dormant-paper");
  const restarted = await rpc.startRpcSession(sid, path, undefined), status = await rpc.getGenericModePackStatus(sid);
  assert.equal(status.runtime.verified, true); assert.ok(readFileSync(path, "utf8").startsWith(bytes));
  const snapshot = status.runtime.binding.snapshot;
  assert.ok(snapshot.instructions.includes(defaults.LEARNING_WORKFLOW_CONTROL_MARKER));
  assert.equal(snapshot.instructions[2], old.snapshot.instructions[2]); assert.deepEqual(snapshot.tools, old.snapshot.tools);
  assert.equal(snapshot.model, old.snapshot.model); assert.equal(snapshot.provider, old.snapshot.provider);
  assert.ok(restarted.session.inner.getActiveToolNames().includes("caw"));
  assert.ok(!restarted.session.inner.getActiveToolNames().includes("subagent_supervisor"));
});

test("learning admission uses exact known profile scope and keeps management available", async () => {
  const { learningWorkflowScope } = await jiti.import("./host-baseline-plugins.ts");
  assert.equal(learningWorkflowScope({ profileId: "study-research.study" }), true);
  assert.equal(learningWorkflowScope({ profileId: "study-research.research" }), true);
  for (const profileId of ["student-learn", "practice", "teach-back", "visual-lab"]) {
    assert.equal(learningWorkflowScope({ profileId, role: "student" }), true);
    assert.equal(learningWorkflowScope({ profileId, role: "teacher" }), false);
  }
  assert.equal(learningWorkflowScope({ profileId: "custom.study-research.study-copy", role: "general" }), false);


});

test("only dedicated Study/Research defaults promise the available Study execution adapter", async () => {
  const { BUILTIN_MODE_PACK_DRAFTS } = await jiti.import("../../../packages/profile-resource-host/src/mode-packs.ts");
  for (const id of ["student-learn", "practice", "teach-back", "visual-lab"]) {
    const pack = BUILTIN_MODE_PACK_DRAFTS[id], guidance = [pack.systemPrompt, ...pack.instructions].join("\n");
    assert.match(guidance, /\/caw/); assert.doesNotMatch(guidance, /study_workflow|study-explanation/);
  }
  for (const pack of STUDY_RESEARCH_DRAFTS) assert.match(pack.systemPrompt, /study_workflow prepare/);
});

test("portable Study alias adopts defaults without rewriting its archive or importing ambient Skills", { concurrency: false }, async t => {
  const fixture = isolate(t), old = await legacy(fixture, true);
  const { ResourceCatalog } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");
  const { createPortableModePackage, portableModePackageAssetHash } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");
  const { ensurePortableModePackageArchive } = await jiti.import("./portable-mode-package-install.ts");
  const { readPortableModePackage } = await jiti.import("./portable-mode-pack-registry.ts");
  const { learningWorkflowScope } = await jiti.import("./host-baseline-plugins.ts");
  const files = old.definition.components.map(component => {
    const path = component.type === "plugin" ? `extensions/${component.id}.mjs` : `skills/${component.id}/SKILL.md`;
    const bytes = Buffer.from(component.type === "plugin" ? "export default function() {}\n" : `---\nname: ${component.id}\ndescription: Offline fixture\n---\nScoped source guidance.\n`);
    return { path, base64: bytes.toString("base64"), bytes: bytes.length, contentHash: portableModePackageAssetHash(bytes) };
  });
  const resources = old.definition.components.map((component, index) => ({ kind: component.type === "plugin" ? "extension" : "skill", id: component.id,
    contentHash: files[index].contentHash, delivery: component.delivery ?? "system-instruction", source: { type: "bundled", path: files[index].path } }));
  const catalog = new ResourceCatalog(resources.map(resource => ({ kind: resource.kind, id: resource.id, version: "1.0.0", contentHash: resource.contentHash })));
  const definition = compileModePackDraft({ ...STUDY_RESEARCH_DRAFTS[0], modePackId: "custom.reader.study", revision: 3, instructions: [],
    components: old.definition.components.map(({ version, contentHash, ...component }) => component), tools: [], systemPrompt: "Portable personal study prompt." }, catalog);
  const archive = createPortableModePackage({ moduleId: "custom.reader", definition, resources, files, frontend: null,
    projectCapabilities: [], targetPlatform: { os: process.platform, arch: process.arch }, externalDependencies: [],
    runtimeAssets: [{ kind: "harness", id: "study-research", version: "1", entry: files[0].path, contentHash: files[0].contentHash, files: files.filter(file => file.path.startsWith("extensions/")).map(file => file.path) }] });
  await ensurePortableModePackageArchive(archive);
  writeFileSync(fixture.storePath, JSON.stringify({ version: 1, histories: { [archive.definition.modePackId]: [archive.definition] }, retainedSharedPackageHashes: [], retainedSnapshotPackageHashes: [] }));
  const frozen = structuredClone(readPortableModePackage(archive.packageContentHash));
  const current = await fixture.store.resolve(archive.definition.modePackId, fixture.cwd);
  assert.equal(learningWorkflowScope(current.snapshot), true, "verified imported module aliases retain Study scope");
  assert.equal(current.definition.packageContentHash, archive.packageContentHash); assert.equal(current.definition.systemPrompt, definition.systemPrompt);
  assert.ok(current.snapshot.instructions.includes(defaults.LEARNING_WORKFLOW_CONTROL_MARKER));
  assert.ok(!current.snapshot.resources.some(resource => resource.id === "pi-caw"), "missing optional archive bytes never fall back to ambient local Skills");
  assert.deepEqual(readPortableModePackage(archive.packageContentHash), frozen);
});
