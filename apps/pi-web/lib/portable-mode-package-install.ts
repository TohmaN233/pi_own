import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, promises as fs, readFileSync, renameSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { contentHash, stableStringify } from "../../../packages/harness-core/src/index.ts";
import type { ResourceKind } from "../../../packages/harness-contracts/src/index.ts";
import { portableModePackageAssetHash, type PortableModePackage, type PortableModePackageResource } from "../../../packages/mode-pack-host/src/index.ts";
import { portableModePackageDirectory } from "./portable-mode-pack-registry";
import { unpackPortableOfflineRuntime } from "./portable-mode-offline-runtime";

const execFileAsync = promisify(execFile);
const installationByRuntimeDirectory = new Map<string, Promise<string>>();
// Cross-process activation cannot use the in-memory transaction map. Wait
// beyond the stale threshold for a real npm install or a dead owner lock;
// proper-lockfile keeps this asynchronous while the owner remains alive.
const portableInstallLockRetries = { retries: 180, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 };

/** Dependency choices are input to installation, not a fabricated snapshot. */
export interface PortableModePackageSelection {
  resources: ReadonlyArray<{ kind: ResourceKind; id: string; enabled: boolean }>;
}

interface NpmInvocation { command: string; prefix: string[] }

export function resolvePortableNpmInvocation(options: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executablePath?: string;
} = {}): NpmInvocation {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const executablePath = options.executablePath ?? process.execPath;
  const candidates = [environment.npm_execpath, join(dirname(executablePath), "node_modules", "npm", "bin", "npm-cli.js")];
  const found = candidates.find((value): value is string => typeof value === "string" && existsSync(value));
  if (found) return { command: executablePath, prefix: [found] };
  // Packaged Node installations frequently put npm beside the Node prefix
  // (Homebrew, distro packages) rather than beneath process.execPath. On
  // POSIX execFile resolves the executable without a shell, preserving the
  // same structured argv boundary as the direct npm-cli invocation above.
  if (platform !== "win32") {
    const executable = (environment.PATH ?? "").split(delimiter)
      .map((directory) => directory.trim())
      .filter(Boolean)
      .map((directory) => join(directory, "npm"))
      .find((candidate) => existsSync(candidate));
    if (executable) return { command: executable, prefix: [] };
  }
  throw new Error("Portable Mode Package cannot locate npm-cli.js or a POSIX npm executable on PATH");
}

function selectedRuntimeResources(archive: PortableModePackage, selection: PortableModePackageSelection): PortableModePackageResource[] {
  const enabled = new Set(selection.resources.filter((item) => item.enabled).map((item) => `${item.kind}:${item.id}`));
  return archive.resources.filter((item) => enabled.has(`${item.kind}:${item.id}`) && (item.source.type === "npm" || item.runtimeDependencies?.length));
}

export function portableSelectedNpmDependencies(archive: PortableModePackage, selection: PortableModePackageSelection): Array<{ package: string; version: string; integrity: string; entries: string[] }> {
  if (archive.offlineRuntime) return archive.offlineRuntime.dependencies.map((item) => ({ ...item, entries: [...item.entries] })).sort((left, right) => left.package.localeCompare(right.package));
  const dependencies = selectedRuntimeResources(archive, selection)
    .flatMap((item) => [
      ...(item.source.type === "npm" ? [item.source] : []),
      ...(item.runtimeDependencies ?? []),
    ])
    .concat((archive.runtimeAssets ?? []).flatMap((asset) => asset.runtimeDependencies ?? []))
    .map((item) => ({ package: item.package, version: item.version, integrity: item.integrity, entries: [...item.entries].sort() }))
    .sort((left, right) => left.package.localeCompare(right.package));
  const deduplicated = new Map<string, typeof dependencies[number]>();
  for (const dependency of dependencies) {
    const prior = deduplicated.get(dependency.package);
    if (!prior) {
      deduplicated.set(dependency.package, dependency);
      continue;
    }
    if (stableStringify(prior) !== stableStringify(dependency)) {
      throw new Error(`Portable package selected runtime dependency conflicts: ${dependency.package}`);
    }
  }
  return [...deduplicated.values()];
}

/** Writes/repairs only archive files; runtime selection directories remain intact. */
export async function ensurePortableModePackageArchive(archive: PortableModePackage): Promise<string> {
  const target = portableModePackageDirectory(archive.packageContentHash);
  const lockPath = `${target}.archive.lock`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(lockPath, "lock\n", { flag: "a" });
  const release = await lockfile.lock(lockPath, { realpath: false, stale: 60_000, retries: portableInstallLockRetries });
  try {
    mkdirSync(target, { recursive: true });
    for (const file of archive.files) {
      const destination = join(target, file.path);
      const valid = existsSync(destination) && (() => {
        const bytes = readFileSync(destination);
        return bytes.byteLength === file.bytes && portableModePackageAssetHash(bytes) === file.contentHash;
      })();
      if (valid) continue;
      if (typeof file.base64 !== "string") throw new Error(`Portable Mode Package stored file is missing or tampered: ${file.path}`);
      mkdirSync(dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, Buffer.from(file.base64, "base64"), { flag: "wx" });
      renameSync(temporary, destination);
    }
    const manifest = join(target, "manifest.json");
    const content = `${stableStringify({ ...archive, files: archive.files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })) })}\n`;
    if (!existsSync(manifest) || readFileSync(manifest, "utf8") !== content) {
      const temporary = `${manifest}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, content, { flag: "wx" });
      renameSync(temporary, manifest);
    }
    return target;
  } finally {
    await release();
  }
}

export function portablePackageRuntimeDirectory(archive: PortableModePackage, selection: PortableModePackageSelection): string {
  const dependencies = selectedDependencies(archive, selection);
  // Identical exact dependency pins are one shared immutable component across
  // Mode Packs. The archive remains private under packages/<content-hash>;
  // runtime bytes are shared only when every selected version/integrity pin
  // matches. A different implementation can coexist in another runtime.
  const modePacksDirectory = dirname(dirname(portableModePackageDirectory(archive.packageContentHash)));
  const identity = contentHash({ platform: process.platform, arch: process.arch, dependencies }).slice("sha256:".length);
  // Keep the runtime root short on Windows. npm's transitive tree already has
  // paths near 300 characters under the historical directory layout.
  const shared = join(modePacksDirectory, "r", identity.slice(0, 40));
  if (existsSync(join(shared, ".portable-install.json"))) {
    let marker: { version?: unknown; dependencies?: unknown } | null = null;
    try { marker = JSON.parse(readFileSync(join(shared, ".portable-install.json"), "utf8")) as { version?: unknown; dependencies?: unknown }; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // The installer below diagnoses and repairs a truncated marker.
    }
    if (marker?.version === 5 && Array.isArray(marker.dependencies) && stableStringify(marker.dependencies) !== stableStringify(dependencies)) {
      throw new Error(`Portable runtime identity collision: ${shared}`);
    }
  }
  // Existing sessions may still load the previous per-archive runtime path.
  // Reuse it in place until a shared tree exists; never move a live 600 MB
  // dependency tree out from under an active Pi extension.
  const legacyIdentity = contentHash({ packageContentHash: archive.packageContentHash, dependencies }).slice("sha256:".length);
  const legacy = join(modePacksDirectory, "runtimes", legacyIdentity);
  return !existsSync(shared) && existsSync(legacy) ? legacy : shared;
}

function runtimeStagePath(target: string, kind: "stage" | "broken"): string {
  const parent = dirname(target);
  const candidate = join(parent, `${kind === "stage" ? ".s" : ".b"}-${randomUUID().slice(0, 16)}`);
  if (dirname(resolve(candidate)) !== resolve(parent)) throw new Error(`Portable runtime ${kind} path escaped its parent: ${candidate}`);
  return candidate;
}

const selectedDependencies = portableSelectedNpmDependencies;

interface InstalledTreeEntry {
  path: string;
  label: string;
  kind: "file" | "directory" | "symlink";
  linkTarget?: string;
}

interface InstalledTree {
  entries: InstalledTreeEntry[];
  metadataHash: string;
}

const verifiedRuntimeTrees = new Map<string, { metadataHash: string; nodeModulesHash: string }>();

/** Drop process-local trust after a caller intentionally changes a private
 * runtime. Normal Mode Pack activation never writes these immutable trees. */
export function invalidatePortableRuntimeVerification(target: string): void {
  verifiedRuntimeTrees.delete(target);
}

async function scanInstalledTree(path: string): Promise<InstalledTree> {
  const entries: InstalledTreeEntry[] = [];
  const metadata = createHash("sha256");
  const root = await fs.realpath(path);
  let visited = 0;
  const cooperate = async (): Promise<void> => {
    visited += 1;
    if (visited % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const isInsideNodeModules = (candidate: string): boolean => {
    const relation = relative(root, candidate);
    return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !relation.startsWith("../") && !relation.startsWith("..\\"));
  };
  const visit = async (current: string, label: string, knownStat?: BigIntStats): Promise<void> => {
    const stat = knownStat ?? await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      let target: string;
      let resolvedTarget: string;
      try {
        [target, resolvedTarget] = await Promise.all([fs.readlink(current), fs.realpath(current)]);
      } catch (error) {
        throw new Error(`Portable package symlink cannot be resolved: ${current}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isInsideNodeModules(resolvedTarget)) throw new Error(`Portable package symlink escapes node_modules: ${current} -> ${resolvedTarget}`);
      const targetStat = await fs.stat(resolvedTarget, { bigint: true });
      if (targetStat.isDirectory()) {
        const parent = await fs.realpath(dirname(current));
        const parentFromTarget = relative(resolvedTarget, parent);
        // A directory link to its parent/ancestor is a physical graph cycle.
        // Never follow links during traversal; normal root traversal reaches a
        // valid in-tree target once under its physical path for hashing.
        if (parentFromTarget === "" || (!parentFromTarget.startsWith(`..${sep}`) && parentFromTarget !== ".." && !parentFromTarget.startsWith("../") && !parentFromTarget.startsWith("..\\"))) {
          throw new Error(`Portable package directory symlink forms a cycle: ${current} -> ${resolvedTarget}`);
        }
      }
      entries.push({ path: current, label, kind: "symlink", linkTarget: target });
      metadata.update(`symlink:${label}\0${target}\0${relative(root, resolvedTarget).replace(/\\/gu, "/")}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
      await cooperate();
      return;
    }
    if (stat.isFile()) {
      entries.push({ path: current, label, kind: "file" });
      metadata.update(`file:${label}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
      await cooperate();
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Portable package entrypoint is not a regular file or directory: ${current}`);
    entries.push({ path: current, label, kind: "directory" });
    // Publishing stage -> target changes the scan root metadata on POSIX.
    // It is a container, not installed package content, so omit its volatile
    // timestamps while retaining every descendant directory/file identity.
    if (label !== ".") metadata.update(`directory:${label}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
    const children = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    // Directory entries identify the common case, but lstat supplies stable
    // ctime/mtime metadata. Read a bounded batch before descending so a warm
    // 40k-file npm tree does not become 40k serial Windows I/O round trips.
    for (let start = 0; start < children.length; start += 32) {
      const batch = await Promise.all(children.slice(start, start + 32).map(async (child) => {
        const childPath = join(current, child.name);
        return { childPath, childLabel: `${label}/${child.name}`, stat: await fs.lstat(childPath, { bigint: true }) };
      }));
      for (const child of batch) await visit(child.childPath, child.childLabel, child.stat);
      await new Promise<void>((done) => setImmediate(done));
    }
    await cooperate();
  };
  await visit(path, ".");
  return { entries, metadataHash: `sha256:${metadata.digest("hex")}` };
}

async function completeTreeHash(tree: InstalledTree): Promise<string> {
  const leaves = new Array<string>(tree.entries.length);
  const files = tree.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === "file");
  // Bounded parallel reads turn a 40k-file cold cache verification into I/O
  // work rather than 40k serial event-loop round trips, without unbounded RAM.
  for (let start = 0; start < files.length; start += 32) {
    await Promise.all(files.slice(start, start + 32).map(async ({ entry, index }) => {
      leaves[index] = createHash("sha256").update(await fs.readFile(entry.path)).digest("hex");
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const digest = createHash("sha256");
  for (let index = 0; index < tree.entries.length; index += 1) {
    const entry = tree.entries[index]!;
    digest.update(`${entry.kind}:${entry.label}\0`);
    if (entry.kind === "file") digest.update(leaves[index]!);
    if (entry.kind === "symlink") digest.update(entry.linkTarget ?? "");
  }
  return `sha256:${digest.digest("hex")}`;
}

async function runtimeMarker(dependencies: ReturnType<typeof selectedDependencies>, target: string, knownTree?: InstalledTree): Promise<{ version: 5; dependencies: typeof dependencies; metadataHash: string; nodeModulesHash: string }> {
  const nodeModules = join(target, "node_modules");
  if (!existsSync(nodeModules)) throw new Error(`Portable package is missing node_modules: ${target}`);
  // Entry-point hashes only prove those entries. This covers every selected
  // package and its complete resolved dependency tree, detecting tampering in
  // imported implementation files before an existing cache is reused.
  const tree = knownTree ?? await scanInstalledTree(nodeModules);
  const nodeModulesHash = await completeTreeHash(tree);
  for (const pin of dependencies) {
    const packageJson = join(target, "node_modules", pin.package, "package.json");
    if (!existsSync(packageJson)) throw new Error(`Portable package is missing package.json: ${pin.package}`);
    for (const entry of pin.entries) {
      const path = join(target, "node_modules", pin.package, entry);
      if (!existsSync(path)) throw new Error(`Portable package entrypoint is missing: ${pin.package}/${entry}`);
    }
  }
  return { version: 5, dependencies, metadataHash: tree.metadataHash, nodeModulesHash };
}

async function markerIsCurrent(target: string, dependencies: ReturnType<typeof selectedDependencies>, expectedNodeModulesHash?: string): Promise<boolean> {
  const marker = join(target, ".portable-install.json");
  if (!existsSync(marker)) {
    console.info("[mode-pack] runtime cache marker missing", { runtime: basename(target), dependencyCount: dependencies.length });
    return false;
  }
  try {
    const current = JSON.parse(readFileSync(marker, "utf8")) as { version?: unknown; dependencies?: unknown; metadataHash?: unknown; nodeModulesHash?: unknown };
    const trusted = verifiedRuntimeTrees.get(target);
    const dependenciesMatch = stableStringify(current.dependencies) === stableStringify(dependencies);
    if (current.version === 5
      && dependenciesMatch
      && trusted !== undefined
      && trusted.metadataHash === current.metadataHash
      && trusted.nodeModulesHash === current.nodeModulesHash
      && (!expectedNodeModulesHash || current.nodeModulesHash === expectedNodeModulesHash)) {
      console.info("[mode-pack] runtime integrity trust reused", { runtime: basename(target), dependencyCount: dependencies.length });
      return true;
    }
    console.info("[mode-pack] runtime metadata verification started", { runtime: basename(target), dependencyCount: dependencies.length });
    const tree = await scanInstalledTree(join(target, "node_modules"));
    // The marker was written only after a full content hash at installation.
    // On a later process start, unchanged size/mtime/ctime and tree topology
    // let us reuse that result without reading every package byte again.
    // Any metadata drift triggers the full content comparison below.
    if (current.version === 5 && dependenciesMatch
      && typeof current.nodeModulesHash === "string"
      && /^sha256:[a-f0-9]{64}$/u.test(current.nodeModulesHash)
      && current.metadataHash === tree.metadataHash
      && (!expectedNodeModulesHash || current.nodeModulesHash === expectedNodeModulesHash)) {
      verifiedRuntimeTrees.set(target, { metadataHash: tree.metadataHash, nodeModulesHash: current.nodeModulesHash });
      console.info("[mode-pack] runtime metadata verified; content hash reused", { runtime: basename(target), dependencyCount: dependencies.length, files: tree.entries.length });
      return true;
    }
    console.info("[mode-pack] runtime full integrity verification started", { runtime: basename(target), dependencyCount: dependencies.length, reason: "metadata-drift" });
    const expected = await runtimeMarker(dependencies, target, tree);
    const currentMatch = current.version === expected.version
      && stableStringify(current.dependencies) === stableStringify(expected.dependencies)
      && current.metadataHash === expected.metadataHash
      && current.nodeModulesHash === expected.nodeModulesHash
      && (!expectedNodeModulesHash || expected.nodeModulesHash === expectedNodeModulesHash);
    const contentMatch = current.version === expected.version
      && stableStringify(current.dependencies) === stableStringify(expected.dependencies)
      && current.nodeModulesHash === expected.nodeModulesHash;
    if (contentMatch) {
      if (!currentMatch) {
        const temporary = `${marker}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(temporary, `${stableStringify(expected)}\n`, { flag: "wx" });
        renameSync(temporary, marker);
        console.info("[mode-pack] runtime metadata marker refreshed", { runtime: basename(target), dependencyCount: dependencies.length });
      }
      verifiedRuntimeTrees.set(target, { metadataHash: expected.metadataHash, nodeModulesHash: expected.nodeModulesHash });
      return true;
    }
    const reason = current.version !== expected.version
      ? "marker-version"
      : !dependenciesMatch
        ? "selected-dependencies"
        : "tree-content";
    console.warn("[mode-pack] runtime cache mismatch; repairing", { runtime: basename(target), dependencyCount: dependencies.length, reason });
    return false;
  } catch (error) {
    console.error(`[mode-pack] runtime cache verification failed for ${target}; it will be repaired`, error);
    return false;
  }
}

async function ensurePortableModePackageInstalledInternal(archive: PortableModePackage, selection: PortableModePackageSelection): Promise<string> {
  await ensurePortableModePackageArchive(archive);
  const dependencies = selectedDependencies(archive, selection);
  const target = portablePackageRuntimeDirectory(archive, selection);
  const lockPath = `${target}.lock`;
  const lifecycleStartedAt = Date.now();
  const dependencyLabels = dependencies.map((dependency) => `${dependency.package}@${dependency.version}`);
  console.info("[mode-pack] runtime cache verification started", { runtime: basename(target), dependencyCount: dependencies.length, dependencies: dependencyLabels });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(lockPath, "lock\n", { flag: "a" });
  const release = await lockfile.lock(lockPath, { realpath: false, stale: 60_000, retries: portableInstallLockRetries });
  try {
    if (await markerIsCurrent(target, dependencies, archive.offlineRuntime?.nodeModulesHash)) {
      console.info("[mode-pack] runtime cache reused", { runtime: basename(target), dependencyCount: dependencies.length, durationMs: Date.now() - lifecycleStartedAt });
      return target;
    }
    console.info("[mode-pack] runtime cache install started", { runtime: basename(target), dependencyCount: dependencies.length, dependencies: dependencyLabels });
    const stage = runtimeStagePath(target, "stage");
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    try {
      const overrides = dependencies.some((item) => item.package === "pi-lsp-extension") ? { "vscode-languageserver-protocol": "3.17.5" } : undefined;
      if (archive.offlineRuntime) {
        await unpackPortableOfflineRuntime(join(portableModePackageDirectory(archive.packageContentHash), archive.offlineRuntime.archivePath), stage);
      } else {
        writeFileSync(join(stage, "package.json"), `${stableStringify({ private: true, dependencies: Object.fromEntries(dependencies.map((item) => [item.package, item.version])), ...(overrides ? { overrides } : {}) })}\n`);
        if (dependencies.length) {
          const npm = resolvePortableNpmInvocation();
          await execFileAsync(npm.command, [...npm.prefix, "install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: stage, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        }
        else mkdirSync(join(stage, "node_modules"));
      }
      const lock = dependencies.length ? JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: string }> } : { packages: {} };
      for (const pin of dependencies) {
        const pkg = JSON.parse(readFileSync(join(stage, "node_modules", pin.package, "package.json"), "utf8")) as { name?: string; version?: string };
        if (pkg.name !== pin.package || pkg.version !== pin.version || lock.packages?.[`node_modules/${pin.package}`]?.integrity !== pin.integrity) throw new Error(`Portable package pin verification failed: ${pin.package}`);
      }
      if (overrides) {
        const protocol = JSON.parse(readFileSync(join(stage, "node_modules", "vscode-languageserver-protocol", "package.json"), "utf8")) as { version?: string };
        if (protocol.version !== "3.17.5") throw new Error("Portable package requires vscode-languageserver-protocol 3.17.5");
      }
      const stagedMarker = await runtimeMarker(dependencies, stage);
      if (archive.offlineRuntime && stagedMarker.nodeModulesHash !== archive.offlineRuntime.nodeModulesHash) {
        throw new Error(`Portable offline npm tree hash mismatch: expected ${archive.offlineRuntime.nodeModulesHash}, got ${stagedMarker.nodeModulesHash}`);
      }
      writeFileSync(join(stage, ".portable-install.json"), `${stableStringify(stagedMarker)}\n`);
      const previous = runtimeStagePath(target, "broken");
      if (existsSync(target)) renameSync(target, previous);
      try {
        renameSync(stage, target);
        rmSync(previous, { recursive: true, force: true });
        verifiedRuntimeTrees.set(target, { metadataHash: stagedMarker.metadataHash, nodeModulesHash: stagedMarker.nodeModulesHash });
        console.info("[mode-pack] runtime cache install complete", { runtime: basename(target), dependencyCount: dependencies.length, durationMs: Date.now() - lifecycleStartedAt });
      } catch (error) {
        if (existsSync(previous) && !existsSync(target)) renameSync(previous, target);
        throw error;
      }
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      console.error("[mode-pack] runtime cache install failed", { runtime: basename(target), dependencyCount: dependencies.length, durationMs: Date.now() - lifecycleStartedAt, reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return target;
  } finally {
    await release();
  }
}

/** Concurrent sessions selecting the same immutable dependency identity share
 * one npm transaction. Different selections retain independent target locks. */
export async function ensurePortableModePackageInstalled(archive: PortableModePackage, selection: PortableModePackageSelection): Promise<string> {
  const target = portablePackageRuntimeDirectory(archive, selection);
  const existing = installationByRuntimeDirectory.get(target);
  if (existing) return existing;
  const installation = ensurePortableModePackageInstalledInternal(archive, selection);
  installationByRuntimeDirectory.set(target, installation);
  try {
    return await installation;
  } finally {
    if (installationByRuntimeDirectory.get(target) === installation) installationByRuntimeDirectory.delete(target);
  }
}
