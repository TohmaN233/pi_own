import { DefaultResourceLoader, getAgentDir, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { localModeSkillsDirectory } from "../../../packages/profile-resource-host/src/index.ts";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { readLocalSkillLock } from "./local-skill-install";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { bundledCodeModePackage } from "./bundled-code-mode-package";
import { portableModePackageDirectory, readLatestPortableModePackageManifests, verifyStoredPortableFile } from "./portable-mode-pack-registry";
import { ModePackStore } from "./mode-pack-store";

function packagedSkills(): { skills: SkillInfo[]; diagnostics: SkillsResponse["diagnostics"] } {
  const skills: SkillInfo[] = [];
  const diagnostics: SkillsResponse["diagnostics"] = [];
  const seen = new Set<string>();
  const builtIn = bundledCodeModePackage();
  // A user-customized Coding installation replaces the shipped default catalog.
  // Deleted Skills must not reappear from the original distribution archive.
  for (const resource of new ModePackStore().getCustom("coding") ? [] : builtIn.resources) {
    if (resource.kind !== "skill" || resource.source.type !== "bundled") continue;
    const sourcePath = resource.source.path;
    const entry = builtIn.files.find((file) => file.path === sourcePath);
    if (!entry?.base64) throw new Error(`Bundled Skill is missing its archive bytes: ${resource.id}`);
    const bytes = Buffer.from(entry.base64, "base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(digest)) continue;
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(bytes.toString("utf8"));
    if (!match) throw new Error(`Bundled Skill has no frontmatter: ${resource.id}`);
    const metadata = loadYaml(match[1]) as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata.name !== "string" || typeof metadata.description !== "string") {
      throw new Error(`Bundled Skill has invalid frontmatter: ${resource.id}`);
    }
    const filePath = `bundle://coding/${entry.path}`;
    skills.push({
      name: metadata.name,
      description: metadata.description,
      filePath,
      baseDir: filePath.slice(0, -"/SKILL.md".length),
      disableModelInvocation: metadata["disable-model-invocation"] === true,
      sourceInfo: { source: "portable-mode-package", scope: "coding" },
    });
    seen.add(digest);
  }
  const paths: Array<{ path: string; source: string }> = [];
  for (const archive of readLatestPortableModePackageManifests()) {
    for (const resource of archive.resources) {
      if (resource.kind !== "skill" || resource.source.type !== "bundled") continue;
      const sourcePath = resource.source.path;
      const entry = archive.files.find((file) => file.path === sourcePath);
      if (!entry) throw new Error(`Portable Skill is missing its manifest file: ${archive.packageContentHash}/${resource.id}`);
      const path = join(portableModePackageDirectory(archive.packageContentHash), entry.path);
      if (!existsSync(path)) throw new Error(`Installed portable Skill is missing: ${path}`);
      verifyStoredPortableFile(path, entry.bytes, entry.contentHash);
      paths.push({ path, source: archive.moduleId ?? archive.definition.modePackId });
    }
  }
  for (const entry of paths) {
    const content = readFileSync(entry.path);
    const digest = createHash("sha256").update(content).digest("hex");
    if (seen.has(digest)) continue;
    const loaded = loadSkillsFromDir({ dir: dirname(entry.path), source: "portable-mode-package" });
    diagnostics.push(...loaded.diagnostics);
    const selected = loaded.skills.find((skill) => resolve(skill.filePath) === resolve(entry.path));
    if (!selected) throw new Error(`Portable Skill did not parse: ${entry.path}`);
    skills.push({ ...selected, sourceInfo: { ...selected.sourceInfo, source: "portable-mode-package", scope: entry.source } } as SkillInfo);
    seen.add(digest);
  }
  return { skills, diagnostics };
}

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  // This endpoint lists Skills only. Loading unrelated extensions, templates,
  // themes and context files made the list wait for whole Pi resource startup.
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  const directory = localModeSkillsDirectory();
  readLocalSkillLock(directory);
  const local = loadSkillsFromDir({ dir: directory, source: "pi-own-local-skills" });
  const combined = [...local.skills, ...skills.filter((skill) => !local.skills.some((item) => item.filePath === skill.filePath))];
  const packaged = packagedSkills();
  const existing = new Set(combined.map((skill) => resolve(skill.filePath)));
  return {
    skills: [...annotateSkillsWithInstallInfo(combined as SkillInfo[], { cwd, agentDir, localSkillsDirectory: directory }), ...packaged.skills.filter((skill) => !existing.has(resolve(skill.filePath)))],
    installDirectory: directory,
    diagnostics: [...local.diagnostics, ...diagnostics, ...packaged.diagnostics],
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
