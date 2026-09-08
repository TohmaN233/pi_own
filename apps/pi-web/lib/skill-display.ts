export function orderSkillsByDormancy<T extends { disableModelInvocation: boolean }>(skills: T[]): T[] {
  return [...skills.filter((skill) => !skill.disableModelInvocation), ...skills.filter((skill) => skill.disableModelInvocation)];
}
