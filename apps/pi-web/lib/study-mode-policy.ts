import type { ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";

export const STUDY_MODE_ID = "study-research.study";
export const RESEARCH_MODE_ID = "study-research.research";

export function studyModePhase(profileId: string): "study" | "research" | null {
  if (profileId === STUDY_MODE_ID) return "study";
  if (profileId === RESEARCH_MODE_ID) return "research";
  return null;
}

/** Enforced on resolved snapshots, including personal settings and restored JSONL. */
export function assertStudyModeBoundary(snapshot: ResourceSnapshot): void {
  const phase = studyModePhase(snapshot.profileId);
  if (!phase) return;
  if (snapshot.role !== "general" || snapshot.mode !== "general" || snapshot.courseVersionId !== null) {
    throw new Error("Study & Research requires a general session without a course binding");
  }
  if (snapshot.tools.length !== 0) {
    throw new Error("Study & Research uses scoped Host tools; raw filesystem and shell presets are unavailable");
  }
  const allowed = new Set([
    "extension:study-research",
    "extension:study-visualization",
    "extension:study-assignment",
    "skill:study.paper-learning",
    "skill:study.visual-validation",
    ...(phase === "research" ? ["extension:research-execution", "extension:study-results", "extension:study-manuscript", "skill:study.research-execution"] : []),
  ]);
  for (const resource of snapshot.resources) {
    if (resource.enabled && !allowed.has(`${resource.kind}:${resource.id}`)) {
      throw new Error(`Resource is outside the ${phase} capability boundary: ${resource.kind}:${resource.id}`);
    }
  }
  for (const key of allowed) {
    const resource = snapshot.resources.find((item) => `${item.kind}:${item.id}` === key);
    if (!resource?.enabled || !resource.required) throw new Error(`Required ${phase} resource is absent: ${key}`);
  }
}
