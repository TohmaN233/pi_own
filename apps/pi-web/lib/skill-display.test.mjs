import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { groupSkillsForLibrary } = await createJiti(import.meta.url).import("./skill-display.ts");

test("Skill library renders every API source, including portable package Skills", () => {
  const skills = [
    { name: "local", sourceInfo: { source: "pi-own-local-skills" } },
    { name: "bundled", sourceInfo: { source: "portable-mode-package", scope: "coding" } },
    { name: "user", sourceInfo: { source: "user" } },
  ];
  const groups = groupSkillsForLibrary(skills, { project: "Project", global: "Global", path: "Path", package: "Package" });
  assert.deepEqual(groups.flatMap((group) => group.skills.map((skill) => skill.name)), ["local", "user", "bundled"]);
  assert.equal(groups.find((group) => group.label === "Package")?.skills[0]?.name, "bundled");
});
