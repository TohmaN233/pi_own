import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { trustProject } = await jiti.import("./project-trust.ts");
const { loadSkillsWithInstallInfo } = await jiti.import("./skills-service.ts");

test("Skill listing discovers project Skills without executing trusted project extensions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-skills-list-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const marker = join(root, "extension-executed");
  mkdirSync(join(cwd, ".pi", "skills", "list-fixture"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(cwd, ".pi", "skills", "list-fixture", "SKILL.md"), "---\nname: list-fixture\ndescription: list fixture\n---\nList me.\n");
  writeFileSync(join(cwd, ".pi", "extensions", "probe.js"), `import { writeFileSync } from "node:fs";\nexport default () => writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  trustProject(cwd, agentDir);
  const result = await loadSkillsWithInstallInfo(cwd);
  assert.ok(result.skills.some((skill) => skill.name === "list-fixture"));
  assert.ok(result.skills.some((skill) => skill.name === "test-driven-development" && skill.sourceInfo.source === "portable-mode-package"), "optional packaged Skills belong in the full library");
  assert.ok(result.skills.some((skill) => skill.name === "test-driven-development" && skill.filePath.startsWith("bundle://coding/")), "bundled Skill metadata must be readable without the source checkout");
  assert.ok(result.skills.some((skill) => skill.name === "grill-with-docs" && skill.sourceInfo.source === "portable-mode-package"));
  assert.equal(result.skills.some((skill) => skill.name.startsWith("code.")), false, "visible Skill names do not acquire a mode prefix");
  assert.equal(existsSync(marker), false, "a Skill-list request must not execute unrelated project extensions");
});
