import { join } from "node:path";
import type { LearningHarness } from "../../../packages/learning-harness/src/index.ts";
import { EnvironmentPackageChangeError, executeEnvironmentPackagePlan } from "../../../packages/study-execution-host/src/environment-package-changes.ts";

/** Drains durable operations without importing the interactive Pi session lifecycle. */
export async function runStudyEnvironmentWorker(harness: LearningHarness, input: { projectId: string; workerId: string }) {
  let completed = 0;
  let failed = 0;
  let unknown = 0;
  let needsInput = 0;
  while (true) {
    const claim = harness.claimEnvironmentPackageOperation(input.projectId, input.workerId);
    if (!claim) {
      const state = harness.environmentPackageDrainState(input.projectId);
      if (state.queued === 0) break;
      // An unknown environment blocks only its own key. Keep draining a later
      // runnable environment and report the reconciliation need after it is done.
      if (state.needsInput > 0 && state.runnable === 0) { needsInput = state.needsInput; break; }
      await new Promise((ready) => setTimeout(ready, 2000));
      continue;
    }
    const workDirectory = join(claim.plan.plan.projectDirectory, ".study-environment-package-operations", claim.operation.operationId);
    try {
      harness.renewEnvironmentPackageOperationLease({ projectId: input.projectId, operationId: claim.operation.operationId, workerId: input.workerId });
      const result = await executeEnvironmentPackagePlan({ plan: claim.plan.plan, workDirectory,
        onProgress: () => harness.renewEnvironmentPackageOperationLease({ projectId: input.projectId, operationId: claim.operation.operationId, workerId: input.workerId }),
        onInstallerStarted: (installer) => harness.recordEnvironmentPackageInstallerStarted({
          projectId: input.projectId, operationId: claim.operation.operationId, workerId: input.workerId, installer,
        }),
        onInstallerExited: (installer) => harness.recordEnvironmentPackageInstallerExited({
          projectId: input.projectId, operationId: claim.operation.operationId, workerId: input.workerId, installer,
        }),
      });
      harness.finishEnvironmentPackageOperation({ projectId: input.projectId, operationId: claim.operation.operationId, workerId: input.workerId, result });
      completed++;
      console.info("[study-environment] package operation validated", { projectId: input.projectId, operationId: claim.operation.operationId, installed: result.installed.length });
    } catch (error) {
      const status = error instanceof EnvironmentPackageChangeError && ["PACKAGE_INVENTORY_STALE", "PACKAGE_PLAN_INVALID", "PACKAGE_PLAN_TAMPERED"].includes(error.code) ? "failed" : "unknown";
      harness.failEnvironmentPackageOperation({ projectId: input.projectId, operationId: claim.operation.operationId, workerId: input.workerId, status, diagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
      if (status === "failed") failed++; else unknown++;
      console.error("[study-environment] package operation did not reach validated final inventory", { projectId: input.projectId, operationId: claim.operation.operationId, status, error });
    }
  }
  return { completed, failed, unknown, needsInput };
}
