import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const platformChecks = String.raw`
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  detectStudyPlatform,
  classifyStudyPythonEnvironment,
  probeWindowsExecutionCapabilities,
  suggestStudyResources,
} from "./packages/study-execution-host/src/index.ts";

const report = detectStudyPlatform(process.cwd());
assert.equal(report.operatingSystem.platform, "win32");
assert.equal(report.executables.node.capability.status, "available");
assert.ok(report.executables.node.executablePath);
assert.ok(Number.isSafeInteger(report.resources.cpu.logicalCores));
assert.ok(report.resources.cpu.logicalCores > 0);
assert.ok(Number.isSafeInteger(report.resources.memory.totalBytes));
assert.ok(report.resources.memory.totalBytes > 0);
for (const executable of [report.executables.python, report.executables.rscript]) {
  if (executable.capability.status !== "available") {
    assert.ok(executable.diagnostics.length > 0, executable.name + " must expose its discovery failure.");
  }
}
assert.equal(report.executables.rscript.capability.status, "available", report.executables.rscript.capability.detail);
assert.match(report.executables.rscript.executablePath, /\\Program Files\\R\\/u);
assert.ok(report.executables.rscript.rLibraryPaths?.length > 0);
if (report.resources.disk.capability.status === "available") {
  assert.ok(report.resources.disk.totalBytes > 0);
  assert.ok(report.resources.disk.availableBytes >= 0);
}

const suggestion = suggestStudyResources(report);
assert.equal(suggestion.initialConcurrentRuns, 1);
assert.equal(suggestion.taskCpuLimit, null);
assert.equal(suggestion.taskMemoryLimitBytes, null);
assert.equal(suggestion.taskWallTimeLimitMs, null);
assert.equal(suggestion.gpuScheduling, "disabled-until-hard-limit-is-verified");
assert.equal(suggestion.requiresAdmissionBeforeIncrease, true);

const probe = await probeWindowsExecutionCapabilities({
  artifactDirectory: resolve(process.cwd(), ".artifacts/study-research/p0-platform/tests"),
});
assert.equal(probe.backgroundProcessSurvival.status, "available", probe.backgroundProcessSurvival.detail);
assert.equal(probe.processTreeCancellation.status, "available", probe.processTreeCancellation.detail);
assert.equal(probe.controllerWallTimeCancellation.status, "available", probe.controllerWallTimeCancellation.detail);
assert.equal(probe.hardCpuLimit.status, "unavailable");
assert.equal(probe.hardMemoryLimit.status, "unavailable");
assert.equal(probe.hardWallTimeLimit.status, "unavailable");
assert.equal(probe.fileSystemIsolation.status, "unavailable");
assert.deepEqual(probe.processes.survivingPidsAfterCancellation, []);
assert.ok(probe.artifactDirectory);
const persisted = JSON.parse(await readFile(resolve(probe.artifactDirectory, "execution-probe.json"), "utf8"));
assert.equal(persisted.processTreeCancellation.status, "available");
assert.deepEqual(persisted.processes.survivingPidsAfterCancellation, []);

const observation = {
  platform: report,
  resourceSuggestion: suggestion,
  probe,
};
const observationPath = resolve(process.cwd(), ".artifacts/study-research/p0-platform/latest-platform-observation.json");
await writeFile(observationPath, JSON.stringify(observation, null, 2) + "\n", "utf8");
const persistedObservation = JSON.parse(await readFile(observationPath, "utf8"));
assert.equal(persistedObservation.probe.processTreeCancellation.status, "available");
assert.ok(persistedObservation.platform.operatingSystem.release);
assert.ok(persistedObservation.platform.detectedAt);
for (const adapter of report.resources.gpu.adapters) {
  if (adapter.memorySource === "unavailable") assert.equal(adapter.adapterMemoryBytes, null);
  else assert.ok(adapter.adapterMemoryBytes > 0);
}
const base = resolve("C:/python");
const intended = resolve("C:/work/.venv");
const other = resolve("C:/other/.venv");
const cases = [
  {prefix:base, basePrefix:base, conda:false, expected:null, kind:"base", owned:false},
  {prefix:other, basePrefix:base, conda:false, expected:intended, kind:"venv", owned:false},
  {prefix:intended, basePrefix:base, conda:false, expected:intended, kind:"venv", owned:true},
  {prefix:intended, basePrefix:intended, conda:true, expected:intended, kind:"conda", owned:true},
];
for (const item of cases) {
  const result = classifyStudyPythonEnvironment({prefix:item.prefix, basePrefix:item.basePrefix, executablePath:resolve(item.prefix,"python.exe"), intendedProjectEnvironment:item.expected, condaMetadataPresent:item.conda});
  assert.equal(result.kind,item.kind);
  assert.equal(result.isProjectEnvironment,item.owned);
}
console.log(JSON.stringify(observation, null, 2));
`;

test("Study execution platform reports observed Windows capabilities and does not claim unverified isolation", { skip: process.platform !== "win32" }, () => {
	const output = execFileSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "--eval", platformChecks],
		{
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
			stdio: "pipe",
		},
	);
	assert.match(output, /"processTreeCancellation"/u);
	process.stdout.write(output);
});
