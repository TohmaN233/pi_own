import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ModePackStore, definitionToDraft } = await jiti.import("./mode-pack-store.ts");
const { bundledCodeModePackage } = await jiti.import("./bundled-code-mode-package.ts");
const { exportPortableModePackage, exportPortableModePackageFiles } = await jiti.import("./portable-mode-pack-service.ts");

test("package library excludes course-bound workflow profiles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-module-list-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const listed = await new ModePackStore(join(root, "store.json")).list(root);
  const ids = new Set(listed.packs.map((item) => item.definition.modePackId));
  for (const internal of ["student-learn", "practice", "teach-back", "visual-lab", "teacher-prep"]) {
    assert.equal(ids.has(internal), false, `${internal} is an internal learning workflow, not a standalone module package`);
  }
  assert.equal(ids.has("course-builder"), true);
  assert.equal(ids.has("study-research.study"), true);
  assert.equal(ids.has("study-research.research"), true);
});

test("Mode Pack store keeps one current version and fails on stale writers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-mode-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "mode-packs.json");
  const store = new ModePackStore(path);
  const draft = {
    version: 1,
    modePackId: "custom.review",
    revision: 1,
    title: "Review",
    description: "Read-only review mode.",
    category: "general",
    role: "general",
    runtimeMode: "general",
    provider: null,
    model: null,
    thinkingLevel: "high",
    externalKnowledgePolicy: "allow",
    courseRequired: false,
    tools: ["find", "grep", "ls", "read"],
    components: [],
    systemPrompt: "Review evidence before conclusions.",
    instructions: [],
  };
  const first = await store.saveDraft(draft, root, 0);
  assert.equal(first.revision, 1);
  assert.equal((await store.resolve("custom.review", root)).snapshot.profileId, "custom.review", "unpackaged editable modes still resolve through the ambient catalog");
  await assert.rejects(() => store.saveDraft({ ...draft, revision: 2 }, root, 0), /revision conflict/i);
  const second = await store.saveDraft({ ...draft, revision: 2, systemPrompt: "Review evidence and cite defects." }, root, 1);
  assert.equal(second.revision, 2);
  assert.equal(new ModePackStore(path).getCustom("custom.review")?.revision, 2);
  await assert.rejects(
    () => store.saveDraft({ ...draft, modePackId: "custom.bad", components: [{ type: "plugin", id: "learning-harness", required: true, enabled: true }] }, root, 0),
    /course-only learning-harness/i,
  );

  const historyBefore = JSON.parse(readFileSync(path, "utf8"));
  const writes = await Promise.allSettled([
    new ModePackStore(path).saveDraft({ ...draft, revision: 3, systemPrompt: "Concurrent writer A." }, root, 2),
    new ModePackStore(path).saveDraft({ ...draft, revision: 3, systemPrompt: "Concurrent writer B." }, root, 2),
  ]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const loser = writes.find((result) => result.status === "rejected");
  assert.match(String(loser?.reason), /revision conflict/i);
  const third = new ModePackStore(path).getCustom("custom.review");
  assert.equal(third?.revision, 3);
  const historyAfter = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(historyBefore.histories["custom.review"].length, 1);
  assert.equal(historyAfter.histories["custom.review"].length, 1);
  assert.equal(historyAfter.histories["custom.review"][0].revision, 3);
  await assert.rejects(() => store.deleteCustom("custom.review", 2), /revision conflict/i);
  await store.deleteCustom("custom.review", 3);
  assert.equal(store.getCustom("custom.review"), null);
});


test("fresh users can save a custom clone of built-in Coding before npm activation", { concurrency: false }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-mode-clone-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousStorePath = process.env.PI_MODE_PACK_STORE_PATH;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_MODE_PACK_STORE_PATH = join(root, "agent", "mode-packs", "store.json");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousStorePath === undefined) delete process.env.PI_MODE_PACK_STORE_PATH; else process.env.PI_MODE_PACK_STORE_PATH = previousStorePath;
    rmSync(root, { recursive: true, force: true });
  });
  const builtin = bundledCodeModePackage().definition;
  assert.ok(builtin.components.some((component) => component.type === "skill" && component.enabled), "Code has default Skills");
  assert.equal(builtin.components.some((component) => component.type === "skill" && component.required), false, "default Skills must remain removable");
  const draft = definitionToDraft(builtin, { modePackId: "custom.coding-copy", revision: 1 });
  const saved = await new ModePackStore(join(root, "agent", "mode-packs", "store.json")).saveDraft(draft, root, 0);
  assert.equal(saved.modePackId, "custom.coding-copy");
  assert.equal(saved.packageContentHash, builtin.packageContentHash);
  assert.equal(existsSync(join(root, "agent", "mode-packs", "packages", builtin.packageContentHash.slice("sha256:".length), "manifest.json")), true);
  assert.equal(existsSync(join(root, "agent", "mode-packs", "runtimes")), false, "cloning records only the archive; private npm installation waits for activation");
  const unlinked = definitionToDraft(saved, { revision: 2 });
  unlinked.components = unlinked.components.filter((component) => component.id !== "incremental-implementation");
  const revised = await new ModePackStore(join(root, "agent", "mode-packs", "store.json")).saveDraft(unlinked, root, 1);
  assert.equal(revised.components.some((component) => component.id === "incremental-implementation"), false, "unlink removes a default Skill from the mode definition");
  const empty = definitionToDraft(revised, { revision: 3 });
  empty.components = [];
  const withoutDefaults = await new ModePackStore(join(root, "agent", "mode-packs", "store.json")).saveDraft(empty, root, 2);
    const exported = await exportPortableModePackage(withoutDefaults.modePackId, root);
    assert.equal(exported.resources.some((resource) => resource.kind === "skill"), false);
    assert.equal(exported.files.some((file) => file.path.endsWith("/SKILL.md")), false, "fully unlinked Code Skills do not ride along as orphan archive bytes");
    const lock = exported.files.find((file) => file.path === "provenance/.skills-lock.json");
    assert.ok(lock?.base64, "the exported package keeps a readable source lock");
    assert.deepEqual(JSON.parse(Buffer.from(lock.base64, "base64").toString("utf8")).resources, [], "the source lock cannot retain removed Skills");
    const binary = await exportPortableModePackageFiles(withoutDefaults.modePackId, root);
    try {
      const binaryLock = binary.sources.get("provenance/.skills-lock.json");
      assert.ok(binaryLock && "bytes" in binaryLock, "binary export uses regenerated lock bytes");
      assert.equal(createHash("sha256").update(binaryLock.bytes).digest("hex"), lock.contentHash.slice("sha256:".length));
    } finally { binary.cleanup(); }
});

test("editing bundled Coding keeps its id and only one visible current version", { concurrency: false }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-mode-edit-builtin-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousStorePath = process.env.PI_MODE_PACK_STORE_PATH;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_MODE_PACK_STORE_PATH = join(root, "store.json");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousStorePath === undefined) delete process.env.PI_MODE_PACK_STORE_PATH; else process.env.PI_MODE_PACK_STORE_PATH = previousStorePath;
    rmSync(root, { recursive: true, force: true });
  });
  const builtin = bundledCodeModePackage().definition;
  const draft = definitionToDraft(builtin, { revision: 2 });
  draft.components = draft.components.filter((component) => component.id !== "test-driven-development");
  const store = new ModePackStore(join(root, "store.json"));
  const saved = await store.saveDraft(draft, root, 1);
  assert.equal(saved.modePackId, "coding");
  assert.equal(saved.components.some((component) => component.id === "test-driven-development"), false);
  const matches = (await store.list(root)).packs.filter((item) => item.definition.modePackId === "coding");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].definition.revision, 2);
  assert.equal(JSON.parse(readFileSync(join(root, "store.json"), "utf8")).histories.coding.length, 1);
  const empty = definitionToDraft(saved, { revision: 3 });
  empty.components = [];
  await store.saveDraft(empty, root, 2);
  const exported = await exportPortableModePackage("coding", root);
  assert.equal(exported.resources.some((resource) => resource.kind === "skill"), false, "export must use the edited Code definition, not the bundled defaults");
});
