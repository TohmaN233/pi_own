import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { resolveSharedResourceProviders, type SharedResourceConflict } from "./portable-mode-shared-resources";

export interface SelectedSkillNameConflict {
  kind: "selected-skill-name";
  name: string;
  providers: Array<{ resourceId: string; contentHash: string; path: string }>;
}

export interface TargetPlatformConflict {
  kind: "target-platform";
  required: { os: string; arch: string } | null;
  actual: { os: string; arch: string };
}

export interface MissingExternalDependencyConflict {
  kind: "missing-external-dependency";
  name: string;
  searchedDirectories: string[];
}

export interface UnsupportedModeRuntimeConflict {
  kind: "unsupported-mode-runtime";
  modePackId: string;
  role: string;
  runtimeMode: string;
}
export interface MissingLocalNpmPayloadConflict {
  kind: "missing-local-npm-payload";
  packages: string[];
}
export interface UnsupportedRuntimeAssetConflict {
  kind: "unsupported-runtime-asset";
  assets: string[];
}
export interface RuntimeActivationConflict {
  kind: "runtime-activation";
  assets: string[];
  diagnostic: string;
}
export interface UnsupportedHostCapabilityConflict {
  kind: "unsupported-host-capability";
  requested: string;
  supported: string[];
}
export interface PublicRegistrationConflict {
  kind: "public-registration";
  moduleId: string;
  diagnostic: string;
}

export type PortableImportConflict = SelectedSkillNameConflict | TargetPlatformConflict | MissingExternalDependencyConflict | UnsupportedModeRuntimeConflict | MissingLocalNpmPayloadConflict | UnsupportedRuntimeAssetConflict | RuntimeActivationConflict | UnsupportedHostCapabilityConflict | PublicRegistrationConflict | ({ kind: "shared-resource" } & SharedResourceConflict);

const HOST_CAPABILITIES = ["spec-kit", "host-api:cwd-browse@1", "host-api:pdf-preview@1"] as const;

/** Host interface versions are checked before registration, not on first use. */
export function preflightPortableHostCapabilities(archive: PortableModePackage): void {
  const unsupported = archive.projectCapabilities.filter((name) => !HOST_CAPABILITIES.includes(name as typeof HOST_CAPABILITIES[number]));
  if (unsupported.length) throw new PortableModeImportConflictError(unsupported.map((requested) => ({ kind: "unsupported-host-capability", requested, supported: [...HOST_CAPABILITIES] })));
}

function conflictDescription(conflict: PortableImportConflict): string {
  if (conflict.kind === "target-platform") {
    return `target-platform: package requires ${conflict.required ? `${conflict.required.os}/${conflict.required.arch}` : "an unspecified platform"}; Pi host is ${conflict.actual.os}/${conflict.actual.arch}`;
  }
  if (conflict.kind === "missing-external-dependency") {
    return `${conflict.kind}: ${conflict.name}; searched PATH: ${conflict.searchedDirectories.join(", ") || "(empty)"}`;
  }
  if (conflict.kind === "unsupported-mode-runtime") {
    return `unsupported-mode-runtime: ${conflict.modePackId} requires ${conflict.role}/${conflict.runtimeMode}; this Pi import surface only installs ordinary general sessions`;
  }
  if (conflict.kind === "missing-local-npm-payload") {
    return `missing-local-npm-payload: ${conflict.packages.join(", ")}; all non-cloud dependency bytes must be inside the archive`;
  }
  if (conflict.kind === "unsupported-runtime-asset") {
    return `unsupported-runtime-asset: this host has no activation loader for ${conflict.assets.join(", ")}`;
  }
  if (conflict.kind === "runtime-activation") {
    return `runtime-activation: ${conflict.assets.join(", ")}; ${conflict.diagnostic}`;
  }
  if (conflict.kind === "unsupported-host-capability") {
    return `unsupported-host-capability: ${conflict.requested}; supported host interfaces: ${conflict.supported.join(", ")}`;
  }
  if (conflict.kind === "shared-resource") {
    return `shared-resource: ${conflict.logicalId}; ${conflict.reason}; version decision ${conflict.latestVersion}; installed Pi providers: ${conflict.providers.map((item) => `${item.moduleId}/${item.kind}:${item.resourceId}@${item.version} (${item.contentHash}; closure ${item.closureHash}; accepts ${item.compatibleVersions.join(", ") || "exact only"})`).join(" vs ")}`;
  }
  if (conflict.kind === "public-registration") {
    return `public-registration: ${conflict.moduleId}; ${conflict.diagnostic}`;
  }
  return `${conflict.kind}: ${conflict.name}: ${conflict.providers.map((item) => `${item.resourceId} (${item.contentHash}, ${item.path})`).join(" vs ")}`;
}

export function preflightPortableSharedResources(incoming: PortableModePackage, installed: readonly PortableModePackage[]): void {
  const result = resolveSharedResourceProviders([...installed, incoming]);
  if (result.conflicts.length) throw new PortableModeImportConflictError(result.conflicts.map((conflict) => ({ kind: "shared-resource", ...conflict })));
}

export function preflightPortableLocalNpmPayload(archive: PortableModePackage): void {
  const packages = [...new Set(archive.resources.flatMap((resource) => [
    ...(resource.source.type === "npm" ? [resource.source.package] : []),
    ...(resource.runtimeDependencies ?? []).map((item) => item.package),
  ]).concat((archive.runtimeAssets ?? []).flatMap((asset) => (asset.runtimeDependencies ?? []).map((item) => item.package))))].sort();
  if (packages.length && !archive.offlineRuntime) {
    throw new PortableModeImportConflictError([{ kind: "missing-local-npm-payload", packages }]);
  }
}

export class PortableModeImportConflictError extends Error {
  readonly code = "PORTABLE_MODE_IMPORT_CONFLICT";

  constructor(readonly conflicts: PortableImportConflict[]) {
    super([
      "Conflicts happen",
      ...conflicts.map(conflictDescription),
      "install failed.",
    ].join("\n"));
    this.name = "PortableModeImportConflictError";
  }

  agentPrompt(): string {
    return [
      "请处理以下工作模块导入预检冲突。先核对包内资源和当前 Pi 模式的装配，不要覆盖已安装资源或绕过预检。修正包或模式选择后重新导入并验证。",
      this.message,
    ].join("\n\n");
  }
}

export function preflightPortableTargetPlatform(archive: PortableModePackage, actual = { os: process.platform, arch: process.arch }): void {
  if (!archive.targetPlatform || archive.targetPlatform.os !== actual.os || archive.targetPlatform.arch !== actual.arch) {
    throw new PortableModeImportConflictError([{ kind: "target-platform", required: archive.targetPlatform ?? null, actual }]);
  }
}

/** Host-provided programs are declared by the archive and resolved without
 * executing them. The import is atomic: an absent prerequisite never stages
 * package bytes or changes the registered mode. */
export function preflightPortableExternalDependencies(
  archive: PortableModePackage,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!archive.externalDependencies) {
    throw new PortableModeImportConflictError([{
      kind: "missing-external-dependency",
      name: "externalDependencies manifest",
      searchedDirectories: [],
    }]);
  }
  const pathValue = platform === "win32"
    ? Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1]
    : environment.PATH;
  const directories = [...new Set((pathValue ?? "").split(delimiter).map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1")).filter(Boolean))];
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  const existsAsFile = (path: string): boolean => {
    try {
      const stat = statSync(path);
      return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
      throw error;
    }
  };
  const conflicts: MissingExternalDependencyConflict[] = [];
  for (const dependency of archive.externalDependencies) {
    const suffixes = platform === "win32" && !extensions.some((extension) => dependency.name.toLowerCase().endsWith(extension.toLowerCase()))
      ? ["", ...extensions]
      : [""];
    if (!directories.some((directory) => suffixes.some((suffix) => existsAsFile(join(directory, `${dependency.name}${suffix}`))))) {
      conflicts.push({ kind: "missing-external-dependency", name: dependency.name, searchedDirectories: directories });
    }
  }
  if (conflicts.length) throw new PortableModeImportConflictError(conflicts);
}

/** Validate every Skill the mode can select with Pi's own parser before
 * registration, including optional Skills a user may enable later. Pi's
 * native discovery otherwise keeps the first Skill with a duplicate name.
 * Separate mode packages are checked independently. */
export function preflightSelectedPortableSkills(archive: PortableModePackage, packageDirectory: string, cwd: string, definition = archive.definition): void {
  const selectable = new Set(definition.components
    .filter((component) => component.type === "skill")
    .map((component) => component.id));
  const names = new Map<string, SelectedSkillNameConflict["providers"]>();
  for (const resource of archive.resources.filter((item) => item.kind === "skill" && selectable.has(item.id))) {
    if (resource.source.type !== "bundled") {
      throw new Error(`Portable Skill must carry its complete source bytes: ${resource.id}`);
    }
    const path = join(packageDirectory, resource.source.path);
    const loaded = loadSkills({ cwd, agentDir: packageDirectory, skillPaths: [path], includeDefaults: false });
    if (loaded.diagnostics.length || loaded.skills.length !== 1) {
      throw new Error(`Portable Skill is not loadable by Pi: ${resource.id}: ${loaded.diagnostics.map((item) => `${item.type}: ${item.message}`).join("; ") || "expected exactly one Skill"}`);
    }
    const name = loaded.skills[0]!.name;
    const providers = names.get(name) ?? [];
    providers.push({ resourceId: resource.id, contentHash: resource.contentHash, path: resource.source.path });
    names.set(name, providers);
  }
  // Pi's native loader is first-wins for duplicate names even when the
  // SKILL.md bytes match: relative references and scripts may still differ.
  // A mode therefore gets exactly one selected provider for each Skill name.
  const conflicts = [...names].filter(([, providers]) => providers.length > 1)
    .map(([name, providers]) => ({ kind: "selected-skill-name" as const, name, providers }));
  if (conflicts.length) throw new PortableModeImportConflictError(conflicts);
}
