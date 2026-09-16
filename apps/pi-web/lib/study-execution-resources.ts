import { cpus, freemem, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import type { ExecutionResourceRequest } from "../../../packages/study-execution-host/src/execution-queue.ts";
import { MAX_EXECUTION_OUTPUT_BYTES } from "../../../packages/study-execution-host/src/execution-payloads.ts";

const MIB = 1024 * 1024;

/** Read actual local capacity. Suggested limits are reservations, never an assertion that a job has started. */
export function studyExecutionResources(directory: string) {
  if (process.platform !== "win32") throw new Error("The current isolated execution adapter requires Windows");
  const disk = statfsSync(directory, { bigint: true });
  const availableDiskBytes = Number(disk.bavail * disk.bsize);
  const logicalCores = cpus().length;
  const availableMemoryMiB = Math.floor(freemem() / MIB);
  const totalMemoryMiB = Math.floor(totalmem() / MIB);
  return deriveStudyExecutionResources({ logicalCores, availableMemoryMiB, totalMemoryMiB, availableDiskBytes });
}

export function deriveStudyExecutionResources(observed: {
  logicalCores: number; availableMemoryMiB: number; totalMemoryMiB: number; availableDiskBytes: number;
}) {
  for (const [key, value] of Object.entries(observed)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Cannot establish local execution capacity: ${key}`);
  }
  // Windows Job CPU rate has 1% machine-wide granularity. Round the reservation up, enforcement down.
  const minimumCpuMilliCores = Math.ceil(observed.logicalCores * 10);
  const maxCpuMilliCores = Math.max(minimumCpuMilliCores, Math.floor(observed.logicalCores * 1000 / 2));
  const maxMemoryMiB = Math.min(1_048_576, Math.floor(Math.min(observed.availableMemoryMiB / 2, observed.totalMemoryMiB / 4)));
  const maxDiskBytes = Math.min(MAX_EXECUTION_OUTPUT_BYTES, Math.floor(observed.availableDiskBytes / 20));
  if (maxMemoryMiB < 64 || maxDiskBytes < MIB) throw new Error("Insufficient available memory or disk for an isolated learning example");
  const defaults: ExecutionResourceRequest = {
    cpuMilliCores: Math.min(maxCpuMilliCores, Math.max(minimumCpuMilliCores, 1000)),
    memoryMiB: Math.min(maxMemoryMiB, 512), wallTimeMs: 60_000, diskBytes: Math.min(maxDiskBytes, 16 * MIB),
  };
  return { observed, minimumCpuMilliCores, maximum: { cpuMilliCores: maxCpuMilliCores, memoryMiB: maxMemoryMiB,
    wallTimeMs: 3_600_000, diskBytes: maxDiskBytes }, defaults, initialConcurrentRuns: 1 as const };
}

export function validateStudyExecutionResources(request: ExecutionResourceRequest, capacity: ReturnType<typeof deriveStudyExecutionResources>) {
  for (const key of ["cpuMilliCores", "memoryMiB", "wallTimeMs", "diskBytes"] as const) {
    const minimum = key === "cpuMilliCores" ? capacity.minimumCpuMilliCores : key === "memoryMiB" ? 64 : key === "wallTimeMs" ? 1000 : 1024 * 1024;
    if (!Number.isSafeInteger(request[key]) || request[key] < minimum || request[key] > capacity.maximum[key]) {
      throw new Error(`${key} must be ${minimum}..${capacity.maximum[key]} for current local capacity`);
    }
  }
  return { cpuMilliCores: request.cpuMilliCores, memoryMiB: request.memoryMiB, wallTimeMs: request.wallTimeMs, diskBytes: request.diskBytes };
}
