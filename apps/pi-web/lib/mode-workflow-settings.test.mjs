import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const settings = await jiti.import("./mode-workflow-settings.ts");
function isolate(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-combination-")), agent = join(root, "agent"), cwd = join(root, "work");
  mkdirSync(agent); mkdirSync(cwd);
  const env = { PI_CODING_AGENT_DIR: agent, PI_MODE_PACK_STORE_PATH: join(root, "packs.json"), PI_LEARNING_HARNESS_DIR: join(root, "data"), ANTHROPIC_API_KEY: "offline-scope-fixture" };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  writeFileSync(join(agent, "host-plugins.json"), JSON.stringify({ "@eko24ive/pi-ask": false, "pi-context-usage": false }));
  const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No network/model calls allowed"); };
  t.after(async () => {
    for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
    globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined;
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agent, cwd };
}
const snapshot = (profileId, adapter = "course-builder") => ({ profileId, resourceSnapshotId: `snapshot-${profileId}`, role: "general", resources: [{ kind: "extension", id: adapter, enabled: true }] });

test("mode composition defaults qualify actual profiles, preserve global off and isolate session preferences", { concurrency: false }, async t => {
  const fixture = isolate(t), course = snapshot("course-builder"), study = snapshot("study-research.study", "study-research");
  const frozen = structuredClone(course);
  assert.deepEqual(settings.modeWorkflowScope("one", course).enabled_workflow_ids, ["course-production"]);
  const { COURSE_WORKFLOW_DEFINITIONS } = await jiti.import("./course-workflow-tasks.ts");
  assert.equal(Object.keys(COURSE_WORKFLOW_DEFINITIONS).length, 12, "product selectors remain distinct from the one master graph");
  assert.deepEqual(settings.modeWorkflowScope("one", study).enabled_workflow_ids, ["study-explanation"]);
  assert.deepEqual(settings.modeWorkflowScope("one", snapshot("study-research.research", "study-research")).workflow_ids, ["study-explanation"]);
  for (const id of ["student-learn", "practice", "teach-back", "visual-lab"]) {
    assert.deepEqual(settings.modeWorkflowScope("one", { ...snapshot(id), role: "student" }).enabled_workflow_ids, []);
  }
  for (const id of ["custom.study-research.study-copy", "general", "coding"]) assert.deepEqual(settings.modeWorkflowScope("one", snapshot(id)).workflow_ids, []);
  settings.writeModeWorkflowSettings("one", course, [{ id: "course-production", enabled: false }], 0);
  assert.equal(settings.modeWorkflowScope("one", course).revision, 1);
  assert.ok(!settings.modeWorkflowScope("one", course).enabled_workflow_ids.includes("course-production"));
  assert.ok(settings.modeWorkflowScope("two", course).enabled_workflow_ids.includes("course-production"));
  assert.deepEqual(settings.modeWorkflowScope("one", study).enabled_workflow_ids, ["study-explanation"]);
  assert.ok(!settings.modeWorkflowScope("one", course).enabled_workflow_ids.includes("course-production"), "mode switch restores prior composition");
  assert.throws(() => settings.writeModeWorkflowSettings("one", course, [{ id: "course-production", enabled: true }], 0), /revision conflict/);
  assert.throws(() => settings.writeModeWorkflowSettings("one", study, [{ id: "course-production", enabled: true }], 0), /not in the installed library/);
  assert.throws(() => settings.parseWorkflowSelections([{ id: "study-explanation", enabled: true, grant: "teacher" }]), /Invalid/);
  assert.deepEqual(settings.parseWorkflowSelections([{ id: "3d_visual.demo", enabled: true }]), [{ id: "3d_visual.demo", enabled: true }], "use the native CAW ID contract");
  writeFileSync(join(fixture.agent, "host-plugins.json"), JSON.stringify({ "pi-caw": false }));
  assert.deepEqual(settings.modeWorkflowScope("one", course).enabled_workflow_ids, []);
  assert.equal(settings.getModeWorkflowSettings("one", study).workflows[0].enabled, true, "global off does not overwrite per-mode preference");
  assert.deepEqual(course, frozen, "immutable snapshot never changes");
});

test("verified portable alias receives the Study combination without trusting name substrings", { concurrency: false }, async t => {
  isolate(t);
  const { compileModePackDraft, resolveModePackSnapshot, ResourceCatalog } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");
  const { createPortableModePackage, portableModePackageAssetHash } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");
  const { ensurePortableModePackageArchive } = await jiti.import("./portable-mode-package-install.ts");
  const { STUDY_RESEARCH_DRAFTS } = await jiti.import("./study-research-pack.ts");
  const bytes = Buffer.from("export default function() {}\n"), hash = portableModePackageAssetHash(bytes);
  const catalog = new ResourceCatalog([{ kind: "extension", id: "study-research", version: "1.0.0", contentHash: hash }]);
  const definition = compileModePackDraft({ ...STUDY_RESEARCH_DRAFTS[0], modePackId: "renamed.reader.study", title: "Renamed Study", description: "Offline alias", revision: 1,
    role: "general", provider: null, model: null, tools: [], instructions: [], systemPrompt: "Scoped study", systemPromptMode: "replace",
    components: [{ type: "plugin", id: "study-research", required: true, enabled: true }] }, catalog);
  const file = { path: "extensions/study-research.mjs", base64: bytes.toString("base64"), bytes: bytes.length, contentHash: hash };
  const archive = createPortableModePackage({ moduleId: "renamed.reader", definition,
    resources: [{ kind: "extension", id: "study-research", contentHash: hash, delivery: "system-instruction", source: { type: "bundled", path: file.path } }], files: [file],
    frontend: null, projectCapabilities: [], targetPlatform: { os: process.platform, arch: process.arch }, externalDependencies: [],
    runtimeAssets: [{ kind: "harness", id: "study-research", version: "1", entry: file.path, contentHash: hash, files: [file.path] }] });
  await ensurePortableModePackageArchive(archive);
  writeFileSync(process.env.PI_MODE_PACK_STORE_PATH, JSON.stringify({ version: 1, histories: { [archive.definition.modePackId]: [archive.definition] }, retainedSharedPackageHashes: [], retainedSnapshotPackageHashes: [] }));
  const portable = resolveModePackSnapshot({ pack: archive.definition, catalog, courseVersionId: null });
  assert.deepEqual(settings.modeWorkflowScope("portable-session", portable).enabled_workflow_ids, ["study-explanation"]);
  assert.equal(settings.modeWorkflowScope("portable-session", portable).origin, archive.packageContentHash);
  assert.throws(() => settings.modeWorkflowScope("portable-session", { ...portable, profileId: "renamed.reader.study-copy" }), /not part of portable module/);
});

test("Course can select shared native generic workflows in every mode without copying graphs", { concurrency: false }, t => {
  isolate(t);
  const course = snapshot("course-builder"), study = snapshot("study-research.study", "study-research");
  const catalog = [{ id: "video-use", name: "Video", kind: "workflow", system_managed: false, enabled: true },
    { id: "zenonzard", kind: "workflow", system_managed: false, enabled: false }, { id: "system.skill2workflow", kind: "workflow", system_managed: true },
    { id: "role.reviewer", kind: "role", system_managed: false }];
  const initial = settings.modeWorkflowScope("teacher", course, catalog);
  const projected = settings.getModeWorkflowSettings("teacher", course, catalog).workflows;
  assert.equal(projected.find(item => item.id === "course-production").globalEnabled, null, "no installed definition is visibly unknown");
  assert.equal(projected.find(item => item.id === "zenonzard").globalEnabled, false);
  assert.ok(initial.workflow_ids.includes("video-use")); assert.ok(!initial.enabled_workflow_ids.includes("video-use"));
  assert.ok(!initial.workflow_ids.includes("system.skill2workflow")); assert.ok(!initial.workflow_ids.includes("role.reviewer"));
  settings.writeModeWorkflowSettings("teacher", course, [{ id: "video-use", enabled: true }], 0, catalog);
  assert.ok(settings.modeWorkflowScope("teacher", course, catalog).enabled_workflow_ids.includes("video-use"));
  assert.ok(!settings.modeWorkflowScope("other-teacher", course, catalog).enabled_workflow_ids.includes("video-use"));
  assert.deepEqual(settings.modeWorkflowScope("student", study, catalog).workflow_ids, ["study-explanation", "video-use", "zenonzard"]);
  settings.writeModeWorkflowSettings("student", study, [{ id: "video-use", enabled: true }], 0, catalog);
  assert.ok(settings.modeWorkflowScope("student", study, catalog).enabled_workflow_ids.includes("video-use"));
  assert.ok(!settings.modeWorkflowScope("teacher", course, []).workflow_ids.includes("video-use"), "deleted/unregistered graph cannot get a grant from stale preference");
  const coding = snapshot("coding"), custom = snapshot("my-pack");
  assert.deepEqual(settings.modeWorkflowScope("same-session", coding, catalog).enabled_workflow_ids, ["video-use"]);
  assert.deepEqual(settings.modeWorkflowScope("same-session", custom, catalog).enabled_workflow_ids, ["video-use"]);
  settings.writeModeWorkflowSettings("same-session", coding, [{ id: "video-use", enabled: false }, { id: "zenonzard", enabled: true }], 0, catalog);
  assert.deepEqual(settings.modeWorkflowScope("same-session", coding, catalog).enabled_workflow_ids, ["zenonzard"]);
  const checkedButGlobalOff = settings.getModeWorkflowSettings("same-session", coding, catalog).workflows.find(item => item.id === "zenonzard");
  assert.equal(checkedButGlobalOff.enabled, true); assert.equal(checkedButGlobalOff.effectiveEnabled, false);
  assert.deepEqual(settings.modeWorkflowScope("same-session", custom, catalog).enabled_workflow_ids, ["video-use"], "switching Pack changes combination without changing the global catalog");
  assert.deepEqual(settings.modeWorkflowScope("other-session", coding, catalog).enabled_workflow_ids, ["video-use"]);
  assert.equal(catalog[0].enabled, true); assert.equal(catalog[1].enabled, false);
  const all = [...catalog, { id: "course-production", kind: "workflow", enabled: true }, { id: "study-explanation", kind: "workflow", enabled: true }];
  for (const mode of [course, study, coding, custom, { ...snapshot("student-learn"), role: "student" }]) {
    const sid = `all-${mode.profileId}`;
    assert.ok(settings.modeWorkflowScope(sid, mode, all).workflow_ids.includes("course-production"));
    assert.ok(settings.modeWorkflowScope(sid, mode, all).workflow_ids.includes("study-explanation"));
    settings.writeModeWorkflowSettings(sid, mode, [{ id: "video-use", enabled: true }, { id: "course-production", enabled: true }], 0, all);
    assert.ok(settings.modeWorkflowScope(sid, mode, all).enabled_workflow_ids.includes("video-use"));
    assert.ok(settings.modeWorkflowScope(sid, mode, all).enabled_workflow_ids.includes("course-production"));
  }
});

test("corrupted preference identity is observable instead of defaulting silently", { concurrency: false }, t => {
  const fixture = isolate(t);
  writeFileSync(join(fixture.agent, "mode-workflow-settings.json"), JSON.stringify({ version: 1, preferences: { forged: { sessionId: "one", modePackId: "course-builder", origin: "builtin:course-builder", revision: 1, workflows: [] } } }));
  assert.throws(() => settings.modeWorkflowScope("one", snapshot("course-builder")), /preference identity/);
});

test("real dormant Study preference update keeps live wrapper, immutable pins and transcript", { concurrency: false, timeout: 90000 }, async t => {
  const fixture = isolate(t);
  const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
  const { snapshot: bound } = await new ModePackStore(process.env.PI_MODE_PACK_STORE_PATH).resolve("study-research.study", fixture.cwd);
  const rpc = await jiti.import("./rpc-manager.ts"), { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const sid = rpc.createPersistedGenericSession(fixture.cwd, "Workflow combination", bound), file = await resolveSessionPath(sid);
  const { getLearningHarness } = await jiti.import("./harness-server.ts");
  const projects = getLearningHarness().projectWorkspaces;
  projects.create({ id: "scope-project", title: "Workflow scope", cwd: fixture.cwd, defaults: bound, courseProjectId: null }); projects.move(sid, "scope-project");
  const { session: live } = await rpc.startRpcSession(sid, file, undefined);
  const before = readFileSync(file, "utf8"), pinned = structuredClone(rpc.getLiveModePackSnapshot(sid));
  const service = await jiti.import("./mode-settings-service.ts");
  const result = await service.updateSessionModeSettings({ sessionId: sid, expectedSnapshotId: pinned.resourceSnapshotId, expectedWorkflowRevision: 0,
    idempotencyKey: "scope-change", settingsPatch: { workflows: [{ id: "study-explanation", enabled: false }] } });
  assert.equal(result.workflows[0].enabled, false); assert.equal(result.workflowScope.revision, 1);
  assert.equal(rpc.getRpcSession(sid), live, "setter did not reload/replace the live plugin runtime");
  assert.deepEqual(rpc.getLiveModePackSnapshot(sid), pinned); assert.equal(readFileSync(file, "utf8"), before);
  const bus = live.inner.resourceLoader.eventBus;
  const query = { session_id: sid }; bus.emit("pi-caw:workflow-scope", query);
  assert.deepEqual(query.scope.enabled_workflow_ids, []); assert.equal(query.scope.revision, 1);
  const foreign = { session_id: "another-session" }; bus.emit("pi-caw:workflow-scope", foreign); assert.equal(foreign.scope, undefined);
  const admission = { session_id: sid, operation: "run", args: {}, workflow_id: "study-explanation" };
  bus.emit("pi-caw:execution-admission", admission);
  assert.equal(admission.required, true); await assert.rejects(admission.authorize, /disabled in the current conversation/);
  const setting = (scope, overrides = {}) => new Promise((resolve, reject) => bus.emit("pi-caw:workflow-setting", {
    session_id: sid, mode_pack_id: scope.mode_pack_id, workflow_id: "study-explanation", enabled: true,
    expected_revision: scope.revision, expected_origin: scope.origin, expected_snapshot_id: scope.snapshot_id, resolve, reject, ...overrides,
  }));
  await assert.rejects(setting(query.scope, { expected_origin: "forged" }), /identity conflict/);
  const updated = await setting(query.scope); assert.deepEqual(updated.enabled_workflow_ids, ["study-explanation"]); assert.equal(updated.revision, 2);
  await assert.rejects(setting(query.scope), /revision conflict/);
  const unrelated = { session_id: sid, operation: "run", args: {}, workflow_id: "course-beamer-deck" }; bus.emit("pi-caw:execution-admission", unrelated);
  await assert.rejects(unrelated.authorize, /disabled in the current conversation/);
  const catalog = [{ id: "study-explanation", kind: "workflow", enabled: true }, { id: "video-use", kind: "workflow", enabled: true }];
  const library = { session_id: sid, catalog }; bus.emit("pi-caw:workflow-scope", library);
  const selected = await setting(library.scope, { workflow_id: "video-use", catalog });
  assert.ok(selected.enabled_workflow_ids.includes("video-use"));
  const generic = { session_id: sid, operation: "run", args: {}, workflow_id: "video-use" };
  bus.emit("pi-caw:execution-admission", generic);
  assert.equal((await generic.authorize).authorized, true, "learning mode permits an explicitly enabled generic Workflow");
  const domain = { session_id: sid, operation: "run", args: {}, workflow_id: "study-explanation" };
  bus.emit("pi-caw:execution-admission", domain);
  await assert.rejects(domain.authorize, /task|binding|inputs|scope/i, "domain tasks still require their actual binding");
  assert.equal(rpc.getRpcSession(sid), live); assert.equal(readFileSync(file, "utf8"), before);
  await assert.rejects(service.updateSessionModeSettings({ sessionId: sid, expectedSnapshotId: "stale", expectedWorkflowRevision: 1, idempotencyKey: "stale", settingsPatch: { workflows: [] } }), /snapshot conflict/);
  await assert.rejects(service.updateSessionModeSettings({ sessionId: sid, expectedSnapshotId: pinned.resourceSnapshotId, expectedWorkflowRevision: 1, idempotencyKey: "mixed", settingsPatch: { workflows: [], systemPrompt: "unexpected" } }), /separately/);
});
