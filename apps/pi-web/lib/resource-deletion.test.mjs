import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createHash } from "node:crypto";

const { removeResourceFiles } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./resource-deletion.ts");

test("resource deletion removes the complete installed tree and rejects roots and escaped links", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-delete-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, "skills");
  const skill = join(library, "example");
  const outside = join(root, "outside");
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(skill, "SKILL.md"), "Example");
  writeFileSync(join(skill, "references", "data.md"), "Reference");
  assert.throws(() => removeResourceFiles(library, [library]), /outside its resource directory/);
  const linked = join(library, "escaped");
  symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => removeResourceFiles(linked, [library]), /outside its resource directory/);
  assert.ok(existsSync(outside));
  removeResourceFiles(skill, [library]);
  assert.equal(existsSync(skill), false);
});

test("deleting a required mode plugin prunes the package and physically retires its previous installation", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-mode-plugin-delete-"));
  const cwd = join(root, "project"); mkdirSync(cwd);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MODE_PACK_STORE_PATH: process.env.PI_MODE_PACK_STORE_PATH };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_MODE_PACK_STORE_PATH = join(root, "modes.json");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
  const { createPortableModePackage } = await jiti.import("../../../packages/mode-pack-host/src/index.ts");
  const { importPortableModePackage } = await jiti.import("./portable-mode-pack-service.ts");
  const { portableModePackageDirectory, readPortableModePackage } = await jiti.import("./portable-mode-pack-registry.ts");
  const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
  const { deleteModePlugin } = await jiti.import("./resource-deletion.ts");
  const file = (name, content) => { const bytes = Buffer.from(content); return { path: name, contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length, base64: bytes.toString("base64") }; };
  const plugin = file("resources/plugins/disposable.js", "export default () => {};\n");
  const html = file("frontend/index.html", "<!doctype html><title>Disposable</title>");
  const draft = { version: 1, modePackId: "custom.delete-fixture", revision: 1, title: "Disposable", description: "Deletion fixture", category: "general", role: "general", runtimeMode: "general", provider: null, model: null, thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false, tools: ["read"], systemPrompt: "Disposable", instructions: [], components: [{ type: "plugin", id: "fixture.delete-plugin", required: true, enabled: true, version: "1", contentHash: plugin.contentHash }] };
  const archive = createPortableModePackage({ definition: { ...draft, contentHash: contentHash(draft) }, resources: [{ kind: "extension", id: "fixture.delete-plugin", delivery: "system-instruction", contentHash: plugin.contentHash, source: { type: "bundled", path: plugin.path } }], files: [plugin, html], frontend: { entry: html.path, assets: [{ path: html.path, contentHash: html.contentHash, bytes: html.bytes }] }, projectCapabilities: [], targetPlatform: { os: process.platform, arch: process.arch }, externalDependencies: [] });
  const installed = await importPortableModePackage(archive, cwd);
  const oldDirectory = portableModePackageDirectory(installed.packageContentHash);
  assert.ok(existsSync(oldDirectory));
  const deleted = await deleteModePlugin(cwd, draft.modePackId, "fixture.delete-plugin");
  assert.ok(deleted.deletedArchives.includes(installed.packageContentHash));
  assert.equal(existsSync(oldDirectory), false);
  const current = new ModePackStore().getCustom(draft.modePackId);
  assert.equal(current.components.some(item => item.id === "fixture.delete-plugin"), false);
  const updated = readPortableModePackage(current.packageContentHash);
  assert.equal(updated.resources.some(item => item.id === "fixture.delete-plugin"), false);
  assert.equal(updated.files.some(item => item.path === plugin.path), false);
});
