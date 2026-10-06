import type { ModePackDefinition, ModePackDraft } from "../../../packages/harness-contracts/src/index.ts";
import type { ModePluginInfo } from "./api-types";
import { bundledCodeModePackage } from "./bundled-code-mode-package";
import { COURSE_BUILDER_DRAFT } from "./course-builder-pack";
import { ModePackStore } from "./mode-pack-store";
import { STUDY_RESEARCH_DRAFTS } from "./study-research-pack";

/** Read package selections without resolving ambient Pi packages or installing a runtime. */
export function readModePlugins(store = new ModePackStore()): ModePluginInfo[] {
  const code = bundledCodeModePackage();
  const definitions = new Map<string, ModePackDraft | ModePackDefinition>([
    [code.definition.modePackId, code.definition],
    [COURSE_BUILDER_DRAFT.modePackId, COURSE_BUILDER_DRAFT],
    ...STUDY_RESEARCH_DRAFTS.map((draft) => [draft.modePackId, draft] as const),
  ]);
  for (const definition of store.listCustom()) definitions.set(definition.modePackId, definition);
  const codeSources = new Map(code.resources.filter((resource) => resource.kind === "extension")
    .map((resource) => [resource.id, resource.source.type === "npm"
      ? `npm:${resource.source.package}@${resource.source.version}`
      : resource.id]));
  return [...definitions.values()].flatMap((definition) => definition.components
    .filter((component) => component.type === "plugin")
    .map((component) => ({
      modePackId: definition.modePackId,
      modeTitle: definition.title,
      id: component.id,
      source: definition.modePackId === code.definition.modePackId
        ? codeSources.get(component.id) ?? component.id : component.id,
      ...("version" in component && typeof component.version === "string" && component.version
        ? { version: component.version } : {}),
      enabled: component.enabled,
      required: component.required,
    }))).sort((left, right) => left.modePackId.localeCompare(right.modePackId) || left.id.localeCompare(right.id));
}
