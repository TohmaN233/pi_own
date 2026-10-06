import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
const { COURSE_BUILDER_DRAFT } = await jiti.import("./course-builder-pack.ts");
const migration = await jiti.import("./course-workflow-migration.ts");
const { compileModePackDraft, resolveModePackSnapshot, ResourceCatalog } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");
const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
const { createPortableModePackage, portableModePackageAssetHash } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");
const { ensurePortableModePackageArchive } = await jiti.import("./portable-mode-package-install.ts");
const { readPortableModePackage } = await jiti.import("./portable-mode-pack-registry.ts");
const legacyDefault = JSON.parse(readFileSync(new URL("./course-workflow-migration.fixture.json", import.meta.url), "utf8"));

test("conditional production migration upgrades marker-v1 defaults and preserves personal prompts", () => {
  const previous = { ...COURSE_BUILDER_DRAFT, instructions: [migration.COURSE_WORKFLOW_MIGRATION_MARKER], systemPrompt: legacyDefault.systemPrompt };
  assert.equal(migration.needsCourseWorkflowDefinitionMigration(previous), true);
  const next = migration.courseWorkflowRetirementDraft(previous, COURSE_BUILDER_DRAFT);
  assert.equal(next.systemPrompt, COURSE_BUILDER_DRAFT.systemPrompt);
  assert.equal(migration.needsCourseWorkflowDefinitionMigration(next), false);
  assert.ok(next.instructions.includes(migration.COURSE_PRODUCTION_MIGRATION_MARKER));
  assert.equal(migration.courseWorkflowRetirementDraft({ ...previous, systemPrompt: "My personal teacher prompt." }, COURSE_BUILDER_DRAFT).systemPrompt, "My personal teacher prompt.");
});

function isolate(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-course-retirement-")), cwd = join(root, "project"), skills = join(root, "skills"), storePath = join(root, "mode-packs.json");
  mkdirSync(cwd); cpSync(new URL("../../../skills/", import.meta.url), skills, { recursive: true });
  // Model an old installation explicitly. Production has already retired this
  // directory, so the regression must not depend on an obsolete live Skill.
  const retiredDirectory = join(skills, "course-planning-beamer");
  mkdirSync(retiredDirectory, { recursive: true });
  writeFileSync(join(retiredDirectory, "SKILL.md"), "---\nname: course-planning-beamer\ndescription: Legacy migration fixture.\n---\n# Legacy teacher workflow\nRetired course production instructions.\n");
  const env = { PI_SKILLS_DIR: skills, PI_MODE_PACK_STORE_PATH: storePath, PI_CODING_AGENT_DIR: join(root, "agent"), PI_LEARNING_HARNESS_DIR: join(root, "harness"), ANTHROPIC_API_KEY: "offline-course-retirement-fixture" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(async () => {
    for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
    globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, skills, storePath, store: new ModePackStore(storePath) };
}
function saveDefinition(path, definition, peers = []) {
  writeFileSync(path, JSON.stringify({ version: 1, histories: Object.fromEntries([definition, ...peers].map(item => [item.modePackId, [item]])), retainedSharedPackageHashes: [], retainedSnapshotPackageHashes: [] }));
}
async function legacy(fixture, personal = false, extra = false) {
  const fresh = await fixture.store.resolve("course-builder", fixture.cwd);
  const retired = { kind: "skill", id: "teacher.course-planning-beamer", version: "1", contentHash: contentHash({ legacy: true }), instructions: ["Retired course production instructions."] };
  const descriptors = [...fresh.inventory.resources.map(({ kind, id, version, contentHash, delivery }) => ({ kind, id, version, contentHash, ...(delivery ? { delivery } : {}) })), retired];
  if (extra) descriptors.push({ kind: "skill", id: "test.unrelated-required", version: "1", contentHash: contentHash({ unrelated: true }) });
  const catalog = new ResourceCatalog(descriptors);
  const draft = { ...COURSE_BUILDER_DRAFT, revision: legacyDefault.revision, instructions: [], systemPrompt: personal ? "Keep my carefully customized teacher prompt." : legacyDefault.systemPrompt,
    provider: personal ? "anthropic" : null, model: personal ? "claude-sonnet-4-5" : null, tools: personal ? ["codemode", "read"] : COURSE_BUILDER_DRAFT.tools,
    components: [...COURSE_BUILDER_DRAFT.components, { type: "skill", id: retired.id, required: true, enabled: true, delivery: "native-skill" },
      { type: "skill", id: "education.lesson-blueprint", required: true, enabled: true, delivery: "native-skill" },
      ...(personal ? [{ type: "skill", id: "shared.personal-skill-builder", required: false, enabled: true, delivery: "native-skill" }] : []),
      ...(extra ? [{ type: "skill", id: "test.unrelated-required", required: true, enabled: true }] : [])] };
  const definition = compileModePackDraft(draft, catalog), snapshot = resolveModePackSnapshot({ pack: definition, catalog, courseVersionId: null });
  saveDefinition(fixture.storePath, definition);
  return { definition, snapshot, catalog };
}

test("Course default retirement adopts scoped prompt, preserves personal definitions and shared learner files", { concurrency: false }, async t => {
  const fixture = isolate(t), old = await legacy(fixture);
  const frozen = structuredClone(old.definition);
  rmSync(join(fixture.skills, "course-planning-beamer"), { recursive: true });
  const current = await fixture.store.resolve("course-builder", fixture.cwd);
  assert.equal(current.definition.revision, old.definition.revision + 1);
  assert.equal(current.definition.systemPrompt, COURSE_BUILDER_DRAFT.systemPrompt);
  assert.ok(current.definition.instructions.includes(migration.COURSE_WORKFLOW_MIGRATION_MARKER));
  assert.ok(!current.definition.components.some(item => migration.isRetiredCourseResource(item.type, item.id)));
  assert.ok(current.inventory.catalog.get("skill", "education.lesson-blueprint"), "learner Skill remains available");
  assert.deepEqual(old.definition, frozen, "previous definition is immutable");
  assert.equal((await fixture.store.resolve("course-builder", fixture.cwd)).definition.contentHash, current.definition.contentHash, "migration is idempotent");
  const { resolveSavedModeSettings } = await jiti.import("./rpc-manager.ts");
  const rebound = await resolveSavedModeSettings(old.snapshot, undefined, fixture.cwd, undefined, current.definition);
  assert.equal(rebound.snapshot.instructions[2], COURSE_BUILDER_DRAFT.systemPrompt, "an uncustomized historical session adopts the new default");
  assert.ok(!rebound.snapshot.instructions.includes("Retired course production instructions."));
  const personal = await legacy(fixture, true);
  const customized = await fixture.store.resolve("course-builder", fixture.cwd);
  for (const field of ["provider", "model", "tools", "systemPrompt"]) assert.deepEqual(customized.definition[field], personal.definition[field]);
  assert.ok(customized.snapshot.resources.some(item => item.id === "shared.personal-skill-builder"));
  const personalSkill = join(fixture.skills, "personal-skill-builder", "SKILL.md");
  writeFileSync(personalSkill, readFileSync(personalSkill, "utf8") + "\nRetained personal customization.\n");
  const refreshed = await fixture.store.resolve("course-builder", fixture.cwd);
  assert.equal(refreshed.definition.revision, customized.definition.revision + 1, "retained local personal Skills continue to refresh after migration");
  assert.equal(refreshed.definition.systemPrompt, personal.definition.systemPrompt);
});

test("Course retirement does not hide an unrelated missing required resource", { concurrency: false }, async t => {
  const fixture = isolate(t), old = await legacy(fixture, true, true), bytes = readFileSync(fixture.storePath, "utf8");
  await assert.rejects(fixture.store.resolve("course-builder", fixture.cwd), /test.unrelated-required.*not installed/);
  assert.equal(readFileSync(fixture.storePath, "utf8"), bytes, "failed migration leaves current definition intact");
  assert.ok(old.definition.components.some(item => item.id === "test.unrelated-required"));
});

test("portable Course retirement retains exact archive identity and custom settings", { concurrency: false }, async t => {
  const fixture = isolate(t);
  const file = (path, text) => { const bytes = Buffer.from(text); return { path, bytes: bytes.length, contentHash: portableModePackageAssetHash(bytes), base64: bytes.toString("base64") }; };
  const extension = file("module-runtime/extension.mjs", "export default function() {}\n"), skill = file("resources/retired/SKILL.md", "---\nname: old-course\ndescription: old\n---\nOld production instructions.\n");
  const resources = [{ kind: "extension", id: "course-builder", delivery: "system-instruction", contentHash: extension.contentHash, source: { type: "bundled", path: extension.path } },
    { kind: "skill", id: "teacher.course-planning-beamer", delivery: "native-skill", contentHash: skill.contentHash, source: { type: "bundled", path: skill.path } }];
  const tools = (await fixture.store.resolve("course-builder", fixture.cwd)).inventory.resources.filter(item => item.kind === "tool")
    .map(({ kind, id, version, contentHash }) => ({ kind, id, version, contentHash }));
  const catalog = new ResourceCatalog([...tools, ...resources.map(item => ({ kind: item.kind, id: item.id, version: "1.0.0", contentHash: item.contentHash }))]);
  const definition = compileModePackDraft({ ...COURSE_BUILDER_DRAFT, modePackId: "custom.course-import", revision: 1, systemPrompt: "My portable teacher prompt.", tools: ["read"], instructions: [],
    components: resources.map(item => ({ type: item.kind === "extension" ? "plugin" : "skill", id: item.id, required: true, enabled: true, ...(item.kind === "skill" ? { delivery: "native-skill" } : {}) })) }, catalog);
  const archive = createPortableModePackage({ moduleId: definition.modePackId, definition, resources, files: [extension, skill], frontend: null, projectCapabilities: [], targetPlatform: { os: process.platform, arch: process.arch }, externalDependencies: [],
    runtimeAssets: [{ kind: "harness", id: "course-builder", version: "1", entry: extension.path, contentHash: extension.contentHash, files: [extension.path] }],
    sharedResources: [{ logicalId: "fixture.course-extension", kind: "extension", id: "course-builder", files: [extension.path], compatibleVersions: ["2.0.0"] }] });
  const newerFile = file(extension.path, "export default function() { /* updated shared implementation */ }\n");
  const newerResource = { ...resources[0], contentHash: newerFile.contentHash };
  const newerDefinition = compileModePackDraft({ ...COURSE_BUILDER_DRAFT, modePackId: "custom.course-shared-provider", revision: 1,
    components: [{ type: "plugin", id: "course-builder", required: true, enabled: true }] },
    new ResourceCatalog([...tools, { kind: "extension", id: "course-builder", version: "2.0.0", contentHash: newerFile.contentHash }]));
  const newerArchive = createPortableModePackage({ definition: newerDefinition, resources: [newerResource], files: [newerFile], frontend: null,
    projectCapabilities: [], targetPlatform: archive.targetPlatform, externalDependencies: [],
    sharedResources: [{ logicalId: "fixture.course-extension", kind: "extension", id: "course-builder", files: [newerFile.path], compatibleVersions: [] }] });
  await ensurePortableModePackageArchive(archive); await ensurePortableModePackageArchive(newerArchive);
  saveDefinition(fixture.storePath, archive.definition, [newerArchive.definition]);
  const immutable = structuredClone(readPortableModePackage(archive.packageContentHash)), current = await fixture.store.resolve(archive.definition.modePackId, fixture.cwd);
  assert.equal(current.definition.packageContentHash, archive.packageContentHash);
  assert.equal(current.definition.systemPrompt, archive.definition.systemPrompt);
  assert.deepEqual(current.definition.tools, ["read"]);
  assert.equal(current.snapshot.resources.some(item => item.kind === "skill"), false);
  assert.equal(current.snapshot.resources.find(item => item.id === "course-builder").contentHash, newerFile.contentHash, "declared-compatible current shared provider is adopted");
  assert.deepEqual(readPortableModePackage(archive.packageContentHash), immutable);
  const { resolveSavedModeSettings } = await jiti.import("./rpc-manager.ts");
  const oldSnapshot = resolveModePackSnapshot({ pack: archive.definition, catalog, courseVersionId: null });
  const rebound = await resolveSavedModeSettings(oldSnapshot, undefined, fixture.cwd, undefined, current.definition);
  assert.ok(rebound.snapshot.instructions.includes(migration.COURSE_WORKFLOW_MIGRATION_MARKER));
  assert.equal(rebound.snapshot.packageContentHash, oldSnapshot.packageContentHash);
  assert.equal(rebound.snapshot.instructions[2], oldSnapshot.instructions[2]);
  assert.equal(rebound.snapshot.resources.some(item => item.id === "teacher.course-planning-beamer"), false);
});

test("dormant Course restart appends a verified migrated binding and preserves custom settings and history", { concurrency: false, timeout: 90000 }, async t => {
  const fixture = isolate(t), old = await legacy(fixture, true);
  const rpc = await jiti.import("./rpc-manager.ts"), { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const sid = rpc.createPersistedGenericSession(fixture.cwd, "Dormant legacy Course", old.snapshot), path = await resolveSessionPath(sid), before = readFileSync(path, "utf8");
  rmSync(join(fixture.skills, "course-planning-beamer"), { recursive: true });
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No model/network turn is authorized in migration regression"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const restarted = await rpc.startRpcSession(sid, path, undefined), status = await rpc.getGenericModePackStatus(sid);
  assert.equal(restarted.realSessionId, sid); assert.equal(status.runtime.verified, true);
  assert.ok(readFileSync(path, "utf8").startsWith(before), "historical JSONL is retained byte-for-byte");
  const migrated = status.runtime.binding.snapshot;
  assert.notEqual(migrated.resourceSnapshotId, old.snapshot.resourceSnapshotId);
  assert.ok(migrated.instructions.includes(migration.COURSE_WORKFLOW_MIGRATION_MARKER));
  assert.equal(migrated.instructions[2], old.snapshot.instructions[2]);
  assert.deepEqual(migrated.tools, old.snapshot.tools); assert.equal(migrated.model, old.snapshot.model);
  assert.ok(!migrated.resources.some(item => migration.isRetiredCourseResource(item.kind, item.id)));
  await restarted.session.shutdown();
});

test("marker-present built-in Course Host upgrade refreshes exact pins and appends a new binding", { concurrency: false, timeout: 90000 }, async t => {
  const fixture = isolate(t), fresh = await fixture.store.resolve("course-builder", fixture.cwd);
  const staleCatalog = new ResourceCatalog(fresh.inventory.resources.map(resource => ({ kind: resource.kind, id: resource.id,
    version: resource.version, contentHash: resource.id === "course-builder" && resource.kind === "extension" ? contentHash({ previousCourseHost: true }) : resource.contentHash })));
  const draft = { ...COURSE_BUILDER_DRAFT, revision: 22, systemPrompt: "Preserve my Course Host upgrade settings.",
    provider: "anthropic", model: "claude-sonnet-4-5", tools: ["codemode", "read"] };
  const definition = compileModePackDraft(draft, staleCatalog), oldSnapshot = resolveModePackSnapshot({ pack: definition, catalog: staleCatalog, courseVersionId: null });
  saveDefinition(fixture.storePath, definition);
  const current = await fixture.store.resolve("course-builder", fixture.cwd);
  assert.equal(current.definition.revision, 23);
  for (const field of ["provider", "model", "tools", "systemPrompt", "instructions"]) assert.deepEqual(current.definition[field], definition[field]);
  assert.equal(current.definition.components.find(component => component.id === "course-builder").contentHash, fresh.definition.components.find(component => component.id === "course-builder").contentHash);
  const actualHost = current.inventory.resourcesByKey.get("extension:course-builder");
  assert.equal(migration.isBuiltinCourseHostUpgrade(oldSnapshot, actualHost), true);
  assert.equal(migration.isBuiltinCourseHostUpgrade({ ...oldSnapshot, packageContentHash: "sha256:immutable-package" }, actualHost), false);
  assert.equal(migration.isBuiltinCourseHostUpgrade(oldSnapshot, { ...actualHost, source: "custom-extension" }), false);
  assert.equal(migration.isBuiltinCourseHostUpgrade(oldSnapshot, { ...actualHost, paths: [join(fixture.cwd, "course-builder-extension.ts")] }), false);
  const rpc = await jiti.import("./rpc-manager.ts"), { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const sid = rpc.createPersistedGenericSession(fixture.cwd, "Dormant updated Course Host", oldSnapshot), path = await resolveSessionPath(sid), bytes = readFileSync(path, "utf8");
  const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No model/network calls allowed during Host migration"); }; t.after(() => { globalThis.fetch = fetch; });
  const restarted = await rpc.startRpcSession(sid, path, undefined), status = await rpc.getGenericModePackStatus(sid);
  assert.equal(status.runtime.verified, true); assert.ok(readFileSync(path, "utf8").startsWith(bytes));
  const snapshot = status.runtime.binding.snapshot;
  assert.notEqual(snapshot.resourceSnapshotId, oldSnapshot.resourceSnapshotId);
  assert.equal(snapshot.resources.find(resource => resource.id === "course-builder").contentHash, actualHost.contentHash);
  assert.equal(snapshot.instructions[2], oldSnapshot.instructions[2]); assert.equal(snapshot.model, oldSnapshot.model); assert.deepEqual(snapshot.tools, oldSnapshot.tools);
  assert.match(status.runtime.binding.idempotencyKey, /^course-host-upgrade-v1:/);
  await restarted.session.shutdown();
});

test("Course Host refresh rejects unrelated missing required resources without changing the saved definition", { concurrency: false }, async t => {
  const fixture = isolate(t), fresh = await fixture.store.resolve("course-builder", fixture.cwd);
  const catalog = new ResourceCatalog([...fresh.inventory.resources.map(resource => ({ kind: resource.kind, id: resource.id, version: resource.version,
    contentHash: resource.kind === "extension" && resource.id === "course-builder" ? contentHash({ oldHost: true }) : resource.contentHash })),
    { kind: "extension", id: "test.unrelated-required", version: "1", contentHash: contentHash({ unrelated: true }) }]);
  const definition = compileModePackDraft({ ...COURSE_BUILDER_DRAFT, components: [...COURSE_BUILDER_DRAFT.components,
    { type: "plugin", id: "test.unrelated-required", enabled: true, required: true }] }, catalog);
  saveDefinition(fixture.storePath, definition); const bytes = readFileSync(fixture.storePath, "utf8");
  await assert.rejects(fixture.store.resolve("course-builder", fixture.cwd), /missing extension:test.unrelated-required/);
  assert.equal(readFileSync(fixture.storePath, "utf8"), bytes);
});

test("built-in Course Host upgrade works without a saved definition and preserves session overrides", { concurrency: false, timeout: 90000 }, async t => {
  const fixture = isolate(t), fresh = await fixture.store.resolve("course-builder", fixture.cwd);
  const catalog = new ResourceCatalog(fresh.inventory.resources.map(resource => ({ kind: resource.kind, id: resource.id, version: resource.version,
    contentHash: resource.kind === "extension" && resource.id === "course-builder" ? contentHash({ previousBuiltinHost: true }) : resource.contentHash })));
  const definition = compileModePackDraft({ ...COURSE_BUILDER_DRAFT, revision: 22 }, catalog);
  const { reviseModePackSettings } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");
  const snapshot = reviseModePackSettings(resolveModePackSnapshot({ pack: definition, catalog, courseVersionId: null }), {
    systemPrompt: "My personal persisted Course prompt.", provider: "anthropic", model: "claude-sonnet-4-5", tools: ["read", "codemode"],
  }, catalog);
  assert.equal(fixture.store.getCustom("course-builder"), null);
  const rpc = await jiti.import("./rpc-manager.ts"), { resolveSessionPath } = await jiti.import("./session-reader.ts");
  const sid = rpc.createPersistedGenericSession(fixture.cwd, "Builtin Course Host restore", snapshot), path = await resolveSessionPath(sid), bytes = readFileSync(path, "utf8");
  const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No model/network calls allowed during Host migration"); }; t.after(() => { globalThis.fetch = fetch; });
  const restarted = await rpc.startRpcSession(sid, path, undefined), status = await rpc.getGenericModePackStatus(sid);
  assert.equal(status.runtime.verified, true); assert.ok(readFileSync(path, "utf8").startsWith(bytes));
  const upgraded = status.runtime.binding.snapshot;
  assert.equal(upgraded.instructions[2], snapshot.instructions[2]); assert.equal(upgraded.provider, snapshot.provider);
  assert.equal(upgraded.model, snapshot.model); assert.deepEqual(upgraded.tools, snapshot.tools);
  assert.equal(upgraded.resources.find(resource => resource.id === "course-builder").contentHash, fresh.snapshot.resources.find(resource => resource.id === "course-builder").contentHash);
  assert.equal(fixture.store.getCustom("course-builder"), null, "built-in upgrade does not create a saved personal definition");
  await restarted.session.shutdown();
});
