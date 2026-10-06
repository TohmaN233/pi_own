import type { ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { portableModuleProfileIds } from "../../../packages/mode-pack-host/src/index.ts";
import { activePortableModePackageForSnapshot } from "./portable-mode-pack-registry";

/** A Course Builder import may have a different local profile name. Its
 * verified package identity, rather than that name, grants course behavior. */
export function isCourseBuilderSnapshot(snapshot: ResourceSnapshot): boolean {
  if (!snapshot.packageContentHash) return snapshot.profileId === "course-builder";
  const archive = activePortableModePackageForSnapshot(snapshot);
  if (archive?.runtimeAssets?.find((asset) => asset.kind === "harness")?.id !== "course-builder") return false;
  const layout = portableModuleProfileIds(archive, snapshot.profileId);
  return layout?.profileIds.includes(snapshot.profileId) === true
    && snapshot.profileId === layout.moduleId;
}
