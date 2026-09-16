import { randomUUID } from "node:crypto";
import { getLearningHarness } from "./harness-server";
import { activateGenericModePack, getGenericModePackStatus } from "./rpc-manager";
import { studyModePhase } from "./study-mode-policy";

/** Refresh the already selected phase through Pi's existing snapshot transaction. */
export async function ensureStudySessionRuntime(sessionId: string) {
  const harness = getLearningHarness();
  const member = harness.projectWorkspaces.members().find((entry) => entry.sessionId === sessionId);
  if (!member || harness.projectWorkspaces.get(member.projectId).courseProjectId) throw new Error("Study requires an independent project conversation");
  const status = await getGenericModePackStatus(sessionId);
  const snapshot = status.runtime.binding?.snapshot;
  if (!snapshot || !studyModePhase(snapshot.profileId)) throw new Error("Select Study or Research explicitly before opening this workspace");
  if (status.runtime.live && status.runtime.verified) return { sessionId, verified: true, snapshotId: snapshot.resourceSnapshotId };
  if (status.runtime.busy) throw new Error("Wait for the current Pi reply before refreshing Study resources");
  const activated = await activateGenericModePack({ sessionId, modePackId: snapshot.profileId,
    expectedSnapshotId: snapshot.resourceSnapshotId, idempotencyKey: randomUUID() });
  if (!activated.runtime.verified || activated.binding.snapshot.profileId !== snapshot.profileId) throw new Error("Study runtime refresh failed verification");
  return { sessionId, verified: true, snapshotId: activated.binding.snapshot.resourceSnapshotId };
}
