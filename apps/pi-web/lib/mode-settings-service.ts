import { SessionManager } from "@earendil-works/pi-coding-agent";
import { localModeSkillsDirectory, modeSystemPrompt } from "../../../packages/profile-resource-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { inspectModePackInventory, buildModePackRuntimePlanFromInventory, collectModePackRuntimeEvidence } from "./mode-pack-inventory";
import { getGenericModePackStatus, getRpcSession, getHarnessRuntimeVerification, activateGenericModePack, reviseHarnessSessionSettings } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

export async function getSessionModeSettings(sessionId: string) {
  const learner = getLearningHarness().findCurrentSession(sessionId);
  const live = getRpcSession(sessionId);
  const generic = learner ? null : await getGenericModePackStatus(sessionId);
  const snapshot = learner?.snapshot ?? generic?.runtime.binding?.snapshot ?? null;
  let cwd = live?.cwd ?? generic?.runtime.cwd;
  if (!cwd) {
    const file = await resolveSessionPath(sessionId);
    if (!file) throw new Error("Session not found");
    cwd = SessionManager.open(file, undefined).getCwd();
  }
  const inventory = await inspectModePackInventory(cwd);
  const verified = learner ? getHarnessRuntimeVerification(sessionId, learner.snapshot).verified : generic?.runtime.verified ?? false;
  let loadedSkillIds: string[] = [];
  if (snapshot && live?.isAlive() && verified) {
    if (learner) {
      // Learner Skills are injected as complete Host-owned prompt text.
      const prompt = live.inner.agent.state?.systemPrompt ?? "";
      loadedSkillIds = snapshot.resources.filter((resource) => resource.kind === "skill" && resource.enabled && inventory.resourcesByKey.get(`skill:${resource.id}`)?.text && prompt.includes(inventory.resourcesByKey.get(`skill:${resource.id}`)!.text!)).map((resource) => resource.id);
    } else {
      const plan = buildModePackRuntimePlanFromInventory({ snapshot, inventory });
      loadedSkillIds = collectModePackRuntimeEvidence(live.inner, plan).loadedSkillIds;
    }
  }
  return {
    sessionId, cwd, kind: learner ? "learning" as const : "generic" as const,
    modePackId: snapshot?.profileId ?? null, snapshotId: snapshot?.resourceSnapshotId ?? null,
    systemPrompt: snapshot ? modeSystemPrompt(snapshot) : "", verified,
    live: live?.isAlive() ?? false, busy: live?.isRunning() ?? false,
    skillDirectory: localModeSkillsDirectory(),
    skills: inventory.resources.filter((resource) => resource.kind === "skill" && (!learner || resource.source === "pi-own-mode-pack")).map((resource) => {
      const descriptor = snapshot?.resources.find((item) => item.kind === "skill" && item.id === resource.id);
      return { id: resource.id, name: resource.title, filePath: resource.paths[0], content: resource.text ?? "", required: descriptor?.required ?? false, enabled: descriptor?.enabled ?? false, loaded: loadedSkillIds.includes(resource.id), contentHash: resource.contentHash };
    }),
  };
}

export async function updateSessionModeSettings(options: { sessionId: string; expectedSnapshotId: string; idempotencyKey: string; settingsPatch: unknown }) {
  const learner = getLearningHarness().findCurrentSession(options.sessionId);
  if (learner) {
    await reviseHarnessSessionSettings(options.sessionId, options.expectedSnapshotId, options.settingsPatch, options.idempotencyKey);
  } else {
    const status = await getGenericModePackStatus(options.sessionId);
    const modePackId = status.runtime.binding?.snapshot.profileId;
    if (!modePackId) throw new Error("请先选择一个模式，再调整该模式的提示词与 Skills。");
    await activateGenericModePack({ ...options, modePackId });
  }
  return getSessionModeSettings(options.sessionId);
}
