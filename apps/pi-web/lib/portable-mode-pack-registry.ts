import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { stableStringify } from "../../../packages/harness-core/src/index.ts";
import { assertPortableModePackageContentHash, parsePortableModePackage, type PortableModePackage } from "../../../packages/mode-pack-host/src/portable-mode-package.ts";
import { modePackStorePathFromEnvironment } from "./mode-pack-paths";
import { bundledCodeModePackage } from "./bundled-code-mode-package";
import type { ResourceSnapshot } from "../../../packages/harness-contracts/src/index.ts";
import { isExplicitlyUninstalledPackage } from "./resource-uninstall-state";

export function portableModePackageDirectory(hash: string): string {
  const contentHash = assertPortableModePackageContentHash(hash);
  return join(getAgentDir(), "mode-packs", "packages", contentHash.slice("sha256:".length));
}

const candidates = new AsyncLocalStorage<ReadonlyMap<string, PortableModePackage>>();
const verifiedFiles = new Map<string, string>();

export function verifyStoredPortableFile(path: string, expectedBytes: number, expectedHash: string): void {
  const before = statSync(path, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(expectedBytes)) throw new Error(`Portable Mode Package file is tampered (size changed): ${path}`);
  const stamp = `${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
  if (verifiedFiles.get(path) === `${stamp}:${expectedHash}`) return;
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
  } finally { closeSync(descriptor); }
  const after = statSync(path, { bigint: true });
  if (`${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== stamp || `sha256:${digest.digest("hex")}` !== expectedHash) {
    throw new Error(`Portable Mode Package file is tampered: ${path}`);
  }
  verifiedFiles.set(path, `${stamp}:${expectedHash}`);
}

/** Runtime-only scratch space. Never use the system temp root for archive
 * assembly: Next's file tracer may otherwise capture unrelated host files. */
export function portableModeTemporaryDirectory(): string {
  const directory = join(getAgentDir(), "mode-packs", "tmp");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function currentCandidate(hash: string): PortableModePackage | null {
  return candidates.getStore()?.get(hash) ?? null;
}

function definitionPackageHashes(): Set<string> {
  const path = modePackStorePathFromEnvironment();
  if (!existsSync(path)) return new Set();
  const value = JSON.parse(readFileSync(path, "utf8")) as { histories?: Record<string, Array<{ packageContentHash?: string }> > };
  return new Set(Object.values(value.histories ?? {}).flatMap((history) => history
    .map((definition) => definition.packageContentHash)
    .filter((hash): hash is string => typeof hash === "string" && /^sha256:[a-f0-9]{64}$/u.test(hash))));
}

function registeredPackageHashes(): Set<string> {
  const path = modePackStorePathFromEnvironment();
  if (!existsSync(path)) return new Set();
  const value = JSON.parse(readFileSync(path, "utf8")) as { retainedSharedPackageHashes?: string[]; retainedSnapshotPackageHashes?: string[] };
  return new Set([...definitionPackageHashes(),
    ...(value.retainedSharedPackageHashes ?? []).map((hash) => assertPortableModePackageContentHash(hash, "retained shared package hash")),
    ...(value.retainedSnapshotPackageHashes ?? []).map((hash) => assertPortableModePackageContentHash(hash, "retained snapshot package hash"))]);
}

const BUILTIN_REGISTRY_VERSION = 1;

function builtinRegistryPath(): string {
  return join(getAgentDir(), "mode-packs", "builtin-packages.json");
}

function registeredBuiltinPackageHashes(): Set<string> {
  const path = builtinRegistryPath();
  if (!existsSync(path)) return new Set();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; hashes?: unknown };
  if (parsed.version !== BUILTIN_REGISTRY_VERSION || !Array.isArray(parsed.hashes)) {
    throw new Error(`Builtin Mode Package registry is invalid: ${path}`);
  }
  return new Set(parsed.hashes.map((hash) => assertPortableModePackageContentHash(hash, "builtin package hash")));
}

/** Persist exactly the immutable built-in hashes this installation has
 * materialized. This is a registry, never a cache scan: an orphan package
 * cannot become trusted merely because its directory happens to exist. */
function registerBuiltinPackageHash(hash: string): void {
  const path = builtinRegistryPath();
  const hashes = registeredBuiltinPackageHashes();
  if (hashes.has(hash)) return;
  hashes.add(hash);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: BUILTIN_REGISTRY_VERSION, hashes: [...hashes].sort() })}\n`, { flag: "wx", flush: true });
  renameSync(temporary, path);
}

export function forgetUninstalledBuiltinArchives(hashes: readonly string[]): void {
  const path = builtinRegistryPath();
  if (!existsSync(path)) return;
  const removed = new Set(hashes);
  const remaining = [...registeredBuiltinPackageHashes()].filter(hash => !removed.has(hash));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: BUILTIN_REGISTRY_VERSION, hashes: remaining.sort() })}\n`, { flag: "wx", flush: true });
  renameSync(temporary, path);
}

export async function withPortableModePackageCandidate<T>(archive: PortableModePackage, operation: () => Promise<T>): Promise<T> {
  const inherited = candidates.getStore() ?? new Map<string, PortableModePackage>();
  const scoped = new Map(inherited);
  scoped.set(archive.packageContentHash, archive);
  return candidates.run(scoped, operation);
}

/** Reads only a selected, persisted package, or the candidate scoped to the
 * current import transaction. It intentionally never scans the cache: orphan
 * and tampered cache directories cannot affect unrelated modes. */
export function readPortableModePackage(hash: string): PortableModePackage | null {
  const contentHash = assertPortableModePackageContentHash(hash);
  if (registeredPackageHashes().has(contentHash) || currentCandidate(contentHash) || registeredBuiltinPackageHashes().has(contentHash)) {
    return readPortableModePackageAt(contentHash);
  }
  return null;
}

function readPortableModePackageAt(contentHash: string): PortableModePackage {
  const directory = portableModePackageDirectory(contentHash);
  const manifest = join(directory, "manifest.json");
  if (!existsSync(manifest)) throw new Error(`Portable Mode Package is missing its manifest: ${contentHash}`);
  const value = JSON.parse(readFileSync(manifest, "utf8")) as PortableModePackage;
  const legacy = value.files?.some((file) => typeof file.base64 === "string");
  const parsed = legacy ? parsePortableModePackage(value) : parsePortableModePackage(value, { storedManifest: true });
  if (parsed.packageContentHash !== contentHash || resolve(directory) !== resolve(portableModePackageDirectory(parsed.packageContentHash))) {
    throw new Error(`Portable Mode Package directory identity mismatch: ${contentHash}`);
  }
  for (const file of parsed.files) {
    verifyStoredPortableFile(join(directory, file.path), file.bytes, file.contentHash);
  }
  if (legacy) {
    const compact = { ...parsed, files: parsed.files.map(({ path, contentHash: fileHash, bytes }) => ({ path, contentHash: fileHash, bytes })) };
    const temporary = `${manifest}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${stableStringify(compact)}\n`, { flag: "wx" });
    renameSync(temporary, manifest);
    return parsePortableModePackage(compact, { storedManifest: true });
  }
  return parsed;
}

/** Compatibility read for package-management views. It reads only package
 * hashes referenced by durable definitions, never arbitrary cache folders. */
export function readPortableModePackages(): PortableModePackage[] {
  return [...definitionPackageHashes()].sort().flatMap((hash) => {
    const archive = readPortableModePackage(hash);
    return archive ? [archive] : [];
  });
}

export function installedPortableModePackageManifests(): PortableModePackage[] {
  return [...new Set([...registeredPackageHashes(), ...registeredBuiltinPackageHashes()])].map(hash => {
    const manifest = join(portableModePackageDirectory(hash), "manifest.json");
    const raw = JSON.parse(readFileSync(manifest, "utf8")) as PortableModePackage;
    const archive = parsePortableModePackage(raw, { storedManifest: !raw.files?.some(file => typeof file.base64 === "string") });
    if (archive.packageContentHash !== hash) throw new Error(`Portable package directory identity mismatch: ${hash}`);
    return archive;
  });
}

/** Current shared-component arbitration considers only the latest installed
 * revision of each mode. Historical hashes remain readable for old session
 * snapshots, but they cannot veto a new module import. */
export function readLatestPortableModePackages(excludingModePackIds: readonly string[] = [], sharedLogicalIds?: readonly string[]): PortableModePackage[] {
  const path = modePackStorePathFromEnvironment();
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as { histories?: Record<string, Array<{ packageContentHash?: string }>> };
  const excluded = new Set(excludingModePackIds);
  const hashes = new Set(Object.entries(value.histories ?? {}).filter(([id]) => !excluded.has(id)).map(([, history]) => history.at(-1)?.packageContentHash)
    .filter((hash): hash is string => typeof hash === "string" && /^sha256:[a-f0-9]{64}$/u.test(hash)));
  const wanted = sharedLogicalIds ? new Set(sharedLogicalIds) : null;
  return [...hashes].sort().flatMap((hash) => {
    if (wanted) {
      const path = join(portableModePackageDirectory(hash), "manifest.json");
      if (!existsSync(path)) throw new Error(`Portable Mode Package is missing its manifest: ${hash}`);
      const value = JSON.parse(readFileSync(path, "utf8")) as PortableModePackage;
      const metadata = parsePortableModePackage(value, { storedManifest: !value.files?.some((file) => typeof file.base64 === "string") });
      if (metadata.packageContentHash !== hash) throw new Error(`Portable Mode Package directory identity mismatch: ${hash}`);
      if (!(metadata.sharedResources ?? []).some((binding) => wanted.has(binding.logicalId))) return [];
    }
    return [readPortableModePackageAt(hash)];
  });
}

/** Listing-only read: validate the hash-bound manifest identity without hashing
 * every frontend/runtime asset. Callers must verify each file they expose;
 * import and activation continue to use the full package read above. */
export function readLatestPortableModePackageManifests(): PortableModePackage[] {
  const path = modePackStorePathFromEnvironment();
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as { histories?: Record<string, Array<{ packageContentHash?: string }>> };
  const hashes = new Set(Object.values(value.histories ?? []).map((history) => history.at(-1)?.packageContentHash)
    .filter((hash): hash is string => typeof hash === "string" && /^sha256:[a-f0-9]{64}$/u.test(hash)));
  return [...hashes].sort().map((hash) => {
    const manifest = join(portableModePackageDirectory(hash), "manifest.json");
    if (!existsSync(manifest)) throw new Error(`Portable Mode Package is missing its manifest: ${hash}`);
    const raw = JSON.parse(readFileSync(manifest, "utf8")) as PortableModePackage;
    const archive = parsePortableModePackage(raw, { storedManifest: !raw.files?.some((file) => typeof file.base64 === "string") });
    if (archive.packageContentHash !== hash) throw new Error(`Portable Mode Package directory identity mismatch: ${hash}`);
    return archive;
  });
}

export function readHistoricalSharedProvider(logicalId: string, version: string, contentHash: string): PortableModePackage | null {
  for (const hash of [...registeredPackageHashes()].sort()) {
    const path = join(portableModePackageDirectory(hash), "manifest.json");
    if (!existsSync(path)) throw new Error(`Portable Mode Package is missing its manifest: ${hash}`);
    const value = JSON.parse(readFileSync(path, "utf8")) as PortableModePackage;
    const metadata = parsePortableModePackage(value, { storedManifest: !value.files?.some((file) => typeof file.base64 === "string") });
    if (metadata.packageContentHash !== hash) throw new Error(`Portable Mode Package directory identity mismatch: ${hash}`);
    for (const binding of metadata.sharedResources ?? []) {
      if (binding.logicalId !== logicalId) continue;
      const component = [metadata.definition, ...(metadata.profiles ?? [])].flatMap((definition) => definition.components).find((item) =>
        binding.kind === "extension" ? item.type === "plugin" && item.id === binding.id
          : binding.kind === "prompt" ? (item.type === "prompt" && item.id === binding.id) || (item.type === "workflow" && `workflow:${item.id}` === binding.id)
            : item.type === binding.kind && item.id === binding.id);
      if (component?.version === version && component.contentHash === contentHash) return readPortableModePackageAt(hash);
    }
  }
  return null;
}

/** Resolve a selected extension path through the registered package identity.
 * A path inside an unregistered cache directory grants no execution authority. */
export function registeredPortableExtensionAtPath(path: string): { archive: PortableModePackage; resourceId: string } | null {
  const root = join(getAgentDir(), "mode-packs", "packages");
  const relativePath = resolve(path).slice(resolve(root).length).replace(/^[/\\]/u, "").replaceAll("\\", "/");
  const match = /^([a-f0-9]{64})\/(.+)$/u.exec(relativePath);
  if (!match || resolve(path) !== resolve(join(root, match[1]!, match[2]!))) return null;
  const archive = readPortableModePackage(`sha256:${match[1]}`);
  if (!archive) return null;
  const resource = archive.resources.find((item) => item.kind === "extension" && item.source.type === "bundled" && item.source.path === match[2]);
  return resource ? { archive, resourceId: resource.id } : null;
}

/** The built-in Code archive is immutable repository content, while imported
 * archives are durable cache content. Consumers use this one generic lookup. */
export function activePortableModePackage(hash: string, options: { allowHistoricalBuiltinSnapshot?: boolean } = {}): PortableModePackage | null {
  if (isExplicitlyUninstalledPackage(hash)) return null;
  const cached = readPortableModePackage(hash);
  if (cached) return cached;
  const bundled = bundledCodeModePackage();
  registerBuiltinPackageHash(bundled.packageContentHash);
  if (bundled.packageContentHash === hash) return bundled;
  if (registeredBuiltinPackageHashes().has(hash)) return readPortableModePackageAt(hash);
  // One-time migration for sessions created before the durable registry was
  // introduced. Only a caller holding a persisted Coding snapshot may request
  // this exact hash; we still verify the cached archive's own immutable
  // identity and never enumerate package directories.
  if (options.allowHistoricalBuiltinSnapshot) {
    const historical = readPortableModePackageAt(assertPortableModePackageContentHash(hash));
    if (historical.definition.modePackId !== "coding") {
      throw new Error(`Persisted builtin package does not identify Coding: ${hash}`);
    }
    registerBuiltinPackageHash(hash);
    return historical;
  }
  return null;
}

/** A session binding is the authority for the one migration exception. An old
 * Coding snapshot may name its exact prior generated archive; no other cache
 * lookup gains that privilege. */
export function activePortableModePackageForSnapshot(snapshot: Pick<ResourceSnapshot, "profileId" | "packageContentHash">): PortableModePackage | null {
  if (!snapshot.packageContentHash) return null;
  return activePortableModePackage(snapshot.packageContentHash, {
    allowHistoricalBuiltinSnapshot: snapshot.profileId === "coding",
  });
}
