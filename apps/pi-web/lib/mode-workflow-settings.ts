import type { ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isCourseBuilderSnapshot } from "./course-builder-mode";
import { studyModePhaseForSnapshot } from "./study-mode-policy";
import { isHostPluginEnabled } from "./host-plugin-settings";
import lockfile from "proper-lockfile";
import { COURSE_PRODUCTION_WORKFLOW_ID, COURSE_PRODUCT_DEFINITIONS } from "./course-production-policy";

/** Composition references only; graph implementations and Provider bindings stay in CAW. */
const COURSE_WORKFLOWS = [[COURSE_PRODUCTION_WORKFLOW_ID, "课程生产"]] as const;
const DOMAIN_WORKFLOW_IDS = new Set([COURSE_PRODUCTION_WORKFLOW_ID, ...Object.keys(COURSE_PRODUCT_DEFINITIONS), "study-explanation"]);
export type WorkflowSelection = { id: string; enabled: boolean };
/** Metadata read from the native CAW store, never a second graph registry. */
export type WorkflowCatalogEntry = { id: string; name?: string; kind?: string; template_kind?: string; system_managed?: boolean; enabled?: boolean; global_enabled?: boolean };
type Preference = { sessionId: string; modePackId: string; origin: string; revision: number; workflows: WorkflowSelection[] };
type Store = { version: 1; preferences: Record<string, Preference> };
function path() { return join(getAgentDir(), "mode-workflow-settings.json"); }
function origin(snapshot: ResourceSnapshot): string { return snapshot.packageContentHash ?? `builtin:${snapshot.profileId}`; }
function key(sessionId: string, snapshot: ResourceSnapshot) { return contentHash({ sessionId, modePackId: snapshot.profileId, origin: origin(snapshot) }); }

export function parseWorkflowSelections(value: unknown): WorkflowSelection[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("workflows must be an array with at most 256 selections");
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(item.id)
      || typeof item.enabled !== "boolean" || Object.keys(item).some(field => field !== "id" && field !== "enabled")) throw new Error("Invalid Workflow selection");
    if (ids.has(item.id)) throw new Error(`Duplicate Workflow: ${item.id}`);
    ids.add(item.id);
  }
  return structuredClone(value) as WorkflowSelection[];
}
function readStore(): Store {
  let source: string;
  try { source = readFileSync(path(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, preferences: {} }; throw error; }
  const store = JSON.parse(source) as Store;
  if (!store || store.version !== 1 || !store.preferences || typeof store.preferences !== "object" || Array.isArray(store.preferences)
    || Object.keys(store).some(field => field !== "version" && field !== "preferences")) throw new Error("Invalid Mode Workflow settings store");
  for (const [id, preference] of Object.entries(store.preferences)) {
    if (!preference || typeof preference.sessionId !== "string" || !preference.sessionId || typeof preference.modePackId !== "string"
      || !preference.modePackId || typeof preference.origin !== "string" || !preference.origin
      || !Number.isSafeInteger(preference.revision) || preference.revision < 1
      || Object.keys(preference).some(field => !["sessionId", "modePackId", "origin", "revision", "workflows"].includes(field))
      || id !== contentHash({ sessionId: preference.sessionId, modePackId: preference.modePackId, origin: preference.origin })) throw new Error("Invalid Mode Workflow preference identity");
    parseWorkflowSelections(preference.workflows);
  }
  return store;
}
function defaults(snapshot: ResourceSnapshot, catalog: readonly WorkflowCatalogEntry[]) {
  const course = isCourseBuilderSnapshot(snapshot), study = Boolean(studyModePhaseForSnapshot(snapshot));
  const expected: ReadonlyArray<readonly [string, string]> = course ? COURSE_WORKFLOWS : study ? [["study-explanation", "当前问题解释"]] : [];
  const workflows = new Map(expected);
  for (const item of catalog) if ((item.kind ?? item.template_kind) === "workflow" && !item.system_managed) workflows.set(item.id, item.name ?? item.id);
  return { workflows: [...workflows], course, study };
}
export function hasModeWorkflowScope(snapshot?: ResourceSnapshot): boolean {
  return Boolean(snapshot);
}
export function getModeWorkflowSettings(sessionId: string, snapshot: ResourceSnapshot, catalog: readonly WorkflowCatalogEntry[] = []) {
  const policy = defaults(snapshot, catalog), preference = readStore().preferences[key(sessionId, snapshot)];
  const selected = new Map((preference?.workflows ?? []).map(item => [item.id, item.enabled]));
  // Catalog deletion leaves a dormant preference, never an execution grant.
  const pluginEnabled = isHostPluginEnabled("pi-caw");
  // A mode chooses defaults, not library membership. Tool availability is checked per Run.
  const executionAvailable = pluginEnabled;
  return {
    workflows: policy.workflows.map(([id, name]) => { const row = catalog.find(item => item.id === id);
      const defaultEnabled = policy.course ? id === COURSE_PRODUCTION_WORKFLOW_ID
        : policy.study ? id === "study-explanation" : !DOMAIN_WORKFLOW_IDS.has(id) && (row?.global_enabled ?? row?.enabled) === true;
      // A previous all-off product combination remains off after consolidation.
      const legacyAllOff = id === COURSE_PRODUCTION_WORKFLOW_ID && Object.keys(COURSE_PRODUCT_DEFINITIONS).every(action => selected.get(action) === false);
      const enabled = selected.get(id) ?? (legacyAllOff ? false : defaultEnabled);
      const globalState = row?.global_enabled ?? row?.enabled;
      const globalEnabled = typeof globalState === "boolean" ? globalState : null;
      return { id, name, defaultEnabled, enabled, globalEnabled, effectiveEnabled: enabled && globalEnabled === true && executionAvailable }; }),
    workflowScope: { modePackId: snapshot.profileId, snapshotId: snapshot.resourceSnapshotId, origin: origin(snapshot), revision: preference?.revision ?? 0,
      executionAvailable, pluginEnabled, reason: !pluginEnabled ? "pi-CAW 已在全局插件设置中关闭。" : null },
  };
}
export function modeWorkflowScope(sessionId: string, snapshot: ResourceSnapshot, catalog: readonly WorkflowCatalogEntry[] = []) {
  const settings = getModeWorkflowSettings(sessionId, snapshot, catalog);
  if (!settings.workflowScope) return null;
  return { mode_pack_id: settings.workflowScope.modePackId, snapshot_id: settings.workflowScope.snapshotId, origin: settings.workflowScope.origin,
    revision: settings.workflowScope.revision, workflow_ids: settings.workflows.map(workflow => workflow.id),
    enabled_workflow_ids: settings.workflowScope.executionAvailable ? settings.workflows.filter(workflow => workflow.enabled).map(workflow => workflow.id) : [] };
}
/** Mutable preference CAS leaves immutable resource pins, origin and transcript untouched. */
export function writeModeWorkflowSettings(sessionId: string, snapshot: ResourceSnapshot, value: unknown, expectedRevision: number, catalog: readonly WorkflowCatalogEntry[] = []) {
  mkdirSync(dirname(path()), { recursive: true });
  const release = lockfile.lockSync(path(), { realpath: false });
  try {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Expected Workflow settings revision is required");
    const selections = parseWorkflowSelections(value), current = getModeWorkflowSettings(sessionId, snapshot, catalog);
    if (!current.workflowScope) throw new Error("This mode uses shared native Workbench configuration");
    if (current.workflowScope.revision !== expectedRevision) throw new Error("Workflow settings revision conflict; reload before saving");
    for (const selection of selections) if (!current.workflows.some(workflow => workflow.id === selection.id)) throw new Error(`Workflow is not in the installed library: ${selection.id}`);
    const store = readStore(), identity = key(sessionId, snapshot), prior = store.preferences[identity];
    if ((prior?.revision ?? 0) !== expectedRevision) throw new Error("Workflow settings changed before saving");
    const overrides = new Map((prior?.workflows ?? []).map(workflow => [workflow.id, workflow.enabled]));
    for (const selection of selections) overrides.set(selection.id, selection.enabled);
    store.preferences[identity] = { sessionId, modePackId: snapshot.profileId, origin: origin(snapshot), revision: expectedRevision + 1,
      workflows: [...overrides].sort(([left], [right]) => left.localeCompare(right)).map(([id, enabled]) => ({ id, enabled })) };
    writePrivateFileAtomicSync(path(), JSON.stringify(store));
    console.info("[mode-workflow] saved scoped combination", { sessionId, modePackId: snapshot.profileId, origin: origin(snapshot), revision: expectedRevision + 1, workflows: selections });
    return getModeWorkflowSettings(sessionId, snapshot, catalog);
  } finally { release(); }
}
