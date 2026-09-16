import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runTrustedCommand } from "../packages/study-execution-host/src/environment-package-changes.ts";

const root = resolve(".artifacts/study-research/environment-command");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

test("trusted installer timeout, output overflow and lease loss await the complete Windows tree", { skip: process.platform !== "win32", timeout: 45000 }, async () => {
  await mkdir(root, { recursive: true });
  const fixture = join(root, "nested-installer.mjs");
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const [directory, level, mode] = process.argv.slice(2);",
    "writeFileSync(join(directory, level+'.json'), JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));",
    "if(level==='0') writeFileSync(join(directory,'installer-mutated.json'), JSON.stringify({mutatedAt:new Date().toISOString()}));",
    "if(Number(level)<2) spawn(process.execPath,[process.argv[1],directory,String(Number(level)+1),mode],{stdio:'ignore',windowsHide:true});",
    "setInterval(()=>{if(level==='0'&&mode==='output'&&existsSync(join(directory,'2.json'))) process.stdout.write('x'.repeat(65536));},100);",
  ].join("\n"));
  const evidence = [];
  for (const mode of ["timeout", "output", "lease"]) {
    const directory = join(root, `${mode}-${Date.now()}`); await mkdir(directory);
    let leaseFailed = false;
    const registrations = [];
    await assert.rejects(runTrustedCommand(process.execPath, [fixture, directory, "0", mode], {}, () => {
      if (mode === "lease" && existsSync(join(directory, "2.json"))) { leaseFailed = true; throw new Error("fixture lease lost"); }
    }, { timeoutMs: mode === "timeout" ? 2000 : 10000, outputLimitBytes: mode === "output" ? 8192 : 1048576, heartbeatMs: 100 }, {
      supervisorDirectory: directory,
      onStarted(identity) {
        const registration = { ...identity, registeredAt: new Date().toISOString() };
        registrations.push(registration);
        writeFileSync(join(directory, "durable-registration.json"), JSON.stringify(registration));
      },
    }),
    (error) => error.code === ({timeout:"PACKAGE_COMMAND_TIMEOUT", output:"PACKAGE_COMMAND_OUTPUT_LIMIT", lease:"PACKAGE_WORKER_LEASE_FAILED"})[mode]);
    assert.equal(registrations.length, 1, `${mode} must register one supervisor before releasing the installer`);
    const mutation = JSON.parse(readFileSync(join(directory, "installer-mutated.json"), "utf8"));
    assert.ok(mutation.mutatedAt >= registrations[0].registeredAt, `${mode} installer mutated before durable registration`);
    const processes = [0,1,2].map((level) => JSON.parse(readFileSync(join(directory, `${level}.json`), "utf8")));
    for (const process of processes) {
      for (let retry = 0; retry < 30 && alive(process.pid); retry++) await delay(100);
      assert.equal(alive(process.pid), false, `${mode} retained descendant ${process.pid}`);
    }
    if (mode === "lease") assert.equal(leaseFailed, true);
    evidence.push({ mode, registrations, processes, allExited: true });
  }
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
});

test("a failed durable registration leaves the gated installer suspended and unmodified", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const directory = join(root, `registration-failure-${Date.now()}`); await mkdir(directory, { recursive: true });
  const fixture = join(directory, "would-mutate.mjs");
  await writeFile(fixture, [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.argv[2], 'mutated.json'), String(process.pid));",
    "setInterval(()=>{}, 1000);",
  ].join("\n"));
  await assert.rejects(
    runTrustedCommand(process.execPath, [fixture, directory], {}, undefined, { timeoutMs: 10000, outputLimitBytes: 1024, heartbeatMs: 100 }, {
      supervisorDirectory: directory,
      onStarted() { throw new Error("fixture durable store rejected registration"); },
    }),
    (error) => error.code === "PACKAGE_DURABLE_REGISTRATION_FAILED",
  );
  await delay(250);
  assert.equal(existsSync(join(directory, "mutated.json")), false, "installer ran even though durable registration failed");
});

test("a gated supervisor preserves the trusted command environment after durable registration", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const directory = join(root, `environment-propagation-${Date.now()}`); await mkdir(directory, { recursive: true });
  const registrations = [], exits = [];
  const result = await runTrustedCommand(
    process.execPath,
    ["--input-type=module", "--eval", "process.stdout.write(process.env.PI_ENVIRONMENT_SUPERVISOR_PROBE ?? 'missing')"],
    { PI_ENVIRONMENT_SUPERVISOR_PROBE: "gated-environment-propagated" },
    undefined,
    { timeoutMs: 10000, outputLimitBytes: 1024, heartbeatMs: 100 },
    {
      supervisorDirectory: directory,
      onStarted(identity) { registrations.push(identity); },
      onExited(identity) { exits.push(identity); },
    },
  );
  assert.equal(result.stdout, "gated-environment-propagated");
  assert.equal(registrations.length, 1, "the probe must cross a registered supervisor gate");
  assert.deepEqual(exits, registrations, "the registered supervisor must report its durable exit identity");
  await writeFile(join(directory, "environment-propagation-evidence.json"), JSON.stringify({ registrations, exits, stdout: result.stdout }, null, 2));
});

test("a worker crash after supervisor readiness but before durable registration never releases the installer", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const directory = join(root, `worker-crash-before-registration-${Date.now()}`); await mkdir(directory, { recursive: true });
  const installer = join(directory, "would-mutate.mjs");
  await writeFile(installer, [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.argv[2], 'mutated.json'), String(process.pid));",
  ].join("\n"));
  const commandModule = pathToFileURL(resolve("packages/study-execution-host/src/environment-package-changes.ts")).href;
  const worker = join(directory, "crashing-worker.mjs");
  await writeFile(worker, [
    `import { runTrustedCommand } from ${JSON.stringify(commandModule)};`,
    `void runTrustedCommand(process.execPath, [${JSON.stringify(installer)}, ${JSON.stringify(directory)}], {}, undefined, { timeoutMs: 1000, outputLimitBytes: 1024, heartbeatMs: 100 }, {`,
    `  supervisorDirectory: ${JSON.stringify(directory)},`,
    "  onStarted() { process.exit(17); },",
    "});",
  ].join("\n"));
  const crashed = spawn(process.execPath, [worker], { windowsHide: true, stdio: "ignore" });
  const exitCode = await new Promise((ready) => crashed.once("close", ready));
  assert.equal(exitCode, 17, "fixture worker must die at the pre-registration boundary");
  await delay(1500);
  assert.equal(existsSync(join(directory, "mutated.json")), false, "worker death released an installer that was not durably registered");
  assert.equal(existsSync(join(directory, "supervisor.ready.json")), true, "supervisor did not retain pre-release readiness evidence");
});
