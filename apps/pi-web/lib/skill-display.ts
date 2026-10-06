export function orderSkillsByDormancy<T extends { disableModelInvocation: boolean }>(skills: T[]): T[] {
  return [...skills.filter((skill) => !skill.disableModelInvocation), ...skills.filter((skill) => skill.disableModelInvocation)];
}

interface LibrarySkill {
  sourceInfo?: { source?: string; scope?: string };
  install?: { skillsShUrl?: string };
}

export function skillLibrarySourceLabel(skill: LibrarySkill): "project" | "global" | "package" | "path" {
  if (skill.sourceInfo?.source === "pi-own-local-skills") return "project";
  if (skill.sourceInfo?.source === "portable-mode-package") return "package";
  if (skill.sourceInfo?.scope === "user" || skill.sourceInfo?.source === "user") return "global";
  if (skill.sourceInfo?.scope === "project" || skill.sourceInfo?.source === "project") return "project";
  return "path";
}

export function groupSkillsForLibrary<T extends LibrarySkill>(
  skills: T[], labels: { project: string; global: string; path: string; package: string },
): Array<{ label: string; skills: T[] }> {
  const definitions = [
    { label: `${labels.project} / skills.sh`, matches: (skill: T) => skillLibrarySourceLabel(skill) === "project" && Boolean(skill.install?.skillsShUrl) },
    { label: labels.project, matches: (skill: T) => skillLibrarySourceLabel(skill) === "project" && !skill.install?.skillsShUrl },
    { label: `${labels.global} / skills.sh`, matches: (skill: T) => skillLibrarySourceLabel(skill) === "global" && Boolean(skill.install?.skillsShUrl) },
    { label: labels.global, matches: (skill: T) => skillLibrarySourceLabel(skill) === "global" && !skill.install?.skillsShUrl },
    { label: labels.package, matches: (skill: T) => skillLibrarySourceLabel(skill) === "package" },
    { label: labels.path, matches: (skill: T) => skillLibrarySourceLabel(skill) === "path" },
  ];
  return definitions.map(({ label, matches }) => ({ label, skills: skills.filter(matches) }))
    .filter((group) => group.skills.length > 0);
}
