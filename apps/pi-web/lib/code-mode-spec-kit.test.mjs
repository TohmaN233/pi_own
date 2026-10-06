import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = resolve(`.tmp-code-mode-spec-kit-${process.pid}-${Date.now()}`);
const cwd = join(root, "project");
const agentDir = join(root, "agent");
mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
mkdirSync(join(cwd, ".specify"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
  PI_LEARNING_HARNESS_DIR: join(root, "harness"),
  PI_MODE_PACK_STORE_PATH: join(root, "modes.json"),
  PI_OFFLINE: "1",
  ANTHROPIC_API_KEY: "local-never-sent",
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
const { SPEC_KIT_COMMANDS, inspectSpecKit } = await jiti.import("./code-mode-spec-kit.ts");
const { importPortableModePackage } = await jiti.import("./portable-mode-pack-service.ts");
const rpc = await jiti.import("./rpc-manager.ts");

function portableFile(path, bytes) {
  return { path, contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.byteLength, base64: bytes.toString("base64") };
}

function optionalSkillArchive(revision, includeNew = false) {
  const skills = ["fixture.optional.known", ...(includeNew ? ["fixture.optional.new"] : [])];
  const files = skills.map((id) => portableFile(`resources/skill/${id}/SKILL.md`, Buffer.from(`---\nname: ${id.replaceAll(".", "-")}\ndescription: fixture optional skill\n---\n${id}\n`)));
  const resources = skills.map((id, index) => ({
    kind: "skill",
    id,
    delivery: "native-skill",
    contentHash: files[index].contentHash,
    source: { type: "bundled", path: files[index].path },
    runtimeDependencies: [{ package: index === 0 ? "fixture-known" : "fixture-new", version: "1.0.0", integrity: "sha512-YQ==", entries: ["index.js"] }],
  }));
  const frontend = null; const projectCapabilities = []; const targetPlatform = { os: process.platform, arch: process.arch }; const externalDependencies = [];
  const packageContentHash = contentHash({ resources, files: files.map(({ path, contentHash: hash, bytes }) => ({ path, contentHash: hash, bytes })), frontend, projectCapabilities, targetPlatform, externalDependencies });
  const raw = {
    version: 1, modePackId: "custom.optional-preferences", revision,
    title: "Optional preference fixture", description: "fixture", category: "general",
    role: "general", runtimeMode: "general", provider: null, model: null,
    thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false,
    tools: ["read"], systemPrompt: "Preserve optional Skill preferences.", instructions: [], packageContentHash,
    components: resources.map((resource) => ({
      type: "skill", id: resource.id, required: false, enabled: true,
      delivery: "native-skill", version: packageContentHash, contentHash: resource.contentHash,
    })),
  };
  return { version: 1, definition: { ...raw, contentHash: contentHash(raw) }, resources, files, frontend, projectCapabilities, targetPlatform, externalDependencies, packageContentHash };
}

function samePayloadDefinitionArchive(revision, updated) {
	const promptRevision = updated === "C" ? "C" : updated ? "B" : "A";
  const resourceInputs = [
    ["skill", "fixture.definition.optional", "resources/skill/optional/SKILL.md", "---\nname: definition-optional\ndescription: fixture\n---\noptional\n"],
    ["skill", "fixture.definition.retained-off", "resources/skill/retained-off/SKILL.md", "---\nname: definition-retained-off\ndescription: fixture\n---\nretained off\n"],
    ["skill", "fixture.definition.promoted", "resources/skill/promoted/SKILL.md", "---\nname: definition-promoted\ndescription: fixture\n---\npromoted\n"],
    ["extension", "fixture.definition.plugin.old", "resources/extension/old/index.ts", "export default function oldPlugin() {}\n"],
    ["extension", "fixture.definition.plugin.new", "resources/extension/new/index.ts", "export default function newPlugin() {}\n"],
  ];
  const files = resourceInputs.map(([, , path, content]) => portableFile(path, Buffer.from(content)));
  const resources = resourceInputs.map(([kind, id, path], index) => ({
    kind,
    id,
    delivery: kind === "skill" ? "native-skill" : "system-instruction",
    contentHash: files[index].contentHash,
    source: { type: "bundled", path },
  }));
  const frontend = null; const projectCapabilities = []; const targetPlatform = { os: process.platform, arch: process.arch }; const externalDependencies = [];
  const packageContentHash = contentHash({ resources, files: files.map(({ path, contentHash: hash, bytes }) => ({ path, contentHash: hash, bytes })), frontend, projectCapabilities, targetPlatform, externalDependencies });
  const component = (type, id, required, enabled) => {
    const resource = resources.find((item) => item.id === id);
    return { type, id, required, enabled, ...(type === "skill" ? { delivery: "native-skill" } : {}), version: packageContentHash, contentHash: resource.contentHash };
  };
  const raw = {
    version: 1, modePackId: "custom.same-payload-definition", revision,
    title: "Same payload definition fixture", description: "fixture", category: "general",
    role: "general", runtimeMode: "general", provider: null, model: null,
    thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false,
    tools: ["read", "grep"], systemPrompt: `Definition revision ${promptRevision}.`, instructions: [], packageContentHash,
    components: updated
      ? [
        component("skill", "fixture.definition.retained-off", false, true),
        component("skill", "fixture.definition.promoted", true, true),
        component("plugin", "fixture.definition.plugin.new", false, true),
      ]
      : [
        component("skill", "fixture.definition.optional", false, true),
        component("skill", "fixture.definition.retained-off", false, true),
        component("skill", "fixture.definition.promoted", false, true),
        component("plugin", "fixture.definition.plugin.old", false, true),
      ],
  };
  return { version: 1, definition: { ...raw, contentHash: contentHash(raw) }, resources, files, frontend, projectCapabilities, targetPlatform, externalDependencies, packageContentHash };
}

test("Spec Kit reports partial existing files without treating them as initialized", () => {
  const partial = join(root, "partial-project");
  mkdirSync(join(partial, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(partial, ".pi", "prompts", "speckit.plan.md"), "partial\n");
  const status = inspectSpecKit(partial);
  assert.equal(status.state, "partial");
  assert.equal(status.initialized, false);
  assert.ok(status.missingCommands.includes("speckit.specify"));
});

test("portable optional preferences survive refreshes and ordinary settings pin their committed archive", async (t) => {
  const fakeNpm = join(root, "optional-preferences-npm.cjs");
  const installations = join(root, "optional-preferences-installs.jsonl");
  const previousNpm = process.env.npm_execpath;
  writeFileSync(fakeNpm, [
    'const fs=require("node:fs"),path=require("node:path");',
    `fs.appendFileSync(${JSON.stringify(installations)}, JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(path.join(process.cwd(),"package.json"),"utf8")).dependencies).sort())+"\\n");`,
    'const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),"package.json"),"utf8")),packages={};',
    'for(const [name,version] of Object.entries(pkg.dependencies)){const dir=path.join(process.cwd(),"node_modules",name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name,version}));fs.writeFileSync(path.join(dir,"index.js"),`${name}@${version}`);packages[`node_modules/${name}`]={integrity:"sha512-YQ=="};}',
    'fs.writeFileSync(path.join(process.cwd(),"package-lock.json"),JSON.stringify({packages}));',
  ].join("\n"));
  process.env.npm_execpath = fakeNpm;
  t.after(async () => {
    if (previousNpm === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpm;
  });
  const archiveA = optionalSkillArchive(1);
  const archiveB = optionalSkillArchive(2, true);
  await importPortableModePackage(archiveA, cwd, 0, undefined, { allowLegacyOnlineNpm: true });
  const started = await rpc.startRpcSession("__optional_preferences__", "", cwd);
  const sessionId = started.realSessionId;
  try {
    const initial = await rpc.activateGenericModePack({ sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: null, idempotencyKey: "optional-initial" });
    assert.equal(initial.binding.snapshot.packageContentHash, archiveA.packageContentHash);
    assert.ok(initial.binding.snapshot.resources.some((resource) => resource.id === "fixture.optional.known"));
    assert.deepEqual(readFileSync(installations, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [["fixture-known"]]);

    const disabled = await rpc.activateGenericModePack({
      sessionId, modePackId: archiveA.definition.modePackId,
      expectedSnapshotId: initial.binding.snapshot.resourceSnapshotId, idempotencyKey: "optional-disable",
      settingsPatch: { skills: [{ id: "fixture.optional.known", enabled: false }] },
    });
    assert.equal(disabled.binding.snapshot.resources.some((resource) => resource.id === "fixture.optional.known"), false);

    const refreshed = await rpc.activateGenericModePack({ sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: disabled.binding.snapshot.resourceSnapshotId, idempotencyKey: "optional-refresh" });
    assert.equal(refreshed.binding.snapshot.resources.some((resource) => resource.id === "fixture.optional.known"), false, "same-package refresh retains a disabled known optional Skill");
    const away = await rpc.activateGenericModePack({ sessionId, modePackId: "general", expectedSnapshotId: refreshed.binding.snapshot.resourceSnapshotId, idempotencyKey: "optional-away" });
    const returned = await rpc.activateGenericModePack({ sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: away.binding.snapshot.resourceSnapshotId, idempotencyKey: "optional-return" });
    assert.equal(returned.binding.snapshot.resources.some((resource) => resource.id === "fixture.optional.known"), false, "saved settings retain an omitted optional Skill after switching away");

    await importPortableModePackage(archiveB, cwd, 1, undefined, { allowLegacyOnlineNpm: true });
    const storeAfterUpgrade = JSON.parse(readFileSync(process.env.PI_MODE_PACK_STORE_PATH, "utf8"));
    assert.equal(storeAfterUpgrade.histories[archiveA.definition.modePackId].length, 1, "only the current definition is stored");
    assert.ok(storeAfterUpgrade.retainedSnapshotPackageHashes.includes(archiveA.packageContentHash), "committed sessions can still resolve their old archive");
    const { updateSessionModeSettings } = await jiti.import("./mode-settings-service.ts");
    await updateSessionModeSettings({
      sessionId, expectedSnapshotId: returned.binding.snapshot.resourceSnapshotId, idempotencyKey: "optional-settings",
      settingsPatch: { thinkingLevel: "high", tools: ["read"] },
    });
    assert.equal((await rpc.getGenericModePackStatus(sessionId)).runtime.binding.snapshot.packageContentHash, archiveA.packageContentHash, "an ordinary settings revision cannot adopt a newer same-ID package");

    await rpc.getRpcSession(sessionId).send({ type: "reload" });
    const upgraded = (await rpc.getGenericModePackStatus(sessionId)).runtime;
    assert.equal(upgraded.verified, true);
    assert.equal(upgraded.binding.snapshot.packageContentHash, archiveB.packageContentHash, "native reload is an explicit package refresh");
    assert.equal(upgraded.binding.snapshot.resources.some((resource) => resource.id === "fixture.optional.known"), false, "an upgrade retains a disabled known optional Skill");
    assert.ok(upgraded.binding.snapshot.resources.some((resource) => resource.id === "fixture.optional.new"), "a newly introduced optional Skill keeps its enabled package default");
    assert.deepEqual(readFileSync(installations, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1), ["fixture-new"], "only the newly selected optional Skill installs its private dependency");
  } finally {
    await rpc.getRpcSession(sessionId)?.shutdown();
  }
});

test("explicit same-payload definition activation refreshes policy without reviving removed optional resources", async () => {
  const archiveA = samePayloadDefinitionArchive(1, false);
  const archiveB = samePayloadDefinitionArchive(2, true);
  await importPortableModePackage(archiveA, cwd);
  const started = await rpc.startRpcSession("__same_payload_definition__", "", cwd);
  const sessionId = started.realSessionId;
	const sessionFile = started.session.inner.sessionManager.getSessionFile();
  try {
    const first = await rpc.activateGenericModePack({ sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: null, idempotencyKey: "same-payload-first" });
    const customized = await rpc.activateGenericModePack({
      sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: first.binding.snapshot.resourceSnapshotId, idempotencyKey: "same-payload-personal",
      settingsPatch: {
        skills: [
          { id: "fixture.definition.retained-off", enabled: false },
          { id: "fixture.definition.promoted", enabled: false },
        ],
        tools: ["read"], thinkingLevel: "high",
      },
    });
    await importPortableModePackage(archiveB, cwd, 1);

    const ordinary = await rpc.activateGenericModePack({
      sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: customized.binding.snapshot.resourceSnapshotId, idempotencyKey: "same-payload-settings-only",
      settingsPatch: { tools: ["read"], thinkingLevel: "high" },
    });
    assert.match(rpc.getRpcSession(sessionId).systemPrompt, /Definition revision A/u, "ordinary settings retain the committed definition");
    assert.ok(ordinary.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.plugin.old"));
    assert.ok(ordinary.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.optional"));
    assert.equal(ordinary.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.promoted"), false);

    const refreshed = await rpc.activateGenericModePack({ sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: ordinary.binding.snapshot.resourceSnapshotId, idempotencyKey: "same-payload-refresh" });
    assert.equal(refreshed.binding.snapshot.packageContentHash, archiveA.packageContentHash, "definition policy refresh does not require a payload hash change");
    assert.match(rpc.getRpcSession(sessionId).systemPrompt, /Definition revision B/u);
    assert.deepEqual(refreshed.binding.snapshot.tools, ["read"]);
    assert.equal(refreshed.binding.snapshot.thinkingLevel, "high");
    assert.equal(refreshed.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.optional"), false, "a removed optional Skill is not carried from the old definition");
    assert.equal(refreshed.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.retained-off"), false, "a retained known optional-off Skill remains disabled");
    assert.ok(refreshed.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.promoted" && resource.required), "a newly required resource wins over its former optional-off preference");
    assert.equal(refreshed.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.plugin.old"), false, "removed plugin is not carried from the old definition");
    assert.ok(refreshed.binding.snapshot.resources.some((resource) => resource.id === "fixture.definition.plugin.new"), "new plugin comes from the explicitly selected definition");

		const archiveC = samePayloadDefinitionArchive(3, "C");
		await importPortableModePackage(archiveC, cwd, 2);
		const third = await rpc.activateGenericModePack({ sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: refreshed.binding.snapshot.resourceSnapshotId, idempotencyKey: "same-payload-third" });
		assert.match(rpc.getRpcSession(sessionId).systemPrompt, /Definition revision C/u, "an inherited revision-B default does not become a personal override for revision C");

		const personalized = await rpc.activateGenericModePack({
			sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: third.binding.snapshot.resourceSnapshotId, idempotencyKey: "same-payload-custom-prompt",
			settingsPatch: { systemPrompt: "Personal same-payload prompt." },
		});
		await rpc.getRpcSession(sessionId).shutdown();
		await rpc.startRpcSession(sessionId, sessionFile, undefined);
		const final = await rpc.activateGenericModePack({ sessionId, modePackId: archiveA.definition.modePackId, expectedSnapshotId: personalized.binding.snapshot.resourceSnapshotId, idempotencyKey: "same-payload-custom-prompt-refresh" });
		assert.match(rpc.getRpcSession(sessionId).systemPrompt, /Personal same-payload prompt/u, "a personal prompt survives an explicit same-payload refresh after restart");
		assert.equal(final.binding.snapshot.modePackSystemPromptDefaultHash, contentHash({ systemPrompt: "Definition revision C." }), "the durable baseline follows the selected definition rather than archive cache identity");

		const legacy = structuredClone(final.binding.snapshot);
		delete legacy.modePackSystemPromptDefaultHash;
		const legacySettings = await rpc.resolveSavedModeSettings(legacy, { thinkingLevel: "medium" }, cwd);
		assert.equal(legacySettings.snapshot.modePackSystemPromptDefaultHash, undefined, "an old binding never invents prompt-default provenance during an unrelated settings edit");
		const legacyRefresh = await rpc.resolveSavedModeSettings(legacySettings.snapshot, undefined, cwd, undefined, archiveC.definition);
		assert.match(legacyRefresh.snapshot.instructions[2], /Personal same-payload prompt/u, "a legacy personal prompt survives an unrelated edit and explicit refresh");
  } finally {
    await rpc.getRpcSession(sessionId)?.shutdown();
  }
});

function writeTemplates(suffix = "one") {
  for (const command of SPEC_KIT_COMMANDS) {
    writeFileSync(join(cwd, ".pi", "prompts", `${command}.md`), `# ${command}\n${suffix}\n`);
  }
}

async function importCapabilityArchive() {
  return importCapabilityRevision("custom.spec-kit-clone", 1, "Use templates natively.");
}

async function importCapabilityRevision(modePackId, revision, systemPrompt) {
  const resources = [];
  const files = [];
  const frontend = null;
  const projectCapabilities = ["spec-kit"];
  const targetPlatform = { os: process.platform, arch: process.arch }; const externalDependencies = [];
  const packageContentHash = contentHash({ resources, files, frontend, projectCapabilities, targetPlatform, externalDependencies });
  const raw = {
    version: 1, modePackId, revision,
    title: "Spec Kit clone", description: "fixture", category: "general",
    role: "general", runtimeMode: "general", provider: null, model: null,
    thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false,
    tools: ["read", "grep"], systemPrompt, instructions: [], components: [], packageContentHash,
  };
  await importPortableModePackage({
    version: 1,
    definition: { ...raw, contentHash: contentHash(raw) },
    resources, files, frontend, projectCapabilities, targetPlatform, externalDependencies, packageContentHash,
  }, cwd, revision - 1);
  return raw;
}

let importedDefinition;
async function capabilityDefinition() {
  importedDefinition ??= await importCapabilityArchive();
  return importedDefinition;
}

test("Spec Kit capability commits native templates, detects drift, and refreshes only on transition", async () => {
  writeTemplates();
  const definition = await capabilityDefinition();
  const started = await rpc.startRpcSession("__spec_kit_capability__", "", cwd);
  const sessionId = started.realSessionId;
  try {
    const first = await rpc.activateGenericModePack({ sessionId, modePackId: definition.modePackId, expectedSnapshotId: null, idempotencyKey: "first" });
    const templates = first.binding.snapshot.resources.filter((resource) => resource.kind === "prompt" && resource.delivery === "native-prompt-template");
    assert.equal(templates.length, SPEC_KIT_COMMANDS.length);
    assert.ok(templates.every((resource) => resource.required && resource.enabled));
    const wrapper = rpc.getRpcSession(sessionId);
    assert.equal(wrapper.inner.resourceLoader.getPrompts().prompts.filter((prompt) => prompt.name.startsWith("speckit.")).length, SPEC_KIT_COMMANDS.length);
    assert.ok(!wrapper.systemPrompt.includes("# speckit.specify"));

    const configured = await rpc.activateGenericModePack({
      sessionId,
      modePackId: definition.modePackId,
      expectedSnapshotId: first.binding.snapshot.resourceSnapshotId,
      idempotencyKey: "personal-tools",
      settingsPatch: { tools: ["read"] },
    });
    assert.deepEqual(configured.binding.snapshot.tools, ["read"]);
    const changed = join(cwd, ".pi", "prompts", "speckit.converge.md");
    writeFileSync(changed, `${readFileSync(changed, "utf8")}changed\n`);
    const drift = await rpc.getGenericModePackStatus(sessionId);
    assert.equal(drift.runtime.verified, false);
    assert.equal(drift.runtime.binding.snapshot.resourceSnapshotId, configured.binding.snapshot.resourceSnapshotId);

    const refreshed = await rpc.activateGenericModePack({ sessionId, modePackId: definition.modePackId, expectedSnapshotId: configured.binding.snapshot.resourceSnapshotId, idempotencyKey: "refresh" });
    assert.notEqual(refreshed.binding.snapshot.resourceSnapshotId, configured.binding.snapshot.resourceSnapshotId);
    assert.equal(refreshed.runtime.verified, true);
    assert.deepEqual(refreshed.binding.snapshot.tools, ["read"]);
    assert.ok(rpc.getRpcSession(sessionId).inner.resourceLoader.getPrompts().prompts.some((prompt) => prompt.name === "speckit.converge" && prompt.content.includes("changed")));
  } finally {
    await rpc.getRpcSession(sessionId)?.shutdown();
  }
});

test("portable settings reject Spec Kit drift until an explicit definition refresh", async () => {
  writeTemplates("drift-a");
  const definitionA = await importCapabilityRevision("custom.spec-kit-drift", 1, "Spec drift definition A.");
  const started = await rpc.startRpcSession("__spec_kit_drift__", "", cwd);
  const sessionId = started.realSessionId;
  try {
    const initial = await rpc.activateGenericModePack({ sessionId, modePackId: definitionA.modePackId, expectedSnapshotId: null, idempotencyKey: "spec-drift-initial" });
    const configured = await rpc.activateGenericModePack({
      sessionId, modePackId: definitionA.modePackId, expectedSnapshotId: initial.binding.snapshot.resourceSnapshotId, idempotencyKey: "spec-drift-settings",
      settingsPatch: { thinkingLevel: "high", tools: ["read"] },
    });
    await importCapabilityRevision(definitionA.modePackId, 2, "Spec drift definition B.");
    writeTemplates("drift-b");

    await assert.rejects(
      rpc.activateGenericModePack({
        sessionId, modePackId: definitionA.modePackId, expectedSnapshotId: configured.binding.snapshot.resourceSnapshotId, idempotencyKey: "spec-drift-ordinary-settings",
        settingsPatch: { thinkingLevel: "low" },
      }),
      /resources changed.*explicitly reload or activate/i,
    );
    const rejected = await rpc.getGenericModePackStatus(sessionId);
    assert.equal(rejected.runtime.binding.snapshot.resourceSnapshotId, configured.binding.snapshot.resourceSnapshotId, "a rejected settings edit leaves the committed snapshot unchanged");
    assert.equal(rejected.runtime.binding.snapshot.thinkingLevel, "high");
    assert.match(rpc.getRpcSession(sessionId).systemPrompt, /Spec drift definition A/u);

    const refreshed = await rpc.activateGenericModePack({ sessionId, modePackId: definitionA.modePackId, expectedSnapshotId: configured.binding.snapshot.resourceSnapshotId, idempotencyKey: "spec-drift-explicit-refresh" });
    assert.equal(refreshed.binding.snapshot.thinkingLevel, "high", "explicit refresh preserves personal thinking settings");
    assert.match(rpc.getRpcSession(sessionId).systemPrompt, /Spec drift definition B/u);
    assert.ok(rpc.getRpcSession(sessionId).inner.resourceLoader.getPrompts().prompts.some((prompt) => prompt.name === "speckit.specify" && prompt.content.includes("drift-b")), "explicit refresh adopts the changed committed template");
  } finally {
    await rpc.getRpcSession(sessionId)?.shutdown();
  }
});

test("Spec Kit initializer rejects stale and concurrent requests before a second initializer runs", async () => {
  const definition = await capabilityDefinition();
  const started = await rpc.startRpcSession("__spec_kit_transition__", "", cwd);
  const sessionId = started.realSessionId;
  try {
    const active = await rpc.activateGenericModePack({ sessionId, modePackId: definition.modePackId, expectedSnapshotId: null, idempotencyKey: "transition-first" });
    let release;
    const blocked = new Promise((resolveBlocked) => { release = resolveBlocked; });
    let initializers = 0;
    const pending = rpc.initializeModePackProjectCapability({
      sessionId,
      expectedSnapshotId: active.binding.snapshot.resourceSnapshotId,
      idempotencyKey: "initialize-one",
      capability: "spec-kit",
      initialize: async (projectCwd) => {
        initializers++;
        assert.equal(projectCwd, cwd);
        await blocked;
        return inspectSpecKit(projectCwd);
      },
    });
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await assert.rejects(
      rpc.initializeModePackProjectCapability({ sessionId, expectedSnapshotId: active.binding.snapshot.resourceSnapshotId, idempotencyKey: "initialize-two", capability: "spec-kit", initialize: async () => { initializers++; return inspectSpecKit(cwd); } }),
      /activation is already in progress/,
    );
    await assert.rejects(
      rpc.activateGenericModePack({ sessionId, modePackId: "general", expectedSnapshotId: active.binding.snapshot.resourceSnapshotId, idempotencyKey: "competing-switch" }),
      /activation is already in progress/,
    );
    release();
    const completed = await pending;
    assert.equal(initializers, 1);
    await assert.rejects(
      rpc.initializeModePackProjectCapability({ sessionId, expectedSnapshotId: active.binding.snapshot.resourceSnapshotId, idempotencyKey: "stale", capability: "spec-kit", initialize: async () => { initializers++; return inspectSpecKit(cwd); } }),
      /stale Mode Pack snapshot/,
    );
    assert.notEqual(completed.activation.binding.snapshot.resourceSnapshotId, active.binding.snapshot.resourceSnapshotId);
  } finally {
    await rpc.getRpcSession(sessionId)?.shutdown();
  }
});

test.after(async () => {
  for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
  globalThis.__piLearningHarness?.close();
  rmSync(root, { recursive: true, force: true });
});
