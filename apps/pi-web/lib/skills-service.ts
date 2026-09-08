import { DefaultResourceLoader, getAgentDir, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { localModeSkillsDirectory } from "../../../packages/profile-resource-host/src/index.ts";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { readLocalSkillLock } from "./local-skill-install";

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  const directory = localModeSkillsDirectory();
  readLocalSkillLock(directory);
  const local = loadSkillsFromDir({ dir: directory, source: "pi-own-local-skills" });
  const combined = [...local.skills, ...skills.filter((skill) => !local.skills.some((item) => item.filePath === skill.filePath))];
  return {
    skills: annotateSkillsWithInstallInfo(combined as SkillInfo[], { cwd, agentDir, localSkillsDirectory: directory }),
    installDirectory: directory,
    diagnostics: [...local.diagnostics, ...diagnostics],
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
