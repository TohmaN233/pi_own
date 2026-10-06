import type { ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { portableModuleProfileIds } from "../../../packages/mode-pack-host/src/index.ts";
import { activePortableModePackageForSnapshot } from "./portable-mode-pack-registry";
import { studyModePhase } from "./study-mode-phase";
export { STUDY_MODE_ID, RESEARCH_MODE_ID, studyModePhase } from "./study-mode-phase";


/** Resolve an installed module by verified package identity, rather than by
 * the local name chosen during import. A same-named unrelated mode is never
 * granted the Study capability boundary. */
export function studyModePhaseForSnapshot(snapshot: Pick<ResourceSnapshot, "profileId" | "packageContentHash">): "study" | "research" | null {
  if (!snapshot.packageContentHash) return studyModePhase(snapshot.profileId);
  const archive = activePortableModePackageForSnapshot(snapshot);
  if (archive?.runtimeAssets?.find((asset) => asset.kind === "harness")?.id !== "study-research") return null;
  const layout = portableModuleProfileIds(archive, snapshot.profileId);
  if (!layout || !layout.profileIds.includes(snapshot.profileId)) return null;
  const suffix = snapshot.profileId.slice(layout.moduleId.length);
  return suffix === ".study" ? "study" : suffix === ".research" ? "research" : null;
}

/** Enforced on resolved snapshots, including personal settings and restored JSONL. */
export function assertStudyModeBoundary(snapshot: ResourceSnapshot): void {
  const phase = studyModePhaseForSnapshot(snapshot);
  if (!phase) return;
  if (snapshot.role !== "general" || snapshot.mode !== "general" || snapshot.courseVersionId !== null) {
    throw new Error("Study & Research requires a general session without a course binding");
  }
  if (snapshot.tools.some((tool) => tool !== "codemode" && tool !== "tool_search")) {
    throw new Error("Study & Research uses scoped Host tools; raw filesystem and shell presets are unavailable");
  }
  const required = new Set([
    "extension:study-research",
    "extension:study-visualization",
    "extension:study-assignment",
    "skill:study.paper-learning",
    "skill:study.visual-validation",
    ...(phase === "research" ? ["extension:research-execution", "extension:study-results", "extension:study-manuscript", "skill:study.research-execution"] : []),
  ]);
  const allowed = new Set([...required, "skill:pi-caw"]);
  for (const resource of snapshot.resources) {
    if (resource.enabled && !allowed.has(`${resource.kind}:${resource.id}`)) {
      throw new Error(`Resource is outside the ${phase} capability boundary: ${resource.kind}:${resource.id}`);
    }
  }
  for (const key of required) {
    const resource = snapshot.resources.find((item) => `${item.kind}:${item.id}` === key);
    if (!resource?.enabled || !resource.required) throw new Error(`Required ${phase} resource is absent: ${key}`);
  }
}
