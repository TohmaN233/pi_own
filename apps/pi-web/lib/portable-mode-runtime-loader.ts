import { join } from "node:path";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti/static";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { portableModePackageDirectory, verifyStoredPortableFile } from "./portable-mode-pack-registry";

const CONTRACT = "pi-own-portable-runtime/v1";
const HOST_MODULES = [
  "file-access", "harness-server", "mode-pack-inventory", "mode-pack-store",
  "portable-mode-pack-registry", "portable-mode-pack-service", "request-security",
  "rpc-manager", "session-reader", "bundled-domain-workflows",
] as const;

export interface PortableModeRuntime {
  routes: Record<string, { GET?: (request: Request) => Promise<Response> | Response; POST?: (request: Request) => Promise<Response> | Response }>;
  extensions: Record<string, ExtensionFactory>;
}

interface RuntimeManifest {
  format: typeof CONTRACT;
  moduleId: string;
  entry: string;
  routes: string[];
  extensionEntries: Record<string, string>;
  hostCapabilities: string[];
  platformImports: string[];
  files: Array<{ path: string; contentHash: string; bytes: number }>;
}

const loaded = new Map<string, Promise<PortableModeRuntime>>();

function runtimeDescriptor(archive: PortableModePackage) {
  const harness = archive.runtimeAssets?.find((asset) => asset.kind === "harness");
  const routeValidation = archive.runtimeAssets?.find((asset) => asset.kind === "route-validation");
  if (!harness || !routeValidation || harness.id !== routeValidation.id || harness.entry !== routeValidation.entry || harness.version !== "1.0.0" || routeValidation.version !== "1.0.0") {
    throw new Error(`Portable module ${archive.moduleId ?? archive.definition.modePackId} lacks a supported harness and route-validation pair`);
  }
  const manifest = harness.files.find((path) => path.endsWith("/runtime-manifest.json"));
  if (!manifest || !routeValidation.files.includes(manifest)) throw new Error("Portable runtime manifest is missing from both assets");
  return { harness, routeValidation, manifest };
}

function parseManifest(archive: PortableModePackage, path: string, runtimeId: string): RuntimeManifest {
  const file = archive.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`Portable runtime manifest is undeclared: ${path}`);
  const absolute = join(portableModePackageDirectory(archive.packageContentHash), path);
  verifyStoredPortableFile(absolute, file.bytes, file.contentHash);
  const value = JSON.parse(readFileSync(absolute, "utf8")) as RuntimeManifest;
  if (value.format !== CONTRACT || value.moduleId !== runtimeId || !Array.isArray(value.routes)
    || !value.routes.every((route) => typeof route === "string" && !route.includes(".."))
    || !value.extensionEntries || typeof value.extensionEntries !== "object" || Array.isArray(value.extensionEntries)
    || !Array.isArray(value.hostCapabilities) || !Array.isArray(value.platformImports) || !Array.isArray(value.files)) {
    throw new Error(`Invalid portable runtime manifest: ${path}`);
  }
  if (value.hostCapabilities.some((name) => !HOST_MODULES.includes(name as typeof HOST_MODULES[number]))) {
    throw new Error(`Portable runtime requires an unknown host capability: ${value.hostCapabilities.join(", ")}`);
  }
  const files = new Set(archive.files.map((entry) => entry.path));
  const base = path.slice(0, -"runtime-manifest.json".length);
  if (`${base}${value.entry}` !== archive.runtimeAssets?.find((asset) => asset.kind === "harness")?.entry) {
    throw new Error("Portable runtime entry differs from its manifest");
  }
  for (const record of value.files) {
    const declared = archive.files.find((entry) => entry.path === `${base}${record.path}`);
    if (!declared || declared.contentHash !== record.contentHash || declared.bytes !== record.bytes || !files.has(declared.path)) {
      throw new Error(`Portable runtime file differs from its manifest: ${record.path}`);
    }
  }
  for (const [id, entry] of Object.entries(value.extensionEntries)) {
    if (!id.trim() || typeof entry !== "string" || !files.has(`${base}${entry}`)) throw new Error(`Portable runtime extension is missing: ${id}`);
    const resource = archive.resources.find((item) => item.kind === "extension" && item.id === id);
    if (!resource || resource.source.type !== "bundled" || resource.source.path !== `${base}${entry}`) {
      throw new Error(`Portable runtime extension resource is not bound to its compiled entry: ${id}`);
    }
  }
  return value;
}

async function hostVirtualModules(names: readonly string[]): Promise<Record<string, unknown>> {
  const providers: Record<typeof HOST_MODULES[number], () => Promise<unknown>> = {
    "file-access": () => import("./file-access"),
    "harness-server": () => import("./harness-server"),
    "mode-pack-inventory": () => import("./mode-pack-inventory"),
    "mode-pack-store": () => import("./mode-pack-store"),
    "portable-mode-pack-registry": () => import("./portable-mode-pack-registry"),
    "portable-mode-pack-service": () => import("./portable-mode-pack-service"),
    "request-security": () => import("./request-security"),
    "rpc-manager": () => import("./rpc-manager"),
    "session-reader": () => import("./session-reader"),
    "bundled-domain-workflows": () => import("./bundled-domain-workflows"),
  };
  const modules = await Promise.all(names.map((name) => providers[name as typeof HOST_MODULES[number]]()));
  return Object.fromEntries(names.map((name, index) => [`pi-own-host:${name}`, modules[index]]));
}

/** Import exactly one verified, package-owned runtime image per content hash.
 * Route handlers and Pi extension factories share its module instance. */
export async function loadPortableModeRuntime(archive: PortableModePackage): Promise<PortableModeRuntime> {
  const cacheKey = resolve(portableModePackageDirectory(archive.packageContentHash));
  const prior = loaded.get(cacheKey);
  if (prior) return prior;
  const pending = (async () => {
    const descriptor = runtimeDescriptor(archive);
    const manifest = parseManifest(archive, descriptor.manifest, descriptor.harness.id);
    for (const path of new Set([...descriptor.harness.files, ...descriptor.routeValidation.files])) {
      const file = archive.files.find((entry) => entry.path === path);
      if (!file) throw new Error(`Portable runtime file is undeclared: ${path}`);
      verifyStoredPortableFile(join(portableModePackageDirectory(archive.packageContentHash), path), file.bytes, file.contentHash);
    }
    const virtualModules = { ...(await hostVirtualModules(manifest.hostCapabilities)), "@earendil-works/pi-coding-agent": piCodingAgent };
    const importer = createJiti(import.meta.url, { virtualModules, tryNative: false, moduleCache: true, fsCache: false });
    const loadedModule = await importer.import(join(portableModePackageDirectory(archive.packageContentHash), descriptor.harness.entry));
    if (!loadedModule || typeof loadedModule !== "object" || !("routes" in loadedModule) || !("extensions" in loadedModule)) throw new Error("Portable runtime has no route/extension exports");
    const runtime = loadedModule as PortableModeRuntime;
    if (!runtime.routes || typeof runtime.routes !== "object" || !runtime.extensions || typeof runtime.extensions !== "object") throw new Error("Portable runtime exports are invalid");
    if (Object.keys(runtime.routes).sort().join("\0") !== [...manifest.routes].sort().join("\0")) throw new Error("Portable runtime route exports differ from its manifest");
    if (Object.keys(runtime.extensions).sort().join("\0") !== Object.keys(manifest.extensionEntries).sort().join("\0")) throw new Error("Portable runtime extension exports differ from its manifest");
    for (const [name, route] of Object.entries(runtime.routes)) {
      if (!route || typeof route !== "object" || !["GET", "POST"].some((method) => typeof route[method as keyof typeof route] === "function")) {
        throw new Error(`Portable runtime route has no supported handler: ${name}`);
      }
    }
    for (const [name, factory] of Object.entries(runtime.extensions)) if (typeof factory !== "function") throw new Error(`Portable runtime extension is not a factory: ${name}`);
    return runtime;
  })();
  loaded.set(cacheKey, pending);
  try { return await pending; }
  catch (error) { if (loaded.get(cacheKey) === pending) loaded.delete(cacheKey); throw error; }
}
