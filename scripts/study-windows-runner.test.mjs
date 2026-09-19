import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const checks = String.raw`
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { resolve, join } from "node:path";
import {
  cancelIsolatedWindowsRun,
  getIsolatedWindowsRunStatus,
  launchPreparedIsolatedWindowsRun,
  prepareIsolatedWindowsRun,
  reconcileIsolatedWindowsRun,
  startIsolatedWindowsRun,
} from "./packages/study-execution-host/src/windows-runner.ts";
import { detectStudyPlatform } from "./packages/study-execution-host/src/platform.ts";

const root = resolve(".artifacts/study-research/windows-runner/tests");
const source = join(root, "source");
await rm(root, {recursive:true, force:true});
await mkdir(source, {recursive:true});
const nodeExecutable = process.execPath;
const platform = detectStudyPlatform(process.cwd());
const pythonExecutable = platform.executables.python.executablePath;
const rscriptExecutable = platform.executables.rscript.executablePath;
assert.ok(pythonExecutable, "Python is required for the Windows runner integration test");
assert.ok(rscriptExecutable, "Rscript is required for the Windows runner integration test");
for (const executable of [nodeExecutable, pythonExecutable, rscriptExecutable]) await stat(executable);

const sentinelPath = join(source, "synthetic-credential-sentinel.txt");
await writeFile(sentinelPath, "synthetic-secret", "utf8");
let acceptedNetworkConnections = 0;
const networkServer = net.createServer((socket) => { acceptedNetworkConnections += 1; socket.destroy(); });
await new Promise((resolve, reject) => {
  networkServer.once("error", reject);
  networkServer.listen(0, "127.0.0.1", resolve);
});
const networkAddress = networkServer.address();
if (networkAddress === null || typeof networkAddress === "string") throw new Error("network fixture did not expose a TCP port");
const nodeProgram = join(source, "node-boundary.mjs");
await writeFile(nodeProgram, [
  "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
  "import net from 'node:net';",
  "import { fileURLToPath } from 'node:url';",
  "import { join } from 'node:path';",
  "const sentinel = " + JSON.stringify(sentinelPath) + ";",
  "async function attempt(label, action) { try { await action(); console.log(label + ':allowed'); } catch (error) { console.log(label + ':denied:' + (error.code || error.name)); } }",
  "await attempt('sentinel-read', async () => { await readFile(sentinel, 'utf8'); });",
  "await attempt('sentinel-write', async () => { await writeFile(sentinel, 'changed', 'utf8'); });",
  "await attempt('input-write', async () => { await writeFile(fileURLToPath(import.meta.url), 'changed', 'utf8'); });",
  "await attempt('output-write', async () => { await writeFile(join(process.cwd(), 'worker-output.txt'), 'owned-output', 'utf8'); });",
  "await attempt('output-mkdir', async () => { await mkdir(join(process.cwd(), 'worker-output-directory')); });",
  "await attempt('control-forge', async () => { await writeFile(join(process.cwd(), '..', 'control', 'forged.json'), 'forged', 'utf8'); });",
  "console.log('secret:' + (process.env.STUDY_SYNTHETIC_SECRET || 'absent'));",
  "await new Promise((resolve) => { const socket = net.connect(" + networkAddress.port + ", '127.0.0.1'); const done = (value) => { console.log(value); socket.destroy(); resolve(); }; const timer = setTimeout(() => done('network:denied:timeout'), 750); socket.once('connect', () => { clearTimeout(timer); done('network:connected'); }); socket.once('error', (error) => { clearTimeout(timer); done('network:denied:' + (error.code || error.name)); }); });",
  "console.log('node-result:' + (2 + 2));",
].join("\n") + "\n", "utf8");

async function terminal(handle, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await getIsolatedWindowsRunStatus(handle);
    if (!["launching", "running"].includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("terminal runner receipt was not published: " + JSON.stringify(latest));
}
async function running(handle, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await getIsolatedWindowsRunStatus(handle);
    if (latest.status === "running") return latest;
    if (!["launching", "running"].includes(latest.status)) throw new Error("runner stopped before running: " + JSON.stringify(latest));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runner did not reach running: " + JSON.stringify(latest));
}
async function log(handle, name) {
  return readFile(join(handle.outputDirectory, name), "utf8");
}

const originalSecret = process.env.STUDY_SYNTHETIC_SECRET;
process.env.STUDY_SYNTHETIC_SECRET = "must-not-cross-runner-boundary";
let nodeStatus = null;
try {
  const nodeRun = await prepareIsolatedWindowsRun({
    runRootDirectory: root,
    language: "node",
    executablePath: nodeExecutable,
    programPath: nodeProgram,
    limits: {memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 5_000, outputLimitBytes: 16 * 1024},
  });
  const initialLaunch = await launchPreparedIsolatedWindowsRun(nodeRun);
  assert.equal(initialLaunch.status, "launching");
  assert.ok(["launching", "running"].includes((await launchPreparedIsolatedWindowsRun(nodeRun)).status));
  nodeStatus = await terminal(nodeRun);
  assert.equal(nodeStatus.status, "succeeded", nodeStatus.error);
  assert.equal(nodeStatus.appContainerCleanup, "workspace-deleted;profile-deleted");
  const nodeStdout = await log(nodeRun, "stdout.log");
  for (const label of ["sentinel-read", "sentinel-write", "input-write", "control-forge"]) {
    assert.match(nodeStdout, new RegExp(label + ":denied:"), nodeStdout);
  }
  assert.match(nodeStdout, /output-write:allowed/u, nodeStdout);
  assert.match(nodeStdout, /output-mkdir:allowed/u, nodeStdout);
  assert.match(nodeStdout, /secret:absent/u);
  assert.match(nodeStdout, /network:denied:/u);
  assert.doesNotMatch(nodeStdout, /network:connected/u);
  assert.equal(acceptedNetworkConnections, 0, nodeStdout);
  assert.match(nodeStdout, /node-result:4/u);
  assert.equal(await readFile(sentinelPath, "utf8"), "synthetic-secret");
  assert.match(await readFile(nodeProgram, "utf8"), /node-result/u);
  const finalReceipt = JSON.parse(await readFile(join(nodeRun.controlDirectory, "status.json"), "utf8"));
  assert.equal(finalReceipt.ConfigBindingHash, nodeRun.configBindingHash);
  await assert.rejects(stat(join(nodeRun.controlDirectory, "forged.json")));
} finally {
  await new Promise((resolve, reject) => networkServer.close((error) => error ? reject(error) : resolve()));
  if (originalSecret === undefined) delete process.env.STUDY_SYNTHETIC_SECRET;
  else process.env.STUDY_SYNTHETIC_SECRET = originalSecret;
}

const pythonProgram = join(source, "python-smoke.py");
await writeFile(pythonProgram, "print('python-result:' + str(2 + 2))\n", "utf8");
const pythonRun = await startIsolatedWindowsRun({
  runRootDirectory: root,
  language: "python",
  executablePath: pythonExecutable,
  programPath: pythonProgram,
  limits: {memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 5_000, outputLimitBytes: 16 * 1024},
});
assert.equal((await terminal(pythonRun)).status, "succeeded");
assert.match(await log(pythonRun, "stdout.log"), /python-result:4/u);

const rProgram = join(source, "r-smoke.R");
await writeFile(rProgram, "cat('r-result:', 2 + 2, '\\n')\n", "utf8");
const rRun = await startIsolatedWindowsRun({
  runRootDirectory: root,
  language: "rscript",
  executablePath: rscriptExecutable,
  programPath: rProgram,
  limits: {memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 7_000, outputLimitBytes: 16 * 1024},
});
const rStatus = await terminal(rRun, 140_000);
assert.equal(rStatus.status, "succeeded", rStatus.error);
assert.match(await log(rRun, "stdout.log"), /r-result:\s*4/u);
const rCompatibility = JSON.parse(await log(rRun, "r-compatibility.json"));
assert.equal(rCompatibility.mode, "r-4.5.1-appcontainer-nt-volume-iat");
assert.equal(rCompatibility.iatPatched, true);
assert.equal(rCompatibility.initialized, true);
assert.equal(rCompatibility.evaluated, true);
assert.equal(rCompatibility.evaluationError, false);
assert.ok(Number.isSafeInteger(rCompatibility.hookCalls) && rCompatibility.hookCalls > 0, JSON.stringify(rCompatibility));

const childProgram = join(source, "child-and-wait.mjs");
await writeFile(childProgram, [
  "import { spawn } from 'node:child_process';",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});",
  "console.log('child-pid:' + child.pid);",
  "setInterval(() => {}, 1000);",
].join("\n") + "\n", "utf8");
const childRun = await startIsolatedWindowsRun({
  runRootDirectory: root,
  language: "node",
  executablePath: nodeExecutable,
  programPath: childProgram,
  limits: {memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 10_000, outputLimitBytes: 16 * 1024},
});
let childStatus = await running(childRun);
let childStdout = "";
for (let attempt = 0; attempt < 30 && !/child-pid:\d+/u.test(childStdout); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  childStdout = await log(childRun, "stdout.log");
}
const childPid = Number(/child-pid:(\d+)/u.exec(childStdout)?.[1]);
assert.ok(Number.isSafeInteger(childPid) && childPid > 0, childStdout);
const wrongCancel = spawnSync(childRun.helperPath, ["--cancel", childRun.controlDirectory, "wrong-token"], {windowsHide:true});
assert.equal(wrongCancel.status, 3);
assert.equal((await cancelIsolatedWindowsRun(childRun)).status, "cancelled");
await new Promise((resolve) => setTimeout(resolve, 100));
assert.throws(() => process.kill(childPid, 0));

const timeoutProgram = join(source, "timeout-child.mjs");
await writeFile(timeoutProgram, [
  "import { spawn } from 'node:child_process';",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});",
  "console.log('timeout-child-pid:' + child.pid);",
  "setInterval(() => {}, 1000);",
].join("\n") + "\n", "utf8");
const timeoutRun = await startIsolatedWindowsRun({
  runRootDirectory: root,
  language: "node",
  executablePath: nodeExecutable,
  programPath: timeoutProgram,
  limits: {memoryBytes: 256 * 1024 * 1024, cpuRatePercent: 1, wallTimeMs: 400, outputLimitBytes: 16 * 1024},
});
assert.equal((await terminal(timeoutRun)).status, "limit-reached");

const memoryProgram = join(source, "memory-limit.mjs");
await writeFile(memoryProgram, [
  "const blocks = [];",
  "for (let index = 0; index < 64; index += 1) blocks.push(Buffer.alloc(8 * 1024 * 1024, 1));",
  "console.log('memory-limit-bypassed');",
].join("\n") + "\n", "utf8");
const memoryRun = await startIsolatedWindowsRun({
  runRootDirectory: root,
  language: "node",
  executablePath: nodeExecutable,
  programPath: memoryProgram,
  limits: {memoryBytes: 128 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 8_000, outputLimitBytes: 16 * 1024},
});
const memoryStatus = await terminal(memoryRun);
assert.notEqual(memoryStatus.status, "succeeded");
assert.doesNotMatch(await log(memoryRun, "stdout.log"), /memory-limit-bypassed/u);

const parentProgram = join(source, "parent-survival.mjs");
await writeFile(parentProgram, "setInterval(() => {}, 1000)\n", "utf8");
const launcher = [
  "import { writeFile } from 'node:fs/promises';",
  "import { startIsolatedWindowsRun } from './packages/study-execution-host/src/windows-runner.ts';",
  "const handle = await startIsolatedWindowsRun({",
  "runRootDirectory:" + JSON.stringify(root) + ",",
  "language:'node',",
  "executablePath:" + JSON.stringify(nodeExecutable) + ",",
  "programPath:" + JSON.stringify(parentProgram) + ",",
  "limits:{memoryBytes:268435456,cpuRatePercent:25,wallTimeMs:10000,outputLimitBytes:16384},",
  "});",
  "await writeFile(" + JSON.stringify(join(root, "parent-handoff.json")) + ", JSON.stringify(handle), 'utf8');",
].join("\n");
execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", launcher], {cwd:process.cwd(), stdio:"pipe"});
const parentHandle = JSON.parse(await readFile(join(root, "parent-handoff.json"), "utf8"));
const reattached = await running(parentHandle);
assert.equal(reattached.runId, parentHandle.runId);
assert.equal(reattached.status, "running");
assert.equal((await cancelIsolatedWindowsRun(parentHandle)).status, "cancelled");

const evidence = {
  nodeStatus,
  pythonStatus: await getIsolatedWindowsRunStatus(pythonRun),
  rStatus,
  childStatus: await getIsolatedWindowsRunStatus(childRun),
  timeoutStatus: await getIsolatedWindowsRunStatus(timeoutRun),
  memoryStatus,
  parentStatus: await getIsolatedWindowsRunStatus(parentHandle),
};
await writeFile(join(root, "latest-test-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(JSON.stringify(evidence, null, 2));
`;

test("Windows runner enforces observed AppContainer, Job Object, and detached-supervisor boundaries", { skip: process.platform !== "win32" }, () => {
	const output = execFileSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "--eval", checks],
		{
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
			stdio: "pipe",
			timeout: 180_000,
		},
	);
	assert.match(output, /"nodeStatus"/u);
	process.stdout.write(output);
});
