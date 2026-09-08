import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { localModeSkillsDirectory } from "../../../packages/profile-resource-host/src/index.ts";
import { runNpx } from "./npx";

type Entry = { source: string; sourceType: string; computedHash: string; [key: string]: unknown };
type Lock = { version: number; skills: Record<string, Entry> };
export const LOCAL_SKILL_LOCK = ".skills-lock.json";

export function readLocalSkillLock(directory: string): Lock {
  const path = join(directory, LOCAL_SKILL_LOCK);
  if (!existsSync(path)) return { version: 1, skills: {} };
  const value = JSON.parse(readFileSync(path, "utf8")) as Lock;
  if (value.version !== 1 || !value.skills || typeof value.skills !== "object" || Array.isArray(value.skills)) throw new Error("Invalid project skill installation lock");
  return value;
}

function checkTree(directory: string): void {
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Installed skill directory is a symbolic link");
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Installed skill contains a symbolic link: ${item.name}`);
    if (item.isDirectory()) checkTree(path);
    else if (!item.isFile()) throw new Error(`Unsupported skill file: ${item.name}`);
  }
}

/** Use the native installer in a staging directory, then commit full skills and its lock together. */
export async function installLocalSkills(pkg: string, options: { update?: boolean; args?: string[]; run?: typeof runNpx; directory?: string } = {}) {
  if (typeof pkg !== "string" || !pkg.trim() || pkg.trim().startsWith("-") || pkg.length > 2048) throw new Error("A skill package or repository URL is required");
  const directory = resolve(options.directory ?? localModeSkillsDirectory());
  const release = await lockfile.lock(directory, { realpath: false, retries: 0 });
  let stage: string | undefined;
  const published: string[] = [];
  const backups: Array<{ target: string; backup: string }> = [];
  let committed = false;
  let cleanup = true;
  try {
    stage = mkdtempSync(join(dirname(directory), ".pi-skills-install-"));
    const args = options.args ?? ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
    if (args.includes("-g") || args.includes("--global")) throw new Error("Project skill installation cannot target a global directory");
    console.info("[skills/install] staging project skills", { package: pkg, directory });
    const result = await (options.run ?? runNpx)(["--yes", ...args, "--copy"], { timeout: 120_000, cwd: stage, env: { ...process.env, FORCE_COLOR: "0", DISABLE_TELEMETRY: "1" } });
    const stagedRoot = join(stage, ".pi", "skills");
    if (!existsSync(stagedRoot)) throw new Error("Installer did not produce Pi skill files");
    checkTree(stagedRoot);
    const loaded = loadSkillsFromDir({ dir: stagedRoot, source: "pi-own-install" });
    if (!loaded.skills.length || loaded.diagnostics.length) throw new Error(`Installed Skills failed validation: ${loaded.diagnostics.map((item) => item.message).join("; ") || "No valid SKILL.md"}`);
    const lockPath = join(stage, "skills-lock.json");
    if (!existsSync(lockPath)) throw new Error("Installer did not produce a project skills lock");
    const stagedLock = JSON.parse(readFileSync(lockPath, "utf8")) as Lock;
    const current = readLocalSkillLock(directory);
    const next: Lock = { version: 1, skills: { ...current.skills } };
    const moves = loaded.skills.map((skill) => {
      const source = dirname(skill.filePath);
      const folder = relative(stagedRoot, source);
      if (!folder || folder.startsWith(".") || folder.includes("/") || folder.includes("\\") || isAbsolute(folder)) throw new Error("Installer produced an unexpected skill folder");
      const entry = stagedLock.skills?.[skill.name];
      if (!entry || typeof entry.source !== "string" || typeof entry.sourceType !== "string" || typeof entry.computedHash !== "string") throw new Error(`Missing installation metadata for ${skill.name}`);
      const target = join(directory, folder);
      const previous = current.skills[skill.name];
      if (existsSync(target) && (!options.update || !previous || previous.source !== entry.source || previous.sourceType !== entry.sourceType)) throw new Error(`Skill already exists; use its Update action: ${folder}`);
      next.skills = { ...next.skills, [skill.name]: entry };
      return { source, target, name: skill.name };
    });
    const pendingLock = join(stage, "committed-lock.json");
    writeFileSync(pendingLock, JSON.stringify(next, null, 2) + "\n");
    for (const move of moves) {
      if (existsSync(move.target)) {
        const backup = join(stage, `backup-${randomUUID()}`);
        renameSync(move.target, backup);
        backups.push({ target: move.target, backup });
      }
      renameSync(move.source, move.target);
      published.push(move.target);
      if (!readFileSync(join(move.target, "SKILL.md"), "utf8").trim()) throw new Error(`Empty installed Skill: ${move.name}`);
    }
    renameSync(pendingLock, join(directory, LOCAL_SKILL_LOCK));
    committed = true;
    console.info("[skills/install] project skills committed", { package: pkg, directory, skills: moves.map((item) => item.name) });
    return { success: true, directory, skills: moves.map((item) => item.name), output: `${result.stdout}${result.stderr}`.replace(/\x1B\[[0-9;]*m/g, "").slice(-2000) };
  } catch (error) {
    try {
      if (!committed) {
        for (const path of published.reverse()) rmSync(path, { recursive: true, force: true });
        for (const { target, backup } of backups.reverse()) renameSync(backup, target);
      }
    } catch (rollbackError) {
      cleanup = false;
      throw new AggregateError([error, rollbackError], `Skill rollback failed; recovery files retained at ${stage}`);
    }
    console.error("[skills/install] project installation failed", { package: pkg, directory, error });
    throw error;
  } finally {
    // stage is a resolved, unique sibling of the configured library; never remove the library.
    try {
      if (stage && cleanup) {
        const parent = resolve(dirname(directory));
        if (dirname(resolve(stage)) !== parent || !stage.includes(".pi-skills-install-")) throw new Error("Unexpected installer staging path");
        rmSync(stage, { recursive: true, force: true });
      }
    } finally { await release(); }
  }
}
