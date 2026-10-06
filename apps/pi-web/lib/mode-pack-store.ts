import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import lockfile from "proper-lockfile";
import type {
  ModePackDefinition,
  ModePackDraft,
  ResourceSnapshot,
} from "../../../packages/harness-contracts/src/index.ts";
import { parseModePackDefinition, parseModePackDraft, parseResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { contentHash, deterministicId, stableStringify } from "../../../packages/harness-core/src/index.ts";
import {
  compileModePackDraft,
  inspectModePackAvailability,
  resolveModePackSnapshot,
} from "../../../packages/profile-resource-host/src/index.ts";
import {
  assertGenericModePackSnapshot,
  assertModePackDefinitionIntegrity,
  assertPortableModePackageContentHash,
  portableModuleProfileIds,
} from "../../../packages/mode-pack-host/src/index.ts";
import {
  inspectModePackInventory,
  type ModePackInventory,
} from "./mode-pack-inventory";
import { modePackStorePathFromEnvironment } from "./mode-pack-paths";
import { bundledCodeModePackage } from "./bundled-code-mode-package";
import { ensurePortableModePackageArchive, type PortableModePackageSelection } from "./portable-mode-package-install";
import { readPortableModePackage, withPortableModePackageCandidate } from "./portable-mode-pack-registry";
import { COURSE_BUILDER_DRAFT } from "./course-builder-pack";
import { courseWorkflowRetirementDraft, needsCourseWorkflowDefinitionMigration, COURSE_WORKFLOW_MIGRATION_MARKER, isBuiltinCourseHostUpgrade } from "./course-workflow-migration";
import { learningWorkflowDefaultsDraft, needsLearningWorkflowDefaults, LEARNING_WORKFLOW_CONTROL_MARKER } from "./learning-workflow-defaults";
import { studyModePhaseForSnapshot } from "./study-mode-policy";
import { STUDY_RESEARCH_DRAFTS } from "./study-research-pack";

const STORE_VERSION = 1;
const EDITABLE_BUILTIN_IDS = new Set(["coding", "general", "creative", "course-builder", "study-research.study", "study-research.research"]);
const SIMPLE_BUILTIN_IDS = new Set(["coding", "general", "creative"]);

interface PersistedModePackStore {
  version: typeof STORE_VERSION;
  histories: Record<string, ModePackDefinition[]>;
  /** Successful shared providers remain addressable by committed snapshots
   * after their owning mode is removed. They do not enter current arbitration. */
  retainedSharedPackageHashes: string[];
  /** Exact archives still required by already committed session snapshots. */
  retainedSnapshotPackageHashes: string[];
}

export interface ModePackListItem {
  definition: ModePackDefinition;
  builtin: boolean;
  selectable: boolean;
  missingRequiredResources: string[];
  missingOptionalResources: string[];
  identityMismatches: string[];
  /** A package-specific corruption error. Other mode definitions remain usable. */
  packageError?: string;
}

function emptyStore(): PersistedModePackStore {
  return { version: STORE_VERSION, histories: {}, retainedSharedPackageHashes: [], retainedSnapshotPackageHashes: [] };
}

function parseStore(value: unknown): PersistedModePackStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mode Pack store must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!["version", "histories", "retainedSharedPackageHashes", "retainedSnapshotPackageHashes"].includes(key)) throw new Error(`modePackStore.${key}: unknown field`);
  for (const key of ["version", "histories"]) if (!(key in record)) throw new Error(`modePackStore.${key}: missing required field`);
  if (record.version !== STORE_VERSION) throw new Error("Unsupported Mode Pack store version");
  if (!record.histories || typeof record.histories !== "object" || Array.isArray(record.histories)) {
    throw new Error("Mode Pack store histories must be an object");
  }
  const histories: Record<string, ModePackDefinition[]> = {};
  for (const [modePackId, rawHistory] of Object.entries(record.histories as Record<string, unknown>)) {
    if (!modePackId.startsWith("custom.") && !EDITABLE_BUILTIN_IDS.has(modePackId)) throw new Error(`Stored Mode Pack id is not editable: ${modePackId}`);
    if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
      throw new Error(`Mode Pack history is empty: ${modePackId}`);
    }
    const history = rawHistory.map((item) => assertModePackDefinitionIntegrity(item));
    let revision = history[0]!.revision - 1;
    for (const definition of history) {
      if (definition.modePackId !== modePackId) throw new Error(`Mode Pack history id mismatch: ${modePackId}`);
      if (definition.revision !== revision + 1) throw new Error(`Mode Pack history revisions are not contiguous: ${modePackId}`);
      // Imported archives may carry course-bound roles. Their immutable bytes
      // are validated at import; editable global drafts retain the stricter
      // general-mode policy below.
      if (!definition.packageContentHash) assertGenericDefinition(definition);
      revision = definition.revision;
    }
    histories[modePackId] = history;
  }
  const retainedSharedPackageHashes = record.retainedSharedPackageHashes === undefined ? [] : (() => {
    if (!Array.isArray(record.retainedSharedPackageHashes)) throw new Error("Mode Pack retained shared providers must be an array");
    const hashes = record.retainedSharedPackageHashes.map((value) => assertPortableModePackageContentHash(value, "retained shared package hash"));
    if (new Set(hashes).size !== hashes.length) throw new Error("Mode Pack retained shared providers contain duplicates");
    return hashes;
  })();
  const retainedSnapshotPackageHashes = record.retainedSnapshotPackageHashes === undefined ? [] : (() => {
    if (!Array.isArray(record.retainedSnapshotPackageHashes)) throw new Error("Mode Pack retained snapshot archives must be an array");
    const hashes = record.retainedSnapshotPackageHashes.map((value) => assertPortableModePackageContentHash(value, "retained snapshot package hash"));
    if (new Set(hashes).size !== hashes.length) throw new Error("Mode Pack retained snapshot archives contain duplicates");
    return hashes;
  })();
  // Migrate older stores with immutable definition histories to one current
  // definition, while retaining their exact archives for bound sessions.
  for (const history of Object.values(histories)) for (const prior of history.slice(0, -1)) {
    if (prior.packageContentHash) retainedSnapshotPackageHashes.push(prior.packageContentHash);
  }
  return { version: STORE_VERSION, histories, retainedSharedPackageHashes, retainedSnapshotPackageHashes: [...new Set(retainedSnapshotPackageHashes)].sort() };
}

/** Local source Skills are edited in place. Their old content pin is a signal
 * to advance the mode revision, not an availability failure. Portable files,
 * missing resources and unrelated identity drift remain strict. */
function hasOnlyEditedLocalSkills(availability: ReturnType<typeof inspectModePackAvailability>, inventory: ModePackInventory): boolean {
  return availability.identityMismatches.length > 0
    && availability.missingRequiredResources.length === 0
    && availability.missingOptionalResources.length === 0
    && availability.identityMismatches.every((key) => {
      if (!key.startsWith("skill:")) return false;
      const installed = inventory.resourcesByKey.get(key);
      return installed?.kind === "skill" && installed.scope === "platform"
        && (installed.source === "pi-own-mode-pack" || installed.source === "pi-own")
        && installed.paths.length === 1;
    });
}

function retainPriorArchive(store: PersistedModePackStore, modePackId: string, nextHash?: string): void {
  const priorHash = store.histories[modePackId]?.at(-1)?.packageContentHash;
  if (priorHash && priorHash !== nextHash) {
    store.retainedSnapshotPackageHashes = [...new Set([...store.retainedSnapshotPackageHashes, priorHash])].sort();
  }
}

function assertGenericDefinition(definition: ModePackDefinition): void {
  if (definition.role !== "general" || definition.runtimeMode !== "general" || definition.courseRequired) {
    throw new Error("Custom global Mode Packs must use role=general, runtimeMode=general, and courseRequired=false");
  }
  if (definition.components.some((component) => component.type === "plugin" && component.id === "learning-harness")) {
    throw new Error("Custom global Mode Packs cannot include the course-only learning-harness plugin");
  }
}

export function modePackDefinitionSelection(definition: ModePackDefinition): PortableModePackageSelection {
  return {
    resources: definition.components.map((component) => ({
      kind: component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type,
      id: component.type === "workflow" ? `workflow:${component.id}` : component.id,
      enabled: component.enabled,
    })),
  };
}

function modePackDraftSelection(draft: ModePackDraft): PortableModePackageSelection {
  return {
    resources: draft.components.map((component) => ({
      kind: component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type,
      id: component.type === "workflow" ? `workflow:${component.id}` : component.id,
      enabled: component.enabled,
    })),
  };
}

function readStore(path: string): PersistedModePackStore {
  if (!existsSync(path)) return emptyStore();
  const text = readFileSync(path, "utf8");
  if (!text.trim()) throw new Error("Mode Pack store is empty or truncated");
  return parseStore(JSON.parse(text) as unknown);
}

function ensureStoreFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return;
  try {
    writeFileSync(path, `${stableStringify(emptyStore())}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!existsSync(path)) throw error;
  }
}

function writeStore(path: string, store: PersistedModePackStore): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const compact = { ...store, histories: Object.fromEntries(Object.entries(store.histories).map(([id, history]) => [id, [history.at(-1)!]])) };
    // Flush the writable handle: Windows rejects fsync on a read-only handle.
    writeFileSync(temporary, `${stableStringify(compact)}\n`, { encoding: "utf8", flag: "wx", flush: true });
    renameSync(temporary, path);
    // Windows does not support opening directories for fsync through Node.
    if (process.platform !== "win32") {
      const descriptor = openSync(dirname(path), "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[mode-pack-store] failed to remove temporary store", { temporary, cleanupError });
      }
    }
    throw error;
  }
}

export function modePackStorePath(): string {
  return modePackStorePathFromEnvironment();
}

async function withStoreLock<T>(path: string, operation: () => Promise<T> | T): Promise<T> {
  ensureStoreFile(path);
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
    stale: 10_000,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function latestDefinitions(store: PersistedModePackStore): ModePackDefinition[] {
  return Object.values(store.histories)
    .map((history) => history.at(-1))
    .filter((definition): definition is ModePackDefinition => definition !== undefined)
    .sort((left, right) => left.modePackId.localeCompare(right.modePackId));
}

/** Add discovered project capability resources to a new immutable snapshot.
 * Definitions intentionally stay portable: project files are discovered only
 * when a session is explicitly resolved in its project, then their exact
 * native-template identity is committed with that session binding. */
function withProjectCapabilityResources(snapshot: ResourceSnapshot, inventory: ModePackInventory): ResourceSnapshot {
  const projectResources = inventory.resources
    .filter((resource) => resource.source === "project:spec-kit")
    .map((resource) => ({
      kind: resource.kind,
      id: resource.id,
      version: resource.version,
      contentHash: resource.contentHash,
      required: true,
      enabled: true,
      ...(resource.delivery ? { delivery: resource.delivery } : {}),
    }));
  if (projectResources.length === 0) return snapshot;
  const existing = new Map(snapshot.resources.map((resource) => [`${resource.kind}:${resource.id}`, resource]));
  for (const resource of projectResources) existing.set(`${resource.kind}:${resource.id}`, resource);
  const resources = [...existing.values()].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  const payload = {
    version: snapshot.version,
    profileId: snapshot.profileId,
    profileRevision: snapshot.profileRevision,
    role: snapshot.role,
    mode: snapshot.mode,
    courseVersionId: snapshot.courseVersionId,
    provider: snapshot.provider,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    externalKnowledgePolicy: snapshot.externalKnowledgePolicy,
    tools: snapshot.tools,
    resources,
    instructions: snapshot.instructions,
    ...(snapshot.packageContentHash ? { packageContentHash: snapshot.packageContentHash } : {}),
    ...(snapshot.modePackSystemPromptDefaultHash ? { modePackSystemPromptDefaultHash: snapshot.modePackSystemPromptDefaultHash } : {}),
    ...(snapshot.modePackSystemPromptMode ? { modePackSystemPromptMode: snapshot.modePackSystemPromptMode } : {}),
  };
  return parseResourceSnapshot({
    ...payload,
    resourceSnapshotId: deterministicId("snapshot", { ...payload, createdAt: snapshot.createdAt }),
    createdAt: snapshot.createdAt,
    contentHash: contentHash(payload),
  });
}

export class ModePackStore {
  readonly path: string;

  constructor(path = modePackStorePath()) {
    this.path = resolve(path);
  }

  listCustom(): ModePackDefinition[] {
    return latestDefinitions(readStore(this.path)).map((definition) => structuredClone(definition));
  }

  getCustom(modePackId: string): ModePackDefinition | null {
    const definition = readStore(this.path).histories[modePackId]?.at(-1);
    return definition ? structuredClone(definition) : null;
  }

  /** Adopt the authorized Course production migration without changing archive
   * bytes. Old session pins remain addressable; unrelated missing files still
   * fail the retained selection's normal catalog validation. */
  async migrateCourseWorkflowDefinition(modePackId: string, cwd: string): Promise<ModePackDefinition | null> {
    const previous = this.getCustom(modePackId);
    if (!previous) return null;
    if (!previous.components.some(component => component.type === "plugin" && component.id === "course-builder")) return previous;
    const archive = previous.packageContentHash ? readPortableModePackage(previous.packageContentHash) : null;
    if (previous.packageContentHash && !archive) throw new Error(`Portable Mode Package is unavailable: ${previous.packageContentHash}`);
    if (!needsCourseWorkflowDefinitionMigration(previous, archive)) return previous;
    const draft = courseWorkflowRetirementDraft(previous, COURSE_BUILDER_DRAFT);
    const inventory = await inspectModePackInventory(cwd, previous.packageContentHash ? {
      packageContentHash: previous.packageContentHash, selection: modePackDraftSelection(draft), useLatestSharedResources: true,
    } : {});
    if (inventory.diagnostics.some(item => item.severity === "error"))
      throw new Error(inventory.diagnostics.filter(item => item.severity === "error").map(item => item.message).join("; "));
    const next = compileModePackDraft(draft, inventory.catalog);
    return withStoreLock(this.path, () => {
      const store = readStore(this.path), current = store.histories[modePackId]?.at(-1);
      if (!current || current.contentHash !== previous.contentHash) {
        if (current && !needsCourseWorkflowDefinitionMigration(current, archive)) return structuredClone(current);
        throw new Error(`Course Workflow migration revision conflict: ${modePackId}`);
      }
      store.histories[modePackId] = [next];
      writeStore(this.path, store);
      console.info("[course-workflow] migrated current Mode Pack definition", { modePackId, previousRevision: previous.revision,
        revision: next.revision, packageContentHash: next.packageContentHash ?? null, migration: COURSE_WORKFLOW_MIGRATION_MARKER });
      return structuredClone(next);
    });
  }

  /** Versioned policy adoption keeps immutable archive bytes and personal settings. */
  async migrateLearningWorkflowDefinition(modePackId: string, cwd: string): Promise<ModePackDefinition | null> {
    const previous = await this.migrateCourseWorkflowDefinition(modePackId, cwd);
    if (!previous) return null;
    const identity = { profileId: previous.modePackId, packageContentHash: previous.packageContentHash, instructions: previous.instructions };
    if (!needsLearningWorkflowDefaults(identity)) return previous;
    const phase = studyModePhaseForSnapshot(identity);
    const defaults = STUDY_RESEARCH_DRAFTS.find(item => item.modePackId === `study-research.${phase}`)!;
    const draft = learningWorkflowDefaultsDraft(previous, defaults);
    const inventory = await inspectModePackInventory(cwd, previous.packageContentHash ? {
      packageContentHash: previous.packageContentHash, selection: modePackDraftSelection(draft), useLatestSharedResources: true,
    } : {});
    const errors = inventory.diagnostics.filter(item => item.severity === "error");
    if (errors.length) throw new Error(errors.map(item => item.message).join("; "));
    const next = compileModePackDraft(draft, inventory.catalog);
    return withStoreLock(this.path, () => {
      const store = readStore(this.path), current = store.histories[modePackId]?.at(-1);
      if (!current || current.contentHash !== previous.contentHash) {
        if (current?.instructions.includes(LEARNING_WORKFLOW_CONTROL_MARKER)) return structuredClone(current);
        throw new Error(`Learning Workflow defaults revision conflict: ${modePackId}`);
      }
      store.histories[modePackId] = [next]; writeStore(this.path, store);
      console.info("[study-workflow] adopted current Mode Pack defaults", { modePackId, previousRevision: previous.revision,
        revision: next.revision, packageContentHash: next.packageContentHash ?? null, migration: LEARNING_WORKFLOW_CONTROL_MARKER });
      return structuredClone(next);
    });
  }

  /** Explicit uninstall retires archives as well as their catalog references.
   * Session JSONL stays intact; the next activation rebases to the current mode. */
  async forgetUninstalledArchives(hashes: string[]): Promise<void> {
    await withStoreLock(this.path, () => {
      const store = readStore(this.path);
      const current = new Set(latestDefinitions(store).map(item => item.packageContentHash));
      for (const hash of hashes) {
        assertPortableModePackageContentHash(hash);
        if (current.has(hash)) throw new Error(`Cannot delete a current Mode Pack archive: ${hash}`);
      }
      const removed = new Set(hashes);
      store.retainedSharedPackageHashes = store.retainedSharedPackageHashes.filter(hash => !removed.has(hash));
      store.retainedSnapshotPackageHashes = store.retainedSnapshotPackageHashes.filter(hash => !removed.has(hash));
      writeStore(this.path, store);
    });
  }

  /** Commit a mechanically validated portable definition without converting it
   * into a global editable draft. A course-bound package keeps its role and
   * runtime identity; the consumer decides which session class can activate it. */
  async installArchiveDefinition(value: unknown, cwd: string, expectedRevision: number): Promise<ModePackDefinition> {
    return (await this.installArchiveDefinitions([value], cwd, expectedRevision))[0];
  }

  /** Validate every profile before committing the module in one store write. */
  async installArchiveDefinitions(values: unknown[], cwd: string, expectedRevision: number, preflight?: () => void, retainSharedPackageHash?: string, editableBuiltinRevisions: Readonly<Record<string, number>> = {}): Promise<ModePackDefinition[]> {
    if (values.length === 0) throw new Error("Portable module must contain at least one profile");
    const definitions = values.map((value) => assertModePackDefinitionIntegrity(value));
    if (new Set(definitions.map((definition) => definition.modePackId)).size !== definitions.length)
      throw new Error("Portable module contains duplicate profile ids");
    for (const definition of definitions) if ((!definition.modePackId.startsWith("custom.") && !(Object.hasOwn(editableBuiltinRevisions, definition.modePackId) && EDITABLE_BUILTIN_IDS.has(definition.modePackId))) || !definition.packageContentHash)
      throw new Error("Imported Mode Pack must have a custom id or an explicitly edited built-in identity, and immutable package identity");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative safe integer");
    }
    for (const definition of definitions) {
      const inventory = await inspectModePackInventory(cwd, {
        packageContentHash: definition.packageContentHash,
        selection: modePackDefinitionSelection(definition),
      });
      if (inventory.diagnostics.some((item) => item.severity === "error")) {
        throw new Error(inventory.diagnostics.map((item) => item.message).join("; "));
      }
      const availability = inspectModePackAvailability(definition, inventory.catalog);
      if (!availability.selectable) {
        throw new Error(`Imported Mode Pack ${definition.modePackId} is unavailable: ${[
          ...availability.missingRequiredResources.map((item) => `missing ${item}`),
          ...availability.identityMismatches.map((item) => `changed ${item}`),
        ].join(", ")}`);
      }
    }
    return withStoreLock(this.path, () => {
      const store = readStore(this.path);
      for (const definition of definitions) {
        const currentRevision = store.histories[definition.modePackId]?.at(-1)?.revision ?? editableBuiltinRevisions[definition.modePackId] ?? 0;
        if (currentRevision !== expectedRevision)
          throw new Error(`Mode Pack ${definition.modePackId} revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
        if (definition.revision !== currentRevision + 1)
          throw new Error(`Mode Pack ${definition.modePackId} archive revision must be ${currentRevision + 1}`);
      }
      preflight?.();
      if (retainSharedPackageHash) {
        const hash = assertPortableModePackageContentHash(retainSharedPackageHash);
        if (!definitions.every((definition) => definition.packageContentHash === hash)) throw new Error("Retained shared provider differs from imported archive");
        store.retainedSharedPackageHashes = [...new Set([...store.retainedSharedPackageHashes, hash])].sort();
      }
      for (const definition of definitions) {
        retainPriorArchive(store, definition.modePackId, definition.packageContentHash);
        store.histories[definition.modePackId] = [definition];
      }
      writeStore(this.path, store);
      return definitions.map((definition) => structuredClone(definition));
    });
  }

  async saveDraft(value: unknown, cwd: string, expectedRevision: number): Promise<ModePackDefinition> {
    const draft = parseModePackDraft(value);
    if (!draft.modePackId.startsWith("custom.") && !SIMPLE_BUILTIN_IDS.has(draft.modePackId)) throw new Error("This built-in Mode Pack must be edited through portable composition");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative safe integer");
    }
    const save = async (): Promise<ModePackDefinition> => {
      const inventory = await inspectModePackInventory(cwd, {
        ...(draft.packageContentHash ? { packageContentHash: draft.packageContentHash } : {}),
        ...(draft.packageContentHash ? { selection: modePackDraftSelection(draft) } : {}),
      });
      if (inventory.diagnostics.some((item) => item.severity === "error")) {
        throw new Error(inventory.diagnostics.map((item) => item.message).join("; "));
      }
      const definition = compileModePackDraft(draft, inventory.catalog);
      assertGenericDefinition(definition);
      const builtinRevision = SIMPLE_BUILTIN_IDS.has(definition.modePackId)
        ? definition.modePackId === "coding" ? bundledCodeModePackage().definition.revision : inventory.builtinPacks[definition.modePackId]?.revision
        : undefined;
      if (SIMPLE_BUILTIN_IDS.has(definition.modePackId) && builtinRevision === undefined) throw new Error(`Built-in Mode Pack is unavailable: ${definition.modePackId}`);
      return withStoreLock(this.path, () => {
        const store = readStore(this.path);
        const history = store.histories[definition.modePackId] ?? [];
        const currentRevision = history.at(-1)?.revision ?? builtinRevision ?? 0;
        if (currentRevision !== expectedRevision) {
          throw new Error(`Mode Pack revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
        }
        if (definition.revision !== currentRevision + 1) {
          throw new Error(`Mode Pack draft revision must be ${currentRevision + 1}`);
        }
        retainPriorArchive(store, definition.modePackId, definition.packageContentHash);
        store.histories[definition.modePackId] = [definition];
        writeStore(this.path, store);
        return structuredClone(definition);
      });
    };
    // A fresh user can clone built-in Coding before any activation. Materialize
    // only its immutable archive and scope it to this draft compilation; npm
    // dependencies remain absent until the custom pack is actually activated.
    const bundled = draft.packageContentHash === bundledCodeModePackage().packageContentHash
      ? bundledCodeModePackage()
      : null;
    if (!bundled) return save();
    await ensurePortableModePackageArchive(bundled);
    return withPortableModePackageCandidate(bundled, save);
  }

  async deleteCustom(modePackId: string, expectedRevision: number): Promise<void> {
    if (!modePackId.startsWith("custom.")) throw new Error("Built-in Mode Packs cannot be deleted");
    await withStoreLock(this.path, () => {
      const store = readStore(this.path);
      const currentRevision = store.histories[modePackId]?.at(-1)?.revision ?? 0;
      if (currentRevision === 0) throw new Error(`Unknown custom Mode Pack: ${modePackId}`);
      if (currentRevision !== expectedRevision) {
        throw new Error(`Mode Pack revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
      }
      const definition = store.histories[modePackId]?.at(-1);
      const archive = definition?.packageContentHash ? readPortableModePackage(definition.packageContentHash) : null;
      const layout = archive ? portableModuleProfileIds(archive, modePackId) : null;
      if (layout && layout.profileIds.length > 1)
        throw new Error(`Mode Pack ${modePackId} is a phase of module ${layout.moduleId}; delete the complete module`);
      retainPriorArchive(store, modePackId);
      delete store.histories[modePackId];
      writeStore(this.path, store);
    });
  }

  async deleteCustomModule(modePackId: string, expectedRevisions: Record<string, number>): Promise<string[]> {
    if (!modePackId.startsWith("custom.")) throw new Error("Built-in modules cannot be deleted");
    return withStoreLock(this.path, () => {
      const store = readStore(this.path);
      const definition = store.histories[modePackId]?.at(-1);
      if (!definition?.packageContentHash) throw new Error(`Unknown portable module profile: ${modePackId}`);
      const archive = readPortableModePackage(definition.packageContentHash);
      if (!archive) throw new Error(`Portable module archive is missing: ${definition.packageContentHash}`);
      const layout = portableModuleProfileIds(archive, modePackId);
      if (!layout || layout.profileIds.length < 2) throw new Error(`Mode Pack ${modePackId} is not a multi-profile module`);
      if (Object.keys(expectedRevisions).length !== layout.profileIds.length || layout.profileIds.some((id) => !(id in expectedRevisions)))
        throw new Error(`Complete expected revisions are required for module ${layout.moduleId}`);
      for (const id of layout.profileIds) {
        const current = store.histories[id]?.at(-1);
        if (!current || current.packageContentHash !== definition.packageContentHash)
          throw new Error(`Portable module ${layout.moduleId} is missing phase ${id}`);
        if (current.revision !== expectedRevisions[id])
          throw new Error(`Mode Pack ${id} revision conflict: expected ${expectedRevisions[id]}, current ${current.revision}`);
      }
      for (const id of layout.profileIds) { retainPriorArchive(store, id); delete store.histories[id]; }
      writeStore(this.path, store);
      return layout.profileIds;
    });
  }

  async list(cwd: string): Promise<{ inventory: ModePackInventory; packs: ModePackListItem[] }> {
    const inventory = await inspectModePackInventory(cwd);
    const custom = this.listCustom();
    const savedIds = new Set(custom.map((definition) => definition.modePackId));
    const packs: ModePackListItem[] = [];
    let bundledCode: ModePackDefinition | null = null;
    let bundledCodeError: string | null = null;
    try { bundledCode = (await inspectModePackInventory(cwd, { includeBundledCode: true })).builtinPacks.coding ?? null; } catch (error) { bundledCodeError = error instanceof Error ? error.message : String(error); }
    for (let definition of [...Object.values(inventory.builtinPacks), ...(bundledCode ? [bundledCode] : [])].filter((item) => !savedIds.has(item.modePackId)).concat(custom).filter(
      (item) => item.role === "general" && item.runtimeMode === "general" && !item.courseRequired,
    )) {
      let scopedInventory = inventory;
      try {
        // Migration reads the package just like scoped inventory inspection. A
        // corrupt unselected package must report its error on its own list item.
        definition = await this.migrateLearningWorkflowDefinition(definition.modePackId, cwd) ?? definition;
        if (definition.packageContentHash) scopedInventory = await inspectModePackInventory(cwd, {
          packageContentHash: definition.packageContentHash,
          selection: modePackDefinitionSelection(definition),
          ...(definition.modePackId === "coding" ? { includeBundledCode: true } : {}),
        });
      } catch (error) {
        packs.push({
          definition,
          builtin: !savedIds.has(definition.modePackId) && !definition.modePackId.startsWith("custom."),
          selectable: false,
          missingRequiredResources: [],
          missingOptionalResources: [],
          identityMismatches: [],
          packageError: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const availability = inspectModePackAvailability(definition, scopedInventory.catalog);
      // A manifest-backed package can be selected while absent so activation can
      // install it in its private cache. Inventory reads themselves never install.
      const installable = Boolean(definition.packageContentHash) && availability.identityMismatches.length === 0;
      const editableLocalSkillDrift = !definition.packageContentHash && hasOnlyEditedLocalSkills(availability, scopedInventory);
      const genericCompatible = definition.role === "general" && definition.runtimeMode === "general" && !definition.courseRequired;
      packs.push({ definition, builtin: !savedIds.has(definition.modePackId) && !definition.modePackId.startsWith("custom."), ...availability, selectable: genericCompatible && (availability.selectable || installable || editableLocalSkillDrift) });
    }
    if (bundledCodeError && !savedIds.has("coding")) packs.push({ definition: {
      version: 1, modePackId: "coding", revision: 1, title: "Coding", description: "Bundled package could not be read", category: "coding", role: "general", runtimeMode: "general", provider: null, model: null, thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false, tools: [], components: [], systemPrompt: "Unavailable bundled package.", instructions: [], contentHash: "sha256:unavailable",
    } as ModePackDefinition, builtin: true, selectable: false, missingRequiredResources: [], missingOptionalResources: [], identityMismatches: [], packageError: bundledCodeError });
    packs.sort((left, right) => left.definition.modePackId.localeCompare(right.definition.modePackId));
    return { inventory, packs };
  }

  async resolve(modePackId: string, cwd: string, createdAt?: string, selection?: PortableModePackageSelection): Promise<{
    definition: ModePackDefinition;
    snapshot: ResourceSnapshot;
    inventory: ModePackInventory;
  }> {
    // A packaged mode is self-contained. Scanning every ambient Pi package on
    // each switch is both slow and capable of contaminating its resource scope.
    const savedDefinition = await this.migrateLearningWorkflowDefinition(modePackId, cwd);
    const packagedDefinition = savedDefinition?.packageContentHash
      ? savedDefinition
      : modePackId === "coding" ? bundledCodeModePackage().definition : null;
    const baseInventory = packagedDefinition ? null : await inspectModePackInventory(cwd);
    let definition = savedDefinition ?? packagedDefinition ?? baseInventory?.builtinPacks[modePackId];
    if (!definition) throw new Error(`Unknown Mode Pack: ${modePackId}`);
    const inventory = definition.packageContentHash
      ? await inspectModePackInventory(cwd, { packageContentHash: definition.packageContentHash, selection: selection ?? modePackDefinitionSelection(definition), useLatestSharedResources: true, ...(modePackId === "coding" ? { includeBundledCode: true } : {}) })
      : baseInventory!;
    const archive = definition.packageContentHash
      ? readPortableModePackage(definition.packageContentHash) ?? (modePackId === "coding" ? bundledCodeModePackage() : null)
      : null;
    const sharedKeys = new Set((archive?.sharedResources ?? []).map((binding) => `${binding.kind === "extension" ? "plugin" : binding.kind}:${binding.kind === "prompt" && binding.id.startsWith("workflow:") ? binding.id.slice("workflow:".length) : binding.id}`));
    let effectiveDefinition = sharedKeys.size ? (() => {
      const components = definition.components.map((component) => {
        if (!sharedKeys.has(`${component.type}:${component.id}`)) return component;
        const kind = component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type;
        const id = component.type === "workflow" ? `workflow:${component.id}` : component.id;
        const provider = inventory.resourcesByKey.get(`${kind}:${id}`);
        if (!provider) throw new Error(`Shared resource provider is missing: ${kind}:${id}`);
        return { ...component, version: provider.version, contentHash: provider.contentHash };
      });
      const body = { ...definition };
      delete (body as { contentHash?: string }).contentHash;
      const current = { ...body, components };
      return { ...current, contentHash: contentHash(current) };
    })() : definition;
    let availability = inspectModePackAvailability(effectiveDefinition, inventory.catalog);
    const knownCourseHostDrift = savedDefinition && !savedDefinition.packageContentHash
      && availability.missingRequiredResources.length === 0 && availability.missingOptionalResources.length === 0 && availability.identityMismatches.length > 0
      && availability.identityMismatches.every(key => key === "extension:course-builder"
        && isBuiltinCourseHostUpgrade({ profileId: savedDefinition.modePackId, instructions: savedDefinition.instructions }, inventory.resourcesByKey.get("extension:course-builder")));
    if (savedDefinition && !savedDefinition.packageContentHash && (hasOnlyEditedLocalSkills(availability, inventory) || knownCourseHostDrift)) {
      const changedSkills = [...availability.identityMismatches];
      try {
        const draft = definitionToDraft(savedDefinition, { revision: savedDefinition.revision + 1 });
        if (savedDefinition.modePackId === "course-builder" && savedDefinition.instructions.includes(COURSE_WORKFLOW_MIGRATION_MARKER)) {
          // A migrated legacy Course definition may retain a personal local
          // Skill. Refresh only its already selected pins; this is not portable
          // composition or permission to author a different built-in policy.
          const next = compileModePackDraft(draft, inventory.catalog);
          definition = await withStoreLock(this.path, () => {
            const store = readStore(this.path), current = store.histories[savedDefinition.modePackId]?.at(-1);
            if (current?.contentHash !== savedDefinition.contentHash)
              throw new Error(`Mode Pack revision conflict: expected ${savedDefinition.revision}, current ${current?.revision ?? 0}`);
            store.histories[savedDefinition.modePackId] = [next];
            writeStore(this.path, store);
            return structuredClone(next);
          });
        } else definition = await this.saveDraft(draft, cwd, savedDefinition.revision);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Mode Pack revision conflict:")) throw error;
        // Another session may have committed the same local edit first. Its
        // current definition is usable only if it exactly matches this catalog.
        const concurrent = this.getCustom(modePackId);
        const samePolicy = concurrent && stableStringify({ ...definitionToDraft(concurrent), revision: 0 })
          === stableStringify({ ...definitionToDraft(savedDefinition), revision: 0 });
        if (!concurrent || !samePolicy || !inspectModePackAvailability(concurrent, inventory.catalog).selectable) throw error;
        definition = concurrent;
      }
      effectiveDefinition = definition;
      availability = inspectModePackAvailability(definition, inventory.catalog);
      console.info(knownCourseHostDrift ? "[course-workflow] advanced built-in Course Host pin" : "[mode-pack] advanced editable local Skill pins", { modePackId, revision: definition.revision, resources: changedSkills });
    }
    if (!availability.selectable) {
      throw new Error(
        `Mode Pack is unavailable: ${[
          ...availability.missingRequiredResources.map((item) => `missing ${item}`),
          ...availability.identityMismatches.map((item) => `changed ${item}`),
        ].join(", ")}`,
      );
    }
    const resolvedSnapshot = resolveModePackSnapshot({
      pack: effectiveDefinition,
      courseVersionId: null,
      catalog: inventory.catalog,
      ...(createdAt ? { createdAt } : {}),
    });
    const snapshot = withProjectCapabilityResources(resolvedSnapshot, inventory);
    assertGenericModePackSnapshot(snapshot);
    return { definition: effectiveDefinition, snapshot, inventory };
  }

  forkDraft(modePackId: string, newModePackId: string): ModePackDraft {
    const definition = this.getCustom(modePackId);
    if (!definition) throw new Error("forkDraft only accepts an existing custom Mode Pack; built-ins are returned by the list API");
    return parseModePackDraft({
      ...definitionToDraft(definition, { modePackId: newModePackId, revision: 1 }),
      title: `${definition.title} copy`,
    });
  }
}

export function definitionToDraft(definitionValue: unknown, options?: { modePackId?: string; revision?: number }): ModePackDraft {
  const definition = parseModePackDefinition(definitionValue);
  return parseModePackDraft({
    version: definition.version,
    modePackId: options?.modePackId ?? definition.modePackId,
    revision: options?.revision ?? definition.revision,
    title: definition.title,
    description: definition.description,
    category: definition.category,
    role: definition.role,
    runtimeMode: definition.runtimeMode,
    provider: definition.provider,
    model: definition.model,
    thinkingLevel: definition.thinkingLevel,
    externalKnowledgePolicy: definition.externalKnowledgePolicy,
    courseRequired: definition.courseRequired,
    tools: [...definition.tools],
    systemPrompt: definition.systemPrompt,
    ...(definition.systemPromptMode ? { systemPromptMode: definition.systemPromptMode } : {}),
    instructions: [...definition.instructions],
    ...(definition.packageContentHash ? { packageContentHash: definition.packageContentHash } : {}),
    components: definition.components.map(({ type, id, required, enabled, delivery }) => ({
      type,
      id,
      required,
      enabled,
      ...(delivery ? { delivery } : {}),
    })),
  });
}
