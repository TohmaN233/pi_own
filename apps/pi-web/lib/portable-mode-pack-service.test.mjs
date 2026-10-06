import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
const { composePortableModePackage, exportPortableModePackage, exportPortableModePackageFiles, importPortableModePackage, importPortableModePackageFiles } = await jiti.import("./portable-mode-pack-service.ts");
const { preflightPortableHostCapabilities } = await jiti.import("./portable-mode-import-preflight.ts");

test("portable host interface versions fail before registration", () => {
  const supported = archive("custom.host-capability");
  supported.projectCapabilities = ["host-api:cwd-browse@1", "host-api:pdf-preview@1"];
  assert.doesNotThrow(() => preflightPortableHostCapabilities(supported));
  supported.projectCapabilities = ["host-api:pdf-preview@2"];
  assert.throws(() => preflightPortableHostCapabilities(supported), /Conflicts happen[\s\S]*host-api:pdf-preview@2[\s\S]*install failed\./u);
});
const { readPortableModeBundle, writePortableModeBundle } = await jiti.import("./portable-mode-bundle.ts");
const { preflightPortableExternalDependencies, preflightPortableLocalNpmPayload } = await jiti.import("./portable-mode-import-preflight.ts");
const { portableModePackageDirectory, readPortableModePackages } = await jiti.import("./portable-mode-pack-registry.ts");
const { ModePackStore, definitionToDraft } = await jiti.import("./mode-pack-store.ts");
const { createPortableModePackage, parsePortableModePackage, portableModuleFrontendEntry } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");
const { ensurePortableModePackageInstalled } = await jiti.import("./portable-mode-package-install.ts");
const { loadPortableModeRuntime } = await jiti.import("./portable-mode-runtime-loader.ts");
const { loadModeExtensions } = await jiti.import("./mode-extension-loader.ts");
const { isCourseBuilderSnapshot } = await jiti.import("./course-builder-mode.ts");
const { studyModePhaseForSnapshot } = await jiti.import("./study-mode-policy.ts");
const { buildModePackRuntimePlan } = await jiti.import("./mode-pack-inventory.ts");

function archiveFile(path, bytes) { return { path, contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.byteLength, base64: bytes.toString("base64") }; }

function archive(id = "custom.portable-smoke", body = "one") {
  const html = Buffer.from("<!doctype html><title>portable</title>");
  const skill = Buffer.from(`---\nname: portable-smoke\ndescription: portable\n---\nUse ${body}. [Shared reference](../../references/common.md)\n`);
  const frontendFile = archiveFile("frontend/index.html", html); const skillFile = archiveFile("resources/skill/portable.skill/SKILL.md", skill); const reference = archiveFile("resources/references/common.md", Buffer.from(`reference-${body}\n`));
  const resources = [{ kind: "skill", id: "portable.skill", delivery: "native-skill", contentHash: skillFile.contentHash, source: { type: "bundled", path: skillFile.path } }]; const frontend = { entry: frontendFile.path, assets: [{ path: frontendFile.path, contentHash: frontendFile.contentHash, bytes: frontendFile.bytes }] }; const projectCapabilities = [];
  const targetPlatform = { os: process.platform, arch: process.arch }; const externalDependencies = [];
  const files = [frontendFile, skillFile, reference]; const packageContentHash = contentHash({ resources, files: files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })), frontend, projectCapabilities, targetPlatform, externalDependencies });
  const components = [{ type: "skill", id: "portable.skill", required: true, enabled: true, delivery: "native-skill", version: packageContentHash, contentHash: skillFile.contentHash }];
  const draft = { version: 1, modePackId: id, revision: 1, title: "Portable", description: "portable smoke", category: "general", role: "general", runtimeMode: "general", provider: null, model: null, thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false, tools: ["read"], components, systemPrompt: "Portable smoke.", instructions: [], packageContentHash };
  return { version: 1, definition: { ...draft, contentHash: contentHash(draft) }, resources, frontend, projectCapabilities, targetPlatform, externalDependencies, files, packageContentHash };
}

function archiveWithConflictingSelectedSkill(equalPrimaryBytes = false) {
  const original = archive("custom.same-skill-name");
  const second = archiveFile("resources/skill/portable.other/SKILL.md", equalPrimaryBytes
    ? Buffer.from(original.files[1].base64, "base64")
    : Buffer.from("---\nname: portable-smoke\ndescription: other implementation\n---\nUse a different implementation.\n"));
  const resources = [...original.resources, { kind: "skill", id: "portable.other", delivery: "native-skill", contentHash: second.contentHash, source: { type: "bundled", path: second.path } }];
  const files = [...original.files, second];
  const packageContentHash = contentHash({ resources, files: files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })), frontend: original.frontend, projectCapabilities: original.projectCapabilities, targetPlatform: original.targetPlatform, externalDependencies: original.externalDependencies });
  const components = [
    ...original.definition.components,
    { type: "skill", id: "portable.other", required: true, enabled: true, delivery: "native-skill", version: packageContentHash, contentHash: second.contentHash },
  ];
  const { contentHash: _priorHash, ...priorDefinition } = original.definition;
  const definition = { ...priorDefinition, components, packageContentHash };
  return { ...original, resources, files, packageContentHash, definition: { ...definition, contentHash: contentHash(definition) } };
}

test("declared host executable is found on PATH without running it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-external-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = "pi-own-external-fixture";
  const extension = process.platform === "win32" ? ".CMD" : "";
  writeFileSync(join(root, `${name}${extension}`), "must never run\n");
  if (process.platform !== "win32") chmodSync(join(root, name), 0o755);
  const value = archive("custom.external-present");
  value.externalDependencies = [{ kind: "executable", name }];
  preflightPortableExternalDependencies(value, { PATH: root, PATHEXT: ".CMD" });
});

test("ordinary built-in modes use the same portable archive and import path", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-builtin-portable-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "harness");
  delete process.env.PI_MODE_PACK_STORE_PATH;
  const cwd = join(root, "project"); mkdirSync(cwd, { recursive: true });
  for (const id of ["general", "creative"]) {
    const exported = await exportPortableModePackage(id, cwd);
    assert.equal(exported.definition.modePackId, id);
    assert.ok(exported.resources.length > 0);
    assert.ok(exported.resources.every((resource) => resource.source.type === "bundled"));
    assert.ok(exported.resources.every((resource) => exported.files.some((file) => file.path === resource.source.path)));
    const imported = await importPortableModePackage(exported, cwd, 0, `custom.${id}-portable`);
    const resolved = await new ModePackStore().resolve(imported.modePackId, cwd);
    assert.equal(resolved.snapshot.profileId, imported.modePackId);
    assert.equal(resolved.snapshot.packageContentHash, exported.packageContentHash);
  }
});

test("binary portable format streams a complete common archive without base64 in its manifest", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-binary-portable-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = join(root, "source-agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "source-harness");
  delete process.env.PI_MODE_PACK_STORE_PATH;
  const cwd = join(root, "project"); mkdirSync(cwd);
  const exported = await exportPortableModePackageFiles("general", cwd);
  const target = join(root, "general.mode-pack.tar");
  try { await writePortableModeBundle(exported.archive, exported.sources, target); } finally { exported.cleanup(); }
  const payload = join(root, "payload"); mkdirSync(payload);
  const parsed = await readPortableModeBundle(createReadStream(target), payload);
  assert.equal(parsed.definition.modePackId, "general");
  assert.ok(parsed.files.every((file) => file.base64 === undefined));
  process.env.PI_CODING_AGENT_DIR = join(root, "destination-agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "destination-harness");
  const installed = await importPortableModePackageFiles(parsed, payload, cwd, 0, "custom.general-binary");
  assert.equal((await new ModePackStore().resolve(installed.modePackId, cwd)).snapshot.packageContentHash, parsed.packageContentHash);
});

test("module-owned harness and route validation travel in a typed, hash-checked package", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-runtime-assets-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(root, { recursive: true, force: true }); });
  const base = archive("custom.with-runtime-assets");
  const harness = archiveFile("assets/harness.mjs", Buffer.from("export default () => ({})\n"));
  const validation = archiveFile("assets/validate.mjs", Buffer.from("export default () => true\n"));
  const packaged = createPortableModePackage({
    definition: base.definition, resources: base.resources, files: [...base.files, harness, validation],
    frontend: base.frontend, projectCapabilities: base.projectCapabilities,
    targetPlatform: base.targetPlatform, externalDependencies: base.externalDependencies,
    runtimeAssets: [
      { kind: "harness", id: "learning", version: "1.0.0", entry: harness.path, contentHash: harness.contentHash, files: [harness.path] },
      { kind: "route-validation", id: "study-route", version: "1.0.0", entry: validation.path, contentHash: validation.contentHash, files: [validation.path] },
    ],
  });
  assert.equal(packaged.runtimeAssets.length, 2);
  const bundle = join(root, "module.mode-pack.tar");
  await writePortableModeBundle({ ...packaged, files: packaged.files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })) },
    new Map(packaged.files.map((file) => [file.path, { bytes: Buffer.from(file.base64, "base64") }])), bundle);
  const payload = join(root, "payload"); mkdirSync(payload);
  const unpacked = await readPortableModeBundle(createReadStream(bundle), payload);
  assert.deepEqual(unpacked.runtimeAssets, packaged.runtimeAssets);
  assert.equal(readFileSync(join(payload, harness.path), "utf8"), "export default () => ({})\n");
  await assert.rejects(importPortableModePackage(packaged, process.cwd()), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.equal(error.conflicts[0]?.kind, "runtime-activation");
    return true;
  });
  const corrupt = structuredClone(packaged);
  corrupt.runtimeAssets[0].contentHash = validation.contentHash;
  const { parsePortableModePackage } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");
  assert.throws(() => parsePortableModePackage(corrupt), /does not match entry bytes/u);
  const needsNpm = createPortableModePackage({
    definition: base.definition, resources: base.resources, files: [...base.files, harness],
    frontend: base.frontend, projectCapabilities: base.projectCapabilities,
    targetPlatform: base.targetPlatform, externalDependencies: base.externalDependencies,
    runtimeAssets: [{ kind: "harness", id: "learning", version: "1.0.0", entry: harness.path,
      contentHash: harness.contentHash, files: [harness.path],
      runtimeDependencies: [{ package: "example-harness-runtime", version: "1.0.0", integrity: "sha512-YQ==", entries: ["index.js"] }] }],
  });
  assert.throws(() => preflightPortableLocalNpmPayload(needsNpm), (error) =>
    error.code === "PORTABLE_MODE_IMPORT_CONFLICT" && error.conflicts[0]?.kind === "missing-local-npm-payload");
});

test("Course Builder and Study & Research transfer complete frontend and runtime trees across installations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-education-package-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const repository = join(import.meta.dirname, "..", "..", "..");
  for (const script of ["build-portable-module-frontends.mjs", "build-portable-module-runtime.mjs"]) {
    const result = spawnSync(process.execPath, [join(repository, "scripts", script)], { cwd: repository, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
  }
  const cwd = join(root, "project"); mkdirSync(cwd, { recursive: true });
  for (const [modeId, moduleId, expectedRoutes, extensionCount] of [
    ["course-builder", "course-builder", ["", "assignment-assets", "deck", "deck/sync", "export", "import", "link", "session", "study-assets", "teacher-notes", "teacher-notes/sync", "workflows"], 1],
    ["study-research.study", "study-research", ["", "assignment", "environment", "execution", "execution/artifact", "export", "manuscript", "reading", "references", "research", "results", "review", "session", "source", "teaching", "visual-interaction", "visual-validation", "visualization", "workflow"], 6],
  ]) {
    process.env.PI_CODING_AGENT_DIR = join(root, moduleId, "source-agent");
    process.env.PI_LEARNING_HARNESS_DIR = join(root, moduleId, "source-harness");
    delete process.env.PI_MODE_PACK_STORE_PATH;
    const exported = await exportPortableModePackageFiles(modeId, cwd);
    assert.equal(exported.archive.moduleId, moduleId);
    assert.equal(exported.archive.runtimeAssets.length, 2);
    assert.ok(exported.archive.frontend.assets.some((asset) => asset.path.endsWith(".html")));
    const bundle = join(root, `${moduleId}.mode-pack.tar`);
    await writePortableModeBundle(exported.archive, exported.sources, bundle);
    exported.cleanup();
    const payload = join(root, `${moduleId}-payload`); mkdirSync(payload);
    const transferred = await readPortableModeBundle(createReadStream(bundle), payload);
    process.env.PI_CODING_AGENT_DIR = join(root, moduleId, "destination-agent");
    process.env.PI_LEARNING_HARNESS_DIR = join(root, moduleId, "destination-harness");
    const installed = await importPortableModePackageFiles(transferred, payload, cwd, 0, `custom.${moduleId}`);
    assert.equal(installed.packageContentHash, transferred.packageContentHash);
    const runtime = await loadPortableModeRuntime(transferred);
    assert.deepEqual(Object.keys(runtime.routes).sort(), expectedRoutes, "the transferred runtime exports every module route, including scoped workflows");
    const harness = transferred.runtimeAssets.find((asset) => asset.kind === "harness");
    const manifestPath = harness.files.find((path) => path.endsWith("/runtime-manifest.json"));
    assert.ok(manifestPath, "the route manifest travels with the runtime");
    const manifest = JSON.parse(readFileSync(join(portableModePackageDirectory(transferred.packageContentHash), manifestPath), "utf8"));
    assert.deepEqual([...manifest.routes].sort(), expectedRoutes, "the complete declared route manifest matches the installed exports");
    assert.equal(Object.keys(runtime.extensions).length, extensionCount);
    const installedExtensions = transferred.resources.filter((resource) => resource.kind === "extension" && resource.source.type === "bundled")
      .map((resource) => join(process.env.PI_CODING_AGENT_DIR, "mode-packs", "packages", transferred.packageContentHash.slice("sha256:".length), resource.source.path));
    const loadedExtensions = await loadModeExtensions(installedExtensions, cwd, undefined, undefined, transferred);
    assert.deepEqual(loadedExtensions.errors, []);
    assert.equal(loadedExtensions.extensions.length, extensionCount);
    const installedSnapshot = (await new ModePackStore().resolve(installed.modePackId, cwd)).snapshot;
    assert.equal(installedSnapshot.packageContentHash, transferred.packageContentHash);
    if (moduleId === "course-builder") assert.equal(isCourseBuilderSnapshot(installedSnapshot), true);
    else assert.equal(studyModePhaseForSnapshot(installedSnapshot), "study");
    if (moduleId === "study-research") assert.ok(new ModePackStore().getCustom("custom.study-research.research"));
  }
});

test("one module archive imports both phases atomically and round-trips by either phase", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-multi-profile-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "harness");
  delete process.env.PI_MODE_PACK_STORE_PATH;
  const cwd = join(root, "project"); mkdirSync(cwd);
  const single = archive("custom.original.study");
  const second = { ...single.definition, modePackId: "custom.original.research", title: "Research" };
  const researchPage = archiveFile("frontend/research.html", Buffer.from("<!doctype html><title>research</title>"));
  const frontend = { ...single.frontend,
    assets: [...single.frontend.assets, { path: researchPage.path, contentHash: researchPage.contentHash, bytes: researchPage.bytes }],
    phaseEntries: { ".research": researchPage.path } };
  const bundled = createPortableModePackage({
    moduleId: "custom.original", definition: single.definition, profiles: [second],
    resources: single.resources, files: [...single.files, researchPage], frontend,
    projectCapabilities: single.projectCapabilities, targetPlatform: single.targetPlatform,
    externalDependencies: single.externalDependencies,
  });
  assert.equal(bundled.profiles.length, 1);
  assert.equal(portableModuleFrontendEntry(bundled, "custom.original.research"), researchPage.path);
  const installed = await importPortableModePackage(bundled, cwd, 0, "custom.installed");
  assert.equal(installed.modePackId, "custom.installed.study");
  const store = new ModePackStore();
  assert.ok(store.getCustom("custom.installed.research"));
  assert.equal((await store.resolve("custom.installed.research", cwd)).snapshot.packageContentHash, installed.packageContentHash);
  assert.equal(portableModuleFrontendEntry(bundled, "custom.installed.research"), researchPage.path);
  const reexported = await exportPortableModePackage("custom.installed.research", cwd);
  assert.equal(reexported.moduleId, "custom.installed");
  assert.deepEqual([reexported.definition.modePackId, ...reexported.profiles.map((item) => item.modePackId)],
    ["custom.installed.study", "custom.installed.research"]);
  const secondInstall = await importPortableModePackage(bundled, cwd, 0, "custom.another");
  assert.equal(secondInstall.packageContentHash, installed.packageContentHash);
  assert.ok(store.getCustom("custom.another.research"));
  const secondExport = await exportPortableModePackage("custom.another.study", cwd);
  assert.equal(secondExport.moduleId, "custom.another");
  assert.equal(secondExport.packageContentHash, bundled.packageContentHash);
  await assert.rejects(store.deleteCustom("custom.another.study", 1), /delete the complete module/u);
  await assert.rejects(store.deleteCustomModule("custom.another.study", {
    "custom.another.study": 1, "custom.another.research": 2,
  }), /revision conflict/u);
  assert.ok(store.getCustom("custom.another.study"));
  await store.deleteCustomModule("custom.another.study", {
    "custom.another.study": 1, "custom.another.research": 1,
  });
  assert.equal(store.getCustom("custom.another.study"), null);
  assert.equal(store.getCustom("custom.another.research"), null);
  await assert.rejects(importPortableModePackage(bundled, cwd, 0, "custom.installed"), /revision conflict/u);
  assert.equal(store.getCustom("custom.installed.study")?.revision, 1);
  assert.equal(store.getCustom("custom.installed.research")?.revision, 1);
  const researchDraft = definitionToDraft(store.getCustom("custom.installed.research"));
  researchDraft.revision = 2;
  researchDraft.components = researchDraft.components.map((component) => component.type === "skill"
    ? { ...component, required: false, enabled: false } : component);
  const revised = await composePortableModePackage({ draft: researchDraft, cwd, expectedRevision: 1, resourceSources: [] });
  assert.equal(revised.modePackId, "custom.installed.research");
  assert.equal(revised.revision, 2);
  assert.equal(revised.components.find((component) => component.type === "skill")?.enabled, false);
  assert.equal(store.getCustom("custom.installed.study")?.revision, 2);
  assert.equal(store.getCustom("custom.installed.study")?.packageContentHash, revised.packageContentHash);
  assert.equal(store.getCustom("custom.installed.study")?.components.find((component) => component.type === "skill")?.enabled, true);
  assert.equal((await exportPortableModePackage("custom.installed.study", cwd)).profiles?.[0]?.modePackId, "custom.installed.research");
});

test("unlink removes a default Skill and its bytes from the exported module", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-unlink-skill-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousStore = process.env.PI_MODE_PACK_STORE_PATH;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_MODE_PACK_STORE_PATH = join(root, "agent", "mode-packs", "store.json");
  t.after(() => {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousStore === undefined) delete process.env.PI_MODE_PACK_STORE_PATH; else process.env.PI_MODE_PACK_STORE_PATH = previousStore;
    rmSync(root, { recursive: true, force: true });
  });
  const cwd = join(root, "project"); mkdirSync(cwd);
  const installed = await importPortableModePackage(createPortableModePackage(archive("custom.unlink-skill")), cwd);
  const draft = definitionToDraft(installed, { revision: 2 });
  draft.components = [];
  const saved = await new ModePackStore().saveDraft(draft, cwd, 1);
  assert.deepEqual(saved.components, []);
  const selected = await new ModePackStore().resolve(saved.modePackId, cwd);
  assert.equal(selected.snapshot.resources.some((resource) => resource.kind === "skill"), false);
  const exported = await exportPortableModePackage(saved.modePackId, cwd);
  assert.equal(exported.resources.some((resource) => resource.kind === "skill"), false);
  assert.equal(exported.files.some((file) => file.path.endsWith("/SKILL.md")), false);
});

test("module layout rejects foreign phases and frontend entries outside its asset graph", () => {
  const single = archive("custom.layout.study");
  const content = {
    moduleId: "custom.layout", definition: single.definition,
    resources: single.resources, files: single.files, frontend: single.frontend,
    projectCapabilities: single.projectCapabilities, targetPlatform: single.targetPlatform,
    externalDependencies: single.externalDependencies,
  };
  assert.throws(() => createPortableModePackage({ ...content,
    profiles: [{ ...single.definition, modePackId: "custom.foreign.research" }],
  }), /does not belong to module/u);
  assert.throws(() => createPortableModePackage({ ...content,
    frontend: { ...single.frontend, phaseEntries: { ".study": "frontend/missing.html" } },
  }), /not an asset/u);
});

test("a complete package dependency graph is bound to its verified asset closure", () => {
  const packaged = createPortableModePackage({ ...archive("custom.graph-check") });
  assert.ok(packaged.dependencyGraph?.nodes.some((node) => node.id === "frontend"));
  assert.ok(packaged.dependencyGraph?.edges.some((edge) => edge.from === "frontend" && edge.to === `file:${packaged.frontend.entry}`));
  const tampered = structuredClone(packaged);
  tampered.dependencyGraph.edges.pop();
  assert.throws(() => parsePortableModePackage(tampered), /dependencyGraph: does not match/u);
});

test("explicit shared resources upgrade to the newest compatible packaged bytes while private names coexist", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-shared-portable-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "harness");
  delete process.env.PI_MODE_PACK_STORE_PATH;
  const cwd = join(root, "project"); mkdirSync(cwd);
  const shared = (id, version, body, compatibleVersions = [], logicalId = "fixture.common-skill") => {
    const base = archive(id, body);
    return createPortableModePackage({
      definition: { ...base.definition, components: base.definition.components.map((component) => ({ ...component, version })) },
      resources: base.resources, files: base.files, frontend: base.frontend,
      projectCapabilities: base.projectCapabilities, targetPlatform: base.targetPlatform,
      externalDependencies: base.externalDependencies,
      sharedResources: [{ logicalId, kind: "skill", id: "portable.skill", files: base.files.filter((file) => file.path.startsWith("resources/")).map((file) => file.path), compatibleVersions }],
    });
  };
  const old = shared("custom.shared-old", "1.0.0", "old", ["2.0.0"]);
  const newest = shared("custom.shared-new", "2.0.0", "new");
  assert.ok(old.dependencyGraph.edges.some((edge) => edge.from === "shared:fixture.common-skill" && edge.to === "resource:skill:portable.skill"));
  const forgedCompatibility = structuredClone(old);
  forgedCompatibility.sharedResources[0].compatibleVersions = ["3.0.0"];
  assert.throws(() => parsePortableModePackage(forgedCompatibility), /packageContentHash: invalid package payload identity/u);
  await importPortableModePackage(old, cwd);
  const historicalSnapshot = (await new ModePackStore().resolve("custom.shared-old", cwd)).snapshot;
  await importPortableModePackage(newest, cwd);
  const resolved = await new ModePackStore().resolve("custom.shared-old", cwd);
  assert.equal(resolved.snapshot.resources.find((resource) => resource.id === "portable.skill")?.version, "2.0.0");
  assert.match(resolved.inventory.resourcesByKey.get("skill:portable.skill")?.text ?? "", /Use new/u);
  const restored = await buildModePackRuntimePlan({ snapshot: resolved.snapshot, cwd, definition: resolved.definition });
  assert.equal(restored.skillPaths.length, 1);
  assert.ok(restored.skillPaths[0].includes(newest.packageContentHash.slice("sha256:".length)), "restored session binds the actual newer provider bytes");
  const oldSession = await buildModePackRuntimePlan({ snapshot: historicalSnapshot, cwd });
  assert.ok(oldSession.skillPaths[0].includes(old.packageContentHash.slice("sha256:".length)), "historical session retains its original exact provider");
  assert.equal((await exportPortableModePackage("custom.shared-old", cwd)).definition.components[0].version, "1.0.0", "standalone export retains complete original bytes and exact pin");
  const incompatible = shared("custom.shared-incompatible", "3.0.0", "unaccepted");
  await assert.rejects(importPortableModePackage(incompatible, cwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.match(error.message, /Conflicts happen[\s\S]*fixture.common-skill[\s\S]*upgrade-not-declared[\s\S]*install failed\./u);
    return true;
  });
  assert.equal(new ModePackStore().getCustom("custom.shared-incompatible"), null);
  const sameVersionDifferentBytes = shared("custom.shared-same-version", "2.0.0", "different");
  await assert.rejects(importPortableModePackage(sameVersionDifferentBytes, cwd), (error) => {
    assert.equal(error.conflicts?.[0]?.reason, "same-version-different-content");
    return true;
  });
  const sameEntry = shared("custom.shared-different-reference", "2.0.0", "new");
  const changedReference = archiveFile("resources/references/common.md", Buffer.from("another-reference\n"));
  const sameEntryDifferentClosure = createPortableModePackage({
    definition: sameEntry.definition, resources: sameEntry.resources,
    files: sameEntry.files.map((file) => file.path === changedReference.path ? changedReference : file),
    frontend: sameEntry.frontend, projectCapabilities: sameEntry.projectCapabilities,
    targetPlatform: sameEntry.targetPlatform, externalDependencies: sameEntry.externalDependencies,
    sharedResources: sameEntry.sharedResources,
  });
  await assert.rejects(importPortableModePackage(sameEntryDifferentClosure, cwd), (error) => {
    assert.equal(error.conflicts?.[0]?.reason, "same-version-different-content", "shared support files participate in the implementation identity");
    return true;
  });
  const privateSameName = archive("custom.private-same-name", "private");
  await importPortableModePackage(privateSameName, cwd);
  assert.match((await new ModePackStore().resolve("custom.private-same-name", cwd)).inventory.resourcesByKey.get("skill:portable.skill")?.text ?? "", /Use private/u);
  const exactCommit = shared("custom.commit-a", "git-abc", "commit", [], "fixture.commit-skill");
  await importPortableModePackage(exactCommit, cwd);
  await importPortableModePackage(shared("custom.commit-b", "git-abc", "commit", [], "fixture.commit-skill"), cwd);
  await assert.rejects(importPortableModePackage(shared("custom.commit-c", "git-def", "commit-next", [], "fixture.commit-skill"), cwd), (error) => {
    assert.equal(error.conflicts?.[0]?.reason, "unorderable-version", "unversioned sources share only on exact identity");
    return true;
  });
  await new ModePackStore().deleteCustom("custom.shared-new", 1);
  const retained = await buildModePackRuntimePlan({ snapshot: resolved.snapshot, cwd, definition: resolved.definition });
  assert.ok(retained.skillPaths[0].includes(newest.packageContentHash.slice("sha256:".length)), "a committed session keeps its provider after its owning mode is deleted");
  assert.equal((await new ModePackStore().resolve("custom.shared-old", cwd)).snapshot.resources.find((resource) => resource.id === "portable.skill")?.version, "1.0.0", "new activations select the newest currently installed provider");
});

test("a shared extension loads the newer package entrypoint in an older mode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-shared-extension-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "harness");
  delete process.env.PI_MODE_PACK_STORE_PATH;
  const cwd = join(root, "project"); mkdirSync(cwd);
  const extension = (id, version, marker, compatibleVersions = []) => {
    const base = archive(id);
    const entry = archiveFile("resources/extension/portable.ext/index.js", Buffer.from(`export default (pi) => { pi.on("session_start", () => { /* ${marker} */ }); };\n`));
    return createPortableModePackage({
      definition: { ...base.definition, components: [{ type: "plugin", id: "portable.ext", required: true, enabled: true, version, contentHash: entry.contentHash }] },
      resources: [{ kind: "extension", id: "portable.ext", delivery: "system-instruction", contentHash: entry.contentHash, source: { type: "bundled", path: entry.path } }],
      files: [...base.files.filter((file) => file.path === base.frontend.entry), entry], frontend: base.frontend,
      projectCapabilities: [], targetPlatform: base.targetPlatform, externalDependencies: [],
      sharedResources: [{ logicalId: "fixture.common-extension", kind: "extension", id: "portable.ext", files: [entry.path], compatibleVersions }],
    });
  };
  const old = extension("custom.extension-old", "1.0.0", "old", ["2.0.0"]);
  const newer = extension("custom.extension-new", "2.0.0", "new");
  await importPortableModePackage(old, cwd);
  await importPortableModePackage(newer, cwd);
  const resolved = await new ModePackStore().resolve("custom.extension-old", cwd);
  const plan = await buildModePackRuntimePlan({ snapshot: resolved.snapshot, cwd, definition: resolved.definition });
  assert.equal(plan.extensionPaths.length, 1);
  assert.ok(plan.extensionPaths[0].includes(newer.packageContentHash.slice("sha256:".length)));
  const loaded = await loadModeExtensions(plan.extensionPaths, cwd, createEventBus(), undefined, old);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].path, plan.extensionPaths[0]);
});

test("import preflight rejects a new shared extension that would collide with an installed mode flag", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-shared-public-conflict-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "harness");
  delete process.env.PI_MODE_PACK_STORE_PATH;
  const cwd = join(root, "project"); mkdirSync(cwd);
  const make = (id, version, sharedFlag, privateFlag, compatibleVersions = []) => {
    const base = archive(id);
    const sharedEntry = archiveFile("resources/extension/fixture.shared/index.js", Buffer.from(`export default (pi) => pi.registerFlag(${JSON.stringify(sharedFlag)}, { type: "boolean", default: false });\n`));
    const privateEntry = privateFlag ? archiveFile("resources/extension/fixture.private/index.js", Buffer.from(`export default (pi) => pi.registerFlag(${JSON.stringify(privateFlag)}, { type: "boolean", default: false });\n`)) : null;
    return createPortableModePackage({
      definition: { ...base.definition, components: [
        { type: "plugin", id: "fixture.shared", required: true, enabled: true, version, contentHash: sharedEntry.contentHash },
        ...(privateEntry ? [{ type: "plugin", id: "fixture.private", required: true, enabled: true, version: "1.0.0", contentHash: privateEntry.contentHash }] : []),
      ] },
      resources: [
        { kind: "extension", id: "fixture.shared", delivery: "system-instruction", contentHash: sharedEntry.contentHash, source: { type: "bundled", path: sharedEntry.path } },
        ...(privateEntry ? [{ kind: "extension", id: "fixture.private", delivery: "system-instruction", contentHash: privateEntry.contentHash, source: { type: "bundled", path: privateEntry.path } }] : []),
      ],
      files: [base.files.find((file) => file.path === base.frontend.entry), sharedEntry, ...(privateEntry ? [privateEntry] : [])],
      frontend: base.frontend, projectCapabilities: [], targetPlatform: base.targetPlatform, externalDependencies: [],
      sharedResources: [{ logicalId: "fixture.public-shared", kind: "extension", id: "fixture.shared", files: [sharedEntry.path], compatibleVersions }],
    });
  };
  await importPortableModePackage(make("custom.public-old", "1.0.0", "old-flag", "taken-flag", ["2.0.0"]), cwd);
  await assert.rejects(importPortableModePackage(make("custom.public-new", "2.0.0", "taken-flag", null), cwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.equal(error.conflicts?.[0]?.kind, "public-registration");
    assert.match(error.message, /Conflicts happen[\s\S]*taken-flag[\s\S]*install failed\./u);
    assert.match(error.agentPrompt(), /taken-flag/u);
    return true;
  });
  assert.equal(new ModePackStore().getCustom("custom.public-new"), null, "the conflicting provider never becomes an installed mode");
});

test("education export carries compiled extension and route closure rather than host source paths", async () => {
  const packaged = await exportPortableModePackage("course-builder", process.cwd());
  const extension = packaged.resources.find((resource) => resource.kind === "extension" && resource.id === "course-builder");
  assert.equal(extension?.source.type, "bundled");
  assert.match(extension.source.path, /^module-runtime\/extension-course-builder\.mjs$/u);
  assert.ok(packaged.files.some((file) => file.path === "module-runtime/module.mjs"));
  assert.ok(packaged.files.some((file) => file.path === "module-runtime/runtime-manifest.json"));
  assert.equal(packaged.runtimeAssets.length, 2);
});

test("npm dependency bytes travel with a package and install without registry access", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-offline-export-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH", "npm_execpath"].map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const npm = join(root, "fixture-npm.cjs");
  const calls = join(root, "npm-calls.txt");
  writeFileSync(npm, [
    'const fs=require("node:fs"),path=require("node:path");',
    `fs.appendFileSync(${JSON.stringify(calls)}, "install\\n");`,
    'const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),"package.json"),"utf8"));',
    'const name="fixture-offline",dir=path.join(process.cwd(),"node_modules",name);',
    'if(pkg.dependencies[name]!=="1.0.0")throw Error("unexpected dependency");',
    'fs.mkdirSync(dir,{recursive:true});',
    'fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name,version:"1.0.0"}));',
    'fs.writeFileSync(path.join(dir,"index.js"),"module.exports = 42;\\n");',
    'fs.writeFileSync(path.join(process.cwd(),"package-lock.json"),JSON.stringify({packages:{[`node_modules/${name}`]:{integrity:"sha512-YQ=="}}}));',
  ].join("\n"));
  process.env.npm_execpath = npm;
  const sourceCwd = join(root, "source", "project"); mkdirSync(sourceCwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "source", "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "source", "harness");
  delete process.env.PI_MODE_PACK_STORE_PATH;
  const base = archive("custom.offline-fixture");
  const source = createPortableModePackage({
    definition: base.definition,
    resources: [{ ...base.resources[0], runtimeDependencies: [{ package: "fixture-offline", version: "1.0.0", integrity: "sha512-YQ==", entries: ["index.js"] }] }],
    files: base.files, frontend: base.frontend, projectCapabilities: base.projectCapabilities,
    targetPlatform: base.targetPlatform, externalDependencies: base.externalDependencies,
  });
  await assert.rejects(importPortableModePackage(source, sourceCwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.equal(error.conflicts[0]?.kind, "missing-local-npm-payload");
    return true;
  });
  await importPortableModePackage(source, sourceCwd, 0, undefined, { allowLegacyOnlineNpm: true });
  const exported = await exportPortableModePackage(source.definition.modePackId, sourceCwd);
  assert.ok(exported.offlineRuntime);
  assert.ok(exported.files.some((file) => file.path === exported.offlineRuntime.archivePath));
  assert.equal(readFileSync(calls, "utf8"), "install\n");

  const bundled = await exportPortableModePackageFiles(source.definition.modePackId, sourceCwd);
  const transfer = join(root, "offline.mode-pack.tar");
  try { await writePortableModeBundle(bundled.archive, bundled.sources, transfer); } finally { bundled.cleanup(); }
  const payload = join(root, "payload"); mkdirSync(payload);
  const parsed = await readPortableModeBundle(createReadStream(transfer), payload);
  assert.equal(parsed.packageContentHash, exported.packageContentHash);

  const destinationCwd = join(root, "destination", "project"); mkdirSync(destinationCwd, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "destination", "agent");
  process.env.PI_LEARNING_HARNESS_DIR = join(root, "destination", "harness");
  const forbiddenNpm = join(root, "forbidden-npm.cjs");
  writeFileSync(forbiddenNpm, 'throw Error("offline import contacted npm");\n');
  process.env.npm_execpath = forbiddenNpm;
  const installed = await importPortableModePackageFiles(parsed, payload, destinationCwd);
  const runtime = await ensurePortableModePackageInstalled(parsed, { resources: [{ kind: "skill", id: "portable.skill", enabled: true }] });
  assert.equal(readFileSync(join(runtime, "node_modules", "fixture-offline", "index.js"), "utf8"), "module.exports = 42;\n");
  assert.equal(installed.packageContentHash, exported.packageContentHash);
  assert.equal(readFileSync(calls, "utf8"), "install\n", "import and activation never contact npm");
});

test("portable archive export/import preserves frontend and shared skill references across agent directories", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-portable-"));
  const original = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_LEARNING_HARNESS_DIR", "PI_MODE_PACK_STORE_PATH"].map((key) => [key, process.env[key]]));
  const useAgent = (name) => {
    process.env.PI_CODING_AGENT_DIR = join(root, name, "agent");
    process.env.PI_LEARNING_HARNESS_DIR = join(root, name, "harness");
    delete process.env.PI_MODE_PACK_STORE_PATH;
    const cwd = join(root, name, "project"); mkdirSync(cwd, { recursive: true }); return cwd;
  };
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });

  const sourceCwd = useAgent("source");
  const source = await importPortableModePackage(archive(), sourceCwd);
  const exported = await exportPortableModePackage(source.modePackId, sourceCwd);
  assert.deepEqual(exported.frontend, archive().frontend, "packaged frontend descriptor must survive re-export");
  assert.ok(exported.files.some((item) => item.path === "resources/references/common.md"), "shared support files travel with the skill");

  const destinationCwd = useAgent("destination");
  const imported = await importPortableModePackage(exported, destinationCwd);
  const storedManifestText = readFileSync(join(portableModePackageDirectory(imported.packageContentHash), "manifest.json"), "utf8");
  assert.ok(!storedManifestText.includes('"base64"'), "installed manifests retain metadata, not duplicate payload bytes");
  assert.ok(storedManifestText.length < 10_000, "mode selection reads a compact manifest");
  assert.equal(imported.modePackId, "custom.portable-smoke"); assert.equal(readPortableModePackages()[0]?.packageContentHash, imported.packageContentHash); assert.equal(imported.components[0]?.id, "portable.skill");
  const resolved = await new ModePackStore().resolve(imported.modePackId, destinationCwd);
  assert.match(resolved.inventory.resourcesByKey.get("skill:portable.skill")?.text ?? "", /Use one/);
  assert.equal(imported.components[0]?.delivery, "native-skill", "native delivery survives the imported definition round trip");

  await assert.rejects(importPortableModePackage(exported, destinationCwd), /revision conflict/i);
  assert.equal(readPortableModePackages().length, 1, "a failed revision cannot delete an already registered shared package");

  const alternative = await importPortableModePackage(archive("custom.portable-alternative", "two"), destinationCwd);
  const alternateResolved = await new ModePackStore().resolve(alternative.modePackId, destinationCwd);
  assert.match(alternateResolved.inventory.resourcesByKey.get("skill:portable.skill")?.text ?? "", /Use two/);
  assert.match((await new ModePackStore().resolve(imported.modePackId, destinationCwd)).inventory.resourcesByKey.get("skill:portable.skill")?.text ?? "", /Use one/);

  const upgraded = await importPortableModePackage(archive("custom.portable-smoke", "three"), destinationCwd, 1, "custom.portable-smoke");
  assert.equal(upgraded.revision, 2);
  assert.match((await new ModePackStore().resolve(upgraded.modePackId, destinationCwd)).inventory.resourcesByKey.get("skill:portable.skill")?.text ?? "", /Use three/);

  writeFileSync(join(portableModePackageDirectory(alternative.packageContentHash), "resources/skill/portable.skill/SKILL.md"), "tampered\n");
  const listedAfterForeignTamper = await new ModePackStore().list(destinationCwd);
  assert.equal(listedAfterForeignTamper.packs.find((item) => item.definition.modePackId === imported.modePackId)?.selectable, true, "a corrupt unselected package cannot block another mode");
  const corrupt = listedAfterForeignTamper.packs.find((item) => item.definition.modePackId === alternative.modePackId);
  assert.equal(corrupt?.selectable, false, "a corrupt package cannot remain selectable");
  assert.match(corrupt?.packageError ?? "", /tampered/i);
  await assert.rejects(new ModePackStore().resolve(alternative.modePackId, destinationCwd), /tampered/i, "selecting the corrupt package still fails its integrity check");
  assert.match((await new ModePackStore().resolve(upgraded.modePackId, destinationCwd)).inventory.resourcesByKey.get("skill:portable.skill")?.text ?? "", /Use three/, "the valid package remains activatable after another package is quarantined");

  const invalid = archive("custom.bad");
  const unsupportedRuntime = archive("custom.student-runtime");
  const { contentHash: _oldRuntimeHash, ...runtimeDefinition } = unsupportedRuntime.definition;
  runtimeDefinition.role = "student";
  runtimeDefinition.runtimeMode = "student-learn";
  runtimeDefinition.courseRequired = true;
  unsupportedRuntime.definition = { ...runtimeDefinition, contentHash: contentHash(runtimeDefinition) };
  await assert.rejects(importPortableModePackage(unsupportedRuntime, destinationCwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.equal(error.conflicts[0]?.kind, "unsupported-mode-runtime");
    return true;
  });
  assert.equal(new ModePackStore().getCustom("custom.student-runtime"), null);
  const skillConflict = archiveWithConflictingSelectedSkill();
  await assert.rejects(importPortableModePackage(skillConflict, destinationCwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.match(error.message, /Conflicts happen[\s\S]*selected-skill-name: portable-smoke[\s\S]*install failed\./u);
    assert.equal(error.conflicts[0]?.providers.length, 2);
    return true;
  });
  assert.equal(new ModePackStore().getCustom("custom.same-skill-name"), null, "a Skill name conflict cannot register a mode");
  assert.equal(existsSync(portableModePackageDirectory(skillConflict.packageContentHash)), false, "a Skill name conflict removes its staging directory and cannot register a package");
  const duplicateSameBytes = archiveWithConflictingSelectedSkill(true);
  duplicateSameBytes.definition.components[1].enabled = false;
  duplicateSameBytes.definition.components[1].required = false;
  const { contentHash: _priorDuplicateDefinitionHash, ...duplicateDefinition } = duplicateSameBytes.definition;
  duplicateSameBytes.definition = { ...duplicateDefinition, contentHash: contentHash(duplicateDefinition) };
  await assert.rejects(importPortableModePackage(duplicateSameBytes, destinationCwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.equal(error.conflicts[0]?.kind, "selected-skill-name");
    assert.equal(error.conflicts[0]?.providers.length, 2);
    return true;
  });
  const wrongPlatform = archive("custom.wrong-platform");
  wrongPlatform.targetPlatform = { os: process.platform === "win32" ? "linux" : "win32", arch: process.arch };
  wrongPlatform.packageContentHash = contentHash({ resources: wrongPlatform.resources, files: wrongPlatform.files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })), frontend: wrongPlatform.frontend, projectCapabilities: wrongPlatform.projectCapabilities, targetPlatform: wrongPlatform.targetPlatform, externalDependencies: wrongPlatform.externalDependencies });
  const { contentHash: _oldDefinitionHash, ...wrongDefinition } = wrongPlatform.definition;
  wrongDefinition.packageContentHash = wrongPlatform.packageContentHash;
  wrongPlatform.definition = { ...wrongDefinition, contentHash: contentHash(wrongDefinition) };
  await assert.rejects(importPortableModePackage(wrongPlatform, destinationCwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.equal(error.conflicts[0]?.kind, "target-platform");
    return true;
  });
  assert.equal(existsSync(portableModePackageDirectory(wrongPlatform.packageContentHash)), false, "wrong-platform import cannot stage package bytes");
  const missingDependency = archive("custom.missing-executable");
  missingDependency.externalDependencies = [{ kind: "executable", name: "pi-own-certainly-absent-fixture" }];
  missingDependency.packageContentHash = contentHash({ resources: missingDependency.resources, files: missingDependency.files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })), frontend: missingDependency.frontend, projectCapabilities: missingDependency.projectCapabilities, targetPlatform: missingDependency.targetPlatform, externalDependencies: missingDependency.externalDependencies });
  const { contentHash: _priorDependencyDefinitionHash, ...dependencyDefinition } = missingDependency.definition;
  dependencyDefinition.packageContentHash = missingDependency.packageContentHash;
  missingDependency.definition = { ...dependencyDefinition, contentHash: contentHash(dependencyDefinition) };
  await assert.rejects(importPortableModePackage(missingDependency, destinationCwd), (error) => {
    assert.equal(error.code, "PORTABLE_MODE_IMPORT_CONFLICT");
    assert.equal(error.conflicts[0]?.kind, "missing-external-dependency");
    assert.match(error.message, /pi-own-certainly-absent-fixture[\s\S]*install failed\./u);
    return true;
  });
  assert.equal(existsSync(portableModePackageDirectory(missingDependency.packageContentHash)), false, "missing external prerequisite cannot stage package bytes");
  await assert.rejects(importPortableModePackage({ ...invalid, files: [{ ...invalid.files[0], base64: "dGFtcGVy" }] }, destinationCwd), /byte\/hash mismatch/i);
  await assert.rejects(importPortableModePackage({ ...invalid, files: [{ ...invalid.files[0], base64: "Zh==" }] }, destinationCwd), /canonical base64/i);
  await assert.rejects(importPortableModePackage({ ...invalid, resources: [...invalid.resources, invalid.resources[0]] }, destinationCwd), /duplicate resource identity/i);
  await assert.rejects(importPortableModePackage({ ...invalid, files: [{ ...invalid.files[0], path: "../escape" }, ...invalid.files.slice(1)] }, destinationCwd), /relative slash path/i);
  assert.equal((await new ModePackStore().list(destinationCwd)).packs.filter((item) => item.definition.modePackId.startsWith("custom.")).length, 2, "invalid archives never register cache entries");
});
