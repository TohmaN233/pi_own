import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function studyAgentPaths() {
  const directory = resolve(process.env.PI_LEARNING_HARNESS_DIR || join(getAgentDir(), "learning-harness"));
  return { directory, databasePath: join(directory, "learning-harness.sqlite"),
    sessionsDirectory: join(directory, "study-agent-sessions"), agentDir: getAgentDir() };
}

/** Resolve the installed pi-web worker before admitting a new model task. */
export async function studyAgentWorkerScript() {
  for (const root of [resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.cwd()]) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
      if (manifest.name !== "@agegr/pi-web") continue;
      const script = join(root, "runtime", "packages", "study-agent", "src", "study-agent-worker.mjs");
      await access(script);
      return script;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("Packaged Study reading worker is missing; run the Study worker packaging step");
}

/** The SQLite queue owns admission/concurrency; these ordinary-user workers only drain existing tasks. */
export async function launchStudyAgentWorker(projectId: string, script?: string) {
  const paths = studyAgentPaths();
  const entry = script ?? await studyAgentWorkerScript();
  mkdirSync(paths.directory, { recursive: true });
  const log = openSync(join(paths.directory, "study-agent-worker.log"), "a");
  try {
    const child = spawn(process.execPath, [entry, "--database", paths.databasePath, "--project", projectId, "--agent-dir", paths.agentDir], {
      cwd: dirname(entry), detached: true, windowsHide: true, stdio: ["ignore", log, log],
    });
    await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
    child.unref();
    return { requested: true };
  } finally { closeSync(log); }
}
