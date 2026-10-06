import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("a Skill from Coding becomes an immediately usable independent mode package", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-compose-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MODE_PACK_STORE_PATH: process.env.PI_MODE_PACK_STORE_PATH };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_MODE_PACK_STORE_PATH = join(root, "mode-packs.json");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { composePortableModePackage } = await jiti.import("./portable-mode-pack-service.ts");
  const { bundledCodeModePackage } = await jiti.import("./bundled-code-mode-package.ts");
  const { readPortableModePackage } = await jiti.import("./portable-mode-pack-registry.ts");
  const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
  const { definitionToDraft } = await jiti.import("./mode-pack-store.ts");
  const coding = bundledCodeModePackage();
  const definition = await composePortableModePackage({
    draft: {
      version: 1, modePackId: "custom.skill-share", revision: 1, title: "Skill Share", description: "Portable shared Skill",
      category: "general", role: "general", runtimeMode: "general", provider: null, model: null,
      thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false,
      tools: ["grep", "read"], components: [{ type: "skill", id: "grill-me", required: false, enabled: true, delivery: "native-skill" }],
      systemPrompt: "Use the selected Skill.", instructions: [],
    },
    cwd, expectedRevision: 0,
    resourceSources: [{ kind: "skill", id: "grill-me", packageContentHash: coding.packageContentHash }],
  });
  const archive = readPortableModePackage(definition.packageContentHash);
  assert.ok(archive);
  assert.deepEqual(archive.resources.map((item) => item.id), ["grill-me"]);
  assert.equal(archive.resources[0].source.type, "bundled");
  assert.deepEqual(archive.files.filter((file) => file.path.endsWith("/SKILL.md")).map((file) => file.path.endsWith("/grill-me/SKILL.md")), [true], "unselected donor Skills must not be copied into the composed package");
  const selected = await new ModePackStore().resolve(definition.modePackId, cwd);
  assert.ok(selected.snapshot.resources.some((resource) => resource.kind === "skill" && resource.id === "grill-me" && resource.enabled));
  const general = (await new ModePackStore().list(cwd)).packs.find((item) => item.definition.modePackId === "general")?.definition;
  assert.ok(general);
  const generalDraft = definitionToDraft(general, { revision: general.revision + 1 });
  generalDraft.components.push({ type: "skill", id: "grill-me", required: false, enabled: true, delivery: "native-skill" });
  const editedGeneral = await composePortableModePackage({
    draft: generalDraft, cwd, expectedRevision: general.revision, sourceModePackId: "general",
    resourceSources: [{ kind: "skill", id: "grill-me", packageContentHash: coding.packageContentHash }],
  });
  assert.equal(editedGeneral.modePackId, "general");
  assert.equal((await new ModePackStore().list(cwd)).packs.filter((item) => item.definition.modePackId === "general").length, 1);
  assert.ok((await new ModePackStore().resolve("general", cwd)).snapshot.resources.some((resource) => resource.kind === "skill" && resource.id === "grill-me" && resource.enabled));
});

test("Course Builder and Study profiles edit their current portable module in place", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-education-edit-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MODE_PACK_STORE_PATH: process.env.PI_MODE_PACK_STORE_PATH };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_MODE_PACK_STORE_PATH = join(root, "mode-packs.json");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { composePortableModePackage } = await jiti.import("./portable-mode-pack-service.ts");
  const { ModePackStore, definitionToDraft } = await jiti.import("./mode-pack-store.ts");
  const store = new ModePackStore();
  const initial = (await store.list(cwd)).packs;
  for (const id of ["course-builder", "study-research.study"]) {
    const current = initial.find((item) => item.definition.modePackId === id)?.definition;
    assert.ok(current);
    const draft = definitionToDraft(current, { revision: current.revision + 1 });
    draft.title = `${draft.title} edited`;
    const saved = await composePortableModePackage({ draft, cwd, expectedRevision: current.revision, sourceModePackId: id, resourceSources: [] });
    assert.equal(saved.modePackId, id);
    assert.equal(saved.revision, current.revision + 1);
    assert.ok(saved.packageContentHash);
    assert.equal((await store.list(cwd)).packs.filter((item) => item.definition.modePackId === id).length, 1);
  }
  assert.equal(store.getCustom("study-research.research")?.revision, initial.find((item) => item.definition.modePackId === "study-research.research")?.definition.revision + 1, "the sibling phase advances atomically");
});
