import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type CuratedCodeKind = "skill" | "extension";
export interface CuratedCodeResource {
  kind: CuratedCodeKind;
  id: string;
  title: string;
  version: string;
  contentHash: string;
  required: boolean;
  skillPath?: string;
  packageName?: string;
  packageEntryPaths?: string[];
  /** Immutable upstream provenance retained in portable archive locks. */
  sourceRepository?: string;
  sourceCommit?: string;
  sourceLicense?: string;
  sourcePath?: string;
}

interface SourceFile { path: string; contentHash: string; bytes: number }
interface Source { id: string; directory: string; repository: string; source: string; commit: string; license: string; files: SourceFile[] }
interface PackagePin { package: string; version: string; integrity: string; repository: string; license: string; pi: { extensions?: string[] } | null }

function repoRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), "../../.."); }
function safeRelative(path: string): string {
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => part === ".." || !part)) throw new Error(`Unsafe curated Code Mode path: ${path}`);
  return path;
}
function sourceManifest(): Source[] { return (JSON.parse(readFileSync(join(repoRoot(), "third_party", "code-mode-sources.json"), "utf8")) as { sources: Source[] }).sources; }
function packagePins(): PackagePin[] { return (JSON.parse(readFileSync(join(repoRoot(), "third_party", "code-mode-packages.json"), "utf8")) as { packages: PackagePin[] }).packages; }
function directoryHash(root: string): string {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in curated source identity: ${join(path, entry.name)}`);
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child); else if (entry.isFile()) files.push(child); else throw new Error(`Unsupported curated source entry: ${child}`);
    }
  };
  visit(root);
  const digest = createHash("sha256");
  for (const file of files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)))) {
    digest.update(relative(root, file).replaceAll(sep, "/"));
    digest.update(readFileSync(file));
  }
  return `sha256:${digest.digest("hex")}`;
}
function skillResource(source: Source, skill: string, required: boolean): CuratedCodeResource {
  const skillPath = `skills/${safeRelative(skill)}/SKILL.md`;
  const root = join(repoRoot(), "third_party", source.directory, "skills", safeRelative(skill));
  return {
    kind: "skill", id: skill, title: skill, version: source.commit,
    contentHash: directoryHash(root), required, skillPath,
    sourceRepository: source.repository, sourceCommit: source.commit,
    sourceLicense: source.license, sourcePath: skillPath,
  };
}
function extensionResource(pin: PackagePin, required: boolean): CuratedCodeResource {
  return {
    kind: "extension", id: `code.extension.${pin.package.replace(/^@/, "").replaceAll("/", ".")}`,
    title: pin.package, version: pin.version,
    contentHash: `sha256:${createHash("sha256").update(`${pin.package}@${pin.version}\0${pin.integrity}`).digest("hex")}`,
    required, packageName: pin.package, packageEntryPaths: pin.pi?.extensions ?? [],
    sourceRepository: pin.repository, sourceCommit: pin.version, sourceLicense: pin.license, sourcePath: pin.package,
  };
}

/** Pure curated identity/provenance registry. Installation belongs exclusively
 * to portable-mode-package-install.ts and is driven by the selected archive. */
export function curatedCodeResources(): CuratedCodeResource[] {
  const sources = sourceManifest();
  const ad = sources.find((source) => source.id === "addyosmani-agent-skills");
  const grill = sources.find((source) => source.id === "max4c-skills");
  const grillWithDocs = sources.find((source) => source.id === "max4c-grill-with-docs");
  const playwright = sources.find((source) => source.id === "playwright-cli");
  if (!ad || !grill || !grillWithDocs || !playwright) throw new Error("Code Mode source manifest is incomplete");
  const skills = [skillResource(grill, "grill-me", false), skillResource(grillWithDocs, "grill-with-docs", false), ...ad.files
    .filter((file) => file.path.startsWith("skills/") && file.path.endsWith("/SKILL.md"))
    .map((file) => { const name = file.path.split("/")[1]; if (!name) throw new Error(`Invalid curated Skill path: ${file.path}`); return skillResource(ad, name, false); }), skillResource(playwright, "playwright-cli", false)];
  const defaults = new Set(["pi-lsp-extension", "pi-permission-system", "pi-web-access"]);
  return [...skills, ...packagePins().filter((pin) => pin.pi?.extensions?.length).map((pin) => extensionResource(pin, defaults.has(pin.package)))];
}

/** Build-time validation keeps provenance manifests honest without creating a
 * second mutable installer or runtime cache. */
export function verifyCuratedCodeSourceManifest(): void {
  for (const source of sourceManifest()) for (const file of source.files) {
    const path = join(repoRoot(), "third_party", source.directory, safeRelative(file.path));
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Code Mode source is missing ${source.id}/${file.path}`);
    const hash = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    if (hash !== file.contentHash) throw new Error(`Code Mode source hash mismatch: ${source.id}/${file.path}`);
  }
}
