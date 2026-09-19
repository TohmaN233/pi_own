import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const checks = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import net from "node:net";
import {
  abandonPreparedIsolatedWindowsRun,
  cancelIsolatedWindowsRun,
  getIsolatedWindowsRunStatus,
  launchPreparedIsolatedWindowsRun,
  prepareIsolatedWindowsRun,
  startIsolatedWindowsRun,
} from "./packages/study-execution-host/src/windows-runner.ts";

const root = resolve(".artifacts/study-research/r-appcontainer/test-runs");
const source = join(root, "source");
const rscriptExecutable = "C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe";
await rm(root, { recursive: true, force: true });
await mkdir(source, { recursive: true });
await stat(rscriptExecutable);

async function terminal(handle, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await getIsolatedWindowsRunStatus(handle);
    if (!['launching', 'running'].includes(latest.status)) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("R runner did not publish a terminal receipt: " + JSON.stringify(latest));
}

async function running(handle, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await getIsolatedWindowsRunStatus(handle);
    if (latest.status === 'running') return latest;
    if (!['launching', 'running'].includes(latest.status)) throw new Error("R runner stopped before running: " + JSON.stringify(latest));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("R runner did not reach running: " + JSON.stringify(latest));
}

function jsonString(value) {
  return JSON.stringify(value);
}

async function totalHarvestedBytes(outputDirectory) {
  const names = ["stdout.log", "stderr.log", "stats-plot.png", "stats-plot.pdf", "output-allowed.txt", "r-compatibility.json"];
  let total = 0;
  for (const name of names) total += (await stat(join(outputDirectory, name))).size;
  return total;
}

const sentinelPath = join(source, "synthetic-g-source-sentinel.txt");
await writeFile(sentinelPath, "synthetic-secret", "utf8");
let acceptedNetworkConnections = 0;
const networkServer = net.createServer((socket) => { acceptedNetworkConnections += 1; socket.destroy(); });
await new Promise((resolvePromise, reject) => {
  networkServer.once("error", reject);
  networkServer.listen(0, "127.0.0.1", resolvePromise);
});
const networkAddress = networkServer.address();
if (networkAddress === null || typeof networkAddress === "string") throw new Error("network fixture did not expose a TCP port");

const statsProgram = join(source, "r-stats-and-boundary.R");
await writeFile(statsProgram, [
  "library(stats)",
  "x <- c(1, 2, 3, 4)",
  "fit <- lm(x ~ c(1, 2, 3, 4))",
  "stopifnot(mean(x) == 2.5, abs(var(x) - 1.6666666667) < 1e-9, abs(coef(fit)[2] - 1) < 1e-9, abs(pnorm(0) - 0.5) < 1e-12)",
  "set.seed(17); first <- runif(1); set.seed(17); stopifnot(identical(first, runif(1)))",
  "program <- Sys.getenv('R_COMPAT_PROGRAM')",
  "stopifnot(file.exists(program), file.exists(R.home()), file.exists(getwd()))",
  "cat('norm-runtime:', normalizePath(R.home(), mustWork=TRUE), '\\n')",
  "cat('norm-input:', normalizePath(program, mustWork=TRUE), '\\n')",
  "cat('norm-output:', normalizePath(getwd(), mustWork=TRUE), '\\n')",
  "missing <- tryCatch({ normalizePath(file.path(getwd(), 'missing'), mustWork=TRUE); FALSE }, error=function(error) TRUE)",
  "stopifnot(missing)",
  "assert_denied <- function(label, action) { denied <- tryCatch({ force(action); FALSE }, error=function(error) TRUE); cat(label, if (denied) ':denied\\n' else ':allowed\\n', sep=''); if (!denied) stop(label, ' unexpectedly allowed') }",
  "assert_denied('sentinel-read', readLines(" + jsonString(sentinelPath) + ", warn=FALSE))",
  "assert_denied('sentinel-write', writeLines('changed', " + jsonString(sentinelPath) + "))",
  "assert_denied('input-write', writeLines('changed', program))",
  "assert_denied('control-forge', writeLines('forged', " + jsonString(join(root, "forged-control.json")) + "))",
  "assert_denied('network', { connection <- socketConnection('127.0.0.1', port=" + networkAddress.port + ", blocking=TRUE, timeout=1, open='r+'); close(connection) })",
  "writeLines('owned-output', file.path(getwd(), 'output-allowed.txt'))",
  "png(file.path(getwd(), 'stats-plot.png'), width=320, height=240); plot(x); dev.off()",
  "pdf(file.path(getwd(), 'stats-plot.pdf'), width=4, height=3); plot(x); dev.off()",
  "cat('r-stats-result:ok\\n')",
].join("\n") + "\n", "utf8");

let statsRun;
try {
  statsRun = await startIsolatedWindowsRun({
    runRootDirectory: root,
    language: "rscript",
    executablePath: rscriptExecutable,
    programPath: statsProgram,
    limits: { memoryBytes: 512 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 30_000, outputLimitBytes: 256 * 1024 },
  });
  const statsStatus = await terminal(statsRun);
  assert.equal(statsStatus.status, "succeeded", statsStatus.error);
  assert.ok(statsStatus.wallTimeMs > 0, JSON.stringify(statsStatus));
  assert.equal(statsStatus.appContainerCleanup, "workspace-deleted;profile-deleted");
  assert.equal(await readFile(sentinelPath, "utf8"), "synthetic-secret");
  await assert.rejects(stat(join(root, "forged-control.json")));
  const stdout = await readFile(join(statsRun.outputDirectory, "stdout.log"), "utf8");
  for (const label of ["sentinel-read", "sentinel-write", "input-write", "control-forge", "network"]) assert.match(stdout, new RegExp(label + ":denied"), stdout);
  assert.match(stdout, /r-stats-result:ok/u, stdout);
  assert.equal(acceptedNetworkConnections, 0, stdout);
  for (const name of ["stats-plot.png", "stats-plot.pdf", "output-allowed.txt"]) assert.ok((await stat(join(statsRun.outputDirectory, name))).size > 0, name);
  const attestation = JSON.parse(await readFile(join(statsRun.outputDirectory, "r-compatibility.json"), "utf8"));
  const config = JSON.parse(await readFile(join(statsRun.controlDirectory, "config.json"), "utf8"));
  assert.equal(attestation.mode, "r-4.5.1-appcontainer-nt-volume-iat");
  assert.equal(attestation.adapterSha256, config.CompatibilityAdapterHash);
  assert.equal(attestation.rDllSha256, config.CompatibilityRDllHash);
  assert.equal(attestation.iatPatched, true);
  assert.ok(attestation.hookCalls > 0, JSON.stringify(attestation));
  assert.equal(attestation.initialized, true);
  assert.equal(attestation.evaluated, true);
  assert.equal(attestation.evaluationError, false);
  assert.equal(statsStatus.outputFiles, 6);
  assert.equal(statsStatus.outputBytes, await totalHarvestedBytes(statsRun.outputDirectory));
  assert.ok(statsStatus.outputBytes <= 256 * 1024);
  assert.equal(config.CompatibilityAdapterHash, createHash("sha256").update(await readFile(config.CompatibilityAdapterPath)).digest("hex"));
  assert.equal(config.CompatibilityRDllHash, createHash("sha256").update(await readFile(config.CompatibilityRDllPath)).digest("hex"));

  const prepared = await prepareIsolatedWindowsRun({
    runRootDirectory: root,
    language: "rscript",
    executablePath: rscriptExecutable,
    programPath: statsProgram,
    limits: { memoryBytes: 512 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 30_000, outputLimitBytes: 256 * 1024 },
  });
  const abandonedStatus = await abandonPreparedIsolatedWindowsRun(prepared);
  assert.equal(abandonedStatus.status, "cancelled", JSON.stringify(abandonedStatus));
  assert.equal(abandonedStatus.wallTimeMs, 0);
  assert.ok(abandonedStatus.preparedCleanup !== null, JSON.stringify(abandonedStatus));
  assert.ok(abandonedStatus.preparedCleanup.runtimeFiles > 0);
  assert.ok(abandonedStatus.preparedCleanup.runtimeBytes > 0);
  await stat(prepared.controlDirectory);
  await assert.rejects(stat(join(prepared.runDirectory, "runtime")));
  await assert.rejects(stat(join(prepared.runDirectory, "input")));

  const raceProgram = join(source, "claim-race.mjs");
  await writeFile(raceProgram, "setTimeout(() => process.exit(0), 400)\n", "utf8");
  const raceHandle = await prepareIsolatedWindowsRun({
    runRootDirectory: root,
    language: "node",
    executablePath: process.execPath,
    programPath: raceProgram,
    limits: { memoryBytes: 128 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 5_000, outputLimitBytes: 16 * 1024 },
  });
  const raceResults = await Promise.allSettled([
    launchPreparedIsolatedWindowsRun(raceHandle),
    abandonPreparedIsolatedWindowsRun(raceHandle),
  ]);
  const abandonedRace = raceResults.find((result) => result.status === "fulfilled" && result.value.status === "cancelled");
  if (abandonedRace) {
    assert.equal((await terminal(raceHandle)).status, "cancelled");
  } else {
    assert.ok(raceResults.some((result) => result.status === "rejected"), JSON.stringify(raceResults));
    assert.equal((await terminal(raceHandle)).status, "succeeded");
  }

  const endlessProgram = join(source, "node-endless.mjs");
  await writeFile(endlessProgram, "setInterval(() => {}, 1000)\n", "utf8");
  const timeoutRun = await startIsolatedWindowsRun({
    runRootDirectory: root,
    language: "node",
    executablePath: process.execPath,
    programPath: endlessProgram,
    limits: { memoryBytes: 128 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 750, outputLimitBytes: 16 * 1024 },
  });
  const timeoutStatus = await terminal(timeoutRun);
  assert.equal(timeoutStatus.status, "limit-reached", JSON.stringify(timeoutStatus));
  assert.ok(timeoutStatus.wallTimeMs >= 700, JSON.stringify(timeoutStatus));

  const cancelRun = await startIsolatedWindowsRun({
    runRootDirectory: root,
    language: "node",
    executablePath: process.execPath,
    programPath: endlessProgram,
    limits: { memoryBytes: 128 * 1024 * 1024, cpuRatePercent: 25, wallTimeMs: 15_000, outputLimitBytes: 16 * 1024 },
  });
  await running(cancelRun);
  const cancelledStatus = await cancelIsolatedWindowsRun(cancelRun);
  assert.equal(cancelledStatus.status, "cancelled", JSON.stringify(cancelledStatus));
  assert.ok(cancelledStatus.wallTimeMs >= 0, JSON.stringify(cancelledStatus));

  const evidence = {
    rCompatibility: {
      rscriptExecutable,
      snapshotAdapterPath: config.CompatibilityAdapterPath,
      snapshotAdapterSha256: config.CompatibilityAdapterHash,
      snapshotRDllPath: config.CompatibilityRDllPath,
      snapshotRDllSha256: config.CompatibilityRDllHash,
      mode: attestation.mode,
      hookCalls: attestation.hookCalls,
    },
    boundaries: {
      sentinelRead: "denied",
      sentinelWrite: "denied",
      inputWrite: "denied",
      controlForge: "denied",
      loopbackNetwork: "denied",
      outputWrite: "allowed",
    },
    statsStatus,
    preparedAbandonStatus: abandonedStatus,
    preparedRace: raceResults.map((result) => result.status),
    timeoutStatus,
    cancelledStatus,
    statsOutputDirectory: statsRun.outputDirectory,
  };
  await writeFile(join(root, "latest-evidence.json"), JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await new Promise((resolvePromise, reject) => networkServer.close((error) => error ? reject(error) : resolvePromise()));
}
`;

test("R 4.5.1 runs inside the AppContainer with an attested path adapter", { skip: process.platform !== "win32" }, () => {
	const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", checks], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
		stdio: "pipe",
		timeout: 240_000,
	});
	assert.match(output, /"statsStatus"/u);
	process.stdout.write(output);
});
