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
import { dirname, join, resolve } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ModePackDefinition,
  ModePackDraft,
  ResourceSnapshot,
} from "../../../packages/harness-contracts/src/index.ts";
import { parseModePackDefinition, parseModePackDraft } from "../../../packages/harness-contracts/src/index.ts";
import { stableStringify } from "../../../packages/harness-core/src/index.ts";
import {
  compileModePackDraft,
  inspectModePackAvailability,
  resolveModePackSnapshot,
} from "../../../packages/profile-resource-host/src/index.ts";
import {
  assertGenericModePackSnapshot,
  assertModePackDefinitionIntegrity,
} from "../../../packages/mode-pack-host/src/index.ts";
import {
  inspectModePackInventory,
  type ModePackInventory,
} from "./mode-pack-inventory";

const STORE_VERSION = 1;

interface PersistedModePackStore {
  version: typeof STORE_VERSION;
  histories: Record<string, ModePackDefinition[]>;
}

export interface ModePackListItem {
  definition: ModePackDefinition;
  builtin: boolean;
  selectable: boolean;
  missingRequiredResources: string[];
  missingOptionalResources: string[];
  identityMismatches: string[];
}

function emptyStore(): PersistedModePackStore {
  return { version: STORE_VERSION, histories: {} };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}.${key}: unknown field`);
  for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key}: missing required field`);
}

function parseStore(value: unknown): PersistedModePackStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mode Pack store must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["version", "histories"], "modePackStore");
  if (record.version !== STORE_VERSION) throw new Error("Unsupported Mode Pack store version");
  if (!record.histories || typeof record.histories !== "object" || Array.isArray(record.histories)) {
    throw new Error("Mode Pack store histories must be an object");
  }
  const histories: Record<string, ModePackDefinition[]> = {};
  for (const [modePackId, rawHistory] of Object.entries(record.histories as Record<string, unknown>)) {
    if (!modePackId.startsWith("custom.")) throw new Error(`Stored Mode Pack id must start with custom.: ${modePackId}`);
    if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
      throw new Error(`Mode Pack history is empty: ${modePackId}`);
    }
    const history = rawHistory.map((item) => assertModePackDefinitionIntegrity(item));
    let revision = 0;
    for (const definition of history) {
      if (definition.modePackId !== modePackId) throw new Error(`Mode Pack history id mismatch: ${modePackId}`);
      if (definition.revision !== revision + 1) throw new Error(`Mode Pack history revisions are not contiguous: ${modePackId}`);
      assertGenericDefinition(definition);
      revision = definition.revision;
    }
    histories[modePackId] = history;
  }
  return { version: STORE_VERSION, histories };
}

function assertGenericDefinition(definition: ModePackDefinition): void {
  if (definition.role !== "general" || definition.runtimeMode !== "general" || definition.courseRequired) {
    throw new Error("Custom global Mode Packs must use role=general, runtimeMode=general, and courseRequired=false");
  }
  if (definition.components.some((component) => component.type === "plugin" && component.id === "learning-harness")) {
    throw new Error("Custom global Mode Packs cannot include the course-only learning-harness plugin");
  }
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

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeStore(path: string, store: PersistedModePackStore): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${stableStringify(store)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fsyncPath(temporary);
    renameSync(temporary, path);
    try {
      fsyncPath(dirname(path));
    } catch {
      // Directory fsync is not available on every supported Windows filesystem.
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

export function modePackStorePath(): string {
  const explicit = process.env.PI_MODE_PACK_STORE_PATH;
  if (explicit) return resolve(explicit);
  const harnessDirectory = process.env.PI_LEARNING_HARNESS_DIR;
  return resolve(harnessDirectory ? join(harnessDirectory, "mode-packs.json") : join(getAgentDir(), "mode-packs.json"));
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

  async saveDraft(value: unknown, cwd: string, expectedRevision: number): Promise<ModePackDefinition> {
    const draft = parseModePackDraft(value);
    if (!draft.modePackId.startsWith("custom.")) throw new Error("Custom Mode Pack ids must start with custom.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative safe integer");
    }
    const inventory = await inspectModePackInventory(cwd);
    if (inventory.diagnostics.some((item) => item.severity === "error")) {
      throw new Error(inventory.diagnostics.map((item) => item.message).join("; "));
    }
    const definition = compileModePackDraft(draft, inventory.catalog);
    assertGenericDefinition(definition);
    return withStoreLock(this.path, () => {
      const store = readStore(this.path);
      const history = store.histories[definition.modePackId] ?? [];
      const currentRevision = history.at(-1)?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new Error(`Mode Pack revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
      }
      if (definition.revision !== currentRevision + 1) {
        throw new Error(`Mode Pack draft revision must be ${currentRevision + 1}`);
      }
      store.histories[definition.modePackId] = [...history, definition];
      writeStore(this.path, store);
      return structuredClone(definition);
    });
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
      delete store.histories[modePackId];
      writeStore(this.path, store);
    });
  }

  async list(cwd: string): Promise<{ inventory: ModePackInventory; packs: ModePackListItem[] }> {
    const inventory = await inspectModePackInventory(cwd);
    const custom = this.listCustom();
    const packs: ModePackListItem[] = [];
    for (const definition of [...Object.values(inventory.builtinPacks), ...custom].filter(
      (item) => item.role === "general" && item.runtimeMode === "general" && !item.courseRequired,
    )) {
      const availability = inspectModePackAvailability(definition, inventory.catalog);
      packs.push({ definition, builtin: !definition.modePackId.startsWith("custom."), ...availability });
    }
    packs.sort((left, right) => left.definition.modePackId.localeCompare(right.definition.modePackId));
    return { inventory, packs };
  }

  async resolve(modePackId: string, cwd: string, createdAt?: string): Promise<{
    definition: ModePackDefinition;
    snapshot: ResourceSnapshot;
    inventory: ModePackInventory;
  }> {
    const inventory = await inspectModePackInventory(cwd);
    const definition = inventory.builtinPacks[modePackId] ?? this.getCustom(modePackId);
    if (!definition) throw new Error(`Unknown Mode Pack: ${modePackId}`);
    const availability = inspectModePackAvailability(definition, inventory.catalog);
    if (!availability.selectable) {
      throw new Error(
        `Mode Pack is unavailable: ${[
          ...availability.missingRequiredResources.map((item) => `missing ${item}`),
          ...availability.identityMismatches.map((item) => `changed ${item}`),
        ].join(", ")}`,
      );
    }
    const snapshot = resolveModePackSnapshot({
      pack: definition,
      courseVersionId: null,
      catalog: inventory.catalog,
      ...(createdAt ? { createdAt } : {}),
    });
    assertGenericModePackSnapshot(snapshot);
    return { definition, snapshot, inventory };
  }

  forkDraft(modePackId: string, newModePackId: string): ModePackDraft {
    const definition = this.getCustom(modePackId);
    if (!definition) throw new Error("forkDraft only accepts an existing custom Mode Pack; built-ins are returned by the list API");
    const { contentHash: _contentHash, components, ...base } = definition;
    return parseModePackDraft({
      ...base,
      modePackId: newModePackId,
      revision: 1,
      title: `${definition.title} copy`,
      components: components.map(({ version: _version, contentHash: _hash, ...component }) => component),
    });
  }
}

export function definitionToDraft(definitionValue: unknown, options?: { modePackId?: string; revision?: number }): ModePackDraft {
  const definition = parseModePackDefinition(definitionValue);
  const { contentHash: _contentHash, components, ...base } = definition;
  return parseModePackDraft({
    ...base,
    ...(options?.modePackId ? { modePackId: options.modePackId } : {}),
    ...(options?.revision ? { revision: options.revision } : {}),
    components: components.map(({ version: _version, contentHash: _hash, ...component }) => component),
  });
}
