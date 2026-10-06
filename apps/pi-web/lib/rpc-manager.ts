import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  DefaultResourceLoader,
  getAgentDir,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type EventBus,
  type ExtensionRuntime,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { hasSessionSettings, modePackSystemPromptIsCustomized, modeSystemPrompt, reviseModePackSettings, parseModePackSettingsPatch, type ModePackSettingsPatch } from "../../../packages/profile-resource-host/src/index.ts";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { ModePackDefinition, ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import {
  MODE_PACK_BINDING_CUSTOM_TYPE,
  prepareModePackSessionBinding,
  recoverModePackBindingHistory,
  verifyModePackRuntime,
  type ModePackEntryLike,
  type ModePackRuntimeExpectation,
  type ModePackSessionBinding,
} from "../../../packages/mode-pack-host/src/index.ts";
import * as Base from "./rpc-manager-base";
import { forkGenericModePackSession } from "./mode-pack-fork";
import { getLearningHarness } from "./harness-server";
import {
  applyModePackToolSelection,
  buildModePackRuntimePlan,
  buildModePackRuntimePlanFromInventory,
  collectModePackRuntimeEvidence,
  expectedModePackActiveTools,
  inspectModePackInventory,
  summarizeInventory,
  type ModePackRuntimePlan,
} from "./mode-pack-inventory";
import { ModePackStore, modePackDefinitionSelection } from "./mode-pack-store";
import {
  createProjectCommandExtensions,
  preferUserBashExtension,
} from "./project-command-env";
import { qualifyModePublicRegistrations } from "./mode-public-registration";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  resolveSessionPath,
} from "./session-reader";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { notifySessionComplete } from "./web-push";
import { persistCommittedRuntimeSettings } from "./session-runtime-settings";
import { activePortableModePackage, activePortableModePackageForSnapshot } from "./portable-mode-pack-registry";
import { ensurePortableModePackageInstalled, portablePackageRuntimeDirectory, type PortableModePackageSelection } from "./portable-mode-package-install";
import { bundledCodeModePackage } from "./bundled-code-mode-package";
import { configureSelectedModeRuntimeDependencies, loadModeExtensions, registerModeSubagentCapabilityCeiling } from "./mode-extension-loader";
import { createHostFffExtensionFactory } from "./host-fff";
import { hasExplicitlyUninstalledResources, isExplicitlyUninstalledPackage } from "./resource-uninstall-state";
import { createHostBaselineExtensions, preferHostBaselinePlugins, registeredHostBaselineToolNames } from "./host-baseline-plugins";
import { createPiBuiltinModeExtensions, nativeMcpDirectToolNames } from "./pi-builtin-mode-extensions";
import { studyModePhaseForSnapshot } from "./study-mode-policy";
import { COURSE_WORKFLOW_MIGRATION_MARKER, isRetiredCourseResource, isKnownLegacyCourseDefaultPrompt,
  needsCourseWorkflowSnapshotMigration, isBuiltinCourseHostUpgrade } from "./course-workflow-migration";
import { needsLearningWorkflowDefaults, isPreviousStudyDefaultPrompt, LEARNING_WORKFLOW_CONTROL_MARKER } from "./learning-workflow-defaults";

export * from "./rpc-manager-base";

function modePackStore(): ModePackStore {
  return new ModePackStore();
}

/** Preserve the primary activation error while leaving lifecycle cleanup
 * observable. Cleanup must never erase the operation that caused rollback. */
async function shutdownFailedModePackCandidate(label: string, shutdown: () => Promise<void>): Promise<void> {
  try {
    await shutdown();
  } catch (error) {
    console.error(`[mode-pack] ${label} shutdown failed`, error);
  }
}

function snapshotSelection(snapshot: ResourceSnapshot, patch?: ModePackSettingsPatch): PortableModePackageSelection {
  const resources = snapshot.resources.map((resource) => ({ kind: resource.kind, id: resource.id, enabled: resource.enabled }));
  for (const skill of patch?.skills ?? []) {
    const existing = resources.find((resource) => resource.kind === "skill" && resource.id === skill.id);
    if (existing) existing.enabled = skill.enabled;
    else if (skill.enabled && snapshot.packageContentHash) {
      const archive = snapshot.packageContentHash ? activePortableModePackageForSnapshot(snapshot) : null;
      const resource = archive?.resources.find((candidate) => candidate.kind === "skill" && candidate.id === skill.id);
      if (!resource) {
        throw new Error(`Skill is not an optional resource in this Mode Pack: ${skill.id}`);
      }
      resources.push({ kind: "skill", id: skill.id, enabled: true });
    }
    else if (skill.enabled) resources.push({ kind: "skill", id: skill.id, enabled: true });
  }
  return { resources };
}

/** Resource snapshots retain only effective resources, so disabling an
 * optional Skill intentionally removes its descriptor. Resource membership in
 * the committed archive is the durable policy source: package definitions are
 * intentionally excluded from the archive hash, so their old required/default
 * flags are not authoritative for a fork sharing the same payload. */
function knownPortableSkillIds(snapshot: ResourceSnapshot): ReadonlySet<string> {
  const archive = activePortableModePackageForSnapshot(snapshot);
  if (!archive) return new Set();
  return new Set(archive.resources
    .filter((resource) => resource.kind === "skill")
    .map((resource) => resource.id));
}

/** An explicit switch chooses the latest definition. Carry only settings that
 * still describe resources in that definition; a historical binding remains
 * immutable until the user explicitly activates the mode again. */
function selectionForExplicitModeActivation(
  definition: ModePackDefinition,
  previous: ResourceSnapshot | undefined,
  patch: ModePackSettingsPatch | undefined,
): PortableModePackageSelection {
  const selection = modePackDefinitionSelection(definition);
  const previouslyKnownSkills = previous ? knownPortableSkillIds(previous) : new Set<string>();
  if (previous) {
    for (const item of selection.resources) {
      if (item.kind !== "skill") continue;
      const component = definition.components.find((candidate) => candidate.type === "skill" && candidate.id === item.id);
      const earlier = previous.resources.find((candidate) => candidate.kind === "skill" && candidate.id === item.id);
      if (component && !component.required && (earlier || previouslyKnownSkills.has(item.id))) {
        item.enabled = earlier?.enabled ?? false;
      }
    }
  }
  for (const skill of patch?.skills ?? []) {
    const item = selection.resources.find((candidate) => candidate.kind === "skill" && candidate.id === skill.id);
    if (item) item.enabled = skill.enabled;
  }
  return selection;
}

async function packageInventory(cwd: string, snapshot: ResourceSnapshot, selection: PortableModePackageSelection) {
  if (!snapshot.packageContentHash) return inspectModePackInventory(cwd);
  const archive = activePortableModePackageForSnapshot(snapshot);
  if (!archive) throw new Error(`Portable Mode Package is unavailable: ${snapshot.packageContentHash}`);
  return inspectModePackInventory(cwd, {
    packageContentHash: snapshot.packageContentHash,
    selection,
    sharedResourcePins: snapshot.resources,
    ...(archive.definition.modePackId === "coding" ? { includeBundledCode: true } : {}),
  });
}

async function ensureSelectedPackageDependencies(snapshot: ResourceSnapshot, selection: PortableModePackageSelection): Promise<void> {
  if (!snapshot.packageContentHash) return;
  const archive = activePortableModePackageForSnapshot(snapshot);
  if (!archive) throw new Error(`Portable Mode Package is unavailable: ${snapshot.packageContentHash}`);
  await ensurePortableModePackageInstalled(archive, selection);
}

function selectedRuntimeBinDirectories(snapshot: ResourceSnapshot): string[] {
  if (!snapshot.packageContentHash) return [];
  const archive = activePortableModePackageForSnapshot(snapshot);
  if (!archive) throw new Error(`Portable Mode Package is unavailable: ${snapshot.packageContentHash}`);
  return [join(portablePackageRuntimeDirectory(archive, snapshotSelection(snapshot)), "node_modules", ".bin")];
}
const MODE_PACK_START_PREFIX = "mode-pack-start:";

interface ModeResourceLoaderInternals {
  eventBus: EventBus;
  loadExtensionFactories(runtime: ExtensionRuntime): Promise<{ extensions: LoadExtensionsResult["extensions"]; errors: LoadExtensionsResult["errors"] }>;
  addExtensionConflictDiagnostics(result: LoadExtensionsResult): void;
  loadFinalExtensionSet(paths: string[], preTrustExtensions?: LoadExtensionsResult): Promise<LoadExtensionsResult>;
}

async function createModePackServices(options: {
  cwd: string;
  agentDir: string;
  modeScope: string;
  settingsManager: SettingsManager;
  resourceLoaderOptions: Omit<ConstructorParameters<typeof DefaultResourceLoader>[0], "cwd" | "agentDir" | "settingsManager">;
  resourceLoaderReloadOptions: Parameters<DefaultResourceLoader["reload"]>[0];
  portableArchive?: ReturnType<typeof activePortableModePackageForSnapshot>;
}) {
  const resourceLoader = new DefaultResourceLoader({
    ...options.resourceLoaderOptions,
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
  });
  const internals = resourceLoader as unknown as ModeResourceLoaderInternals;
  internals.loadFinalExtensionSet = async (paths, preTrustExtensions) => {
    const previouslyLoaded = new Map((preTrustExtensions?.extensions ?? []).map((extension) => [extension.resolvedPath, extension]));
    const failures = new Set((preTrustExtensions?.errors ?? []).map((error) => error.path));
    const remaining = paths.filter((path) => !previouslyLoaded.has(path) && !failures.has(path));
    const loaded = await loadModeExtensions(remaining, options.cwd, internals.eventBus, preTrustExtensions?.runtime, options.portableArchive ?? undefined, options.modeScope);
    for (const extension of loaded.extensions) previouslyLoaded.set(extension.resolvedPath, extension);
    const inline = preTrustExtensions?.extensions.filter((extension) => extension.path.startsWith("<inline:")) ?? [];
    const ordered = paths.map((path) => previouslyLoaded.get(path)).filter((extension): extension is LoadExtensionsResult["extensions"][number] => extension !== undefined);
    ordered.push(...inline);
    const result: LoadExtensionsResult = {
      extensions: ordered,
      errors: [...(preTrustExtensions?.errors ?? []), ...loaded.errors],
      runtime: loaded.runtime,
    };
    const factories = await internals.loadExtensionFactories(result.runtime);
    result.extensions.push(...factories.extensions);
    result.errors.push(...factories.errors);
    const qualified = qualifyModePublicRegistrations(result.extensions);
    if (qualified.length > 0) console.info("[mode-pack] public registrations qualified", { registrations: qualified });
    internals.addExtensionConflictDiagnostics(result);
    return result;
  };
  // Pi's resolveProjectTrust bootstrap imports temporary CLI extension paths
  // through its raw cached loader before loadFinalExtensionSet. A portable
  // permission extension would write config.json into its immutable npm tree.
  // Read the same persisted trust decision first, then perform one isolated
  // extension load through the mode-owned adapter above.
  const projectTrust = getProjectTrustStatus(options.cwd, options.agentDir);
  options.settingsManager.setProjectTrusted(projectTrust.trusted);
  console.info("[mode-pack] project trust applied before isolated resource load", {
    modeScope: options.modeScope,
    requiresTrust: projectTrust.requiresTrust,
    trusted: projectTrust.trusted,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(options.agentDir, "auth.json"),
    modelsPath: join(options.agentDir, "models.json"),
  });
  const diagnostics: Array<{ type: "info" | "warning" | "error"; message: string }> = [];
  const extensions = resourceLoader.getExtensions();
  const skillDiagnostics = resourceLoader.getSkills().diagnostics;
  if (skillDiagnostics.length > 0) {
    const detail = skillDiagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`).join("; ");
    throw new Error(`Mode Pack Skill loading failed: ${detail}`);
  }
  if (extensions.errors.length > 0) {
    const detail = extensions.errors
      .map(({ path, error }) => `${path}: ${error}`)
      .join("; ");
    throw new Error(`Mode Pack extension loading failed: ${detail}`);
  }
  for (const registration of extensions.runtime.pendingProviderRegistrations) {
    try { modelRuntime.registerProvider(registration.name, registration.config); }
    catch (error) { diagnostics.push({ type: "error", message: `Extension "${registration.extensionPath}" error: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  extensions.runtime.pendingProviderRegistrations = [];
  for (const registration of extensions.runtime.pendingNativeProviderRegistrations) {
    try { modelRuntime.registerNativeProvider(registration.provider); }
    catch (error) { diagnostics.push({ type: "error", message: `Extension "${registration.extensionPath}" error: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  extensions.runtime.pendingNativeProviderRegistrations = [];
  await modelRuntime.refresh({ allowNetwork: false });
  return { cwd: options.cwd, agentDir: options.agentDir, modelRuntime, settingsManager: options.settingsManager, resourceLoader, diagnostics };
}

interface ModePackToolCeilingState {
  readonly expected: readonly string[];
  authorizedNarrowing?: string[];
}

const modePackToolCeilings = new WeakMap<object, ModePackToolCeilingState>();
const permissionToolNarrowingContext = new AsyncLocalStorage<ModePackToolCeilingState>();

function isPermissionExtensionPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const normalized = path.replace(/\\/gu, "/").toLocaleLowerCase("en-US");
  const marker = "/node_modules/pi-permission-system";
  return normalized.endsWith(marker) || normalized.includes(`${marker}/`);
}

/** Only a selected permission extension may turn the fixed package ceiling
 * into a narrower per-turn policy. Instrument its own before_agent_start
 * handler; a different extension calling the shared runtime API is never an
 * authorization to relax verification. */
function instrumentPermissionToolNarrowing(session: {
  resourceLoader: { getExtensions(): { extensions: unknown[] } };
}, state: ModePackToolCeilingState): void {
  for (const candidate of session.resourceLoader.getExtensions().extensions) {
    if (!candidate || typeof candidate !== "object") continue;
    const extension = candidate as { path?: unknown; handlers?: unknown };
    if (!isPermissionExtensionPath(extension.path) || !(extension.handlers instanceof Map)) continue;
    const handlers = extension.handlers.get("before_agent_start");
    if (!Array.isArray(handlers)) continue;
    extension.handlers.set("before_agent_start", handlers.map((handler) => {
      if (typeof handler !== "function") return handler;
      return (...args: unknown[]) => permissionToolNarrowingContext.run(state, async () => handler(...args));
    }));
  }
}

function enforceModePackToolCeiling(session: {
  resourceLoader: { getExtensions(): { runtime: { setActiveTools(toolNames: string[]): void }; extensions: Array<{ path?: string; tools?: ReadonlyMap<string, unknown> }> } };
}, allowedToolNames: readonly string[]): ModePackToolCeilingState {
  const runtime = session.resourceLoader.getExtensions().runtime;
  const original = runtime.setActiveTools.bind(runtime);
  const allowed = new Set(allowedToolNames);
  const state: ModePackToolCeilingState = { expected: [...allowed].sort() };
  modePackToolCeilings.set(session as object, state);
  instrumentPermissionToolNarrowing(session, state);
  // Extensions share the SDK runtime only within this AgentSession. Intersecting
  // every later extension request keeps a permission extension free to reduce
  // tools while preventing BEFORE_AGENT_START from reviving a mode-disabled one.
  runtime.setActiveTools = (requested) => {
    const currentAllowed = new Set([...allowed, ...nativeMcpDirectToolNames(session.resourceLoader.getExtensions().extensions)]);
    const narrowed = [...new Set(requested.filter((name) => currentAllowed.has(name)))].sort();
    if (permissionToolNarrowingContext.getStore() === state) state.authorizedNarrowing = narrowed;
    original(narrowed);
  };
  return state;
}

function hasSelectedPermissionPolicy(plan: ModePackRuntimePlan): boolean {
  return plan.extensionPaths.some(isPermissionExtensionPath);
}

/** The generic verifier stays exact. Once the selected permission extension
 * has made a tracked before_agent_start narrowing, that exact live set is the
 * authorized expectation for the current session; startup omissions remain
 * verification failures. */
function verifyBoundModePackRuntime(
  snapshot: ResourceSnapshot,
  evidence: ReturnType<typeof collectModePackRuntimeEvidence>,
  expected: ModePackRuntimeExpectation,
  plan: ModePackRuntimePlan,
  session: object,
) {
  const state = modePackToolCeilings.get(session);
  if (!state?.authorizedNarrowing || !hasSelectedPermissionPolicy(plan)) {
    return verifyModePackRuntime(snapshot, evidence, expected);
  }
  return verifyModePackRuntime(snapshot, evidence, { ...expected, activeTools: state.authorizedNarrowing });
}

class ModePackAgentSessionWrapper extends Base.AgentSessionWrapper {
  readonly modePackSnapshot: ResourceSnapshot;
  private runtimeCleanup: (() => void) | null = null;

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
    if (type === "set_model" || type === "set_thinking_level") {
      const patch = type === "set_model" ? { provider: command.provider, model: command.modelId } : { thinkingLevel: command.level };
      await activateGenericModePack({ sessionId: this.sessionId, modePackId: this.modePackSnapshot.profileId,
        expectedSnapshotId: this.modePackSnapshot.resourceSnapshotId, idempotencyKey: randomUUID(), settingsPatch: patch });
      const model = Base.getRpcSession(this.sessionId)?.inner.model;
      return type === "set_model" && model ? { id: model.id, provider: model.provider } : null;
    }
    if (type === "set_tools") {
      const changed = await setRpcSessionTools(this.sessionId, this.sessionFile, command.toolNames);
      return { sessionId: changed.sessionId, recreated: changed.recreated };
    }
    if (type === "reload") {
      await activateGenericModePack({ sessionId: this.sessionId, modePackId: this.modePackSnapshot.profileId,
        expectedSnapshotId: this.modePackSnapshot.resourceSnapshotId, idempotencyKey: randomUUID() });
      return null;
    }
    if (type === "bash" && !this.modePackSnapshot.tools.some((tool) => tool === "bash" || tool === "powershell")) {
      throw new Error("The active Mode Pack does not allow direct shell commands.");
    }
    if (type === "fork") {
      return forkGenericModePackSession(this, command.entryId, persistUnflushedSession);
    }
    return super.send(command);
  }

  protected override async reloadFromExtensionCommand(): Promise<void> {
    await activateGenericModePack({
      sessionId: this.sessionId,
      modePackId: this.modePackSnapshot.profileId,
      expectedSnapshotId: this.modePackSnapshot.resourceSnapshotId,
      idempotencyKey: randomUUID(),
    });
  }

  setModePackRuntimeCleanup(cleanup: () => void): void {
    if (this.runtimeCleanup) throw new Error("Mode Pack runtime cleanup is already registered");
    this.runtimeCleanup = cleanup;
  }

  override destroy(): void {
    const cleanup = this.runtimeCleanup;
    this.runtimeCleanup = null;
    cleanup?.();
    super.destroy();
  }
}

/** Fast authority for package asset/API requests. Full Mode Pack status reads
 * the catalog and disk; doing that once per frontend chunk is unnecessary and
 * makes a packaged workspace slow to open. */
export function getLiveModePackSnapshot(sessionId: string): ResourceSnapshot | null {
  const live = Base.getRpcSession(sessionId);
  return live instanceof ModePackAgentSessionWrapper && live.isAlive() ? live.modePackSnapshot : null;
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
  packageContentHash: string | null;
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
    packageError?: string;
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
  settingsPatch?: unknown;
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

interface ModePackTransitionLease {
  existing: Base.AgentSessionWrapper | undefined;
  active: boolean;
}

/** A transition lease spans all fallible pre-commit work. It is deliberately
 * AsyncLocalStorage-scoped so a nested activation can reuse the exact same
 * session lock without making it re-entrant for unrelated requests. */
const modePackTransitions = new AsyncLocalStorage<ReadonlyMap<string, ModePackTransitionLease>>();

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
  if (getModePackStartLocks().has(`${MODE_PACK_START_PREFIX}${sessionId}`)) {
    throw new Error("The Mode Pack session is still being restored.");
  }
  locks.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks.delete(sessionId);
  };
}

async function withModePackTransition<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const inherited = modePackTransitions.getStore()?.get(sessionId);
  // An async descendant can retain an ALS store after its parent has finished.
  // Only a live lease may re-enter; an expired one must acquire a fresh lock.
  if (inherited?.active) return operation();
  const registered = Base.getRpcSession(sessionId);
  const existing = registered?.isAlive() ? registered : undefined;
  assertNoCourseBinding(sessionId);
  const releaseGlobal = acquireModePackActivation(sessionId);
  if (existing && !existing.tryAcquireProfileTransition()) {
    releaseGlobal();
    throw new Error("Wait for the current Pi command to finish before switching Mode Packs.");
  }
  const scope = new Map(modePackTransitions.getStore() ?? []);
  const lease: ModePackTransitionLease = { existing, active: true };
  scope.set(sessionId, lease);
  try {
    return await modePackTransitions.run(scope, operation);
  } finally {
    lease.active = false;
    existing?.releaseProfileTransition();
    releaseGlobal();
  }
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

/** A durable product binding must never reference an in-memory-only Pi identity. */
export function createPersistedGenericSession(cwd: string, name: string, snapshot?: ResourceSnapshot): string {
  const manager = SessionManager.create(cwd);
  manager.appendSessionInfo(name);
  if (snapshot) {
    const prepared = prepareModePackSessionBinding({ sessionId: manager.getSessionId(), targetSnapshot: snapshot, history: [], inherited: null, idempotencyKey: randomUUID() });
    manager.appendCustomEntry(MODE_PACK_BINDING_CUSTOM_TYPE, prepared.binding);
    if (snapshot.provider && snapshot.model) manager.appendModelChange(snapshot.provider, snapshot.model);
    manager.appendThinkingLevelChange(snapshot.thinkingLevel);
  }
  persistUnflushedSession(manager);
  invalidateSessionListCache();
  return manager.getSessionId();
}

export async function persistGenericSession(sessionId: string): Promise<void> {
  assertNoCourseBinding(sessionId);
  const live = Base.getRpcSession(sessionId);
  if (live?.isAlive()) {
    persistUnflushedSession(live.inner.sessionManager);
    const file = live.inner.sessionManager.getSessionFile();
    if (!file || !existsSync(file)) throw new Error("Cannot bind a course without a persisted Pi session");
    invalidateSessionListCache();
  } else if (!await resolveSessionPath(sessionId)) {
    throw new Error(`Pi session not found: ${sessionId}`);
  }
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

/** Candidate construction writes to a private transcript, but extension
 * lifecycle state (notably native subagent parent linkage) must always observe
 * the durable session identity. This facade is deliberately per-manager: it
 * does not alter process state or any other concurrent session. */
function presentAuthoritativeSessionFile(sessionManager: SessionManager, sessionFile: string): () => void {
  const manager = sessionManager as unknown as {
    getSessionFile: () => string | undefined;
  };
  const getSessionFile = manager.getSessionFile.bind(manager);
  manager.getSessionFile = () => sessionFile;
  return () => { manager.getSessionFile = getSessionFile; };
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
  const candidateStartedAt = Date.now();
  const sessionCwd = options.sessionManager.getCwd();
  const plan = options.plan ?? await buildModePackRuntimePlan({
    snapshot: options.snapshot,
    cwd: sessionCwd,
    definition: options.definition,
  });
  initTheme();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(sessionCwd, agentDir);
  const services = await createModePackServices({
    cwd: sessionCwd,
    agentDir,
    modeScope: options.snapshot.profileId,
    settingsManager,
    portableArchive: options.snapshot.packageContentHash ? activePortableModePackageForSnapshot(options.snapshot) : null,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      // Mode-owned prompts are isolated from Pi's coding prompt and project
      // AGENTS/APPEND_SYSTEM files. Code Mode opts into the upstream coding
      // prompt and repository context explicitly through `append`.
      noContextFiles: plan.systemPromptMode === "replace",
      additionalExtensionPaths: plan.extensionPaths,
      additionalSkillPaths: plan.skillPaths,
      additionalPromptTemplatePaths: plan.promptPaths,
      additionalThemePaths: plan.themePaths,
      ...(plan.systemPromptMode === "append"
        ? { appendSystemPrompt: [plan.systemPrompt] }
        : {
            systemPrompt: plan.systemPrompt,
            systemPromptOverride: () => plan.systemPrompt,
            appendSystemPromptOverride: () => [],
          }),
      extensionFactories: [
        ...createPiBuiltinModeExtensions(plan.toolNames, {
          mcp: studyModePhaseForSnapshot(options.snapshot) === null && (plan.toolNames.length > 0 || plan.extensionPaths.length > 0),
          models: studyModePhaseForSnapshot(options.snapshot) === null,
        }),
        ...await createHostBaselineExtensions({ tools: plan.toolNames.length > 0 || plan.extensionPaths.length > 0, modeScope: options.snapshot.profileId, snapshot: options.snapshot, modePackOwnsCeiling: true, permissionEntry: plan.extensionPaths.find(path => path.replaceAll("\\", "/").includes("/node_modules/pi-permission-system/")) }),
        ...createProjectCommandExtensions({
          cwd: sessionCwd,
          settings: settingsManager,
          runtimeBinDirs: selectedRuntimeBinDirectories(options.snapshot),
        }),
        ...(plan.toolNames.includes("grep") || plan.toolNames.includes("find") ? [await createHostFffExtensionFactory()].filter((factory): factory is NonNullable<typeof factory> => factory !== null) : []),
      ],
      extensionsOverride: (base) => preferUserBashExtension(preferHostBaselinePlugins(base)),
    },
    resourceLoaderReloadOptions: projectTrustReloadOptions(sessionCwd, agentDir),
  });
  if (process.env.PI_WEB_TRACE_MODE_SWITCH === "1") console.info("[mode-pack] candidate services timing", { modeScope: options.snapshot.profileId, durationMs: Date.now() - candidateStartedAt });
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
  if (process.env.PI_WEB_TRACE_MODE_SWITCH === "1") console.info("[mode-pack] candidate session timing", { modeScope: options.snapshot.profileId, durationMs: Date.now() - candidateStartedAt });
  const wrapper = new ModePackAgentSessionWrapper(inner, options.snapshot);
  wrapper.start();
  wrapper.beginExtensionBinding();
  try {
    await wrapper.waitUntilReady();
    if (process.env.PI_WEB_TRACE_MODE_SWITCH === "1") console.info("[mode-pack] candidate ready timing", { modeScope: options.snapshot.profileId, durationMs: Date.now() - candidateStartedAt });
    await configureSelectedModeRuntimeDependencies(inner, plan.extensionPaths);
    applyModePackToolSelection(inner, plan);
    const allowedTools = [...new Set([...expectedModePackActiveTools(inner, plan), ...registeredHostBaselineToolNames(inner)])];
    enforceModePackToolCeiling(inner, allowedTools);
    const subagentCeiling = await registerModeSubagentCapabilityCeiling({
      sessionId: wrapper.sessionId,
      extensionPaths: plan.extensionPaths,
      allowedTools,
    });
    if (subagentCeiling) wrapper.setModePackRuntimeCleanup(() => subagentCeiling.dispose());
    const evidence = collectModePackRuntimeEvidence(inner, plan);
    const verification = verifyBoundModePackRuntime(options.snapshot, evidence, {
      ...plan.expected,
      activeTools: expectedModePackActiveTools(inner, plan),
    }, plan, inner);
    if (!verification.verified) {
      throw new Error(`Mode Pack runtime verification failed: ${verification.issues.join("; ")}`);
    }
    return { wrapper, plan };
  } catch (error) {
    await shutdownFailedModePackCandidate("candidate", () => wrapper.shutdown());
    throw error;
  }
}

/** A local built-in Skill is user-editable source. Rebind its new bytes as a
 * new snapshot on restart; never silently substitute bytes inside the old
 * committed snapshot or relax exact checks for portable package resources. */
async function refreshEditedLocalSkills(snapshot: ResourceSnapshot, cwd: string): Promise<{
  snapshot: ResourceSnapshot;
  changedSkills: string[];
} | null> {
  if (snapshot.packageContentHash) return null;
  const inventory = await inspectModePackInventory(cwd);
  const errors = inventory.diagnostics.filter((item) => item.severity === "error");
  if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
  const changed = snapshot.resources.filter((resource) => {
    if (!resource.enabled) return false;
    const installed = inventory.resourcesByKey.get(`${resource.kind}:${resource.id}`);
    if (!installed) return true;
    return installed.version !== resource.version || installed.contentHash !== resource.contentHash;
  });
  if (!changed.length || changed.some((resource) => {
    const installed = inventory.resourcesByKey.get(`${resource.kind}:${resource.id}`);
    return resource.kind !== "skill" || !installed || installed.scope !== "platform"
      || (installed.source !== "pi-own-mode-pack" && installed.source !== "pi-own")
      || installed.paths.length !== 1;
  })) return null;
  const refreshed = await resolveSavedModeSettings(snapshot, undefined, cwd);
  if (refreshed.snapshot.resourceSnapshotId === snapshot.resourceSnapshotId) {
    throw new Error("Edited local Skill did not produce a new Mode Pack snapshot");
  }
  return { snapshot: refreshed.snapshot, changedSkills: changed.map((resource) => resource.id) };
}

/** Source-vendored Course Host updates get a new binding; old pins remain exact. */
async function refreshBuiltinCourseHost(snapshot: ResourceSnapshot, cwd: string): Promise<ResourceSnapshot | null> {
  if (snapshot.packageContentHash || snapshot.profileId !== "course-builder"
    || !snapshot.instructions.includes(COURSE_WORKFLOW_MIGRATION_MARKER)) return null;
  const inventory = await inspectModePackInventory(cwd);
  const errors = inventory.diagnostics.filter(item => item.severity === "error");
  if (errors.length) throw new Error(errors.map(item => item.message).join("; "));
  const changed = snapshot.resources.filter(resource => resource.enabled && (() => {
    const installed = inventory.resourcesByKey.get(`${resource.kind}:${resource.id}`);
    return !installed || installed.version !== resource.version || installed.contentHash !== resource.contentHash;
  })());
  if (!changed.length || changed.some(resource => !isBuiltinCourseHostUpgrade(snapshot, inventory.resourcesByKey.get(`${resource.kind}:${resource.id}`)))) return null;
  const refreshed = await resolveSavedModeSettings(snapshot, undefined, cwd);
  if (refreshed.snapshot.resourceSnapshotId === snapshot.resourceSnapshotId) throw new Error("Course Host upgrade did not produce a new snapshot");
  console.info("[course-workflow] prepared built-in Host upgrade", { previousSnapshotId: snapshot.resourceSnapshotId,
    snapshotId: refreshed.snapshot.resourceSnapshotId, resources: changed.map(resource => `${resource.kind}:${resource.id}`) });
  return refreshed.snapshot;
}

async function startPersistedModePackSession(
  sessionId: string,
  sessionFile: string,
  options: { preserveTranscript?: boolean } = {},
): Promise<{ session: Base.AgentSessionWrapper; realSessionId: string }> {
  // A rollback is restoring an already durable binding. SDK construction can
  // journal model/thinking defaults, so construct from a private copy and then
  // reattach the live manager to the untouched authoritative transcript.
  const restoreScratch = options.preserveTranscript
    ? `${sessionFile}.rollback-${process.pid}-${randomUUID()}.jsonl`
    : null;
  if (restoreScratch) copyFileSync(sessionFile, restoreScratch);
  const originalBytes = restoreScratch ? readFileSync(sessionFile) : null;
  let restorePresentedSessionFile: (() => void) | null = null;
  let candidate: Awaited<ReturnType<typeof createModePackCandidate>> | null = null;
  try {
    const sessionManager = SessionManager.open(restoreScratch ?? sessionFile, undefined);
    if (restoreScratch) {
      // Install before AgentSession construction: it captures these manager
      // methods for deferred startup synchronization.
      const manager = sessionManager as unknown as {
        buildSessionContext(): { model?: { provider: string; modelId: string }; thinkingLevel?: string };
        appendModelChange(provider: string, modelId: string): string;
        appendThinkingLevelChange(level: string): string;
      };
      const appendModelChange = manager.appendModelChange.bind(manager);
      const appendThinkingLevelChange = manager.appendThinkingLevelChange.bind(manager);
      manager.appendModelChange = (provider, modelId) => {
        const current = manager.buildSessionContext().model;
        if (current?.provider === provider && current.modelId === modelId) return "";
        return appendModelChange(provider, modelId);
      };
      manager.appendThinkingLevelChange = (level) => {
        if (manager.buildSessionContext().thinkingLevel === level) return "";
        return appendThinkingLevelChange(level);
      };
    }
    const recovery = modePackRecovery(sessionManager);
    const source = recovery.current ?? recovery.inherited;
    if (!source) throw new Error("No Mode Pack binding is available for this session");
    assertNoCourseBinding(sessionManager.getSessionId());
    let courseMigrationSnapshot: ResourceSnapshot | null = null;
    const learningMigration = !options.preserveTranscript && needsLearningWorkflowDefaults(source.snapshot);
    const courseArchive = source.snapshot.packageContentHash ? activePortableModePackageForSnapshot(source.snapshot) : null;
    if ((!options.preserveTranscript && needsCourseWorkflowSnapshotMigration(source.snapshot, courseArchive)) || learningMigration) {
      const migrated = await modePackStore().resolve(source.snapshot.profileId, sessionManager.getCwd());
      courseMigrationSnapshot = (await resolveSavedModeSettings(source.snapshot, undefined, sessionManager.getCwd(), undefined, migrated.definition)).snapshot;
      console.info(learningMigration ? "[study-workflow] adopting scoped Workflow defaults" : "[course-workflow] adopting retired Skill snapshot", { sessionId, previousSnapshotId: source.snapshot.resourceSnapshotId,
        snapshotId: courseMigrationSnapshot.resourceSnapshotId, migration: learningMigration ? LEARNING_WORKFLOW_CONTROL_MARKER : COURSE_WORKFLOW_MIGRATION_MARKER });
    }
    const currentDefinition = modePackStore().getCustom(source.snapshot.profileId);
    const explicitlyDeleted = !courseMigrationSnapshot && (source.snapshot.packageContentHash
      ? isExplicitlyUninstalledPackage(source.snapshot.packageContentHash)
      : hasExplicitlyUninstalledResources(source.snapshot.resources, currentDefinition?.components.map(component => ({ kind: component.type === "plugin" ? "extension" : component.type, id: component.id }))));
    let uninstalledSnapshot: ResourceSnapshot | null = null;
    if (explicitlyDeleted) {
      if (options.preserveTranscript || !currentDefinition) throw new Error("This mode's installed resources were deleted; select its current mode before starting");
      uninstalledSnapshot = (await resolveSavedModeSettings(source.snapshot, undefined, sessionManager.getCwd(), undefined, currentDefinition)).snapshot;
      console.info("[mode-pack] restoring conversation after explicit resource uninstall", { sessionId, modePackId: source.snapshot.profileId, previousPackageContentHash: source.snapshot.packageContentHash ?? null });
    }
    const courseHostUpgradeSnapshot = !options.preserveTranscript && !courseMigrationSnapshot && !uninstalledSnapshot
      ? await refreshBuiltinCourseHost(source.snapshot, sessionManager.getCwd()) : null;
    await ensureSelectedPackageDependencies(courseHostUpgradeSnapshot ?? courseMigrationSnapshot ?? uninstalledSnapshot ?? source.snapshot, snapshotSelection(courseHostUpgradeSnapshot ?? courseMigrationSnapshot ?? uninstalledSnapshot ?? source.snapshot));
    restorePresentedSessionFile = restoreScratch
      ? presentAuthoritativeSessionFile(sessionManager, sessionFile)
      : null;
    let runtimeSnapshot = courseHostUpgradeSnapshot ?? courseMigrationSnapshot ?? uninstalledSnapshot ?? source.snapshot;
    let editedLocalSkills: string[] = [];
    try {
      candidate = await createModePackCandidate({ sessionManager, snapshot: runtimeSnapshot });
    } catch (error) {
      if (options.preserveTranscript || runtimeSnapshot.packageContentHash
        || !(error instanceof Error) || !error.message.startsWith("Mode Pack resource identity changed: skill:")) throw error;
      const refreshed = await refreshEditedLocalSkills(runtimeSnapshot, sessionManager.getCwd());
      if (!refreshed) throw error;
      runtimeSnapshot = refreshed.snapshot;
      editedLocalSkills = refreshed.changedSkills;
      candidate = await createModePackCandidate({ sessionManager, snapshot: runtimeSnapshot });
    }
    if (editedLocalSkills.length || uninstalledSnapshot || courseMigrationSnapshot || courseHostUpgradeSnapshot) {
      const refreshed = prepareModePackSessionBinding({
        sessionId: sessionManager.getSessionId(),
        targetSnapshot: runtimeSnapshot,
        history: recovery.history,
        inherited: recovery.inherited,
        idempotencyKey: `${courseHostUpgradeSnapshot ? "course-host-upgrade-v1" : learningMigration ? "learning-workflow-defaults-v1" : courseMigrationSnapshot ? "course-skill-retirement-v1" : uninstalledSnapshot ? "resource-uninstall" : "local-skill-refresh"}:${source.requestHash}:${runtimeSnapshot.contentHash}`,
      });
      appendModePackBinding(sessionManager, refreshed.binding);
      console.info("[mode-pack] rebound changed resources on session restart", {
        modePackId: runtimeSnapshot.profileId,
        previousSnapshotId: source.snapshot.resourceSnapshotId,
        snapshotId: runtimeSnapshot.resourceSnapshotId,
        skills: editedLocalSkills,
      });
    } else if (!recovery.current) {
      const inherited = prepareModePackSessionBinding({
        sessionId: sessionManager.getSessionId(),
        targetSnapshot: runtimeSnapshot,
        history: [],
        inherited: source,
        idempotencyKey: `inherit:${source.bindingId}:${sessionManager.getSessionId()}`,
      });
      appendModePackBinding(sessionManager, inherited.binding);
    }
    if (candidate.wrapper.sessionId !== sessionId) {
      throw new Error("Recovered Mode Pack runtime changed the Pi session identity");
    }
    if (restoreScratch) {
      sessionManager.setSessionFile(sessionFile);
      const restorePresented = restorePresentedSessionFile;
      if (!restorePresented) throw new Error("Mode Pack rollback lost its authoritative transcript presentation");
      restorePresented();
      restorePresentedSessionFile = null;
      // Give the SDK's already-queued startup synchronization one event-loop
      // turn while it is still inside this private rollback transaction.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const preserved = readFileSync(sessionFile);
      if (!originalBytes || !preserved.equals(originalBytes)) {
        throw new Error("Mode Pack rollback changed the durable Pi transcript");
      }
    } else {
      persistCommittedRuntimeSettings(candidate.wrapper.inner);
    }
    registerPreparedWrapper(candidate.wrapper);
    return { session: candidate.wrapper, realSessionId: sessionId };
  } catch (error) {
    if (candidate) await shutdownFailedModePackCandidate("persisted candidate", () => candidate!.wrapper.shutdown());
    throw error;
  } finally {
    restorePresentedSessionFile?.();
    if (restoreScratch) rmSync(restoreScratch, { force: true });
  }
}
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: Base.RpcSessionStartOptions = {},
): Promise<{ session: Base.AgentSessionWrapper; realSessionId: string }> {
  if (globalThis.__piModePackActivationLocks?.has(sessionId)) {
    throw new Error("A Mode Pack activation is in progress; retry after runtime cutover.");
  }
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
      // Restore a fork's inherited binding before revising its own settings.
      if (!recovery.current) {
        if (!sessionFile) throw new Error("Session file is required to restore inherited mode settings");
        await startRpcSession(sessionId, sessionFile, undefined);
        return setRpcSessionTools(sessionId, sessionFile, requestedToolNames);
      }
      const snapshot = recovery.current.snapshot;
      if (requestedToolNames === undefined) throw new Error("toolNames is required");
      await activateGenericModePack({ sessionId, modePackId: snapshot.profileId,
        expectedSnapshotId: snapshot.resourceSnapshotId, idempotencyKey: randomUUID(),
        settingsPatch: { tools: requestedToolNames } });
      const session = Base.getRpcSession(sessionId);
      if (!session?.isAlive()) throw new Error("Tool settings committed but the runtime is unavailable; reopen this session");
      return { session, sessionId, recreated: true };
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
      packageContentHash: binding?.snapshot.packageContentHash ?? null,
    };
  }
  const expected = {
    ...plan.expected,
    activeTools: expectedModePackActiveTools(wrapper.inner, plan),
  };
  const evidence = collectModePackRuntimeEvidence(wrapper.inner, plan);
  const verification = verifyBoundModePackRuntime(binding.snapshot, evidence, expected, plan, wrapper.inner);
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
    packageContentHash: binding.snapshot.packageContentHash ?? null,
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
  const runtimeInventory = recovery.current
    ? await packageInventory(sessionManager.getCwd(), recovery.current.snapshot, snapshotSelection(recovery.current.snapshot))
    : listed.inventory;
  let runtime: GenericModePackRuntimeStatus;
  if (live?.isAlive()) {
    let plan: ModePackRuntimePlan | undefined;
    if (recovery.current) {
      try {
        plan = buildModePackRuntimePlanFromInventory({
          snapshot: recovery.current.snapshot,
          inventory: runtimeInventory,
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
          packageContentHash: recovery.current.snapshot.packageContentHash ?? null,
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
      packageContentHash: recovery.current?.snapshot.packageContentHash ?? null,
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

function settingsForRebasedSnapshot(
  snapshot: ResourceSnapshot,
  fresh: ResourceSnapshot,
  options: { preserveMissingOptionalSkills: boolean; retireCourseSkills?: boolean; learningWorkflowDefaults?: boolean },
): ModePackSettingsPatch {
  const previouslyKnownSkills = knownPortableSkillIds(snapshot);
  const skills = new Map(fresh.resources
    .filter((resource) => resource.kind === "skill" && !resource.required)
    .map((resource) => {
      const prior = snapshot.resources.find((candidate) => candidate.kind === "skill" && candidate.id === resource.id);
      // Legacy inventories represent an omitted optional Skill as disabled.
      // Portable definitions carry their own effective defaults, so only those
      // may introduce a newly default-enabled resource during a package rebase.
      return [resource.id, {
        id: resource.id,
        // A snapshot cannot carry a disabled descriptor, but its prior archive
        // can. Preserve that choice; only a Skill absent from the old archive
        // is genuinely new and may take this revision's enabled default.
        enabled: prior?.enabled ?? (previouslyKnownSkills.has(resource.id) ? false : (snapshot.packageContentHash || (options.learningWorkflowDefaults && resource.id === "pi-caw") ? resource.enabled : false)),
      }] as const;
    }));
  // A legacy byte refresh can omit a selected local optional resource while
  // its catalog entry remains valid. An explicit Mode Package definition
  // refresh is different: its components are the authoritative selection and
  // must be able to remove a resource even when payload bytes share a hash.
  if (options.preserveMissingOptionalSkills) {
    for (const prior of snapshot.resources) {
      if (prior.kind !== "skill" || prior.required) continue;
      if (options.retireCourseSkills && isRetiredCourseResource(prior.kind, prior.id)) continue;
      const replacement = fresh.resources.find((resource) => resource.kind === "skill" && resource.id === prior.id);
      if (!replacement || !replacement.required) skills.set(prior.id, { id: prior.id, enabled: prior.enabled });
    }
  }
	let systemPrompt: string | undefined;
	try {
		const saved = modeSystemPrompt(snapshot);
		const customized = modePackSystemPromptIsCustomized(snapshot);
		const archivedDefault = customized === undefined && snapshot.packageContentHash
			? activePortableModePackageForSnapshot(snapshot)?.definition.systemPrompt.trim()
			: undefined;
		// A personal tools/model revision creates a settings envelope even when
		// the prompt itself was never edited. The committed baseline, rather than
		// the immutable archive payload, distinguishes definition B's same-payload
		// default from a user override when definition C is selected later.
		if (!(options.retireCourseSkills && isKnownLegacyCourseDefaultPrompt(saved))
      && !(options.learningWorkflowDefaults && isPreviousStudyDefaultPrompt(saved))
      && (customized ?? (!archivedDefault || saved !== archivedDefault))) systemPrompt = saved;
  } catch {
    // Pre-v1 bindings had no mode settings envelope. Their old instructions
    // must not be copied into a current package during an explicit upgrade.
  }
  return {
    ...(snapshot.provider && snapshot.model ? { provider: snapshot.provider, model: snapshot.model } : {}),
    thinkingLevel: snapshot.thinkingLevel,
    ...(systemPrompt ? { systemPrompt } : {}),
    tools: [...snapshot.tools],
    skills: [...skills.values()],
  };
}

export async function resolveSavedModeSettings(
  snapshot: ResourceSnapshot,
  patch: ModePackSettingsPatch | undefined,
  cwd: string,
  createdAt?: string,
  explicitDefinition?: ModePackDefinition,
) {
  const store = modePackStore();
  const selection = explicitDefinition
    ? selectionForExplicitModeActivation(explicitDefinition, snapshot, patch)
    : snapshotSelection(snapshot, patch);
  // Package payload identity deliberately excludes definition policy. An
  // explicit activation/reload therefore resolves the selected definition
  // even when its packageContentHash is unchanged. Settings-only revisions do
  // not pass explicitDefinition and retain their committed definition.
  if (explicitDefinition) {
    const fresh = await store.resolve(snapshot.profileId, cwd, createdAt, selection);
    if (fresh.snapshot.role !== snapshot.role || fresh.snapshot.mode !== snapshot.mode) {
      throw new Error("Mode role changed; select the updated mode explicitly");
    }
    // A portable definition is its own authoritative resource policy. Legacy
    // definitions retain their historical byte-refresh behavior so Education
    // and other catalog-backed modes do not lose an omitted local resource.
    const preserveMissingOptionalSkills = !explicitDefinition.packageContentHash;
    const retireCourseSkills = explicitDefinition.instructions.includes(COURSE_WORKFLOW_MIGRATION_MARKER)
      && needsCourseWorkflowSnapshotMigration(snapshot, snapshot.packageContentHash ? activePortableModePackageForSnapshot(snapshot) : null);
    const learningWorkflowDefaults = explicitDefinition.instructions.includes(LEARNING_WORKFLOW_CONTROL_MARKER) && needsLearningWorkflowDefaults(snapshot);
    if (retireCourseSkills) for (const resource of snapshot.resources) {
      if (!resource.enabled || isRetiredCourseResource(resource.kind, resource.id)) continue;
      const installed = fresh.inventory.catalog.get(resource.kind, resource.id);
      if (!installed || installed.available === false) throw new Error(`Course Workflow migration retained resource is missing: ${resource.kind}:${resource.id}`);
      if (resource.required && !fresh.snapshot.resources.some(item => item.kind === resource.kind && item.id === resource.id && item.enabled))
        throw new Error(`Course Workflow migration would discard an unrelated required resource: ${resource.kind}:${resource.id}`);
    }
    let rebased = reviseModePackSettings(fresh.snapshot, settingsForRebasedSnapshot(snapshot, fresh.snapshot, {
      preserveMissingOptionalSkills: preserveMissingOptionalSkills || retireCourseSkills, retireCourseSkills, learningWorkflowDefaults,
    }), fresh.inventory.catalog, createdAt);
    if (patch) rebased = reviseModePackSettings(rebased, patch, fresh.inventory.catalog, createdAt);
    console.info("[mode-pack] rebased saved settings onto explicitly selected package", {
      modePackId: snapshot.profileId,
      previousPackageContentHash: snapshot.packageContentHash ?? null,
      packageContentHash: explicitDefinition.packageContentHash ?? null,
      previousSnapshotId: snapshot.resourceSnapshotId,
      snapshotId: rebased.resourceSnapshotId,
    });
    return { inventory: fresh.inventory, definition: fresh.definition, snapshot: rebased };
  }
  const inventory = await packageInventory(cwd, snapshot, selection);
  const changed = snapshot.resources.filter((resource) => {
    if (!resource.enabled) return false;
    const installed = inventory.catalog.get(resource.kind, resource.id);
    return !installed || installed.version !== resource.version || installed.contentHash !== resource.contentHash;
  });
  if (!changed.length) return { inventory, definition: undefined, snapshot: patch ? reviseModePackSettings(snapshot, patch, inventory.catalog, createdAt) : snapshot };

  // Settings-only edits own the already committed portable definition. A
  // resource drift cannot safely be rebuilt from ModePackStore because that
  // store resolves the latest same-ID definition (and could install its new
  // dependencies). Require the user to make that adoption explicit.
  if (snapshot.packageContentHash) {
    throw new Error(
      `Selected portable Mode Pack resources changed (${changed.map((resource) => `${resource.kind}:${resource.id}`).join(", ")}); explicitly reload or activate the Mode Pack to refresh its committed definition.`,
    );
  }

  // Rebuild from current mode instructions and resource identities, then reapply
  // the user's settings. Reusing the old snapshot would also retain old Skill text.
  const fresh = await store.resolve(snapshot.profileId, cwd, createdAt, selection);
  if (fresh.snapshot.role !== snapshot.role || fresh.snapshot.mode !== snapshot.mode) throw new Error("Mode role changed; select the updated mode explicitly");
  let refreshed = reviseModePackSettings(fresh.snapshot, settingsForRebasedSnapshot(snapshot, fresh.snapshot, {
    preserveMissingOptionalSkills: !snapshot.packageContentHash || snapshot.packageContentHash === fresh.snapshot.packageContentHash,
  }), fresh.inventory.catalog, createdAt);
  if (patch) refreshed = reviseModePackSettings(refreshed, patch, fresh.inventory.catalog, createdAt);
  console.info("[mode-pack] refreshed saved settings against installed resources", { modePackId: snapshot.profileId, previousSnapshotId: snapshot.resourceSnapshotId, snapshotId: refreshed.resourceSnapshotId, resources: changed.map((resource) => `${resource.kind}:${resource.id}`) });
  return { inventory: fresh.inventory, definition: undefined, snapshot: refreshed };
}

export async function activateGenericModePack(
  options: ActivateGenericModePackOptions,
): Promise<ActivateGenericModePackResult> {
  if (!options.idempotencyKey.trim()) throw new Error("Mode Pack activation requires an idempotency key");
  const lease = modePackTransitions.getStore()?.get(options.sessionId);
  if (!lease?.active) return withModePackTransition(options.sessionId, () => activateGenericModePack(options));
  const existing = lease.existing;
  let candidate: Base.AgentSessionWrapper | null = null;
  let candidateScratch: string | null = null;
  let restoreCandidateSessionFile: (() => void) | null = null;
  let journalCommitted = false;
  let persistedSessionFile: string | null = null;
  try {
    // Resolve and validate the NEW snapshot directly for an explicit activation.
    // Restoring the old runtime first would make stale required resources impossible to upgrade.
    const dormantPath = existing ? null : await resolveSessionPath(options.sessionId);
    if (!existing && !dormantPath) throw new Error(`Pi session not found: ${options.sessionId}`);
    const manager = existing?.inner.sessionManager ?? SessionManager.open(dormantPath!, undefined);
    if (manager.getSessionId() !== options.sessionId) throw new Error("Pi session identity mismatch");
    const recovery = modePackRecovery(manager);
    const settingsPatch = options.settingsPatch === undefined ? undefined : parseModePackSettingsPatch(options.settingsPatch);
    const prior = recovery.history.find((item) => item.idempotencyKey === options.idempotencyKey);
    if (prior) {
      if (prior.snapshot.profileId !== options.modePackId || prior.previousSnapshotId !== options.expectedSnapshotId) {
        throw new Error("Mode Pack activation idempotency key was reused for another request.");
      }
      if (recovery.current?.requestHash !== prior.requestHash) {
        throw new Error("The original idempotent activation is no longer the active Mode Pack.");
      }
      if (settingsPatch) {
        const previous = recovery.history.find((item) => item.snapshot.resourceSnapshotId === options.expectedSnapshotId);
        if (!previous) throw new Error("Cannot validate settings retry without its previous snapshot");
        const retried = await resolveSavedModeSettings(previous.snapshot, settingsPatch, manager.getCwd(), prior.snapshot.createdAt);
        if (retried.snapshot.contentHash !== prior.snapshot.contentHash) {
          throw new Error("Mode Pack settings idempotency key was reused for another request.");
        }
      }
      const status = await getGenericModePackStatus(options.sessionId);
      return { sessionId: options.sessionId, binding: prior, runtime: status.runtime, replay: true };
    }
    const currentSnapshotId = recovery.current?.snapshot.resourceSnapshotId ?? null;
    if (currentSnapshotId !== options.expectedSnapshotId) {
      throw new Error("The active Mode Pack snapshot changed before this activation.");
    }
    const savedSettings = [...recovery.history].reverse().find((item) => item.snapshot.profileId === options.modePackId && hasSessionSettings(item.snapshot));
    const source = settingsPatch ? recovery.current : savedSettings;
    if (settingsPatch && source?.snapshot.profileId !== options.modePackId) throw new Error("Settings must target the current mode");
    // Resolve selection before dependency installation. A restore and a settings
    // revision use the same identity as the later inventory/runtime plan.
    // A settings revision is an ordinary revision of the active immutable
    // binding. It must not discover a newer definition with the same ID:
    // import/update adoption happens only on an explicit mode activation.
    const target = settingsPatch
      ? undefined
      : await modePackStore().migrateLearningWorkflowDefinition(options.modePackId, manager.getCwd())
        ?? (options.modePackId === "coding"
          ? bundledCodeModePackage().definition
          : (await inspectModePackInventory(manager.getCwd())).builtinPacks[options.modePackId]);
    if (!source && !target) throw new Error(`Unknown Mode Pack: ${options.modePackId}`);
    const selection = settingsPatch
      ? snapshotSelection(source!.snapshot, settingsPatch)
      : target
        ? selectionForExplicitModeActivation(target, source?.snapshot, undefined)
        : snapshotSelection(source!.snapshot);
    const packageHash = settingsPatch
      ? source!.snapshot.packageContentHash
      : target?.packageContentHash ?? source?.snapshot.packageContentHash;
    if (packageHash) {
      const archive = activePortableModePackage(packageHash);
      if (!archive) throw new Error(`Portable Mode Package is unavailable: ${packageHash}`);
      // All fallible package work precedes candidate replacement and binding.
      await ensurePortableModePackageInstalled(archive, selection);
    }
    const resolved = source
      ? await resolveSavedModeSettings(source.snapshot, settingsPatch, manager.getCwd(), options.createdAt, settingsPatch ? undefined : target ?? undefined)
      : await modePackStore().resolve(options.modePackId, manager.getCwd(), options.createdAt, selection);
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
    persistUnflushedSession(manager);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile)) {
      throw new Error("Mode Pack activation could not persist the current Pi session before replacement");
    }
    persistedSessionFile = sessionFile;
    // Candidate construction starts extensions and lets the SDK synchronize its
    // selected model/thinking state. It must not write that speculative state
    // into the durable transcript before the binding journal is committed.
    // Use an exact private clone, then attach the already-ready runtime only
    // after the old runtime has stopped and the pre-commit bytes still match.
    const candidateBaseline = readFileSync(sessionFile);
    candidateScratch = `${sessionFile}.candidate-${process.pid}-${randomUUID()}.jsonl`;
    copyFileSync(sessionFile, candidateScratch);
    const candidateManager = SessionManager.open(candidateScratch, undefined);
    restoreCandidateSessionFile = presentAuthoritativeSessionFile(candidateManager, sessionFile);
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
      preservedModel: existing?.inner.model
        ? { provider: existing.inner.model.provider, id: existing.inner.model.id }
        : undefined,
    });
    candidate = created.wrapper;
    candidate.setProfileTransitionLocked(true);
    if (candidate.sessionId !== options.sessionId) {
      throw new Error("Prepared Mode Pack runtime changed the Pi session identity");
    }
    if (existing) await existing.shutdown();
    candidate.inner.sessionManager.setSessionFile(sessionFile);
    restoreCandidateSessionFile();
    restoreCandidateSessionFile = null;
    if (!readFileSync(sessionFile).equals(candidateBaseline)) {
      throw new Error("Mode Pack candidate changed the durable Pi transcript before binding commit");
    }
    appendModePackBinding(candidate.inner.sessionManager, prepared.binding);
    journalCommitted = true;
    persistCommittedRuntimeSettings(candidate.inner);
    registerPreparedWrapper(candidate);
    const runtime = runtimeStatusFromLive(candidate, prepared.binding, recovery.inherited, plan);
    if (!runtime.verified) {
      throw new Error(runtime.diagnostic ?? "Committed Mode Pack runtime failed verification");
    }
    candidate.releaseProfileTransition();
    console.info("[mode-pack] activated", { sessionId: options.sessionId, modePackId: options.modePackId, revision: prepared.binding.revision, snapshotId: resolved.snapshot.resourceSnapshotId, settings: settingsPatch ? Object.keys(settingsPatch) : [] });
    return {
      sessionId: options.sessionId,
      binding: prepared.binding,
      runtime,
      replay: false,
    };
  } catch (error) {
    if (candidate) {
      const candidateToShutdown = candidate;
      await shutdownFailedModePackCandidate("activation candidate", () => candidateToShutdown.shutdown());
    }
    if (journalCommitted) {
      // The Pi JSONL is the commit authority. Once the new binding is durable,
      // never resurrect the previous runtime: a restart must recover the new
      // snapshot or fail closed.
      throw new Error(
        `Mode Pack activation committed to the Pi transcript but the live runtime could not be verified. Reopen the session to recover the committed snapshot. Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (existing && !Base.getRpcSession(options.sessionId)?.isAlive() && persistedSessionFile && existsSync(persistedSessionFile)) {
      // The activation lock deliberately remains held until restoration is
      // complete. Calling public startRpcSession would reject that same lock;
      // this private path creates only the prior durable binding and never
      // grants another caller a cutover window.
      await startPersistedModePackSession(options.sessionId, persistedSessionFile, { preserveTranscript: true }).catch((restoreError) => {
        console.error("[mode-pack] failed to restore previous Pi runtime", restoreError);
      });
    }
    throw error;
  } finally {
    candidate?.releaseProfileTransition();
    restoreCandidateSessionFile?.();
    if (candidateScratch) rmSync(candidateScratch, { force: true });
  }
}

/** Initialize a project capability and commit its refreshed resource snapshot
 * under the exact transition lease used by every Mode Pack activation. The
 * callback is intentionally invoked only after capability/staleness/busy
 * validation, so a duplicate request cannot run an external initializer. */
export async function initializeModePackProjectCapability<T>(options: {
  sessionId: string;
  expectedSnapshotId: string;
  idempotencyKey: string;
  capability: string;
  initialize: (cwd: string) => Promise<T>;
}): Promise<{ initialized: T; activation: ActivateGenericModePackResult }> {
  if (!options.expectedSnapshotId.trim()) throw new Error("Spec Kit request belongs to a stale Mode Pack snapshot");
  if (!options.idempotencyKey.trim()) throw new Error("Mode Pack activation requires an idempotency key");
  return withModePackTransition(options.sessionId, async () => {
    const existing = modePackTransitions.getStore()?.get(options.sessionId)?.existing;
    const dormantPath = existing ? null : await resolveSessionPath(options.sessionId);
    if (!existing && !dormantPath) throw new Error(`Pi session not found: ${options.sessionId}`);
    const manager = existing?.inner.sessionManager ?? SessionManager.open(dormantPath!, undefined);
    if (manager.getSessionId() !== options.sessionId) throw new Error("Pi session identity mismatch");
    const current = modePackRecovery(manager).current;
    if (!current || current.snapshot.resourceSnapshotId !== options.expectedSnapshotId) {
      throw new Error("Spec Kit request belongs to a stale Mode Pack snapshot");
    }
    const archive = current.snapshot.packageContentHash
      ? activePortableModePackageForSnapshot(current.snapshot)
      : null;
    if (!archive?.projectCapabilities.includes(options.capability)) {
      throw new Error("Spec Kit is not enabled by the active Mode Pack");
    }
    const initialized = await options.initialize(manager.getCwd());
    const activation = await activateGenericModePack({
      sessionId: options.sessionId,
      modePackId: current.snapshot.profileId,
      expectedSnapshotId: current.snapshot.resourceSnapshotId,
      idempotencyKey: options.idempotencyKey,
    });
    return { initialized, activation };
  });
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
    const session = Base.getRpcSession(initial.realSessionId);
    if (session) await shutdownFailedModePackCandidate("initial activation", () => session.shutdown());
    throw error;
  }
}
