import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { existsSync, writeFileSync } from "fs";
import type { ModePackDefinition, ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import {
  MODE_PACK_BINDING_CUSTOM_TYPE,
  prepareModePackSessionBinding,
  recoverModePackBindingHistory,
  verifyModePackRuntime,
  type ModePackEntryLike,
  type ModePackSessionBinding,
} from "../../../packages/mode-pack-host/src/index.ts";
import * as Base from "./rpc-manager-base";
import { getLearningHarness } from "./harness-server";
import {
  applyModePackToolSelection,
  buildModePackRuntimePlan,
  buildModePackRuntimePlanFromInventory,
  collectModePackRuntimeEvidence,
  expectedModePackActiveTools,
  summarizeInventory,
  type ModePackRuntimePlan,
} from "./mode-pack-inventory";
import { ModePackStore } from "./mode-pack-store";
import {
  createProjectCommandBashExtension,
  preferUserBashExtension,
} from "./project-command-env";
import { projectTrustReloadOptions } from "./project-trust";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  resolveSessionPath,
} from "./session-reader";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { notifySessionComplete } from "./web-push";

export * from "./rpc-manager-base";

function modePackStore(): ModePackStore {
  return new ModePackStore();
}
const MODE_PACK_START_PREFIX = "mode-pack-start:";

class ModePackAgentSessionWrapper extends Base.AgentSessionWrapper {
  readonly modePackSnapshot: ResourceSnapshot;

  constructor(
    inner: ConstructorParameters<typeof Base.AgentSessionWrapper>[0],
    snapshot: ResourceSnapshot,
  ) {
    super(inner, {
      chatOnly: false,
      profileSnapshot: snapshot,
      onAgentRunComplete: (sessionId: string) => {
        void notifySessionComplete(sessionId).catch((error) => {
          console.error("[pi-web] failed to send Mode Pack completion push:", error instanceof Error ? error.message : error);
        });
      },
    });
    this.modePackSnapshot = snapshot;
  }

  override async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type;
    if (type === "set_tools" || type === "set_model" || type === "set_thinking_level" || type === "reload") {
      throw new Error("This session is controlled by an immutable Mode Pack; switch or revise the Mode Pack instead.");
    }
    if (type === "bash" && !this.modePackSnapshot.tools.some((tool) => tool === "bash" || tool === "powershell")) {
      throw new Error("The active Mode Pack does not allow direct shell commands.");
    }
    return super.send(command);
  }
}

interface GenericModePackRuntimeStatus {
  sessionId: string;
  cwd: string;
  live: boolean;
  busy: boolean;
  binding: ModePackSessionBinding | null;
  inheritedBinding: ModePackSessionBinding | null;
  verified: boolean;
  activeTools: string[];
  expectedTools: string[];
  diagnostic: string | null;
}

export interface GenericModePackStatusResponse {
  runtime: GenericModePackRuntimeStatus;
  packs: Array<{
    definition: ModePackDefinition;
    builtin: boolean;
    selectable: boolean;
    missingRequiredResources: string[];
    missingOptionalResources: string[];
    identityMismatches: string[];
  }>;
  resources: ReturnType<typeof summarizeInventory>;
  diagnostics: Array<{ severity: "warning" | "error"; source: string | null; message: string }>;
}

export interface ActivateGenericModePackOptions {
  sessionId: string;
  modePackId: string;
  expectedSnapshotId: string | null;
  idempotencyKey: string;
  createdAt?: string;
}

export interface ActivateGenericModePackResult {
  sessionId: string;
  binding: ModePackSessionBinding;
  runtime: GenericModePackRuntimeStatus;
  replay: boolean;
}

declare global {
  var __piSessions: Map<string, Base.AgentSessionWrapper> | undefined;
  var __piModePackStartLocks:
    | Map<string, Promise<{ session: Base.AgentSessionWrapper; realSessionId: string }>>
    | undefined;
  var __piModePackActivationLocks: Set<string> | undefined;
}

function getModePackStartLocks(): Map<
  string,
  Promise<{ session: Base.AgentSessionWrapper; realSessionId: string }>
> {
  if (!globalThis.__piModePackStartLocks) globalThis.__piModePackStartLocks = new Map();
  return globalThis.__piModePackStartLocks;
}

function acquireModePackActivation(sessionId: string): () => void {
  const locks = globalThis.__piModePackActivationLocks ??= new Set<string>();
  if (locks.has(sessionId)) throw new Error("A Mode Pack activation is already in progress for this session.");
  locks.add(sessionId);
  return () => locks.delete(sessionId);
}

function modePackRecovery(sessionManager: SessionManager) {
  return recoverModePackBindingHistory(
    sessionManager.getEntries() as unknown as ModePackEntryLike[],
    sessionManager.getSessionId(),
  );
}

function assertNoCourseBinding(sessionId: string): void {
  if (getLearningHarness().findCurrentSession(sessionId)) {
    throw new Error("Course-bound sessions must switch through the Learning Harness Mode Pack transaction.");
  }
}

function registry(): Map<string, Base.AgentSessionWrapper> {
  Base.getRpcSession("__mode_pack_registry_probe__");
  const value = globalThis.__piSessions;
  if (!value) throw new Error("Pi runtime registry is unavailable");
  return value;
}

function registerPreparedWrapper(wrapper: Base.AgentSessionWrapper): void {
  const sessions = registry();
  const sessionId = wrapper.sessionId;
  if (wrapper.sessionFile) cacheSessionPath(sessionId, wrapper.sessionFile);
  wrapper.onDestroy(() => {
    if (sessions.get(sessionId) === wrapper) sessions.delete(sessionId);
  });
  sessions.set(sessionId, wrapper);
  invalidateSessionListCache();
}

function persistUnflushedSession(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return;
  const header = sessionManager.getHeader();
  if (!header) throw new Error("Mode Pack binding cannot be persisted without a Pi session header");
  const content = [header, ...sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });
  (sessionManager as unknown as { flushed: boolean }).flushed = true;
  cacheSessionPath(sessionManager.getSessionId(), sessionFile);
}

function appendModePackBinding(sessionManager: SessionManager, binding: ModePackSessionBinding): void {
  sessionManager.appendCustomEntry(MODE_PACK_BINDING_CUSTOM_TYPE, binding);
  persistUnflushedSession(sessionManager);
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Mode Pack binding has no persisted Pi transcript");
  const recovered = modePackRecovery(SessionManager.open(sessionFile, undefined)).current;
  if (!recovered || recovered.requestHash !== binding.requestHash || recovered.revision !== binding.revision) {
    throw new Error("Mode Pack binding was not durably recovered from the Pi JSONL transcript");
  }
}

function requestedModelForSnapshot(
  snapshot: ResourceSnapshot,
  modelRuntime: { getModel(provider: string, modelId: string): { provider: string; id: string } | undefined },
  preservedModel?: { provider: string; id: string },
): { provider: string; id: string } | undefined {
  if ((snapshot.provider === null) !== (snapshot.model === null)) {
    throw new Error("Mode Pack provider and model must either both be set or both be null");
  }
  if (snapshot.provider && snapshot.model) {
    const pinned = modelRuntime.getModel(snapshot.provider, snapshot.model);
    if (!pinned) throw new Error(`Mode Pack model is unavailable: ${snapshot.provider}/${snapshot.model}`);
    return pinned;
  }
  if (!preservedModel) return undefined;
  const preserved = modelRuntime.getModel(preservedModel.provider, preservedModel.id);
  if (!preserved) throw new Error(`Saved Pi session model is unavailable: ${preservedModel.provider}/${preservedModel.id}`);
  return preserved;
}

async function createModePackCandidate(options: {
  sessionManager: SessionManager;
  snapshot: ResourceSnapshot;
  definition?: ModePackDefinition | null;
  plan?: ModePackRuntimePlan;
  preservedModel?: { provider: string; id: string };
}): Promise<{
  wrapper: Base.AgentSessionWrapper;
  plan: ModePackRuntimePlan;
}> {
  const sessionCwd = options.sessionManager.getCwd();
  const plan = options.plan ?? await buildModePackRuntimePlan({
    snapshot: options.snapshot,
    cwd: sessionCwd,
    definition: options.definition,
  });
  initTheme();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(sessionCwd, agentDir);
  const services = await createAgentSessionServices({
    cwd: sessionCwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: false,
      additionalExtensionPaths: plan.extensionPaths,
      additionalSkillPaths: plan.skillPaths,
      additionalPromptTemplatePaths: plan.promptPaths,
      additionalThemePaths: plan.themePaths,
      appendSystemPrompt: [plan.systemPrompt],
      extensionFactories: [
        createProjectCommandBashExtension({ cwd: sessionCwd, settings: settingsManager }),
      ],
      extensionsOverride: (base) => preferUserBashExtension(base),
    },
    resourceLoaderReloadOptions: projectTrustReloadOptions(sessionCwd, agentDir),
  });
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    services.settingsManager.getEnabledModels(),
  );
  // An unpinned Mode Pack must not replace a persisted session's saved model
  // with the current global default during restart recovery. Read Pi's model
  // entry explicitly even before the first message; SDK default selection is
  // not a substitute for restoring the transcript's model identity.
  const savedModel = options.sessionManager.buildSessionContext().model;
  const preservedModel = options.preservedModel ?? (savedModel
    ? { provider: savedModel.provider, id: savedModel.modelId }
    : undefined);
  const requested = requestedModelForSnapshot(options.snapshot, services.modelRuntime, preservedModel);
  const initial = selectInitialModelScope(scope, {
    ...(requested ? { requestedModel: { provider: requested.provider, modelId: requested.id } } : {}),
    thinkingLevel: options.snapshot.thinkingLevel as ThinkingLevel,
  });
  const { session: inner } = await createAgentSessionFromServices({
    services,
    sessionManager: options.sessionManager,
    ...(initial.model ? { model: initial.model } : {}),
    ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
    ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
  });
  const wrapper = new ModePackAgentSessionWrapper(inner, options.snapshot);
  wrapper.start();
  wrapper.beginExtensionBinding();
  try {
    await wrapper.waitUntilReady();
    applyModePackToolSelection(inner, plan);
    const evidence = collectModePackRuntimeEvidence(inner, plan);
    const verification = verifyModePackRuntime(options.snapshot, evidence, {
      ...plan.expected,
      activeTools: expectedModePackActiveTools(inner, plan),
    });
    if (!verification.verified) {
      throw new Error(`Mode Pack runtime verification failed: ${verification.issues.join("; ")}`);
    }
    return { wrapper, plan };
  } catch (error) {
    await wrapper.shutdown().catch(() => undefined);
    throw error;
  }
}

async function startPersistedModePackSession(
  sessionId: string,
  sessionFile: string,
): Promise<{ session: Base.AgentSessionWrapper; realSessionId: string }> {
  const sessionManager = SessionManager.open(sessionFile, undefined);
  const recovery = modePackRecovery(sessionManager);
  const source = recovery.current ?? recovery.inherited;
  if (!source) throw new Error("No Mode Pack binding is available for this session");
  assertNoCourseBinding(sessionManager.getSessionId());
  const candidate = await createModePackCandidate({
    sessionManager,
    snapshot: source.snapshot,
  });
  try {
    if (!recovery.current) {
      const inherited = prepareModePackSessionBinding({
        sessionId: sessionManager.getSessionId(),
        targetSnapshot: source.snapshot,
        history: [],
        inherited: source,
        idempotencyKey: `inherit:${source.bindingId}:${sessionManager.getSessionId()}`,
      });
      appendModePackBinding(sessionManager, inherited.binding);
    }
    if (candidate.wrapper.sessionId !== sessionId) {
      throw new Error("Recovered Mode Pack runtime changed the Pi session identity");
    }
    registerPreparedWrapper(candidate.wrapper);
    return { session: candidate.wrapper, realSessionId: sessionId };
  } catch (error) {
    await candidate.wrapper.shutdown().catch(() => undefined);
    throw error;
  }
}

export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: Base.RpcSessionStartOptions = {},
): Promise<{ session: Base.AgentSessionWrapper; realSessionId: string }> {
  const existing = Base.getRpcSession(sessionId);
  if (existing?.isAlive() && !options.deferRegister) return { session: existing, realSessionId: sessionId };
  if (
    !sessionFile
    || options.harnessCourseVersionId
    || options.harnessResourceSnapshot
    || options.deferRegister
  ) {
    return Base.startRpcSession(sessionId, sessionFile, cwd, options);
  }
  const probe = SessionManager.open(sessionFile, undefined);
  const recovery = modePackRecovery(probe);
  if (!recovery.current && !recovery.inherited) {
    return Base.startRpcSession(sessionId, sessionFile, cwd, options);
  }
  if (options.toolNames !== undefined || options.initialModel || options.thinkingLevel) {
    throw new Error("A persisted Mode Pack owns tools, model, thinking, and prompt for this session");
  }
  const locks = getModePackStartLocks();
  const lockId = `${MODE_PACK_START_PREFIX}${sessionId}`;
  const inflight = locks.get(lockId);
  if (inflight) return inflight;
  const starting = startPersistedModePackSession(sessionId, sessionFile).finally(() => {
    locks.delete(lockId);
  });
  locks.set(lockId, starting);
  return starting;
}

export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<Base.SetRpcSessionToolsResult> {
  const live = Base.getRpcSession(sessionId);
  const manager = live?.isAlive()
    ? live.inner.sessionManager
    : sessionFile
      ? SessionManager.open(sessionFile, undefined)
      : null;
  if (manager) {
    const recovery = modePackRecovery(manager);
    if (recovery.current || recovery.inherited) {
      throw new Error("Mode Pack sessions own their tool selection; switch Mode Packs instead of using set_tools.");
    }
  }
  return Base.setRpcSessionTools(sessionId, sessionFile, requestedToolNames);
}

function runtimeStatusFromLive(
  wrapper: Base.AgentSessionWrapper,
  binding: ModePackSessionBinding | null,
  inheritedBinding: ModePackSessionBinding | null,
  plan?: ModePackRuntimePlan,
): GenericModePackRuntimeStatus {
  if (!binding || !plan) {
    return {
      sessionId: wrapper.sessionId,
      cwd: wrapper.cwd,
      live: true,
      busy: wrapper.isRunning(),
      binding,
      inheritedBinding,
      verified: binding === null,
      activeTools: [...wrapper.inner.getActiveToolNames()].sort(),
      expectedTools: [],
      diagnostic: binding ? "Mode Pack runtime plan is unavailable." : null,
    };
  }
  const expected = {
    ...plan.expected,
    activeTools: expectedModePackActiveTools(wrapper.inner, plan),
  };
  const evidence = collectModePackRuntimeEvidence(wrapper.inner, plan);
  const verification = verifyModePackRuntime(binding.snapshot, evidence, expected);
  return {
    sessionId: wrapper.sessionId,
    cwd: wrapper.cwd,
    live: true,
    busy: wrapper.isRunning(),
    binding,
    inheritedBinding,
    verified: verification.verified,
    activeTools: evidence.activeTools,
    expectedTools: expected.activeTools,
    diagnostic: verification.verified ? null : verification.issues.join("; "),
  };
}

export async function getGenericModePackStatus(sessionId: string): Promise<GenericModePackStatusResponse> {
  const live = Base.getRpcSession(sessionId);
  let sessionManager: SessionManager;
  if (live?.isAlive()) {
    sessionManager = live.inner.sessionManager;
  } else {
    const path = await resolveSessionPath(sessionId);
    if (!path) throw new Error(`Pi session not found: ${sessionId}`);
    sessionManager = SessionManager.open(path, undefined);
  }
  assertNoCourseBinding(sessionManager.getSessionId());
  const recovery = modePackRecovery(sessionManager);
  const listed = await modePackStore().list(sessionManager.getCwd());
  let runtime: GenericModePackRuntimeStatus;
  if (live?.isAlive()) {
    let plan: ModePackRuntimePlan | undefined;
    if (recovery.current) {
      try {
        plan = buildModePackRuntimePlanFromInventory({
          snapshot: recovery.current.snapshot,
          inventory: listed.inventory,
        });
      } catch (error) {
        runtime = {
          sessionId,
          cwd: sessionManager.getCwd(),
          live: true,
          busy: live.isRunning(),
          binding: recovery.current,
          inheritedBinding: recovery.inherited,
          verified: false,
          activeTools: [...live.inner.getActiveToolNames()].sort(),
          expectedTools: [...recovery.current.snapshot.tools],
          diagnostic: error instanceof Error ? error.message : String(error),
        };
        return {
          runtime,
          packs: listed.packs,
          resources: summarizeInventory(listed.inventory),
          diagnostics: listed.inventory.diagnostics,
        };
      }
    }
    runtime = runtimeStatusFromLive(live, recovery.current, recovery.inherited, plan);
  } else {
    runtime = {
      sessionId,
      cwd: sessionManager.getCwd(),
      live: false,
      busy: false,
      binding: recovery.current,
      inheritedBinding: recovery.inherited,
      verified: false,
      activeTools: [],
      expectedTools: recovery.current ? [...recovery.current.snapshot.tools] : [],
      diagnostic: recovery.current
        ? "Pi runtime is not loaded; reopen the session to verify its Mode Pack."
        : null,
    };
  }
  return {
    runtime,
    packs: listed.packs,
    resources: summarizeInventory(listed.inventory),
    diagnostics: listed.inventory.diagnostics,
  };
}

export async function activateGenericModePack(
  options: ActivateGenericModePackOptions,
): Promise<ActivateGenericModePackResult> {
  if (!options.idempotencyKey.trim()) throw new Error("Mode Pack activation requires an idempotency key");
  const existing = Base.getRpcSession(options.sessionId);
  if (!existing?.isAlive()) throw new Error("Mode Pack activation requires a live Pi session");
  assertNoCourseBinding(options.sessionId);
  const releaseGlobal = acquireModePackActivation(options.sessionId);
  if (!existing.tryAcquireProfileTransition()) {
    releaseGlobal();
    throw new Error("Wait for the current Pi command to finish before switching Mode Packs.");
  }
  let candidate: Base.AgentSessionWrapper | null = null;
  let journalCommitted = false;
  let persistedSessionFile: string | null = null;
  try {
    const recovery = modePackRecovery(existing.inner.sessionManager);
    const prior = recovery.history.find((item) => item.idempotencyKey === options.idempotencyKey);
    if (prior) {
      if (prior.snapshot.profileId !== options.modePackId || prior.previousSnapshotId !== options.expectedSnapshotId) {
        throw new Error("Mode Pack activation idempotency key was reused for another request.");
      }
      if (recovery.current?.requestHash !== prior.requestHash) {
        throw new Error("The original idempotent activation is no longer the active Mode Pack.");
      }
      const status = await getGenericModePackStatus(options.sessionId);
      return { sessionId: options.sessionId, binding: prior, runtime: status.runtime, replay: true };
    }
    const currentSnapshotId = recovery.current?.snapshot.resourceSnapshotId ?? null;
    if (currentSnapshotId !== options.expectedSnapshotId) {
      throw new Error("The active Mode Pack snapshot changed before this activation.");
    }
    const resolved = await modePackStore().resolve(options.modePackId, existing.cwd, options.createdAt);
    const prepared = prepareModePackSessionBinding({
      sessionId: options.sessionId,
      targetSnapshot: resolved.snapshot,
      history: recovery.history,
      inherited: recovery.inherited,
      idempotencyKey: options.idempotencyKey,
      createdAt: options.createdAt,
    });
    // Materialize a transient ordinary session before replacing its runtime.
    // This gives every pre-commit failure a persisted old runtime to reopen.
    persistUnflushedSession(existing.inner.sessionManager);
    const sessionFile = existing.inner.sessionManager.getSessionFile() ?? existing.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) {
      throw new Error("Mode Pack activation could not persist the current Pi session before replacement");
    }
    persistedSessionFile = sessionFile;
    const candidateManager = SessionManager.open(sessionFile, undefined);
    const plan = buildModePackRuntimePlanFromInventory({
      snapshot: resolved.snapshot,
      inventory: resolved.inventory,
      definition: resolved.definition,
    });
    const created = await createModePackCandidate({
      sessionManager: candidateManager,
      snapshot: resolved.snapshot,
      definition: resolved.definition,
      plan,
      preservedModel: existing.inner.model
        ? { provider: existing.inner.model.provider, id: existing.inner.model.id }
        : undefined,
    });
    candidate = created.wrapper;
    candidate.setProfileTransitionLocked(true);
    if (candidate.sessionId !== options.sessionId) {
      throw new Error("Prepared Mode Pack runtime changed the Pi session identity");
    }
    await existing.shutdown();
    appendModePackBinding(candidate.inner.sessionManager, prepared.binding);
    journalCommitted = true;
    registerPreparedWrapper(candidate);
    const status = await getGenericModePackStatus(options.sessionId);
    if (!status.runtime.verified) {
      throw new Error(status.runtime.diagnostic ?? "Committed Mode Pack runtime failed verification");
    }
    candidate.releaseProfileTransition();
    return {
      sessionId: options.sessionId,
      binding: prepared.binding,
      runtime: status.runtime,
      replay: false,
    };
  } catch (error) {
    if (candidate) await candidate.shutdown().catch(() => undefined);
    if (journalCommitted) {
      // The Pi JSONL is the commit authority. Once the new binding is durable,
      // never resurrect the previous runtime: a restart must recover the new
      // snapshot or fail closed.
      throw new Error(
        `Mode Pack activation committed to the Pi transcript but the live runtime could not be verified. Reopen the session to recover the committed snapshot. Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Base.getRpcSession(options.sessionId)?.isAlive() && persistedSessionFile && existsSync(persistedSessionFile)) {
      await startRpcSession(options.sessionId, persistedSessionFile, undefined).catch((restoreError) => {
        console.error("[mode-pack] failed to restore previous Pi runtime", restoreError);
      });
    }
    throw error;
  } finally {
    candidate?.releaseProfileTransition();
    existing.releaseProfileTransition();
    releaseGlobal();
  }
}

export async function createGenericModePackSession(
  cwd: string,
  modePackId: string,
): Promise<{ session: Base.AgentSessionWrapper; realSessionId: string; binding: ModePackSessionBinding }> {
  const initial = await Base.startRpcSession(`__mode_pack_new__${randomUUID()}`, "", cwd, {});
  try {
    const activated = await activateGenericModePack({
      sessionId: initial.realSessionId,
      modePackId,
      expectedSnapshotId: null,
      idempotencyKey: randomUUID(),
    });
    const session = Base.getRpcSession(initial.realSessionId);
    if (!session?.isAlive()) throw new Error("Activated Mode Pack session is not registered");
    return { session, realSessionId: initial.realSessionId, binding: activated.binding };
  } catch (error) {
    await Base.getRpcSession(initial.realSessionId)?.shutdown().catch(() => undefined);
    throw error;
  }
}
