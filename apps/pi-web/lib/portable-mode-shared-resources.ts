import type { PortableModePackage, PortableModePackageResource, PortableModePackageSharedResource } from "../../../packages/mode-pack-host/src/portable-mode-package.ts";
import { contentHash } from "../../../packages/harness-core/src/index.ts";

export interface SharedResourceClaim {
  archive: PortableModePackage;
  binding: PortableModePackageSharedResource;
  resource: PortableModePackageResource;
  version: string;
  contentHash: string;
  closureHash: string;
}

export interface SharedResourceConflict {
  logicalId: string;
  reason: "kind-mismatch" | "same-version-different-content" | "upgrade-not-declared" | "unorderable-version";
  latestVersion: string;
  providers: Array<{ moduleId: string; kind: string; resourceId: string; version: string; contentHash: string; closureHash: string; compatibleVersions: string[] }>;
}

function componentPin(archive: PortableModePackage, binding: PortableModePackageSharedResource): { version: string; contentHash: string } {
  const pins = [archive.definition, ...(archive.profiles ?? [])].flatMap((definition) => definition.components)
    .filter((component) => binding.kind === "extension"
      ? component.type === "plugin" && component.id === binding.id
      : binding.kind === "prompt"
        ? (component.type === "prompt" && component.id === binding.id) || (component.type === "workflow" && `workflow:${component.id}` === binding.id)
        : component.type === binding.kind && component.id === binding.id);
  if (!pins.length || new Set(pins.map((pin) => `${pin.version}\0${pin.contentHash}`)).size !== 1) {
    throw new Error(`Portable shared resource ${binding.logicalId} has no unique component pin in ${archive.moduleId ?? archive.definition.modePackId}`);
  }
  return { version: pins[0]!.version, contentHash: pins[0]!.contentHash };
}

function versionParts(version: string): [bigint, bigint, bigint] {
  const match = /^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/u.exec(version);
  if (!match) throw new Error(`Portable shared resource needs stable semver: ${version}`);
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > b[index]!) return 1;
    if (a[index]! < b[index]!) return -1;
  }
  return 0;
}

export function sharedResourceClaims(archive: PortableModePackage): SharedResourceClaim[] {
  return (archive.sharedResources ?? []).map((binding) => {
    const resource = archive.resources.find((item) => item.kind === binding.kind && item.id === binding.id);
    if (!resource || resource.source.type !== "bundled") throw new Error(`Portable shared resource is missing its complete bundled source: ${binding.logicalId}`);
    const pin = componentPin(archive, binding);
    if (pin.contentHash !== resource.contentHash) throw new Error(`Portable shared resource pin differs from its bytes: ${binding.logicalId}`);
    const closure = binding.files.map((path) => {
      const file = archive.files.find((item) => item.path === path);
      if (!file) throw new Error(`Portable shared resource dependency is missing: ${binding.logicalId}: ${path}`);
      return { path, contentHash: file.contentHash, bytes: file.bytes };
    }).sort((left, right) => left.path.localeCompare(right.path));
    return { archive, binding, resource, ...pin, closureHash: contentHash(closure) };
  });
}

/** Only explicit logical identities participate. Private same-named resources
 * never meet this resolver. A newer provider is usable only if every older
 * installed consumer explicitly listed that exact newer version. */
export function resolveSharedResourceProviders(archives: readonly PortableModePackage[]): {
  providers: ReadonlyMap<string, SharedResourceClaim>;
  conflicts: SharedResourceConflict[];
} {
  const grouped = new Map<string, SharedResourceClaim[]>();
  for (const archive of archives) for (const claim of sharedResourceClaims(archive)) {
    grouped.set(claim.binding.logicalId, [...(grouped.get(claim.binding.logicalId) ?? []), claim]);
  }
  const providers = new Map<string, SharedResourceClaim>();
  const conflicts: SharedResourceConflict[] = [];
  for (const [logicalId, claims] of grouped) {
    const allStable = claims.every((claim) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(claim.version));
    const versions = new Set(claims.map((claim) => claim.version));
    const sorted = [...claims].sort((left, right) => (allStable ? compareVersions(right.version, left.version) : left.version.localeCompare(right.version))
      || left.archive.packageContentHash.localeCompare(right.archive.packageContentHash));
    const latest = sorted[0]!;
    const details = sorted.map((claim) => ({
      moduleId: claim.archive.moduleId ?? claim.archive.definition.modePackId,
      kind: claim.binding.kind,
      resourceId: claim.binding.id,
      version: claim.version,
      contentHash: claim.contentHash,
      closureHash: claim.closureHash,
      compatibleVersions: [...claim.binding.compatibleVersions],
    }));
    const reason = claims.some((claim) => claim.binding.kind !== latest.binding.kind) ? "kind-mismatch"
      : claims.some((claim) => claim.version === latest.version && (claim.contentHash !== latest.contentHash || claim.closureHash !== latest.closureHash)) ? "same-version-different-content"
      : versions.size > 1 && !allStable ? "unorderable-version"
      : claims.some((claim) => claim.version !== latest.version && !claim.binding.compatibleVersions.includes(latest.version)) ? "upgrade-not-declared"
      : null;
    if (reason) conflicts.push({ logicalId, reason, latestVersion: reason === "unorderable-version" ? "(not comparable)" : latest.version, providers: details });
    else providers.set(logicalId, latest);
  }
  return { providers, conflicts };
}
