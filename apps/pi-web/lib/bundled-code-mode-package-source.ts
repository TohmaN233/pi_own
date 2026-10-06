import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../../../packages/harness-core/src/index.ts";
import type { ModePackDefinition } from "../../../packages/harness-contracts/src/index.ts";
import { createPortableModePackage, portableModePackageAssetHash, type PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { curatedCodeResources } from "./curated-code-resources";

interface SourceFile { path: string; contentHash: string; bytes: number }
interface Source { id: string; directory: string; files: SourceFile[] }
interface PackagePin { package: string; version: string; integrity: string; repository: string; license: string; pi: { extensions?: string[] } | null }
interface CodingManifest { version: number; modePackId: string; title: string; description: string; category: string; role: string; runtimeMode: string; tools: string[]; systemPrompt: string; systemPromptMode: "replace" | "append"; projectCapabilities: string[]; frontend: { entry: string } }

function repoRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), "../../.."); }
function sourceManifest(): Source[] { return (JSON.parse(readFileSync(join(repoRoot(), "third_party", "code-mode-sources.json"), "utf8")) as { sources: Source[] }).sources; }
function packagePins(): PackagePin[] { return (JSON.parse(readFileSync(join(repoRoot(), "third_party", "code-mode-packages.json"), "utf8")) as { packages: PackagePin[] }).packages; }
function manifest(): CodingManifest { return JSON.parse(readFileSync(join(repoRoot(), "mode-packs", "coding", "manifest.json"), "utf8")) as CodingManifest; }
function file(path: string): PortableModePackage["files"][number] {
  const bytes = readFileSync(path);
  return { path: "", contentHash: portableModePackageAssetHash(bytes), bytes: bytes.byteLength, base64: bytes.toString("base64") };
}

function runtimeDependencies(resourceId: string, pins: PackagePin[]): Array<{ package: string; version: string; integrity: string; entries: string[] }> {
  const packageNames: Record<string, Array<{ name: string; entries: string[] }>> = {
    "code.extension.pi-lsp-extension": [
      { name: "typescript-language-server", entries: ["lib/cli.mjs"] },
      { name: "typescript", entries: ["lib/typescript.js"] },
    ],
    "code.extension.pi-mcp-adapter": [{ name: "chrome-devtools-mcp", entries: ["build/src/bin/chrome-devtools-mcp.js"] }],
    "playwright-cli": [{ name: "@playwright/cli", entries: ["playwright-cli.js"] }],
  };
  return (packageNames[resourceId] ?? []).map(({ name, entries }) => {
    const pin = pins.find((candidate) => candidate.package === name);
    if (!pin) throw new Error(`Bundled Code Mode cannot locate runtime dependency pin: ${name}`);
    return { package: pin.package, version: pin.version, integrity: pin.integrity, entries };
  });
}

/** The built-in package is constructed from the original pinned source bytes.
 * It is the same self-contained archive format used for imported packages; no
 * checkout path appears in the returned archive. */
export function bundledCodeModePackage(): PortableModePackage {
  const config = manifest();
  const files: PortableModePackage["files"] = [];
  for (const source of sourceManifest()) {
    for (const sourceFile of source.files) {
      const sourcePath = join(repoRoot(), "third_party", source.directory, sourceFile.path);
      if (!existsSync(sourcePath)) throw new Error(`Bundled Code Mode source is missing: ${source.id}/${sourceFile.path}`);
      const entry = file(sourcePath); entry.path = `resources/sources/${source.id}/${sourceFile.path}`;
      if (entry.contentHash !== sourceFile.contentHash || entry.bytes !== sourceFile.bytes) throw new Error(`Bundled Code Mode source hash mismatch: ${source.id}/${sourceFile.path}`);
      files.push(entry);
    }
  }
  for (const name of ["index.html", "panel.css", "panel.js"]) {
    const entry = file(join(repoRoot(), "mode-packs", "coding", "frontend", name)); entry.path = `frontend/${name}`; files.push(entry);
  }
  for (const name of ["code-mode-sources.json", "code-mode-packages.json", "CODE_MODE_NOTICES.md"]) {
    const sourcePath = join(repoRoot(), "third_party", name);
    if (!existsSync(sourcePath)) continue;
    const entry = file(sourcePath); entry.path = `provenance/${name}`; files.push(entry);
  }
  const sources = sourceManifest(); const pins = packagePins();
  const curated = curatedCodeResources();
  const resources = curated.map((resource) => {
    if (resource.kind === "skill") {
      const source = sources.find((candidate) => candidate.files.some((entry) => `resources/sources/${candidate.id}/${entry.path}`.endsWith(resource.skillPath!)));
      if (!source || !resource.skillPath) throw new Error(`Bundled Code Mode cannot locate source for ${resource.id}`);
      const dependencies = runtimeDependencies(resource.id, pins);
      return { kind: "skill" as const, id: resource.id, delivery: "native-skill" as const, contentHash: resource.contentHash, source: { type: "bundled" as const, path: `resources/sources/${source.id}/${resource.skillPath}` }, ...(dependencies.length ? { runtimeDependencies: dependencies } : {}) };
    }
    const pin = pins.find((candidate) => candidate.package === resource.packageName);
    if (!pin) throw new Error(`Bundled Code Mode cannot locate npm pin for ${resource.id}`);
    const dependencies = runtimeDependencies(resource.id, pins);
    return { kind: "extension" as const, id: resource.id, delivery: "system-instruction" as const, contentHash: resource.contentHash, source: { type: "npm" as const, package: pin.package, version: pin.version, integrity: pin.integrity, entries: (pin.pi?.extensions ?? []).map((entry) => entry.replace(/^\.\//u, "")) }, ...(dependencies.length ? { runtimeDependencies: dependencies } : {}) };
  });
  const resourceLock = Buffer.from(`${stableStringify({
    version: 1,
    resources: curated.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      version: resource.version,
      contentHash: resource.contentHash,
      repository: resource.sourceRepository,
      commit: resource.sourceCommit,
      license: resource.sourceLicense,
      sourcePath: resource.sourcePath,
    })),
  })}\n`);
  files.push({ path: "provenance/.skills-lock.json", contentHash: portableModePackageAssetHash(resourceLock), bytes: resourceLock.byteLength, base64: resourceLock.toString("base64") });
  const frontend = { entry: config.frontend.entry, assets: files.filter((entry) => entry.path.startsWith("frontend/")).map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })) };
  const targetPlatform = { os: process.platform, arch: process.arch };
  // Spec Kit project initialization invokes uvx from the target host. It is
  // outside the archive and must be visible to import preflight.
  const externalDependencies: PortableModePackage["externalDependencies"] = [{ kind: "executable", name: "uvx" }];
  const defaultSkills = new Set(["incremental-implementation", "debugging-and-error-recovery", "code-review-and-quality", "source-driven-development", "grill-me", "grill-with-docs"]);
  const defaultExtensions = new Set(["pi-lsp-extension", "pi-permission-system", "pi-web-access", "pi-workspace-history"]);
  const requiredExtensions = new Set(["pi-lsp-extension", "pi-permission-system", "pi-web-access"]);
  const components = resources.map((resource) => {
    const name = resource.kind === "skill" ? resource.id : curated.find((candidate) => candidate.id === resource.id)?.packageName;
    if (!name) throw new Error(`Bundled Code Mode extension has no package identity: ${resource.id}`);
    const enabled = resource.kind === "skill" ? defaultSkills.has(name) : defaultExtensions.has(name);
    const required = resource.kind === "skill" ? false : requiredExtensions.has(name);
    return { type: resource.kind === "extension" ? "plugin" : "skill", id: resource.id, required, enabled, ...(resource.kind === "skill" ? { delivery: "native-skill" as const } : {}), version: resource.kind === "extension" ? (pins.find((pin) => pin.package === name)?.version ?? "") : (sources.find((source) => source.files.some((entry) => `resources/sources/${source.id}/${entry.path}` === resource.source.path))?.id ? curated.find((candidate) => candidate.id === resource.id)!.version : ""), contentHash: resource.contentHash };
  });
  const definition = { version: 1, modePackId: config.modePackId, revision: 1, title: config.title, description: config.description, category: config.category, role: config.role, runtimeMode: config.runtimeMode, provider: null, model: null, thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false, tools: [...config.tools].sort(), components, systemPrompt: config.systemPrompt, systemPromptMode: config.systemPromptMode, instructions: [] } as Omit<ModePackDefinition, "contentHash">;
  return createPortableModePackage({ definition, resources, frontend, projectCapabilities: config.projectCapabilities, targetPlatform, externalDependencies, files });
}

export function isBundledCodeModePackage(hash: string): boolean { return bundledCodeModePackage().packageContentHash === hash; }
