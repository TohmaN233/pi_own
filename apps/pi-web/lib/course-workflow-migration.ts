import type { ModePackDefinition, ModePackDraft, ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { portableModuleProfileIds, type PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { resolve } from "node:path";
import type { RuntimeModeResource } from "./mode-pack-inventory";

/** This is an authorized product migration, not a missing-resource fallback. */
export const COURSE_WORKFLOW_MIGRATION_MARKER = "Course Workflow migration: skill-retirement/v1";
export const COURSE_PRODUCTION_MIGRATION_MARKER = "Course Workflow migration: conditional-production/v2";
/** Only the source-vendored built-in Host may adopt new local implementation bytes. */
export function isBuiltinCourseHostUpgrade(profile: { profileId: string; packageContentHash?: string | null; instructions: readonly string[] }, resource?: RuntimeModeResource): boolean {
  const normalize = (path: string) => resolve(path).replaceAll("\\", "/");
  const knownPaths = [resolve(process.cwd(), "lib/course-builder-extension.ts"), resolve(process.cwd(), "apps/pi-web/lib/course-builder-extension.ts")].map(normalize);
  return profile.profileId === "course-builder" && !profile.packageContentHash
    && profile.instructions.includes(COURSE_WORKFLOW_MIGRATION_MARKER)
    && resource?.kind === "extension" && resource.id === "course-builder" && resource.source === "pi-own"
    && resource.scope === "platform" && !resource.synthetic && resource.available !== false
    && resource.paths.length === 1 && knownPaths.includes(normalize(resource.paths[0]));
}
export const RETIRED_COURSE_SKILL_IDS: ReadonlySet<string> = new Set([
  "teacher.course-planning-beamer", "education.lesson-blueprint", "education.learning-to-learn",
  "local.skill.course.planning.beamer", "local.skill.course-planning-beamer", "course-planning-beamer",
  "education.curriculum-continuity", "education.evidence-ledger", "shared.revision-discipline",
  "education.learn-by-doing", "education.visual-explanation", "education.feynman-teach-back",
  "local.skill.course.lesson.artifact.workflow", "local.skill.course.slide.revision.workflow",
  "local.skill.course-lesson-artifact-workflow", "local.skill.course-slide-revision-workflow",
  "course-lesson-artifact-workflow", "course-slide-revision-workflow",
]);
// Exact shipped defaults only. An unknown historical prompt may be personal.
const LEGACY_DEFAULT_PROMPT_HASHES = new Set([
  "sha256:a5aaeadbdd840637bc0fa80467893d99b201d1ce35aedd73270030f2fe9cc430",
  "sha256:d28801dd8116f3e96ffce187417cdf3a1f0cdccbe4aa775d8e1c796b23073bd4",
  "sha256:7fb64349187b920b87d2f60ebf239cb6404ba933f54190cc2af5ebbc2a94e104",
]);
export function isRetiredCourseResource(kind: string, id: string): boolean {
  return kind === "skill" && RETIRED_COURSE_SKILL_IDS.has(id)
    || (kind === "workflow" && id === "course-builder")
    || (kind === "prompt" && id === "workflow:course-builder");
}
export function isCourseWorkflowProfile(profileId: string, archive?: PortableModePackage | null): boolean {
  if (!archive) return profileId === "course-builder";
  const layout = portableModuleProfileIds(archive, profileId);
  return archive.runtimeAssets?.some(asset => asset.kind === "harness" && asset.id === "course-builder") === true
    && layout?.moduleId === profileId && layout.profileIds.includes(profileId);
}
export function needsCourseWorkflowDefinitionMigration(definition: ModePackDefinition, archive?: PortableModePackage | null): boolean {
  return isCourseWorkflowProfile(definition.modePackId, archive)
    && !definition.instructions.includes(COURSE_PRODUCTION_MIGRATION_MARKER);
}
export function needsCourseWorkflowSnapshotMigration(snapshot: ResourceSnapshot, archive?: PortableModePackage | null): boolean {
  return (!snapshot.packageContentHash || Boolean(archive)) && isCourseWorkflowProfile(snapshot.profileId, archive)
    && !snapshot.instructions.includes(COURSE_PRODUCTION_MIGRATION_MARKER);
}
export function isKnownLegacyCourseDefaultPrompt(prompt: string): boolean {
  return LEGACY_DEFAULT_PROMPT_HASHES.has(contentHash({ systemPrompt: prompt.trim() }));
}
export function courseWorkflowRetirementDraft(definition: ModePackDefinition, defaults: ModePackDraft): ModePackDraft {
  if (!defaults.instructions.includes(COURSE_WORKFLOW_MIGRATION_MARKER))
    throw new Error("Course Workflow default definition has no Skill retirement migration marker");
  const { contentHash: _hash, ...draft } = definition;
  return {
    ...draft, revision: definition.revision + 1,
    components: definition.components.filter(component => !isRetiredCourseResource(component.type, component.id))
      .map(({ version: _version, contentHash: _contentHash, ...component }) => component),
    systemPrompt: isKnownLegacyCourseDefaultPrompt(definition.systemPrompt) ? defaults.systemPrompt : definition.systemPrompt,
    instructions: [...new Set([...definition.instructions, COURSE_WORKFLOW_MIGRATION_MARKER, COURSE_PRODUCTION_MIGRATION_MARKER])],
  };
}
