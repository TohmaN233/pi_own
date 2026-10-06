import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { stableStringify } from "../../../packages/harness-core/src/index.ts";
import { parseModePackDraft, type ModePackDefinition } from "../../../packages/harness-contracts/src/index.ts";
import { compileModePackDraft, ResourceCatalog } from "../../../packages/profile-resource-host/src/index.ts";
import { createPortableModePackage, createStoredPortableModePackage, parsePortableModePackage, portableModePackageAssetHash, portableModuleProfileIds, type PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { ModePackStore, definitionToDraft } from "./mode-pack-store";
import { inspectModePackInventory } from "./mode-pack-inventory";
import { portableModePackageDirectory, portableModeTemporaryDirectory, readLatestPortableModePackages, readPortableModePackage, verifyStoredPortableFile, withPortableModePackageCandidate } from "./portable-mode-pack-registry";
import { PortableModeImportConflictError, preflightPortableExternalDependencies, preflightPortableHostCapabilities, preflightPortableLocalNpmPayload, preflightPortableSharedResources, preflightPortableTargetPlatform, preflightSelectedPortableSkills } from "./portable-mode-import-preflight";
import { bundledCodeModePackage } from "./bundled-code-mode-package";
import { COURSE_BUILDER_DRAFT } from "./course-builder-pack";
import { STUDY_RESEARCH_DRAFTS } from "./study-research-pack";
import { ensurePortableModePackageInstalled, portableSelectedNpmDependencies, type PortableModePackageSelection } from "./portable-mode-package-install";
import { packPortableOfflineRuntime } from "./portable-mode-offline-runtime";
import { loadPortableModeRuntime } from "./portable-mode-runtime-loader";
import { preflightPortablePublicRegistrations } from "./portable-mode-registration-preflight";
import { resolveSharedResourceProviders } from "./portable-mode-shared-resources";

function safeName(value: string): string { return value.replace(/[^a-z0-9.-]+/giu, "_"); }
function resourceKey(kind: string, id: string): string { return `${kind}:${id}`; }

async function withOfflineNpmRuntime(archive: PortableModePackage): Promise<PortableModePackage> {
  if (archive.offlineRuntime) return archive;
  const selection: PortableModePackageSelection = { resources: archive.resources.map((resource) => ({ kind: resource.kind, id: resource.id, enabled: true })) };
  const dependencies = portableSelectedNpmDependencies(archive, selection);
  if (dependencies.length === 0) return archive;
  const runtime = await ensurePortableModePackageInstalled(archive, selection);
  const marker = JSON.parse(readFileSync(join(runtime, ".portable-install.json"), "utf8")) as { nodeModulesHash?: unknown };
  if (typeof marker.nodeModulesHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.nodeModulesHash)) {
    throw new Error("Portable npm runtime has no verified content marker");
  }
  const temporary = join(portableModeTemporaryDirectory(), `pi-own-mode-runtime-${randomUUID()}.tar.gz`);
  try {
    await packPortableOfflineRuntime(runtime, temporary);
    const bytes = readFileSync(temporary);
    const path = "payload/npm-tree.tar.gz";
    const file = { path, contentHash: portableModePackageAssetHash(bytes), bytes: bytes.byteLength, base64: bytes.toString("base64") };
    return createPortableModePackage({
      definition: archive.definition,
      ...(archive.moduleId ? { moduleId: archive.moduleId } : {}),
      ...(archive.profiles ? { profiles: archive.profiles } : {}),
      resources: archive.resources,
      files: [...archive.files, file],
      frontend: archive.frontend,
      projectCapabilities: archive.projectCapabilities,
      targetPlatform: archive.targetPlatform,
      externalDependencies: archive.externalDependencies,
      offlineRuntime: { archivePath: path, dependencies, nodeModulesHash: marker.nodeModulesHash },
      ...(archive.runtimeAssets ? { runtimeAssets: archive.runtimeAssets } : {}),
      ...(archive.sharedResources ? { sharedResources: archive.sharedResources } : {}),
    });
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function archiveWithDefinition(definition: ModePackDefinition, archive: PortableModePackage): PortableModePackage {
  const build = archive.files.every((file) => typeof file.base64 === "string") ? createPortableModePackage : createStoredPortableModePackage;
  let moduleId = archive.moduleId;
  let primary = definition;
  let profiles = archive.profiles;
  if (moduleId) {
    const originals = [archive.definition, ...(archive.profiles ?? [])];
    const layout = portableModuleProfileIds(archive, definition.modePackId)!;
    moduleId = layout.moduleId;
    const installed = originals.map((item, index) => {
      const id = layout.profileIds[index]!;
      if (id === definition.modePackId) return definition;
      const saved = new ModePackStore().getCustom(id);
      if (saved && saved.packageContentHash === definition.packageContentHash) return saved;
      if (moduleId === archive.moduleId) return item;
      throw new Error(`Portable module ${moduleId} is missing sibling profile ${id}`);
    });
    [primary, ...profiles] = installed;
  }
  const selectedResources = new Set([primary, ...(profiles ?? [])].flatMap((item) => item.components.map((component) => resourceKey(
    component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type,
    component.type === "workflow" ? `workflow:${component.id}` : component.id,
  ))));
  const resources = archive.resources.filter((resource) => selectedResources.has(resourceKey(resource.kind, resource.id)));
  return build({
    definition: primary,
    ...(profiles?.length ? { profiles } : {}),
    ...(moduleId ? { moduleId } : {}),
    resources, files: pruneUnlinkedResourceFiles(archive, resources),
    frontend: archive.frontend, projectCapabilities: archive.projectCapabilities,
    targetPlatform: archive.targetPlatform, externalDependencies: archive.externalDependencies,
    ...(archive.offlineRuntime ? { offlineRuntime: archive.offlineRuntime } : {}),
    ...(archive.runtimeAssets ? { runtimeAssets: archive.runtimeAssets } : {}),
    ...(archive.sharedResources ? { sharedResources: archive.sharedResources.filter((shared) => selectedResources.has(resourceKey(shared.kind, shared.id))) } : {}),
  });
}

/** Remove unbound Skill directories while preserving the support tree of any
 * other selected resource from the same upstream source. Package assets with
 * explicit frontend/runtime/shared ownership always remain protected. */
function selectedSourceLockBytes(
  archive: Pick<PortableModePackage, "files"> & Partial<Pick<PortableModePackage, "packageContentHash">>,
  selectedResources: PortableModePackage["resources"],
): Buffer | null {
  const file = archive.files.find((item) => item.path === "provenance/.skills-lock.json");
  if (!file) return null;
  if (!file.base64 && !archive.packageContentHash) throw new Error("Stored portable source lock has no package identity");
  const bytes = file.base64
    ? Buffer.from(file.base64, "base64")
    : readFileSync(join(portableModePackageDirectory(archive.packageContentHash!), file.path));
  if (portableModePackageAssetHash(bytes) !== file.contentHash) throw new Error("Portable source lock content hash mismatch");
  const lock = JSON.parse(bytes.toString("utf8")) as { version?: unknown; resources?: unknown };
  if (lock.version !== 1 || !Array.isArray(lock.resources) || !lock.resources.every((item) =>
    item && typeof item === "object" && typeof item.kind === "string" && typeof item.id === "string")) {
    throw new Error("Portable source lock has invalid resource entries");
  }
  const selected = new Set(selectedResources.map((resource) => resourceKey(resource.kind, resource.id)));
  return Buffer.from(`${stableStringify({ ...lock, resources: lock.resources.filter((item) => {
    const entry = item as { kind: string; id: string };
    return selected.has(resourceKey(entry.kind, entry.id));
  }) })}\n`);
}

function pruneUnlinkedResourceFiles(
  archive: Pick<PortableModePackage, "files" | "resources" | "frontend" | "runtimeAssets" | "sharedResources" | "offlineRuntime"> & Partial<Pick<PortableModePackage, "packageContentHash">>,
  selectedResources: PortableModePackage["resources"],
): PortableModePackage["files"] {
  const selectedPaths = selectedResources.flatMap((resource) => resource.source.type === "bundled" ? [resource.source.path] : []);
  const selectedKeys = new Set(selectedResources.map((resource) => resourceKey(resource.kind, resource.id)));
  const removedRoots = archive.resources
    .filter((resource) => !selectedKeys.has(resourceKey(resource.kind, resource.id)) && resource.source.type === "bundled")
    .map((resource) => posix.dirname((resource.source as { path: string }).path));
  const sourceRoots = new Set(archive.files.map((file) => {
    const parts = file.path.split("/");
    if (parts[0] !== "resources") return null;
    if (parts[1] === "sources" && parts[2]) return parts.slice(0, 3).join("/");
    if (parts[1] === "imported" && parts[2]) return parts.slice(0, 3).join("/");
    return null;
  }).filter((root): root is string => root !== null));
  const protectedFiles = new Set([
    ...(archive.frontend?.assets.map((asset) => asset.path) ?? []),
    ...(archive.runtimeAssets?.flatMap((asset) => asset.files) ?? []),
    ...(archive.sharedResources?.filter((shared) => selectedKeys.has(resourceKey(shared.kind, shared.id))).flatMap((shared) => shared.files) ?? []),
    ...(archive.offlineRuntime ? [archive.offlineRuntime.archivePath] : []),
  ]);
  const retained = archive.files.filter((file) => {
    if (protectedFiles.has(file.path)) return true;
    if (file.path.startsWith("resources/") && selectedPaths.length === 0) return false;
    const sourceRoot = [...sourceRoots].find((root) => file.path.startsWith(`${root}/`));
    if (sourceRoot && !selectedPaths.some((path) => path.startsWith(`${sourceRoot}/`))) return false;
    if (removedRoots.some((root) => (file.path === root || file.path.startsWith(`${root}/`))
      && !selectedPaths.some((path) => path.startsWith(`${root}/`)))) return false;
    return true;
  });
  const lock = selectedSourceLockBytes(archive, selectedResources);
  return lock ? retained.map((file) => file.path === "provenance/.skills-lock.json"
    ? { path: file.path, contentHash: portableModePackageAssetHash(lock), bytes: lock.byteLength,
        ...(file.base64 !== undefined ? { base64: lock.toString("base64") } : {}) }
    : file) : retained;
}

function hydrateStoredArchive(archive: PortableModePackage): PortableModePackage {
  if (archive.files.every((file) => typeof file.base64 === "string")) return archive;
  const directory = portableModePackageDirectory(archive.packageContentHash);
  return { ...archive, files: archive.files.map((file) => {
    const bytes = readFileSync(join(directory, file.path));
    if (bytes.byteLength !== file.bytes || portableModePackageAssetHash(bytes) !== file.contentHash) {
      throw new Error(`Portable Mode Package file changed during export: ${file.path}`);
    }
    return { ...file, base64: bytes.toString("base64") };
  }) };
}

function storedManifest(archive: PortableModePackage): PortableModePackage {
  return { ...archive, files: archive.files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })) };
}

function addResourceFiles(options: {
  files: Map<string, PortableModePackage["files"][number]>;
  root: string;
  primaryPath: string;
  kind: string;
  id: string;
}): string {
  const sourceFiles = new Set<string>();
  const root = resolve(options.root);
  const bundleBase = `resources/${safeName(options.kind)}/${safeName(options.id)}`;
  const addTree = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Cannot export symlinked resource ${child}`);
      if (entry.isDirectory()) addTree(child);
      else if (entry.isFile()) sourceFiles.add(resolve(child));
    }
  };
  if (options.kind === "skill") addTree(root);
  else sourceFiles.add(resolve(options.primaryPath));
  const packagePathFor = (sourcePath: string): string => {
    const sourceRelative = relative(root, sourcePath).replaceAll("\\", "/");
    const packagePath = posix.normalize(posix.join(bundleBase, sourceRelative));
    if (!packagePath.startsWith("resources/") || packagePath.split("/").includes("..")) {
      throw new Error(`Referenced support file escapes portable package: ${sourcePath}`);
    }
    return packagePath;
  };
  const insideRoot = (sourcePath: string): boolean => {
    const sourceRelative = relative(root, sourcePath);
    return sourceRelative === "" || (!sourceRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && sourceRelative !== "..");
  };
  const localReferences = (text: string): string[] => [...text.matchAll(/\]\(([^)]+)\)/gu)]
    .map((match) => match[1]!.trim().split(/[?#]/u, 1)[0]!)
    .filter((target) => target && !/^[a-z][a-z0-9+.-]*:/iu.test(target) && !target.startsWith("/"));
  // Walk markdown links, including a shared ../../references directory. We keep
  // the original relative geometry below resources/, so upstream documentation
  // links remain valid after import without rewriting upstream bytes.
  const pending = [...sourceFiles];
  while (pending.length > 0) {
    const sourcePath = pending.shift()!;
    if (options.kind === "extension") {
      const source = readFileSync(sourcePath, "utf8");
      if (/\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']|\brequire\s*\(|\bimport\s*\(/u.test(source)) {
        throw new Error(`Cannot export extension ${options.id}: ${sourcePath} has module dependencies without a portable dependency closure`);
      }
    }
    if (!/\.md$/iu.test(sourcePath)) continue;
    for (const target of localReferences(readFileSync(sourcePath, "utf8"))) {
      const candidate = resolve(dirname(sourcePath), target);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      if (!insideRoot(candidate)) {
        throw new Error(`Cannot export external Skill reference outside its declared resource root: ${target}`);
      }
      packagePathFor(candidate);
      if (!sourceFiles.has(candidate)) {
        sourceFiles.add(candidate);
        pending.push(candidate);
      }
    }
  }
  let primaryBundlePath = "";
  for (const sourcePath of [...sourceFiles].sort()) {
    const path = packagePathFor(sourcePath);
    const bytes = readFileSync(sourcePath);
    const file = { path, contentHash: portableModePackageAssetHash(bytes), bytes: bytes.byteLength, base64: bytes.toString("base64") };
    const prior = options.files.get(path);
    if (prior && (prior.contentHash !== file.contentHash || prior.bytes !== file.bytes)) {
      throw new Error(`Portable resource support file collision: ${path}`);
    }
    options.files.set(path, file);
    if (resolve(sourcePath) === resolve(options.primaryPath)) primaryBundlePath = path;
  }
  if (!primaryBundlePath) throw new Error(`Resource entrypoint disappeared while exporting ${options.kind}:${options.id}`);
  return primaryBundlePath;
}

interface BuiltFrontendManifest {
  format: "pi-own-portable-frontend/v1";
  moduleId: string;
  entries: Record<string, string>;
  assets: Array<{ path: string; contentHash: string; bytes: number; contentEncoding?: "gzip" }>;
}
interface BuiltRuntimeManifest {
  format: "pi-own-portable-runtime/v1";
  moduleId: string;
  entry: string;
  routes: string[];
  extensionEntries: Record<string, string>;
  hostCapabilities: string[];
  platformImports: string[];
  files: Array<{ path: string; contentHash: string; bytes: number }>;
}

function addBuiltAsset(files: Map<string, PortableModePackage["files"][number]>, source: string, path: string, hash: string, length: number): void {
  const bytes = readFileSync(source);
  if (bytes.byteLength !== length || portableModePackageAssetHash(bytes) !== hash) throw new Error(`Built module asset changed: ${source}`);
  if (files.has(path)) throw new Error(`Portable module asset path collision: ${path}`);
  files.set(path, { path, contentHash: hash, bytes: length, base64: bytes.toString("base64") });
}

/** The two education workspaces are one module each. Their original UI and
 * domain routes are compiled to package-owned files by the repeatable build
 * scripts, then assembled with the same generic archive as every other mode. */
async function bundledEducationModule(modePackId: string, cwd: string): Promise<PortableModePackage | null> {
  const moduleId = modePackId === "course-builder" ? "course-builder"
    : STUDY_RESEARCH_DRAFTS.some((draft) => draft.modePackId === modePackId) ? "study-research" : null;
  if (!moduleId) return null;
  const drafts = moduleId === "course-builder" ? [COURSE_BUILDER_DRAFT] : STUDY_RESEARCH_DRAFTS;
  const inventory = await inspectModePackInventory(cwd);
  const root = join(process.cwd(), "runtime");
  const webRoot = existsSync(join(root, "module-frontends")) ? root : join(process.cwd(), "apps", "pi-web", "runtime");
  const frontendRoot = join(webRoot, "module-frontends", moduleId);
  const runtimeRoot = join(webRoot, "module-runtimes", moduleId);
  if (!existsSync(join(frontendRoot, "frontend-manifest.json")) || !existsSync(join(runtimeRoot, "runtime-manifest.json"))) {
    throw new Error(`Portable ${moduleId} build assets are missing; run the Pi Web prebuild task before exporting`);
  }
  const frontendManifest = JSON.parse(readFileSync(join(frontendRoot, "frontend-manifest.json"), "utf8")) as BuiltFrontendManifest;
  const runtimeManifest = JSON.parse(readFileSync(join(runtimeRoot, "runtime-manifest.json"), "utf8")) as BuiltRuntimeManifest;
  if (frontendManifest.format !== "pi-own-portable-frontend/v1" || frontendManifest.moduleId !== moduleId
    || runtimeManifest.format !== "pi-own-portable-runtime/v1" || runtimeManifest.moduleId !== moduleId) {
    throw new Error(`Portable ${moduleId} build manifest is invalid`);
  }
  const files = new Map<string, PortableModePackage["files"][number]>();
  for (const asset of frontendManifest.assets) addBuiltAsset(files, join(frontendRoot, asset.path), `frontend/${asset.path}`, asset.contentHash, asset.bytes);
  const runtimeFiles = [...runtimeManifest.files];
  const runtimeManifestBytes = readFileSync(join(runtimeRoot, "runtime-manifest.json"));
  runtimeFiles.push({ path: "runtime-manifest.json", contentHash: portableModePackageAssetHash(runtimeManifestBytes), bytes: runtimeManifestBytes.byteLength });
  for (const asset of runtimeFiles) addBuiltAsset(files, join(runtimeRoot, asset.path), `module-runtime/${asset.path}`, asset.contentHash, asset.bytes);
  const catalogEntries = inventory.resources.map(({ kind, id, version, contentHash, delivery }) => ({ kind, id, version, contentHash, ...(delivery ? { delivery } : {}) }));
  for (const [id, path] of Object.entries(runtimeManifest.extensionEntries)) {
    const resource = catalogEntries.find((entry) => entry.kind === "extension" && entry.id === id);
    if (!resource) throw new Error(`Portable ${moduleId} build has an unknown extension: ${id}`);
    resource.version = "1.0.0";
    resource.contentHash = files.get(`module-runtime/${path}`)!.contentHash;
  }
  const catalog = new ResourceCatalog(catalogEntries);
  const definitions = drafts.map((draft) => compileModePackDraft(draft, catalog));
  const resources: PortableModePackage["resources"] = [];
  const seen = new Set<string>();
  for (const component of definitions.flatMap((definition) => definition.components)) {
    const kind = component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type;
    const id = component.type === "workflow" ? `workflow:${component.id}` : component.id;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let path: string;
    if (kind === "extension") {
      const wrapper = runtimeManifest.extensionEntries[id];
      if (!wrapper) throw new Error(`Portable ${moduleId} runtime has no extension ${id}`);
      path = `module-runtime/${wrapper}`;
    } else {
      const source = inventory.resourcesByKey.get(key);
      if (!source) throw new Error(`Portable ${moduleId} has no source for ${key}`);
      if (source.paths[0]) path = addResourceFiles({ files, root: dirname(source.paths[0]), primaryPath: source.paths[0], kind, id });
      else if (source.text?.trim()) {
        path = `resources/${safeName(kind)}/${safeName(id)}/${kind === "skill" ? "SKILL.md" : "prompt.md"}`;
        const bytes = Buffer.from(source.text, "utf8");
        files.set(path, { path, contentHash: portableModePackageAssetHash(bytes), bytes: bytes.byteLength, base64: bytes.toString("base64") });
      } else throw new Error(`Portable ${moduleId} resource has no content: ${key}`);
    }
    resources.push({ kind: kind as PortableModePackage["resources"][number]["kind"], id, delivery: component.delivery ?? "system-instruction", contentHash: component.contentHash, source: { type: "bundled", path } });
  }
  const runtimePaths = runtimeFiles.map((file) => `module-runtime/${file.path}`);
  const entry = `module-runtime/${runtimeManifest.entry}`;
  const runtimeAssets: PortableModePackage["runtimeAssets"] = ["harness", "route-validation"].map((kind) => ({
    kind: kind as "harness" | "route-validation", id: moduleId, version: "1.0.0", entry,
    contentHash: files.get(entry)!.contentHash, files: runtimePaths,
  }));
  const frontend = {
    entry: `frontend/${moduleId === "course-builder" ? frontendManifest.entries["course-builder"] : frontendManifest.entries.study}`,
    assets: frontendManifest.assets.map((asset) => ({ path: `frontend/${asset.path}`, contentHash: asset.contentHash, bytes: asset.bytes, ...(asset.contentEncoding ? { contentEncoding: asset.contentEncoding } : {}) })),
    presentation: "workspace" as const,
    ...(moduleId === "study-research" ? { phaseEntries: { ".study": `frontend/${frontendManifest.entries.study}`, ".research": `frontend/${frontendManifest.entries.study}` } } : {}),
  };
  return createPortableModePackage({
    moduleId, definition: definitions[0]!, ...(definitions.length > 1 ? { profiles: definitions.slice(1) } : {}),
    resources, frontend, projectCapabilities: ["host-api:cwd-browse@1", "host-api:pdf-preview@1"], targetPlatform: { os: process.platform, arch: process.arch }, externalDependencies: [],
    runtimeAssets, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  });
}

export async function exportPortableModePackage(modePackId: string, cwd: string): Promise<PortableModePackage> {
  const inventory = await inspectModePackInventory(cwd, { includeBundledCode: modePackId === "coding" });
  const saved = new ModePackStore().getCustom(modePackId);
  const definition = saved ?? inventory.builtinPacks[modePackId];
  if (!definition) throw new Error(`Unknown Mode Pack: ${modePackId}`);
  if (!saved && modePackId === bundledCodeModePackage().definition.modePackId && definition.packageContentHash === bundledCodeModePackage().packageContentHash) return withOfflineNpmRuntime(bundledCodeModePackage());
  if (!definition.packageContentHash) {
    const educationPackage = await bundledEducationModule(modePackId, cwd);
    if (educationPackage) return educationPackage;
  }
  if (definition.packageContentHash) {
    const packaged = readPortableModePackage(definition.packageContentHash);
    if (!packaged) throw new Error(`Portable Mode Package cache is unavailable: ${definition.packageContentHash}`);
    return withOfflineNpmRuntime(archiveWithDefinition(definition, hydrateStoredArchive(packaged)));
  }
  const files = new Map<string, PortableModePackage["files"][number]>(); const resources: PortableModePackage["resources"] = [];
  // A portable module must also carry components that are selectable after
  // installation. Omitting a disabled optional Skill would turn the first
  // enable action into an ambient-host dependency.
  for (const component of definition.components) {
    const kind = component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type;
    const id = component.type === "workflow" ? `workflow:${component.id}` : component.id;
    const resource = inventory.resourcesByKey.get(resourceKey(kind, id)); if (!resource) throw new Error(`Cannot export unavailable resource ${kind}:${id}`);
    const path = resource.paths[0];
    let primaryPath: string;
    if (path) {
      const root = dirname(path);
      primaryPath = addResourceFiles({ files, root, primaryPath: path, kind, id });
    } else if (resource.text?.trim() && (kind === "prompt" || kind === "skill")) {
      primaryPath = `resources/${safeName(kind)}/${safeName(id)}/${kind === "skill" ? "SKILL.md" : "prompt.md"}`;
      const bytes = Buffer.from(resource.text, "utf8");
      files.set(primaryPath, { path: primaryPath, contentHash: portableModePackageAssetHash(bytes), bytes: bytes.byteLength, base64: bytes.toString("base64") });
    } else {
      throw new Error(`Cannot export ${modePackId}: ${kind}:${id} has no portable implementation bytes`);
    }
    resources.push({ kind: kind as PortableModePackage["resources"][number]["kind"], id, delivery: component.delivery ?? "system-instruction", contentHash: resource.contentHash, source: { type: "bundled", path: primaryPath } });
  }
  const frontend = null; const projectCapabilities: string[] = []; const fileValues = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  const targetPlatform = { os: process.platform, arch: process.arch };
  const externalDependencies: PortableModePackage["externalDependencies"] = [];
  return createPortableModePackage({ definition, resources, frontend, projectCapabilities, targetPlatform, externalDependencies, files: fileValues });
}

/** Assemble selected resources from other installed modules into a new,
 * self-contained archive before the revision becomes visible. Resource IDs
 * remain internal identities; a Skill keeps its upstream frontmatter name. */
export async function composePortableModePackage(options: {
  draft: unknown;
  cwd: string;
  expectedRevision: number;
  sourceModePackId?: string;
  resourceSources: Array<{ kind: "skill" | "extension"; id: string; packageContentHash: string }>;
  removeResources?: Array<{ kind: "skill" | "extension"; id: string }>;
}): Promise<ModePackDefinition> {
  const draft = parseModePackDraft(options.draft);
  const editableBuiltin = ["coding", "general", "creative", "course-builder", "study-research.study", "study-research.research"].includes(draft.modePackId) ? draft.modePackId : undefined;
  if (!draft.modePackId.startsWith("custom.") && !editableBuiltin) throw new Error("Composed Mode Pack id is not editable");
  if (draft.revision !== options.expectedRevision + 1) throw new Error("Composed Mode Pack revision is stale");
  if (editableBuiltin && options.sourceModePackId !== editableBuiltin) throw new Error("Built-in composition requires the same source Mode Pack identity");
  const sourceArchive = draft.packageContentHash
    ? readPortableModePackage(draft.packageContentHash) ?? (bundledCodeModePackage().packageContentHash === draft.packageContentHash ? bundledCodeModePackage() : null)
    : options.sourceModePackId ? await exportPortableModePackage(options.sourceModePackId, options.cwd) : null;
  if (draft.packageContentHash && !sourceArchive) throw new Error(`Base portable package is unavailable: ${draft.packageContentHash}`);
  if (editableBuiltin && sourceArchive && ![sourceArchive.definition, ...(sourceArchive.profiles ?? [])].some((item) => item.modePackId === editableBuiltin))
    throw new Error(`Built-in source package does not contain ${editableBuiltin}`);
  const removed = new Set((options.removeResources ?? []).map(item => resourceKey(item.kind, item.id)));
  const sourceDefinitions = sourceArchive ? [sourceArchive.definition, ...(sourceArchive.profiles ?? [])].map(item => ({
    ...item, components: item.components.filter(component => !removed.has(resourceKey(component.type === "plugin" ? "extension" : component.type, component.id))),
  })) : [];
  const editableBuiltinRevisions = editableBuiltin ? Object.fromEntries(sourceDefinitions.map((item) => [item.modePackId, item.revision])) : {};
  if (editableBuiltin && (!sourceArchive || Object.keys(editableBuiltinRevisions).some((id) => !["coding", "general", "creative", "course-builder", "study-research.study", "study-research.research"].includes(id))))
    throw new Error(`Built-in package source is unavailable or has unexpected profiles: ${editableBuiltin}`);
  if (sourceArchive?.profiles?.length && !sourceDefinitions.some((item) => item.modePackId === draft.modePackId)) {
    throw new Error(`Edited profile does not belong to portable module ${sourceArchive.moduleId}`);
  }
  if (sourceArchive?.profiles?.length && sourceDefinitions.some((item) => (new ModePackStore().getCustom(item.modePackId)?.revision ?? item.revision) !== options.expectedRevision)) {
    throw new Error(`Portable module ${sourceArchive.moduleId} has profiles at different revisions`);
  }
  const donors = new Map<string, PortableModePackage>();
  const requested = new Map<string, string>();
  for (const selection of options.resourceSources) {
    const key = resourceKey(selection.kind, selection.id);
    if (requested.has(key) && requested.get(key) !== selection.packageContentHash) throw new Error(`Resource has two selected providers: ${key}`);
    const archive = readPortableModePackage(selection.packageContentHash)
      ?? (bundledCodeModePackage().packageContentHash === selection.packageContentHash ? bundledCodeModePackage() : null);
    if (!archive) throw new Error(`Resource provider is unavailable: ${selection.packageContentHash}`);
    donors.set(selection.packageContentHash, archive);
    requested.set(key, selection.packageContentHash);
  }
  const selectedComponents = [...draft.components, ...sourceDefinitions.filter((item) => item.modePackId !== draft.modePackId).flatMap((item) => item.components)];
  const draftResources = new Set(selectedComponents.map((component) => resourceKey(
    component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type,
    component.type === "workflow" ? `workflow:${component.id}` : component.id,
  )));
  const resources = [...(sourceArchive?.resources ?? [])].filter((resource) => draftResources.has(resourceKey(resource.kind, resource.id)));
  const files = new Map<string, PortableModePackage["files"][number]>();
  if (sourceArchive) for (const file of hydrateStoredArchive(sourceArchive).files) files.set(file.path, file);
  let addedNpmDependency = false;
  for (const [key, hash] of requested) {
    const donor = donors.get(hash)!;
    const resource = donor.resources.find((candidate) => resourceKey(candidate.kind, candidate.id) === key);
    if (!resource) throw new Error(`Provider ${hash} does not contain ${key}`);
    const priorIndex = resources.findIndex((candidate) => resourceKey(candidate.kind, candidate.id) === key);
    if (priorIndex >= 0 && resources[priorIndex]!.contentHash !== resource.contentHash) {
      throw new Error(`Resource identity conflict for ${key}; choose a different internal id before composition`);
    }
    if (priorIndex >= 0) continue;
    const prefix = `resources/imported/${hash.slice("sha256:".length, "sha256:".length + 24)}/`;
    if (resource.source.type === "bundled") {
      const selectedDonorFiles = pruneUnlinkedResourceFiles(hydrateStoredArchive(donor), [resource]);
      for (const file of selectedDonorFiles.filter((candidate) => candidate.path.startsWith("resources/"))) {
        const target = `${prefix}${file.path}`;
        const previous = files.get(target);
        if (previous && (previous.contentHash !== file.contentHash || previous.bytes !== file.bytes)) throw new Error(`Imported resource file collision: ${target}`);
        files.set(target, { ...file, path: target });
      }
      resources.push({ ...resource, source: { type: "bundled", path: `${prefix}${resource.source.path}` } });
    } else {
      addedNpmDependency = true;
      resources.push(resource);
    }
  }
  const selected = new Set(selectedComponents.map((component) => resourceKey(
    component.type === "plugin" ? "extension" : component.type === "workflow" ? "prompt" : component.type,
    component.type === "workflow" ? `workflow:${component.id}` : component.id,
  )));
  for (const key of requested.keys()) if (!selected.has(key)) throw new Error(`Composed resource was not selected in the draft: ${key}`);
  const baseInventory = await inspectModePackInventory(options.cwd);
  const descriptors: Array<ConstructorParameters<typeof ResourceCatalog>[0][number]> = baseInventory.resources
    .filter((item) => item.kind === "tool").map(({ kind, id, version, contentHash }) => ({ kind, id, version, contentHash }));
  for (const resource of resources) {
    const owner = [sourceArchive, ...donors.values()].find((archive) => archive?.resources.some((candidate) => candidate.kind === resource.kind && candidate.id === resource.id && candidate.contentHash === resource.contentHash));
    const component = [owner?.definition, ...(owner?.profiles ?? [])].flatMap((item) => item?.components ?? []).find((candidate) =>
      (candidate.type === "plugin" ? "extension" : candidate.type === "workflow" ? "prompt" : candidate.type) === resource.kind
      && (candidate.type === "workflow" ? `workflow:${candidate.id}` : candidate.id) === resource.id);
    descriptors.push({ kind: resource.kind, id: resource.id, version: component?.version ?? owner?.packageContentHash ?? "", contentHash: resource.contentHash, delivery: resource.delivery });
  }
  const unpackagedDraft = { ...draft };
  delete unpackagedDraft.packageContentHash;
  const catalog = new ResourceCatalog(descriptors);
  const definition = compileModePackDraft(unpackagedDraft, catalog);
  const moduleDefinitions = sourceArchive?.profiles?.length
    ? sourceDefinitions.map((item) => {
        if (item.modePackId === draft.modePackId) return definition;
        const saved = new ModePackStore().getCustom(item.modePackId) ?? item;
        if (saved !== item && saved.packageContentHash !== sourceArchive.packageContentHash) {
          throw new Error(`Portable module profile changed during composition: ${item.modePackId}`);
        }
        const siblingDraft = definitionToDraft(saved);
        siblingDraft.components = siblingDraft.components.filter(component => !removed.has(resourceKey(component.type === "plugin" ? "extension" : component.type, component.id)));
        delete siblingDraft.packageContentHash;
        return compileModePackDraft({ ...siblingDraft, revision: options.expectedRevision + 1 }, catalog);
      })
    : [definition];
  // A removed dependency must also leave the offline npm payload, otherwise
  // uninstalling a resource merely hides it while retaining its executable files.
  const removedDependency = sourceArchive?.resources.some(resource =>
    !resources.some(item => item.kind === resource.kind && item.id === resource.id)
    && (resource.source.type === "npm" || resource.runtimeDependencies?.length));
  const priorOffline = !addedNpmDependency && !removedDependency ? sourceArchive?.offlineRuntime : undefined;
  if (!priorOffline && sourceArchive?.offlineRuntime) files.delete(sourceArchive.offlineRuntime.archivePath);
  const archive = createPortableModePackage({
    definition: moduleDefinitions[0]!,
    ...(moduleDefinitions.length > 1 ? { profiles: moduleDefinitions.slice(1), moduleId: sourceArchive!.moduleId } : {}),
    resources,
    files: pruneUnlinkedResourceFiles({
      files: [...files.values()], resources: sourceArchive?.resources ?? [],
      frontend: sourceArchive?.frontend ?? null,
      ...(sourceArchive?.runtimeAssets ? { runtimeAssets: sourceArchive.runtimeAssets } : {}),
      ...(sourceArchive?.sharedResources ? { sharedResources: sourceArchive.sharedResources } : {}),
      ...(priorOffline ? { offlineRuntime: priorOffline } : {}),
    }, resources),
    frontend: sourceArchive?.frontend ?? null,
    projectCapabilities: sourceArchive?.projectCapabilities ?? [],
    targetPlatform: { os: process.platform, arch: process.arch },
    externalDependencies: sourceArchive?.externalDependencies ?? [],
    ...(priorOffline ? { offlineRuntime: priorOffline } : {}),
    ...(sourceArchive?.runtimeAssets ? { runtimeAssets: sourceArchive.runtimeAssets } : {}),
    ...(sourceArchive?.sharedResources ? { sharedResources: sourceArchive.sharedResources.filter((shared) => selected.has(resourceKey(shared.kind, shared.id))) } : {}),
  });
  await installPortableModePackage(await withOfflineNpmRuntime(archive), options.cwd, options.expectedRevision, undefined, { editableBuiltinRevisions });
  const saved = new ModePackStore().getCustom(draft.modePackId);
  if (!saved || saved.revision !== definition.revision) throw new Error(`Composed profile was not registered: ${draft.modePackId}`);
  return saved;
}

interface PortableFileExport {
  archive: PortableModePackage;
  sources: Map<string, { file: string } | { bytes: Buffer }>;
  cleanup: () => void;
}

async function includeOfflineRuntime(base: PortableFileExport): Promise<PortableFileExport> {
  if (base.archive.offlineRuntime) return base;
  const selection: PortableModePackageSelection = { resources: base.archive.resources.map((resource) => ({ kind: resource.kind, id: resource.id, enabled: true })) };
  const dependencies = portableSelectedNpmDependencies(base.archive, selection);
  if (dependencies.length === 0) return base;
  const runtime = await ensurePortableModePackageInstalled(base.archive, selection);
  const marker = JSON.parse(readFileSync(join(runtime, ".portable-install.json"), "utf8")) as { nodeModulesHash?: unknown };
  if (typeof marker.nodeModulesHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.nodeModulesHash)) throw new Error("Portable npm runtime has no verified content marker");
  const temporary = join(portableModeTemporaryDirectory(), `pi-own-mode-runtime-${randomUUID()}.tar.gz`);
  try {
    await packPortableOfflineRuntime(runtime, temporary);
    const path = "payload/npm-tree.tar.gz";
    if (base.sources.has(path)) throw new Error(`Portable Mode Package payload path is already occupied: ${path}`);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) digest.update(chunk);
    const file = { path, contentHash: `sha256:${digest.digest("hex")}`, bytes: statSync(temporary).size };
    const archive = createStoredPortableModePackage({
      definition: base.archive.definition, resources: base.archive.resources, files: [...base.archive.files, file],
      ...(base.archive.moduleId ? { moduleId: base.archive.moduleId } : {}),
      ...(base.archive.profiles ? { profiles: base.archive.profiles } : {}),
      frontend: base.archive.frontend, projectCapabilities: base.archive.projectCapabilities,
      targetPlatform: base.archive.targetPlatform, externalDependencies: base.archive.externalDependencies,
      offlineRuntime: { archivePath: path, dependencies, nodeModulesHash: marker.nodeModulesHash },
      ...(base.archive.runtimeAssets ? { runtimeAssets: base.archive.runtimeAssets } : {}),
      ...(base.archive.sharedResources ? { sharedResources: base.archive.sharedResources } : {}),
    });
    const sources = new Map(base.sources); sources.set(path, { file: temporary });
    return { archive, sources, cleanup: () => { base.cleanup(); if (existsSync(temporary)) unlinkSync(temporary); } };
  } catch (error) { base.cleanup(); if (existsSync(temporary)) unlinkSync(temporary); throw error; }
}

export async function exportPortableModePackageFiles(modePackId: string, cwd: string): Promise<PortableFileExport> {
  const packagedDefinition = new ModePackStore().getCustom(modePackId);
  if (packagedDefinition?.packageContentHash) {
    const stored = readPortableModePackage(packagedDefinition.packageContentHash);
    if (!stored) throw new Error(`Portable Mode Package cache is unavailable: ${packagedDefinition.packageContentHash}`);
    const archive = archiveWithDefinition(packagedDefinition, stored);
    const directory = portableModePackageDirectory(stored.packageContentHash);
    const lock = selectedSourceLockBytes(stored, archive.resources);
    return includeOfflineRuntime({ archive, sources: new Map(archive.files.map((file) => [file.path,
      file.path === "provenance/.skills-lock.json" && lock && file.contentHash !== stored.files.find((item) => item.path === file.path)?.contentHash
        ? { bytes: lock } : { file: join(directory, file.path) },
    ])), cleanup: () => {} });
  }
  if (modePackId === "coding") {
    const base = bundledCodeModePackage();
    return includeOfflineRuntime({ archive: parsePortableModePackage(storedManifest(base), { storedManifest: true }),
      sources: new Map(base.files.map((item) => [item.path, { bytes: Buffer.from(item.base64!, "base64") }])), cleanup: () => {} });
  }
  const embedded = await exportPortableModePackage(modePackId, cwd);
  const archive = parsePortableModePackage(storedManifest(embedded), { storedManifest: true });
  return { archive, sources: new Map(embedded.files.map((file) => [file.path, { bytes: Buffer.from(file.base64!, "base64") }])), cleanup: () => {} };
}

function importedArchive(value: unknown, newModePackId?: string, expectedRevision = 0): PortableModePackage {
  const archive = parsePortableModePackage(value);
  if (!newModePackId) return archive;
  return remapArchiveModule(archive, newModePackId, expectedRevision);
}

function remapArchiveModule(archive: PortableModePackage, newModuleId: string, expectedRevision: number): PortableModePackage {
  if (!newModuleId.startsWith("custom.")) throw new Error("Imported module id must start with custom.");
  const multiProfile = Boolean(archive.moduleId && archive.profiles?.length);
  const mapDefinition = (definition: ModePackDefinition): ModePackDefinition => ({
    ...definition,
    modePackId: multiProfile ? `${newModuleId}${definition.modePackId.slice(archive.moduleId!.length)}` : newModuleId,
    revision: expectedRevision + 1,
  });
  const build = archive.files.every((file) => typeof file.base64 === "string") ? createPortableModePackage : createStoredPortableModePackage;
  return build({
    ...(archive.moduleId ? { moduleId: newModuleId } : {}),
    definition: mapDefinition(archive.definition),
    ...(archive.profiles ? { profiles: archive.profiles.map(mapDefinition) } : {}),
    resources: archive.resources, files: archive.files, frontend: archive.frontend,
    projectCapabilities: archive.projectCapabilities, targetPlatform: archive.targetPlatform,
    externalDependencies: archive.externalDependencies,
    ...(archive.offlineRuntime ? { offlineRuntime: archive.offlineRuntime } : {}),
    ...(archive.runtimeAssets ? { runtimeAssets: archive.runtimeAssets } : {}),
    ...(archive.sharedResources ? { sharedResources: archive.sharedResources } : {}),
  });
}

export async function importPortableModePackage(value: unknown, cwd: string, expectedRevision = 0, newModePackId?: string, options: { allowLegacyOnlineNpm?: boolean } = {}): Promise<ModePackDefinition> {
  return installPortableModePackage(importedArchive(value, newModePackId, expectedRevision), cwd, expectedRevision, undefined, options);
}

export async function importPortableModePackageFiles(value: unknown, sourceDirectory: string, cwd: string, expectedRevision = 0, newModePackId?: string): Promise<ModePackDefinition> {
  const parsed = parsePortableModePackage(value, { storedManifest: true });
  if (newModePackId && !newModePackId.startsWith("custom.")) throw new Error("Imported Mode Pack id must start with custom.");
  const archive = newModePackId ? remapArchiveModule(parsed, newModePackId, expectedRevision) : parsed;
  return installPortableModePackage(archive, cwd, expectedRevision, sourceDirectory, {});
}

async function installPortableModePackage(archive: PortableModePackage, cwd: string, expectedRevision: number, sourceDirectory?: string, options: { allowLegacyOnlineNpm?: boolean; editableBuiltinRevisions?: Readonly<Record<string, number>> } = {}): Promise<ModePackDefinition> {
  const definitions = [archive.definition, ...(archive.profiles ?? [])];
  for (const definition of definitions) {
    if (!definition.modePackId.startsWith("custom.") && !Object.hasOwn(options.editableBuiltinRevisions ?? {}, definition.modePackId)) throw new Error("Imported Mode Pack id must start with custom.");
    if (definition.role !== "general" || definition.runtimeMode !== "general" || definition.courseRequired)
      throw new PortableModeImportConflictError([{ kind: "unsupported-mode-runtime", modePackId: definition.modePackId, role: definition.role, runtimeMode: definition.runtimeMode }]);
  }
  preflightPortableTargetPlatform(archive);
  preflightPortableHostCapabilities(archive);
  preflightPortableExternalDependencies(archive);
  if (!options.allowLegacyOnlineNpm) preflightPortableLocalNpmPayload(archive);
  let probedPeerHashes: string | null = null;
  const preflightShared = (): PortableModePackage[] => {
    if (!archive.sharedResources?.length) return [];
    const relatedIds = new Set(archive.sharedResources.map((binding) => binding.logicalId));
    let peers: PortableModePackage[] = [];
    while (true) {
      peers = readLatestPortableModePackages(definitions.map((definition) => definition.modePackId), [...relatedIds]);
      const size = relatedIds.size;
      for (const peer of peers) for (const binding of peer.sharedResources ?? []) relatedIds.add(binding.logicalId);
      if (relatedIds.size === size) break;
    }
    preflightPortableSharedResources(archive, peers);
    const fingerprint = peers.map((peer) => peer.packageContentHash).sort().join("\0");
    if (probedPeerHashes !== null && fingerprint !== probedPeerHashes) {
      throw new PortableModeImportConflictError([{ kind: "public-registration", moduleId: archive.moduleId ?? archive.definition.modePackId,
        diagnostic: "Installed shared providers changed during registration preflight; retry the import against the current Pi installation" }]);
    }
    return peers;
  };
  preflightShared();
  const target = portableModePackageDirectory(archive.packageContentHash); const lockPath = `${target}.lock`; mkdirSync(dirname(target), { recursive: true }); writeFileSync(lockPath, "lock\n", { flag: "a" });
  const release = await lockfile.lock(lockPath, { realpath: false, retries: { retries: 12, factor: 1.25, minTimeout: 30, maxTimeout: 250 }, stale: 60_000 });
  try {
    if (!existsSync(target)) {
      const stage = `${target}.stage-${process.pid}-${Date.now()}`;
      if (dirname(resolve(stage)) !== dirname(resolve(target)) || !basename(stage).startsWith(`${basename(target)}.stage-`)) {
        throw new Error(`Portable Mode Package staging path escaped its package directory: ${stage}`);
      }
      mkdirSync(stage, { recursive: false });
      try {
        for (const file of archive.files) {
          const destination = join(stage, file.path); mkdirSync(dirname(destination), { recursive: true });
          if (sourceDirectory) {
            verifyStoredPortableFile(join(sourceDirectory, file.path), file.bytes, file.contentHash);
            copyFileSync(join(sourceDirectory, file.path), destination, constants.COPYFILE_EXCL);
          } else writeFileSync(destination, Buffer.from(file.base64!, "base64"), { flag: "wx" });
        }
        writeFileSync(join(stage, "manifest.json"), `${stableStringify(storedManifest(archive))}\n`, { flag: "wx" });
        const staged = parsePortableModePackage(JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as unknown, { storedManifest: true });
        for (const file of staged.files) verifyStoredPortableFile(join(stage, file.path), file.bytes, file.contentHash);
        for (const definition of definitions) preflightSelectedPortableSkills(archive, stage, cwd, definition);
        renameSync(stage, target);
      } finally {
        if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      }
    } else {
      for (const definition of definitions) preflightSelectedPortableSkills(archive, target, cwd, definition);
    }
    // Keep an unreferenced immutable cache on registration failure. It is never
    // enumerated until a saved definition points at its hash, and deleting here
    // could destroy a package shared by another registered custom definition.
    return await withPortableModePackageCandidate(archive, async () => {
      // Registration must never claim a mode is usable while its selected
      // extension entrypoints are absent. For offline bundles this installs
      // only from the verified local payload before inventory validation.
      const selection: PortableModePackageSelection = { resources: archive.resources.map((resource) => ({ kind: resource.kind, id: resource.id, enabled: true })) };
      if (portableSelectedNpmDependencies(archive, selection).length > 0) {
        await ensurePortableModePackageInstalled(archive, selection);
      }
      if (archive.runtimeAssets?.length) {
        try { await loadPortableModeRuntime(archive); }
        catch (error) {
          throw new PortableModeImportConflictError([{
            kind: "runtime-activation",
            assets: archive.runtimeAssets.map((item) => `${item.kind}:${item.id}@${item.version}`),
            diagnostic: error instanceof Error ? error.message : String(error),
          }]);
        }
      }
      const peers = preflightShared();
      const sharedProviders = resolveSharedResourceProviders([...peers, archive]).providers;
      const extensionOverrides = (candidate: PortableModePackage) => Object.fromEntries((candidate.sharedResources ?? [])
        .filter((binding) => binding.kind === "extension")
        .flatMap((binding) => {
          const provider = sharedProviders.get(binding.logicalId);
          if (!provider || provider.archive.packageContentHash === candidate.packageContentHash) return [];
          return [[`extension:${binding.id}`, { packageContentHash: provider.archive.packageContentHash, resourceId: provider.binding.id }]];
        }));
      await preflightPortablePublicRegistrations(archive, cwd, extensionOverrides(archive));
      for (const peer of peers) {
        const overrides = extensionOverrides(peer);
        if (Object.values(overrides).some((binding) => binding.packageContentHash === archive.packageContentHash)) {
          await preflightPortablePublicRegistrations(peer, cwd, overrides);
        }
      }
      probedPeerHashes = peers.map((peer) => peer.packageContentHash).sort().join("\0");
      return (await new ModePackStore().installArchiveDefinitions(
        definitions, cwd, expectedRevision, preflightShared,
        archive.sharedResources?.length ? archive.packageContentHash : undefined,
        options.editableBuiltinRevisions,
      ))[0];
    });
  } finally { await release(); }
}
