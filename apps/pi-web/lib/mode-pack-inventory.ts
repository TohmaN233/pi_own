import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { basename, dirname, extname, relative, resolve } from "path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type {
  ModePackDefinition,
  ResourceKind,
  ResourceSnapshot,
} from "../../../packages/harness-contracts/src/index.ts";
import { contentHash, sha256Hex, stableStringify } from "../../../packages/harness-core/src/index.ts";
import {
  BUILTIN_MODE_RESOURCES,
  compileModePackDraft,
  ResourceCatalog,
} from "../../../packages/profile-resource-host/src/index.ts";
import {
  assertGenericModePackSnapshot,
  createRuntimeBuiltinModePacks,
  assertModePackDefinitionIntegrity,
  formatModePackSystemPrompt,
  type ModePackRuntimeEvidence,
  type ModePackRuntimeExpectation,
} from "../../../packages/mode-pack-host/src/index.ts";
import { getProjectTrustStatus } from "./project-trust";
import { COURSE_BUILDER_DRAFT, COURSE_BUILDER_GUIDANCE } from "./course-builder-pack";

const TOOL_HASH = "sha256:built-in-tool";
const BUILTIN_EXTENSION_HASH = "sha256:learning-harness-v1";
const MAX_RESOURCE_TEXT_BYTES = 256 * 1024;
const MAX_COMPILED_PROMPT_BYTES = 768 * 1024;
const BUILTIN_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"] as const;

export interface RuntimeModeResource {
  kind: ResourceKind;
  id: string;
  title: string;
  version: string;
  contentHash: string;
  paths: string[];
  pathHashes: Readonly<Record<string, string>>;
  text: string | null;
  source: string;
  scope: string;
  synthetic: boolean;
}

export interface ModePackInventoryDiagnostic {
  severity: "warning" | "error";
  source: string | null;
  message: string;
}

export interface ModePackInventory {
  cwd: string;
  catalog: ResourceCatalog;
  resources: RuntimeModeResource[];
  resourcesByKey: Map<string, RuntimeModeResource>;
  diagnostics: ModePackInventoryDiagnostic[];
  builtinPacks: Readonly<Record<string, ModePackDefinition>>;
}

export interface ModePackRuntimePlan {
  snapshot: ResourceSnapshot;
  definition: ModePackDefinition | null;
  toolNames: string[];
  extensionPaths: string[];
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
  expected: ModePackRuntimeExpectation;
  systemPrompt: string;
  resourceIdsByPath: ReadonlyMap<string, string>;
  resourceHashesByPath: ReadonlyMap<string, string>;
}

interface ResourceLoaderLike {
  getExtensions(): { extensions: Array<{ path?: string; sourceInfo?: { path?: string } }> };
  getSkills(): { skills: Array<{ filePath?: string; sourceInfo?: { path?: string } }> };
  getPrompts(): { prompts: Array<{ filePath?: string; sourceInfo?: { path?: string } }> };
  getThemes(): { themes: Array<{ path?: string; filePath?: string; sourcePath?: string; sourceInfo?: { path?: string } }> };
}

interface RuntimeSessionLike {
  getActiveToolNames(): string[];
  getAllTools(): Array<{ name: string; sourceInfo?: unknown }>;
  resourceLoader: ResourceLoaderLike;
  agent?: { state?: { systemPrompt?: string } };
  systemPrompt?: string;
}

function resourceKey(kind: ResourceKind, id: string): string {
  return `${kind}:${id}`;
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function stablePathLabel(resource: ResolvedResource): string {
  const baseDir = resource.metadata.baseDir;
  if (!baseDir) return basename(resource.path);
  const label = relative(baseDir, resource.path).replace(/\\/gu, "/");
  return label && !label.startsWith("../") ? label : basename(resource.path);
}

function fileDigest(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Mode Pack resource is not a file: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_RESOURCE_TEXT_BYTES) {
    throw new Error(`Mode Pack resource exceeds ${MAX_RESOURCE_TEXT_BYTES} bytes: ${path}`);
  }
  return sha256Hex(bytes);
}

function readText(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_RESOURCE_TEXT_BYTES) {
    throw new Error(`Mode Pack resource exceeds ${MAX_RESOURCE_TEXT_BYTES} bytes: ${path}`);
  }
  return bytes.toString("utf8");
}

function slug(value: string): string {
  const result = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "")
    .slice(0, 48);
  return result || "resource";
}

function stableRuntimeId(kind: Exclude<ResourceKind, "tool">, label: string, identity: string): string {
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `runtime.${kind}.${slug(label)}.${suffix}`;
}

function resourceTitle(path: string, kind: ResourceKind): string {
  const file = basename(path);
  if (kind === "skill" && file.toLocaleLowerCase("en-US") === "skill.md") return basename(dirname(path));
  const extension = extname(file);
  return extension ? file.slice(0, -extension.length) : file;
}

function runtimeResource(options: {
  kind: Exclude<ResourceKind, "tool">;
  id: string;
  title: string;
  paths: readonly string[];
  source: string;
  scope: string;
  text?: string | null;
  synthetic?: boolean;
  version?: string;
  digestPayload?: unknown;
}): RuntimeModeResource {
  const paths = [...options.paths].sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
  const pathHashes = Object.fromEntries(paths.map((path) => [normalizePath(path), fileDigest(path)]));
  const digestPayload = options.digestPayload ?? paths.map((path) => ({ name: basename(path), sha256: pathHashes[normalizePath(path)] }));
  return {
    kind: options.kind,
    id: options.id,
    title: options.title,
    version: options.version ?? "runtime-v1",
    contentHash: contentHash({
      kind: options.kind,
      id: options.id,
      source: options.source,
      scope: options.scope,
      payload: digestPayload,
    }),
    paths,
    pathHashes,
    text: options.text ?? null,
    source: options.source,
    scope: options.scope,
    synthetic: options.synthetic ?? false,
  };
}

function builtinResources(): RuntimeModeResource[] {
  const tools: RuntimeModeResource[] = BUILTIN_TOOL_NAMES.map((id) => ({
    kind: "tool",
    id,
    title: id,
    version: "1",
    contentHash: TOOL_HASH,
    paths: [],
    pathHashes: {},
    text: null,
    source: "pi-builtin",
    scope: "platform",
    synthetic: true,
  }));
  const learningHarness: RuntimeModeResource = {
    kind: "extension",
    id: "learning-harness",
    title: "Learning Harness",
    version: "1",
    contentHash: BUILTIN_EXTENSION_HASH,
    paths: [],
    pathHashes: {},
    text: null,
    source: "pi-own",
    scope: "platform",
    synthetic: true,
  };
  const modeResources = BUILTIN_MODE_RESOURCES.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    title: entry.id,
    version: entry.version,
    contentHash: entry.contentHash,
    paths: [],
    pathHashes: {},
    text: entry.instructions.join("\n\n"),
    source: "pi-own-mode-pack",
    scope: "platform",
    synthetic: true,
  } satisfies RuntimeModeResource));
  // The app is a source-vendored local workspace. Resolve its physical extension,
  // not a synthetic plugin: the Pi loader must genuinely register its tools.
  const extensionPath = [resolve(process.cwd(), "lib/course-builder-extension.ts"), resolve(process.cwd(), "apps/pi-web/lib/course-builder-extension.ts")].find(existsSync);
  const courseResources = extensionPath ? [
    runtimeResource({kind:"extension",id:"course-builder",title:"Course Builder",paths:[extensionPath],source:"pi-own",scope:"platform"}),
    runtimeResource({kind:"skill",id:"teacher.course-planning-beamer",title:"Course planning and Beamer",paths:[],source:"pi-own",scope:"platform",synthetic:true,text:COURSE_BUILDER_GUIDANCE,digestPayload:COURSE_BUILDER_GUIDANCE}),
    runtimeResource({kind:"prompt",id:"workflow:course-builder",title:"Teacher approval workflow",paths:[],source:"pi-own",scope:"platform",synthetic:true,text:"Use the fixed Course Builder workflow. Wait for real teacher approval between plan, lesson and deck. Never self-approve.",digestPayload:"course-builder-workflow-v1"}),
  ] : [];
  return [...tools, learningHarness, ...modeResources, ...courseResources];
}

function pushResource(
  resources: RuntimeModeResource[],
  resourcesByKey: Map<string, RuntimeModeResource>,
  resource: RuntimeModeResource,
): void {
  const key = resourceKey(resource.kind, resource.id);
  const existing = resourcesByKey.get(key);
  if (existing && stableStringify(existing) !== stableStringify(resource)) {
    throw new Error(`Mode Pack resource identity collision: ${key}`);
  }
  if (!existing) resources.push(resource);
  resourcesByKey.set(key, resource);
}

function groupExtensions(resources: ResolvedResource[]): RuntimeModeResource[] {
  const groups = new Map<string, ResolvedResource[]>();
  for (const resource of resources.filter((entry) => entry.enabled)) {
    // A package can expose several extension entrypoints and must be selected as
    // one plugin. Top-level and auto-discovered files are independent plugins;
    // grouping every user extension under source=auto would make unrelated
    // files impossible to enable or disable separately.
    const identity = resource.metadata.origin === "package"
      ? `${resource.metadata.scope}\0package\0${resource.metadata.source}`
      : `${resource.metadata.scope}\0path\0${normalizePath(resource.path)}`;
    const group = groups.get(identity) ?? [];
    group.push(resource);
    groups.set(identity, group);
  }
  return [...groups.entries()].map(([identity, entries]) => {
    const first = entries[0] as ResolvedResource;
    const packageGrouped = first.metadata.origin === "package";
    const title = packageGrouped ? first.metadata.source : resourceTitle(first.path, "extension");
    const id = stableRuntimeId("extension", title, identity);
    const digests = entries
      .map((entry) => ({ path: stablePathLabel(entry), sha256: fileDigest(entry.path) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return runtimeResource({
      kind: "extension",
      id,
      title,
      paths: entries.map((entry) => entry.path),
      source: first.metadata.source,
      scope: first.metadata.scope,
      digestPayload: digests,
    });
  });
}

function mapIndividualResources(kind: "skill" | "prompt" | "theme", resources: ResolvedResource[]): RuntimeModeResource[] {
  return resources
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const title = resourceTitle(entry.path, kind);
      const identity = `${entry.metadata.scope}\0${entry.metadata.source}\0${stablePathLabel(entry)}`;
      return runtimeResource({
        kind,
        id: stableRuntimeId(kind, title, identity),
        title,
        paths: [entry.path],
        source: entry.metadata.source,
        scope: entry.metadata.scope,
        text: kind === "theme" ? null : readText(entry.path),
        digestPayload: { path: stablePathLabel(entry), sha256: fileDigest(entry.path) },
      });
    });
}

export async function inspectModePackInventory(cwd: string): Promise<ModePackInventory> {
  const resolvedCwd = resolve(cwd);
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(resolvedCwd, agentDir);
  const settingsManager = SettingsManager.create(resolvedCwd, agentDir, { projectTrusted: projectTrust.trusted });
  const packageManager = new DefaultPackageManager({ cwd: resolvedCwd, agentDir, settingsManager });
  const diagnostics: ModePackInventoryDiagnostic[] = [];
  const resources: RuntimeModeResource[] = [];
  const resourcesByKey = new Map<string, RuntimeModeResource>();
  for (const resource of builtinResources()) pushResource(resources, resourcesByKey, resource);

  try {
    const resolved = await packageManager.resolve(async (source) => {
      diagnostics.push({ severity: "warning", source, message: "Configured package is not installed and was skipped." });
      return "skip";
    });
    for (const resource of groupExtensions(resolved.extensions)) pushResource(resources, resourcesByKey, resource);
    for (const resource of mapIndividualResources("skill", resolved.skills)) pushResource(resources, resourcesByKey, resource);
    for (const resource of mapIndividualResources("prompt", resolved.prompts)) pushResource(resources, resourcesByKey, resource);
    for (const resource of mapIndividualResources("theme", resolved.themes)) pushResource(resources, resourcesByKey, resource);
  } catch (error) {
    diagnostics.push({
      severity: "error",
      source: null,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const catalog = new ResourceCatalog(
    resources.map((resource) => ({
      kind: resource.kind,
      id: resource.id,
      version: resource.version,
      contentHash: resource.contentHash,
    })),
  );
  return {
    cwd: resolvedCwd,
    catalog,
    resources: resources.sort((left, right) => resourceKey(left.kind, left.id).localeCompare(resourceKey(right.kind, right.id))),
    resourcesByKey,
    diagnostics,
    builtinPacks: {...createRuntimeBuiltinModePacks(catalog), ...(catalog.get("extension", "course-builder") ? {"course-builder": compileModePackDraft(COURSE_BUILDER_DRAFT, catalog)} : {})},
  };
}

function mapPath(
  resourceIdsByPath: Map<string, string>,
  resourceHashesByPath: Map<string, string>,
  resource: RuntimeModeResource,
): void {
  for (const path of resource.paths) {
    const key = normalizePath(path);
    const previous = resourceIdsByPath.get(key);
    if (previous && previous !== resource.id) throw new Error(`Mode Pack path is claimed by two resources: ${path}`);
    const digest = resource.pathHashes[key];
    if (!digest) throw new Error(`Mode Pack resource is missing its path digest: ${path}`);
    resourceIdsByPath.set(key, resource.id);
    resourceHashesByPath.set(key, digest);
  }
}

export function buildModePackRuntimePlanFromInventory(options: {
  snapshot: ResourceSnapshot;
  inventory: ModePackInventory;
  definition?: ModePackDefinition | null;
}): ModePackRuntimePlan {
  const snapshot = assertGenericModePackSnapshot(options.snapshot);
  const definition = options.definition ? assertModePackDefinitionIntegrity(options.definition) : null;
  if (definition && definition.modePackId !== snapshot.profileId) {
    throw new Error("Mode Pack definition and snapshot profile differ");
  }
  const extensionPaths: string[] = [];
  const skillPaths: string[] = [];
  const promptPaths: string[] = [];
  const themePaths: string[] = [];
  const expectedSkillIds: string[] = [];
  const expectedPluginIds: string[] = [];
  const expectedPromptIds: string[] = [];
  const expectedThemeIds: string[] = [];
  const loadedResourceText: Array<{ id: string; text: string }> = [];
  const resourceIdsByPath = new Map<string, string>();
  const resourceHashesByPath = new Map<string, string>();

  for (const descriptor of snapshot.resources) {
    if (!descriptor.enabled) continue;
    const key = resourceKey(descriptor.kind, descriptor.id);
    const installed = options.inventory.resourcesByKey.get(key);
    if (!installed) {
      if (descriptor.required) throw new Error(`Required Mode Pack resource is missing: ${key}`);
      continue;
    }
    if (installed.version !== descriptor.version || installed.contentHash !== descriptor.contentHash) {
      throw new Error(`Mode Pack resource identity changed: ${key}`);
    }
    if (descriptor.kind === "extension" && descriptor.id === "learning-harness") {
      throw new Error("Generic Mode Packs cannot activate the course-only learning-harness extension");
    }
    if (installed.text) loadedResourceText.push({ id: key, text: installed.text });
    if (descriptor.kind === "extension") {
      extensionPaths.push(...installed.paths);
      expectedPluginIds.push(descriptor.id);
    } else if (descriptor.kind === "skill") {
      skillPaths.push(...installed.paths);
      expectedSkillIds.push(descriptor.id);
    } else if (descriptor.kind === "prompt") {
      promptPaths.push(...installed.paths);
      expectedPromptIds.push(descriptor.id);
    } else if (descriptor.kind === "theme") {
      themePaths.push(...installed.paths);
      expectedThemeIds.push(descriptor.id);
    }
    mapPath(resourceIdsByPath, resourceHashesByPath, installed);
  }

  const systemPrompt = formatModePackSystemPrompt(
    snapshot,
    loadedResourceText.sort((left, right) => left.id.localeCompare(right.id)),
  );
  if (Buffer.byteLength(systemPrompt, "utf8") > MAX_COMPILED_PROMPT_BYTES) {
    throw new Error(`Compiled Mode Pack prompt exceeds ${MAX_COMPILED_PROMPT_BYTES} bytes`);
  }
  return {
    snapshot,
    definition,
    toolNames: [...snapshot.tools],
    extensionPaths: [...new Set(extensionPaths)].sort(),
    skillPaths: [...new Set(skillPaths)].sort(),
    promptPaths: [...new Set(promptPaths)].sort(),
    themePaths: [...new Set(themePaths)].sort(),
    expected: {
      activeTools: [...snapshot.tools],
      loadedSkillIds: [...new Set(expectedSkillIds)].sort(),
      loadedPluginIds: [...new Set(expectedPluginIds)].sort(),
      loadedPromptIds: [...new Set(expectedPromptIds)].sort(),
      loadedThemeIds: [...new Set(expectedThemeIds)].sort(),
    },
    systemPrompt,
    resourceIdsByPath,
    resourceHashesByPath,
  };
}

export async function buildModePackRuntimePlan(options: {
  snapshot: ResourceSnapshot;
  cwd: string;
  definition?: ModePackDefinition | null;
}): Promise<ModePackRuntimePlan> {
  const inventory = await inspectModePackInventory(options.cwd);
  if (inventory.diagnostics.some((item) => item.severity === "error")) {
    throw new Error(inventory.diagnostics.map((item) => item.message).join("; "));
  }
  return buildModePackRuntimePlanFromInventory({
    snapshot: options.snapshot,
    inventory,
    definition: options.definition,
  });
}

function loadedPath(value: { path?: string; filePath?: string; sourcePath?: string; sourceInfo?: { path?: string } }): string | null {
  return value.filePath ?? value.sourcePath ?? value.path ?? value.sourceInfo?.path ?? null;
}

function idsFromLoadedPaths(
  values: Array<{ path?: string; filePath?: string; sourcePath?: string; sourceInfo?: { path?: string } }>,
  plan: ModePackRuntimePlan,
  syntheticKind: ResourceKind,
): string[] {
  const loadedPaths = new Set<string>();
  const unexpected = new Set<string>();
  for (const value of values) {
    const path = loadedPath(value);
    if (!path || path.startsWith("<")) continue;
    const normalized = normalizePath(path);
    loadedPaths.add(normalized);
    if (!plan.resourceIdsByPath.has(normalized)) unexpected.add(`unexpected:${normalized}`);
  }

  const ids = new Set<string>(unexpected);
  const expectedIds = syntheticKind === "skill"
    ? plan.expected.loadedSkillIds
    : syntheticKind === "extension"
      ? plan.expected.loadedPluginIds
      : syntheticKind === "prompt"
        ? plan.expected.loadedPromptIds
        : plan.expected.loadedThemeIds;
  const physicalIds = new Set(plan.resourceIdsByPath.values());
  for (const id of expectedIds) {
    const paths = [...plan.resourceIdsByPath.entries()]
      .filter(([, resourceId]) => resourceId === id)
      .map(([path]) => path);
    if (paths.length === 0) continue;
    const current = paths.every((path) => {
      if (!loadedPaths.has(path)) return false;
      try {
        return fileDigest(path) === plan.resourceHashesByPath.get(path);
      } catch {
        return false;
      }
    });
    if (current) ids.add(id);
  }

  const marker = /<mode-pack-resource id="([^"]+)">/gu;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(plan.systemPrompt)) !== null) {
    const markerId = match[1] ?? "";
    const separator = markerId.indexOf(":");
    if (separator < 0) continue;
    const kind = markerId.slice(0, separator);
    const id = markerId.slice(separator + 1);
    // Synthetic built-in guidance has no filesystem path and is loaded by the
    // immutable prompt marker. Physical Skills/prompts must also appear in the
    // ResourceLoader evidence and pass a fresh content-digest check.
    if (kind === syntheticKind && id && !physicalIds.has(id)) ids.add(id);
  }
  return [...ids].sort();
}

function selectedPluginToolNames(session: RuntimeSessionLike, plan: ModePackRuntimePlan): string[] {
  const selectedPluginPaths = new Set(plan.extensionPaths.map(normalizePath));
  return session
    .getAllTools()
    .filter((tool) => {
      const source = tool.sourceInfo;
      if (!source || typeof source !== "object" || Array.isArray(source) || !("path" in source)) return false;
      const path = source.path;
      return typeof path === "string" && Boolean(path) && !path.startsWith("<") && selectedPluginPaths.has(normalizePath(path));
    })
    .map((tool) => tool.name)
    .sort();
}

export function expectedModePackActiveTools(session: RuntimeSessionLike, plan: ModePackRuntimePlan): string[] {
  return [...new Set([...plan.toolNames, ...selectedPluginToolNames(session, plan)])].sort();
}

export function applyModePackToolSelection(session: RuntimeSessionLike, plan: ModePackRuntimePlan): string[] {
  const active = expectedModePackActiveTools(session, plan);
  const known = new Set(session.getAllTools().map((tool) => tool.name));
  const missing = active.filter((name) => !known.has(name));
  if (missing.length > 0) throw new Error(`Mode Pack tools were not registered: ${missing.join(", ")}`);
  const mutating = session as RuntimeSessionLike & { setActiveToolsByName(toolNames: string[]): void };
  mutating.setActiveToolsByName(active);
  return active;
}

export function collectModePackRuntimeEvidence(
  session: RuntimeSessionLike,
  plan: ModePackRuntimePlan,
): ModePackRuntimeEvidence {
  const loader = session.resourceLoader;
  const systemPrompt = session.agent?.state?.systemPrompt ?? session.systemPrompt ?? "";
  return {
    activeTools: [...session.getActiveToolNames()].sort(),
    loadedSkillIds: idsFromLoadedPaths(loader.getSkills().skills, { ...plan, systemPrompt }, "skill"),
    loadedPluginIds: idsFromLoadedPaths(loader.getExtensions().extensions, { ...plan, systemPrompt }, "extension"),
    loadedPromptIds: idsFromLoadedPaths(loader.getPrompts().prompts, { ...plan, systemPrompt }, "prompt"),
    loadedThemeIds: idsFromLoadedPaths(loader.getThemes().themes, { ...plan, systemPrompt }, "theme"),
    systemPrompt,
  };
}

export function summarizeInventory(inventory: ModePackInventory): Array<{
  kind: ResourceKind;
  id: string;
  title: string;
  version: string;
  contentHash: string;
  source: string;
  scope: string;
}> {
  return inventory.resources.map(({ kind, id, title, version, contentHash: hash, source, scope }) => ({
    kind,
    id,
    title,
    version,
    contentHash: hash,
    source,
    scope,
  }));
}
