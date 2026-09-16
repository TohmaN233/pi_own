import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { studyAgentPaths } from "./study-agent-launcher";

export async function studyEnvironmentWorkerScript() {
  for (const root of [resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.cwd()]) {
    try {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
      if (manifest.name !== "@agegr/pi-web") continue;
      const script = join(root, "runtime", "packages", "study-environment", "src", "study-environment-worker.mjs");
      await access(script);
      return script;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error("Packaged environment worker is missing; run the Study worker packaging step");
}

/** Queue claims fence installs; this ordinary-user process survives page and chat closure. */
export async function launchStudyEnvironmentWorker(projectId: string) {
  const entry = await studyEnvironmentWorkerScript();
  const paths = studyAgentPaths();
  const workerId = randomUUID();
  mkdirSync(paths.directory, { recursive: true });
  const log = openSync(join(paths.directory, "study-environment-worker.log"), "a");
  try {
    const child = spawn(process.execPath, [entry, "--project-id", projectId, "--worker-id", workerId], {
      cwd: dirname(entry), detached: true, windowsHide: true, stdio: ["ignore", log, log],
      env: { ...process.env, PI_LEARNING_HARNESS_DIR: paths.directory },
    });
    await new Promise<void>((ready, reject) => { child.once("spawn", ready); child.once("error", reject); });
    child.unref();
    return { requested: true, workerId };
  } finally { closeSync(log); }
}
