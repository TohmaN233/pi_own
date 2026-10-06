import { getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { localModeSkillsDirectory, modeSystemPrompt, MODE_PACK_TOOL_NAMES } from "../../../packages/profile-resource-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { inspectModePackInventory, buildModePackRuntimePlanFromInventory, collectModePackRuntimeEvidence } from "./mode-pack-inventory";
import { getGenericModePackStatus, getRpcSession, getHarnessRuntimeVerification, activateGenericModePack, reviseHarnessSessionSettings } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { readSessionToolSelection } from "./session-tool-selection";
import { PRESET_DEFAULT } from "./tool-presets";
import type { SessionEntry } from "./types";
import { getModeWorkflowSettings, writeModeWorkflowSettings, type WorkflowCatalogEntry } from "./mode-workflow-settings";

/** Read the one native registry through its existing private session API. */
async function sessionWorkflowCatalog(sessionId: string): Promise<WorkflowCatalogEntry[]> {
  const live = getRpcSession(sessionId);
  if (!live?.isAlive()) return [];
  await live.waitUntilReady();
  if (!live.inner.getActiveToolNames().includes("caw")) return [];
  const bus = (live.inner.resourceLoader as unknown as { eventBus: { emit(name: string, value: unknown): void } }).eventBus;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Workflow catalog query timed out; reconnect this conversation")), 10000);
    try { bus.emit("pi-caw:host-command", { session_id: sessionId, operation: "list", args: {},
      resolve: (result: unknown) => { clearTimeout(timer); if (!Array.isArray(result)) reject(new Error("Invalid native Workflow catalog response")); else resolve(result); },
      reject: (error: unknown) => { clearTimeout(timer); reject(error); } }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}

export async function getSessionModeSettings(sessionId: string) {
  const learner = getLearningHarness().findCurrentSession(sessionId);
  const live = getRpcSession(sessionId);
  const generic = learner ? null : await getGenericModePackStatus(sessionId);
  const snapshot = learner?.snapshot ?? generic?.runtime.binding?.snapshot ?? null;
  const workflowCatalog = snapshot ? await sessionWorkflowCatalog(sessionId) : [];
  let manager = live?.inner.sessionManager;
  let cwd = live?.cwd ?? generic?.runtime.cwd;
  if (!cwd || (!snapshot && !manager)) {
    const file = await resolveSessionPath(sessionId);
    if (!file) throw new Error("Session not found");
    manager = SessionManager.open(file, undefined);
    cwd ??= manager.getCwd();
  }
  const tools = snapshot ? [...snapshot.tools]
    : readSessionToolSelection(manager!.getEntries() as unknown as SessionEntry[])
      ?? [...new Set([...(SettingsManager.create(cwd, getAgentDir()).getDefaultTools() ?? PRESET_DEFAULT).filter((name) => MODE_PACK_TOOL_NAMES.includes(name as typeof MODE_PACK_TOOL_NAMES[number])), "codemode"])];
  const inventory = await inspectModePackInventory(cwd, {
    ...(snapshot?.packageContentHash ? { packageContentHash: snapshot.packageContentHash } : {}),
    ...(snapshot?.packageContentHash ? { selection: { resources: snapshot.resources.map((resource) => ({ kind: resource.kind, id: resource.id, enabled: resource.enabled })) } } : {}),
  });
  const verified = learner ? getHarnessRuntimeVerification(sessionId, learner.snapshot).verified : generic?.runtime.verified ?? false;
  let loadedSkillIds: string[] = [];
  if (snapshot && live?.isAlive() && verified) {
    if (learner) {
      // Learner Skills are injected as complete Host-owned prompt text.
      const prompt = live.systemPrompt;
      loadedSkillIds = snapshot.resources.filter((resource) => resource.kind === "skill" && resource.enabled && inventory.resourcesByKey.get(`skill:${resource.id}`)?.text && prompt.includes(inventory.resourcesByKey.get(`skill:${resource.id}`)!.text!)).map((resource) => resource.id);
    } else {
      const plan = buildModePackRuntimePlanFromInventory({ snapshot, inventory });
      const native = collectModePackRuntimeEvidence(live.inner, plan).loadedSkillIds;
      const prompt = live.systemPrompt;
      const embedded = snapshot.resources
        .filter((resource) => resource.kind === "skill" && resource.enabled && resource.delivery !== "native-skill")
        .filter((resource) => {
          const block = plan.resourcePromptBlocksByKey.get(`skill:${resource.id}`);
          return !!block && prompt.includes(block);
        })
        .map((resource) => resource.id);
      loadedSkillIds = [...new Set([...native, ...embedded])];
    }
  }
  return {
    sessionId, cwd, kind: learner ? "learning" as const : "generic" as const,
    modePackId: snapshot?.profileId ?? null, snapshotId: snapshot?.resourceSnapshotId ?? null,
    systemPrompt: snapshot ? modeSystemPrompt(snapshot) : "", verified,
    live: live?.isAlive() ?? false, busy: live?.isRunning() ?? false,
    skillDirectory: localModeSkillsDirectory(),
    tools,
    ...(snapshot ? getModeWorkflowSettings(sessionId, snapshot, workflowCatalog) : { workflows: [], workflowScope: null }),
    skills: inventory.resources.filter((resource) => resource.kind === "skill" && (!learner || resource.source === "pi-own-mode-pack")).map((resource) => {
      const descriptor = snapshot?.resources.find((item) => item.kind === "skill" && item.id === resource.id);
      return { id: resource.id, name: resource.title, filePath: resource.paths[0], required: descriptor?.required ?? false, enabled: descriptor?.enabled ?? false, loaded: loadedSkillIds.includes(resource.id), contentHash: resource.contentHash };
    }),
  };
}

/** Skill bodies are intentionally absent from the settings list. Fetch one
 * only after the user expands it, through a path already selected by the
 * bound inventory rather than a caller supplied filesystem path. */
export async function getSessionModeSkillContent(sessionId: string, skillId: string) {
  const settings = await getSessionModeSettings(sessionId);
  const skill = settings.skills.find((candidate) => candidate.id === skillId);
  if (!skill?.filePath) throw new Error(`Skill is not available in this mode: ${skillId}`);
  return {
    id: skill.id,
    filePath: skill.filePath,
    contentHash: skill.contentHash,
    content: readFileSync(skill.filePath, "utf8"),
  };
}

export async function updateSessionModeSettings(options: { sessionId: string; expectedSnapshotId: string; idempotencyKey: string; settingsPatch: unknown; expectedWorkflowRevision?: number }) {
  const learner = getLearningHarness().findCurrentSession(options.sessionId);
  const patch = options.settingsPatch;
  if (patch && typeof patch === "object" && Object.hasOwn(patch, "workflows")) {
    if (Object.keys(patch).some(key => key !== "workflows")) throw new Error("Save Workflow combinations separately from resource settings");
    const snapshot = learner?.snapshot ?? (await getGenericModePackStatus(options.sessionId)).runtime.binding?.snapshot;
    if (!snapshot) throw new Error("Select a mode before adjusting Workflow combinations");
    if (snapshot.resourceSnapshotId !== options.expectedSnapshotId) throw new Error("Mode snapshot conflict; reload before saving Workflow settings");
    const catalog = await sessionWorkflowCatalog(options.sessionId);
    // The async catalog read must not let an old settings panel change a new binding.
    const current = getLearningHarness().findCurrentSession(options.sessionId)?.snapshot
      ?? (await getGenericModePackStatus(options.sessionId)).runtime.binding?.snapshot;
    if (current?.resourceSnapshotId !== snapshot.resourceSnapshotId || current.profileId !== snapshot.profileId
      || current.packageContentHash !== snapshot.packageContentHash) throw new Error("Workflow mode binding conflict; reload before saving");
    writeModeWorkflowSettings(options.sessionId, snapshot, (patch as { workflows: unknown }).workflows, options.expectedWorkflowRevision!, catalog);
    return getSessionModeSettings(options.sessionId);
  }
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
