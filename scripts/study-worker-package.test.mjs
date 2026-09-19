import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { buildStudyWorker } from "./build-study-worker.mjs";

const execute = promisify(execFile);

test("packaged worker starts from an installed node_modules layout without tsx, repo paths, or project cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-installed-worker-"));
  try {
    const runtime = join(root, "node_modules", "@agegr", "pi-web", "runtime");
    await mkdir(join(runtime, "skills", "removed-skill"), { recursive: true });
    await writeFile(join(runtime, "skills", "removed-skill", "SKILL.md"), "obsolete");
    const { output } = await buildStudyWorker(runtime);
    await assert.rejects(access(join(runtime, "skills", "removed-skill", "SKILL.md")), { code: "ENOENT" });
    const manifest = JSON.parse(await readFile(resolve("apps/pi-web/package.json"), "utf8"));
    assert.ok(manifest.files.includes("runtime"));
    assert.equal((await readFile(join(dirname(output), "windows-runner.cs"), "utf8")).includes("Supervise"), true);
    assert.equal((await readFile(join(dirname(output), "r-appcontainer-launcher.c"), "utf8")).length > 100, true);
    const databasePath = join(root, "harness.sqlite");
    const harness = new LearningHarness({ databasePath });
    harness.studyExecution.configureTrustedPolicy({ maxConcurrentRuns: 1, maxCpuMilliCores: 1000, maxMemoryMiB: 512, leaseDurationMs: 10000 }, 0);
    harness.close();
    const unrelated = join(root, "unrelated-cwd"); await mkdir(unrelated);
    const env = { ...process.env }; delete env.PI_SKILLS_DIR; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = await execute(process.execPath, [output, "--database", databasePath, "--run-root", join(root, "runs"), "--artifact-dir", join(root, "observations")],
      { cwd: unrelated, env, timeout: 20000, windowsHide: true });
    const observation = JSON.parse(result.stdout);
    assert.ok(Number.isFinite(Date.parse(observation.observedAt)), "relocated worker must report a valid observation timestamp");
    assert.ok(Math.abs(Date.now() - Date.parse(observation.observedAt)) < 20000);
    assert.deepEqual(observation, { observedAt: observation.observedAt, claimedJobId: null, reconciledJobIds: [] });
    // Native Pi is a declared installed dependency of pi-web. Resolve it through the installed
    // package's node_modules, while the worker code itself remains fully relocated.
    await symlink(resolve("node_modules"), join(dirname(runtime), "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const agent = await execute(process.execPath, [join(runtime, "packages", "study-agent", "src", "study-agent-worker.mjs"),
      "--database", databasePath, "--project", "empty-project", "--agent-dir", join(root, "agent")], { cwd: unrelated, env, timeout: 20000, windowsHide: true });
    assert.match(agent.stdout, /worker drained/);
    assert.match(agent.stdout, /completed: 0, failed: 0/);
    const environment = await execute(process.execPath, [join(runtime, "packages", "study-environment", "src", "study-environment-worker.mjs"),
      "--project-id", "empty-project", "--worker-id", "00000000-0000-4000-8000-000000000001"], {
        cwd: unrelated, env: { ...env, PI_LEARNING_HARNESS_DIR: root }, timeout: 20000, windowsHide: true,
      });
    assert.match(environment.stdout, /completed: 0, failed: 0, unknown: 0/);
    const metadata = JSON.parse(await readFile(join(runtime, "study-worker-build.json"), "utf8"));
    assert.ok(metadata.environmentSourceFiles.length > 0);
    assert.ok(metadata.environmentSourceFiles.every((path) => !path.includes("rpc-manager") && !path.includes("study-research-service")), "environment drain must not load interactive sessions");
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/") + "study-installed-worker-"));
    await rm(root, { recursive: true, force: true });
  }
});
