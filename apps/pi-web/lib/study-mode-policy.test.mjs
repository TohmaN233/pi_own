import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { STUDY_RESEARCH_DRAFTS } = await jiti.import("./study-research-pack.ts");
const { assertStudyModeBoundary } = await jiti.import("./study-mode-policy.ts");
const { ResourceCatalog, compileModePackDraft, resolveModePackSnapshot, reviseModePackSettings } =
  await jiti.import("../../../packages/profile-resource-host/src/index.ts");
const { buildModePackRuntimePlanFromInventory } = await jiti.import("./mode-pack-inventory.ts");

function fixture(draft) {
  const resources = draft.components.map((component) => ({
    kind: component.type === "plugin" ? "extension" : component.type,
    id: component.id, version: "1", contentHash: "sha256:test-resource",
  }));
  const catalog = new ResourceCatalog(resources);
  const pack = compileModePackDraft(draft, catalog);
  const snapshot = resolveModePackSnapshot({ pack, catalog, courseVersionId: null, createdAt: "2026-09-12T00:00:00Z" });
  return { snapshot, catalog, pack };
}

test("both phase snapshots retain required learning resources and no raw tools", () => {
  for (const draft of STUDY_RESEARCH_DRAFTS) {
    const { snapshot } = fixture(draft);
    assert.doesNotThrow(() => assertStudyModeBoundary(snapshot));
    assert.equal(snapshot.courseVersionId, null);
  }
});

test("settings cannot restore filesystem/shell bypass on either phase", () => {
  for (const draft of STUDY_RESEARCH_DRAFTS) {
    const { snapshot, catalog } = fixture(draft);
    for (const name of ["bash", "powershell", "write", "read", "grep", "edit", "find", "ls"]) {
      const tools = new ResourceCatalog([
        ...snapshot.resources.map(({ kind, id, version, contentHash }) => ({ kind, id, version, contentHash })),
        { kind: "tool", id: name, version: "1", contentHash: "sha256:built-in-tool" },
      ]);
      const modified = reviseModePackSettings(snapshot, { tools: [name] }, tools);
      assert.throws(() => buildModePackRuntimePlanFromInventory({
        snapshot: modified, inventory: { catalog, resourcesByKey: new Map() },
      }), /scoped Host tools/);
    }
  }
});

test("Study rejects research resources and arbitrary plugins, Research requires its execution resources", () => {
  const study = fixture(STUDY_RESEARCH_DRAFTS[0]).snapshot;
  const research = fixture(STUDY_RESEARCH_DRAFTS[1]).snapshot;
  const execution = research.resources.find((resource) => resource.id === "research-execution");
  const results = research.resources.find((resource) => resource.id === "study-results");
  assert.ok(results);
  const manuscript = research.resources.find((resource) => resource.id === "study-manuscript");
  assert.ok(manuscript);
  assert.throws(() => assertStudyModeBoundary({ ...study, resources: [...study.resources, manuscript] }), /capability boundary/);
  assert.throws(() => assertStudyModeBoundary({ ...study, resources: [...study.resources, results] }), /capability boundary/);
  assert.throws(() => assertStudyModeBoundary({ ...study, resources: [...study.resources, execution] }), /capability boundary/);
  assert.throws(() => assertStudyModeBoundary({ ...research, resources: research.resources.filter((resource) => resource !== execution) }), /Required research resource/);
  assert.throws(() => assertStudyModeBoundary({ ...study, resources: [...study.resources, { ...execution, id: "arbitrary-shell" }] }), /capability boundary/);
  assert.doesNotThrow(() => assertStudyModeBoundary({ ...study, profileId: "course-builder" }));
});
