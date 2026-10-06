import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModePackStore, definitionToDraft, modePackDefinitionSelection } from "./mode-pack-store";
import { composePortableModePackage } from "./portable-mode-pack-service";
import { forgetUninstalledBuiltinArchives, installedPortableModePackageManifests, portableModePackageDirectory } from "./portable-mode-pack-registry";
import { portablePackageRuntimeDirectory } from "./portable-mode-package-install";
import { inspectModePackInventory } from "./mode-pack-inventory";
import { loadSkillsWithInstallInfo } from "./skills-service";
import { LOCAL_SKILL_LOCK, readLocalSkillLock } from "./local-skill-install";
import { localModeSkillsDirectory } from "../../../packages/profile-resource-host/src/index.ts";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { runtimeHomeDirectory } from "./runtime-home";
import { writePrivateFileAtomicSync } from "./atomic-file";
import lockfile from "proper-lockfile";
import { recordResourceUninstall } from "./resource-uninstall-state";

type Resource = { kind: "skill" | "extension"; id: string };
const key = (item: Resource) => `${item.kind}:${item.id}`;

/** The server selects targets from its inventory, never a caller-supplied directory.
 * Verify both lexical and resolved paths before every recursive deletion. */
export function assertResourceDeletionTarget(target: string, roots: readonly string[]): string {
  const absolute = resolve(target);
  const resolved = realpathSync(absolute);
  const contained = (candidate: string, root: string) => {
    const rel = relative(resolve(root), candidate);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
  };
  if (!roots.some(root => existsSync(root) && contained(absolute, root) && contained(resolved, realpathSync(root)))) throw new Error(`Deletion target is outside its resource directory: ${absolute}`);
  return absolute;
}

export function removeResourceFiles(target: string, roots: readonly string[]): void {
  const absolute = assertResourceDeletionTarget(target, roots);
  rmSync(absolute, { recursive: lstatSync(absolute).isDirectory(), force: false });
  if (existsSync(absolute)) throw new Error(`Resource files were not deleted: ${absolute}`);
  console.info("[resources/delete] files deleted", { path: absolute });
}

export async function removeResourcesFromModes(cwd: string, resources: Resource[]): Promise<string[]> {
  if (!resources.length) return [];
  const removed = new Set(resources.map(key));
  const store = new ModePackStore();
  const { packs } = await store.list(cwd);
  const definitions = new Map([...packs.map(item => item.definition), ...Object.values((await inspectModePackInventory(cwd)).builtinPacks), ...store.listCustom()].map(item => [item.modePackId, item]));
  const updated: string[] = [];
  for (const item of definitions.values()) {
    if (!item.modePackId.startsWith("custom.") && !["coding", "general", "creative", "course-builder", "study-research.study", "study-research.research"].includes(item.modePackId)) continue;
    const definition = store.getCustom(item.modePackId) ?? item;
    const components = definition.components.filter(component => !removed.has(`${component.type === "plugin" ? "extension" : component.type}:${component.id}`));
    if (components.length === definition.components.length) continue;
    const draft = definitionToDraft(definition, { revision: definition.revision + 1 });
    draft.components = draft.components.filter(component => !removed.has(`${component.type === "plugin" ? "extension" : component.type}:${component.id}`));
    if (definition.packageContentHash || ["course-builder", "study-research.study", "study-research.research"].includes(definition.modePackId)) await composePortableModePackage({ draft, cwd, sourceModePackId: definition.modePackId, expectedRevision: definition.revision, resourceSources: [], removeResources: resources });
    else await store.saveDraft(draft, cwd, definition.revision);
    updated.push(definition.modePackId);
    console.info("[resources/delete] mode references removed", { modePackId: definition.modePackId, resources });
  }
  return updated;
}

export async function purgeResourceArchives(resources: Resource[]): Promise<string[]> {
  const removed = new Set(resources.map(key));
  const store = new ModePackStore();
  const current = store.listCustom();
  const retained = new Set(current.map(definition => definition.packageContentHash));
  const archives = installedPortableModePackageManifests();
  const retired = archives.filter(archive => !retained.has(archive.packageContentHash)
    && archive.resources.some(resource => removed.has(`${resource.kind}:${resource.id}`)));
  const currentRuntimes = new Set(archives.filter(archive => retained.has(archive.packageContentHash)).map(archive =>
    resolve(portablePackageRuntimeDirectory(archive, modePackDefinitionSelection(archive.definition)))));
  const runtimes = new Set(retired.map(archive => resolve(portablePackageRuntimeDirectory(archive, modePackDefinitionSelection(archive.definition)))));
  const hashes = retired.map(archive => archive.packageContentHash);
  recordResourceUninstall(hashes, resources.map(key));
  await store.forgetUninstalledArchives(hashes);
  forgetUninstalledBuiltinArchives(hashes);
  const root = join(getAgentDir(), "mode-packs");
  for (const archive of retired) removeResourceFiles(portableModePackageDirectory(archive.packageContentHash), [join(root, "packages")]);
  for (const directory of runtimes) if (!currentRuntimes.has(directory) && existsSync(directory)) removeResourceFiles(directory, [root]);
  return hashes;
}

export async function deleteModePlugin(cwd: string, modePackId: string, id: string): Promise<{ updatedModes: string[]; deletedArchives: string[] }> {
  const store = new ModePackStore();
  const definition = (await store.resolve(modePackId, cwd)).definition;
  if (!definition?.components.some(component => component.type === "plugin" && component.id === id)) throw new Error(`Plugin is not installed in ${modePackId}: ${id}`);
  const resources: Resource[] = [{ kind: "extension", id }];
  const updatedModes = await removeResourcesFromModes(cwd, resources);
  return { updatedModes, deletedArchives: await purgeResourceArchives(resources) };
}

export async function deleteInstalledSkill(cwd: string, filePath: string) {
  const skill = (await loadSkillsWithInstallInfo(cwd)).skills.find(item => item.filePath === filePath);
  if (!skill) throw new Error("Skill is not in the current installation inventory");
  const inventory = await inspectModePackInventory(cwd);
  const resources: Resource[] = inventory.resources.filter(item => item.kind === "skill" && item.paths.some(file => resolve(file) === resolve(filePath))).map(item => ({ kind: "skill", id: item.id }));
  for (const archive of installedPortableModePackageManifests()) for (const resource of archive.resources) {
    if (resource.kind !== "skill" || resource.source.type !== "bundled") continue;
    const installedFile = join(portableModePackageDirectory(archive.packageContentHash), resource.source.path);
    if (resolve(installedFile) === resolve(filePath) || filePath === `bundle://coding/${resource.source.path}`) resources.push({ kind: "skill", id: resource.id });
  }
  const unique = [...new Map(resources.map(item => [key(item), item])).values()];
  if (skill.sourceInfo.source === "portable-mode-package") {
    if (!unique.length) throw new Error("Portable Skill has no registered resource identity");
    const updatedModes = await removeResourcesFromModes(cwd, unique);
    return { updatedModes, deletedArchives: await purgeResourceArchives(unique) };
  }
  const library = localModeSkillsDirectory();
  const roots = [...await getAllowedFileRoots(), getAgentDir(), library];
  const globalSkills = join(runtimeHomeDirectory(), ".agents", "skills");
  if (existsSync(globalSkills)) roots.push(globalSkills);
  if (!isExistingFilePathAllowed(filePath, new Set(roots))) throw new Error("Skill deletion access denied");
  const target = dirname(filePath);
  if (basename(filePath).toLowerCase() !== "skill.md" || target === resolve(cwd) || target === resolve(library) || target === resolve(getAgentDir())) throw new Error("Skill is not installed in a dedicated Skill directory");
  assertResourceDeletionTarget(target, roots);
  assertResourceDeletionTarget(realpathSync(target), roots);
  const updatedModes = await removeResourcesFromModes(cwd, unique);
  recordResourceUninstall([], unique.map(key));
  const release = await lockfile.lock(library, { realpath: false, retries: 0 });
  try {
    if (dirname(resolve(target)) === resolve(library)) {
      const deletedFile = join(library, ".deleted-skills.json");
      const deleted: string[] = existsSync(deletedFile) ? JSON.parse(readFileSync(deletedFile, "utf8")) : [];
      if (!Array.isArray(deleted) || deleted.some(item => typeof item !== "string")) throw new Error("Invalid deleted Skills registry");
      writePrivateFileAtomicSync(deletedFile, `${JSON.stringify([...new Set([...deleted, basename(target)])])}\n`);
      const installed = readLocalSkillLock(library);
      delete installed.skills[skill.name];
      writePrivateFileAtomicSync(join(library, LOCAL_SKILL_LOCK), `${JSON.stringify(installed, null, 2)}\n`);
    }
    const actual = realpathSync(target);
    const link = lstatSync(target).isSymbolicLink();
    removeResourceFiles(actual, roots);
    if (link) unlinkSync(target);
  } finally { await release(); }
  return { updatedModes, deletedArchives: await purgeResourceArchives(unique) };
}
