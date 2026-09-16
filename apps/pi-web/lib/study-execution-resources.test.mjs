import assert from "node:assert/strict";
import test from "node:test";
import { deriveStudyExecutionResources, validateStudyExecutionResources } from "./study-execution-resources.ts";

test("local limits reserve spare capacity and honor Windows CPU granularity", () => {
  const capacity = deriveStudyExecutionResources({ logicalCores: 128, availableMemoryMiB: 2048, totalMemoryMiB: 32768, availableDiskBytes: 1024 ** 3 });
  assert.equal(capacity.minimumCpuMilliCores, 1280);
  assert.equal(capacity.defaults.cpuMilliCores, 1280);
  assert.equal(capacity.maximum.memoryMiB, 1024);
  assert.equal(capacity.defaults.memoryMiB, 512);
  assert.throws(() => validateStudyExecutionResources({ ...capacity.defaults, cpuMilliCores: 1000 }, capacity), /cpuMilliCores/);
  assert.throws(() => validateStudyExecutionResources({ ...capacity.defaults, memoryMiB: 2048 }, capacity), /memoryMiB/);
  assert.throws(() => validateStudyExecutionResources({ ...capacity.defaults, wallTimeMs: NaN }, capacity), /wallTimeMs/);
  assert.throws(() => deriveStudyExecutionResources({ ...capacity.observed, availableMemoryMiB: 16 }), /Insufficient/);
  assert.throws(() => deriveStudyExecutionResources({ ...capacity.observed, logicalCores: 0 }), /capacity/);
});
