import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus, type Extension } from "@earendil-works/pi-coding-agent";
import { parsePortableModePackage } from "../../../packages/mode-pack-host/src/portable-mode-package.ts";
import { loadModeExtensions } from "./mode-extension-loader";
import { portablePackageRuntimeDirectory } from "./portable-mode-package-install";
import { portableModePackageDirectory } from "./portable-mode-pack-registry";
import { qualifyModePublicRegistrations } from "./mode-public-registration";

const [packageDirectory, cwd, modeScope, overridesJson = "{}"] = process.argv.slice(2);
if (!packageDirectory || !cwd || !modeScope) throw new Error("Portable registration probe requires package directory, cwd and private mode scope");
const archive = parsePortableModePackage(JSON.parse(readFileSync(join(packageDirectory, "manifest.json"), "utf8")), { storedManifest: true });
const scopedPackageDirectory = portableModePackageDirectory(archive.packageContentHash);
const overrides = JSON.parse(overridesJson) as Record<string, { packageContentHash: string; resourceId: string }>;
if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Portable registration probe overrides are invalid");
for (const [key, binding] of Object.entries(overrides)) {
  if (!key.startsWith("extension:") || !binding || typeof binding !== "object"
    || typeof binding.resourceId !== "string" || !binding.resourceId
    || typeof binding.packageContentHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(binding.packageContentHash)) {
    throw new Error(`Portable registration probe override is invalid: ${key}`);
  }
}
const providerHashes = [...new Set(Object.values(overrides).map((binding) => binding.packageContentHash))];
const additionalArchives = providerHashes.map((hash) => parsePortableModePackage(JSON.parse(readFileSync(join(packageDirectory, "..", hash.slice("sha256:".length), "manifest.json"), "utf8")), { storedManifest: true }));
const archivesByHash = new Map([archive, ...additionalArchives].map((item) => [item.packageContentHash, item]));
const selection = { resources: archive.resources.map((resource) => ({ kind: resource.kind, id: resource.id, enabled: true })) };
const paths = archive.resources.filter((resource) => resource.kind === "extension").flatMap((resource) => {
  const binding = overrides[`extension:${resource.id}`];
  const selectedArchive = binding ? archivesByHash.get(binding.packageContentHash) : archive;
  const selectedResource = binding ? selectedArchive?.resources.find((entry) => entry.kind === "extension" && entry.id === binding.resourceId) : resource;
  if (!selectedArchive || !selectedResource) throw new Error(`Portable registration probe override is missing: ${resource.id}`);
  const source = selectedResource.source;
  return source.type === "bundled"
    ? [join(selectedArchive === archive ? scopedPackageDirectory : portableModePackageDirectory(selectedArchive.packageContentHash), source.path)]
    : source.entries.map(entry => join(portablePackageRuntimeDirectory(selectedArchive, selection), "node_modules", source.package, entry));
});
const result = await loadModeExtensions(paths, cwd, createEventBus(), undefined, archive, modeScope, additionalArchives);
if (result.errors.length) throw new Error(`Portable registration probe could not load extensions: ${result.errors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
if (result.extensions.length !== paths.length) throw new Error(`Portable registration probe loaded ${result.extensions.length} of ${paths.length} extensions`);
const hostTools = new Set([archive.definition, ...(archive.profiles ?? [])].flatMap((definition) => definition.tools));
// The host contributes reserved names only. Qualification reads these maps,
// never invokes a host tool or any of the remaining SDK Extension members.
const host = { path: "<inline:pi-web-portable-probe-host>", tools: new Map([...hostTools].map((name) => [name, { definition: { name }, sourceInfo: {} }])), commands: new Map(), flags: new Map(), shortcuts: new Map() } as unknown as Extension;
const qualified = qualifyModePublicRegistrations([...result.extensions, host]);
const registrations = result.extensions.map((extension) => ({
  path: extension.path,
  tools: [...extension.tools.keys()].sort(),
  commands: [...extension.commands.keys()].sort(),
  flags: [...extension.flags.keys()].sort(),
  shortcuts: [...extension.shortcuts.keys()].sort(),
}));
process.stdout.write(`PI_OWN_REGISTRATION_PROBE:${JSON.stringify({ registrations, qualified })}\n`);
