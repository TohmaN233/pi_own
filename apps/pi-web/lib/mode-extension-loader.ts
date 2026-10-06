import { createEventBus, getAgentDir, getPackageDir, type EventBus, type ExtensionAPI, type ExtensionFactory, type ExtensionRuntime, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import * as bundledPiCodingAgent from "@earendil-works/pi-coding-agent";
import * as bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import * as bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import type { PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { hostPluginDirectory, assertHostPluginInstalled } from "./host-plugin-settings";
import { portableModePackageDirectory, registeredPortableExtensionAtPath } from "./portable-mode-pack-registry";
import { loadPortableModeRuntime } from "./portable-mode-runtime-loader";

type UncaughtExceptionListener = (...args: unknown[]) => void;
type SubagentCapabilityCeilingHandle = { dispose(): void };


const codingAgentPackageRoot = getPackageDir();
const codingAgentEntry = join(codingAgentPackageRoot, "dist", "index.js");
const extensionLoaderUrl = new URL("./core/extensions/loader.js", pathToFileURL(codingAgentEntry)).href;

type ExtensionLoader = {
  loadExtensionFromFactory(factory: ExtensionFactory, cwd: string, eventBus: EventBus, runtime: ExtensionRuntime, path: string): Promise<LoadExtensionsResult["extensions"][number]>;
  loadExtensions(paths: string[], cwd: string, eventBus: EventBus, runtime?: ExtensionRuntime): Promise<LoadExtensionsResult>;
};

const externalSdkLoader = createJiti(codingAgentEntry, { moduleCache: false, fsCache: false });
let sdkLoaderPromise: Promise<ExtensionLoader> | undefined;

/** The SDK package stays external to Next. Its internal loader must be loaded
 * relative to that real package entry, not from a rewritten emitted asset.
 * Jiti resolves this fixed ordinary-Node URL at runtime, keeping Turbopack out
 * of the SDK's internal file graph. */
async function extensionLoader(): Promise<ExtensionLoader> {
  // Reuse SDK loader code only. Its loadExtensions() is the uncached variant;
  // extension module factories, runtimes and event buses stay per session.
  // Reimporting the SDK dependency graph for every selected extension is costly.
  sdkLoaderPromise ??= (async () => {
    const loaded = await externalSdkLoader.import(extensionLoaderUrl);
    if (!loaded || typeof loaded !== "object"
      || !("loadExtensionFromFactory" in loaded) || typeof loaded.loadExtensionFromFactory !== "function"
      || !("loadExtensions" in loaded) || typeof loaded.loadExtensions !== "function") {
      throw new Error(`SDK extension loader has an invalid export surface: ${extensionLoaderUrl}`);
    }
    return loaded as ExtensionLoader;
  })();
  try { return await sdkLoaderPromise; }
  catch (error) { sdkLoaderPromise = undefined; throw error; }
}
const loaderVirtualModules = {
  "@earendil-works/pi-coding-agent": bundledPiCodingAgent,
  "@earendil-works/pi-agent-core": bundledPiAgentCore,
  "@mariozechner/pi-coding-agent": bundledPiCodingAgent,
  "@mariozechner/pi-agent-core": bundledPiAgentCore,
  "@earendil-works/pi-tui": bundledPiTui,
  "@mariozechner/pi-tui": bundledPiTui,
  "@earendil-works/pi-ai": bundledPiAiCompat,
  "@earendil-works/pi-ai/compat": bundledPiAiCompat,
  "@earendil-works/pi-ai/oauth": bundledPiAiOauth,
  "@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
  "@mariozechner/pi-ai": bundledPiAiCompat,
  "@mariozechner/pi-ai/compat": bundledPiAiCompat,
  "@mariozechner/pi-ai/oauth": bundledPiAiOauth,
  "@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
  "typebox": bundledTypebox,
  "typebox/compile": bundledTypeboxCompile,
  "typebox/value": bundledTypeboxValue,
  "@sinclair/typebox": bundledTypebox,
  "@sinclair/typebox/compile": bundledTypeboxCompile,
  "@sinclair/typebox/value": bundledTypeboxValue,
  "pi-web-mode-extension-adapter": {
    createIsolatedChildPermissionExtension,
  },
};
const MAX_TRANSFORM_CACHE_BYTES = 16 * 1024 * 1024;
const transformedModules = new Map<string, { code: string; bytes: number }>();
let transformedModuleBytes = 0;

function compilePinnedModule(
  namespace: string,
  filename: string | undefined,
  source: string,
  compile: () => string,
): string {
  const digest = createHash("sha256").update(source).digest("hex");
  const key = `${namespace}\0${filename ?? ""}\0${digest}`;
  const cached = transformedModules.get(key);
  if (cached) {
    transformedModules.delete(key);
    transformedModules.set(key, cached);
    return cached.code;
  }
  const code = compile();
  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes <= MAX_TRANSFORM_CACHE_BYTES) {
    while (transformedModuleBytes + bytes > MAX_TRANSFORM_CACHE_BYTES) {
      const oldest = transformedModules.keys().next().value;
      if (!oldest) break;
      transformedModuleBytes -= transformedModules.get(oldest)!.bytes;
      transformedModules.delete(oldest);
    }
    transformedModules.set(key, { code, bytes });
    transformedModuleBytes += bytes;
  }
  return code;
}
function isPermissionExtension(path: string): boolean {
  return isPackageEntry(path, "pi-permission-system");
}

function isPermissionGlobalModule(filename: string | undefined): boolean {
  const normalized = filename?.replace(/\\/gu, "/").toLocaleLowerCase("en-US") ?? "";
  return normalized.includes("/node_modules/pi-permission-system/src/yolo-mode-api.")
    || normalized.includes("/node_modules/pi-permission-system/src/model-option-compatibility.");
}

/** Keep extension-owned mutable files outside the immutable package runtime.
 * Exact npm pins can share one runtime tree, so live modes use a separate
 * scope derived from the selected profile instead of the runtime directory. */
export function permissionStateEnvironmentForExtension(path: string, modeScope?: string): Record<string, string> {
  const packageRoot = packageRootFromEntry(path, "pi-permission-system");
  const runtimeIdentity = modeScope
    ? `mode-${createHash("sha256").update(modeScope).digest("hex").slice(0, 32)}`
    : basename(dirname(dirname(packageRoot)));
  if (!runtimeIdentity) throw new Error(`Cannot derive a portable runtime identity for pi-permission-system: ${path}`);
  const stateRoot = join(getAgentDir(), "mode-packs", "state", runtimeIdentity, "pi-permission-system");
  return {
    PI_PERMISSION_SYSTEM_CONFIG_PATH: join(stateRoot, "config.json"),
    PI_PERMISSION_SYSTEM_LOGS_DIR: join(stateRoot, "logs"),
  };
}

function preserveLegacyCodingPermissionState(path: string, modeScope: string | undefined): void {
  if (modeScope !== "coding") return;
  const previous = permissionStateEnvironmentForExtension(path);
  const current = permissionStateEnvironmentForExtension(path, modeScope);
  const directory = dirname(current.PI_PERMISSION_SYSTEM_CONFIG_PATH);
  const marker = join(directory, ".legacy-state-checked");
  if (existsSync(marker)) return;
  mkdirSync(directory, { recursive: true });
  if (!existsSync(current.PI_PERMISSION_SYSTEM_CONFIG_PATH) && existsSync(previous.PI_PERMISSION_SYSTEM_CONFIG_PATH)) {
    try {
      copyFileSync(previous.PI_PERMISSION_SYSTEM_CONFIG_PATH, current.PI_PERMISSION_SYSTEM_CONFIG_PATH, constants.COPYFILE_EXCL);
      console.info("[mode-pack] migrated Coding permission config into isolated mode state", { from: previous.PI_PERMISSION_SYSTEM_CONFIG_PATH, to: current.PI_PERMISSION_SYSTEM_CONFIG_PATH });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  try { writeFileSync(marker, "checked\n", { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

function permissionPrivateProcessPrelude(
  path: string,
  filename: string | undefined,
  extraEnvironment: Record<string, string> = {},
  modeScope?: string,
): string {
  const packageRoot = packageRootFromEntry(path, "pi-permission-system").replace(/\\/gu, "/").toLocaleLowerCase("en-US");
  const normalizedFilename = filename?.replace(/\\/gu, "/").toLocaleLowerCase("en-US") ?? "";
  if (normalizedFilename !== packageRoot && !normalizedFilename.startsWith(`${packageRoot}/`)) return "";
  const environment = { ...permissionStateEnvironmentForExtension(path, modeScope), ...extraEnvironment };
  return `import hostProcess from "node:process";\nconst process = Object.assign(Object.create(hostProcess), { env: Object.assign(Object.create(hostProcess.env), ${JSON.stringify(environment)}) });\n`;
}

function explicitPermissionConfigPath(path: string, filename: string | undefined, source: string, modeScope?: string): string {
  const normalized = filename?.replace(/\\/gu, "/").toLocaleLowerCase("en-US") ?? "";
  if (!normalized.includes("/node_modules/pi-permission-system/src/index.")) return source;
  const call = "const result = loadPermissionSystemConfig();";
  if (!source.includes(call)) throw new Error(`Unsupported pi-permission-system config load shape: ${filename}`);
  const configPath = permissionStateEnvironmentForExtension(path, modeScope).PI_PERMISSION_SYSTEM_CONFIG_PATH;
  return source.replace(call, `const result = loadPermissionSystemConfig(${JSON.stringify(configPath)});`);
}

async function loadPinnedPermissionExtension(
  path: string,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
  modeScope?: string,
): Promise<LoadExtensionsResult> {
  assertPinnedExtensionVersion(path, "pi-permission-system", "0.8.0");
  preserveLegacyCodingPermissionState(path, modeScope);
  // The pinned upstream package uses globalThis only in these two leaf modules.
  // Shadow it there with a lexical object so the runtime API and model-option
  // guard stay private without swapping host globals or editing upstream bytes.
  // Disable Jiti's filesystem cache: its cache key does not include this adapter
  // transform, so a prior raw SDK load must never win over the isolated version.
  const compiler = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: loaderVirtualModules, tryNative: false });
  const permissionLoader = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    virtualModules: loaderVirtualModules,
    tryNative: false,
    transform(options) {
      return { code: compilePinnedModule(`permission:${path}:${modeScope ?? ""}`, options.filename, options.source, () => {
        const privateProcess = permissionPrivateProcessPrelude(path, options.filename, {}, modeScope);
        const privateSource = explicitPermissionConfigPath(path, options.filename, options.source, modeScope);
        const source = isPermissionGlobalModule(options.filename)
          ? `${privateProcess}const globalThis = Object.create(null);\n${privateSource}`
          : `${privateProcess}${privateSource}`;
        return compiler.transform({ ...options, source });
      }) };
    },
  });
  try {
    const { loadExtensionFromFactory } = await extensionLoader();
    const entry = pinnedExtensionEntry(path, "pi-permission-system", "index.ts");
    const factory = await permissionLoader.import(entry, { default: true });
    if (typeof factory !== "function") {
      return { extensions: [], errors: [{ path, error: `Extension does not export a valid factory function: ${path}` }], runtime };
    }
    return { extensions: [await loadExtensionFromFactory(factory as ExtensionFactory, cwd, eventBus, runtime, entry)], errors: [], runtime };
  } catch (error) {
    return { extensions: [], errors: [{ path, error: `Failed to load extension: ${error instanceof Error ? error.message : String(error)}` }], runtime };
  }
}

/**
 * Child sessions share the host process for foreground execution. Loading the
 * selected permission package by its file path would therefore both reuse its
 * module globals and make its forwarding protocol read the host's process
 * environment. Give a child its own factory and lexical environment instead.
 *
 * The forwarding variables are deliberately visible only to modules in this
 * factory. They identify the parent session to the package's existing file
 * forwarding protocol without ever changing `process.env` for the host, a
 * sibling mode, or another concurrently-created child.
 */
export async function createIsolatedChildPermissionExtension(options: {
  path: string;
  parentSessionId: string;
  modeScope?: string;
}): Promise<{ name: string; factory: ExtensionFactory }> {
  if (!options.parentSessionId.trim()) throw new Error("Child permission forwarding requires a parent session id");
  assertPinnedExtensionVersion(options.path, "pi-permission-system", "0.8.0");
  const forwardingEnvironment = {
    ...permissionStateEnvironmentForExtension(options.path, options.modeScope),
    PI_IS_SUBAGENT: "1",
    PI_AGENT_ROUTER_PARENT_SESSION_ID: options.parentSessionId,
    PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR: getAgentDir(),
  };
  const compiler = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: loaderVirtualModules, tryNative: false });
  const loader = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    virtualModules: loaderVirtualModules,
    tryNative: false,
    transform(transformOptions) {
      const filename = transformOptions.filename?.replace(/\\/gu, "/").toLocaleLowerCase("en-US") ?? "";
      const insidePermissionPackage = filename.includes("/node_modules/pi-permission-system/src/");
      // Import the real Node process under a private name before any leaf
      // shadows globalThis. The facade inherits ordinary read-only host
      // environment values but owns the three forwarding keys, so no secret
      // environment is embedded in transformed source or Jiti caches.
      const privateProcess = insidePermissionPackage
        ? permissionPrivateProcessPrelude(options.path, transformOptions.filename, forwardingEnvironment, options.modeScope)
        : "";
      const isolatedGlobals = isPermissionGlobalModule(transformOptions.filename)
        ? "const globalThis = Object.create(null);\n"
        : "";
      const privateSource = explicitPermissionConfigPath(options.path, transformOptions.filename, transformOptions.source, options.modeScope);
      return { code: compilePinnedModule(`permission-child:${options.path}:${options.modeScope ?? ""}:${options.parentSessionId}`, transformOptions.filename, transformOptions.source,
        () => compiler.transform({ ...transformOptions, source: `${privateProcess}${isolatedGlobals}${privateSource}` })) };
    },
  });
  const entry = pinnedExtensionEntry(options.path, "pi-permission-system", "index.ts");
  const factory = await loader.import(entry, { default: true });
  if (typeof factory !== "function") throw new Error(`Selected pi-permission-system does not export a factory: ${entry}`);
  return { name: "pi-web-isolated-child-permission", factory: factory as ExtensionFactory };
}

function isPinnedLspExtension(path: string): boolean {
  return isPackageEntry(path, "pi-lsp-extension");
}

function isPinnedLspClientModule(filename: string | undefined): boolean {
  const normalized = filename?.replace(/\\/gu, "/").toLocaleLowerCase("en-US") ?? "";
  return normalized.includes("/node_modules/pi-lsp-extension/src/lsp-client.");
}

/** pi-lsp-extension@1.3.0 fires JSON-RPC notifications without observing the
 * writer promise. A closed private language server can therefore surface an
 * EPIPE as an unrelated process-level rejection during shutdown. Keep errors
 * visible while the client is live, await the terminal exit notification, and
 * contain only the expected disposed-client write failure in this exact leaf. */
function transformPinnedLspModule(source: string, filename: string | undefined): string {
  if (!isPinnedLspClientModule(filename)) return source;
  const initialized = 'this.connection.sendNotification("initialized", {});';
  const notification = "this.connection.sendNotification(method, params);";
  const exit = 'try { this.connection.sendNotification("exit"); } catch {}';
  if (!source.includes(initialized) || !source.includes(notification) || !source.includes(exit)) {
    throw new Error(`Unsupported pi-lsp-extension lsp-client source shape: ${filename}`);
  }
  return source
    .replace(initialized, 'void Promise.resolve(this.connection.sendNotification("initialized", {})).catch((error) => { if (!this._disposed) console.error(`[LSP ${this.languageId}] initialized notification failed: ${error instanceof Error ? error.message : String(error)}`); });')
    .replace(notification, 'void Promise.resolve(this.connection.sendNotification(method, params)).catch((error) => { if (!this._disposed) console.error(`[LSP ${this.languageId}] notification ${method} failed: ${error instanceof Error ? error.message : String(error)}`); });')
    .replace(exit, 'try { await Promise.resolve(this.connection.sendNotification("exit")).catch((error) => { const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""; if (this._disposed && (code === "EPIPE" || code === "ERR_STREAM_DESTROYED")) return; console.error(`[LSP ${this.languageId}] shutdown exit notification failed: ${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ""}`); throw error; }); } catch (error) { console.error(`[LSP ${this.languageId}] shutdown failed: ${error instanceof Error ? error.message : String(error)}`); throw error; }');
}

function isPinnedMcpAdapterExtension(path: string): boolean {
  return isPackageEntry(path, "pi-mcp-adapter");
}


function isPackageEntry(path: string, packageName: string): boolean {
  const normalized = path.replace(/\\/gu, "/").toLocaleLowerCase("en-US");
  const marker = `/node_modules/${packageName}`.toLocaleLowerCase("en-US");
  return normalized.endsWith(marker) || normalized.includes(`${marker}/`);
}

function packageRootFromEntry(path: string, packageName: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const marker = `/node_modules/${packageName}`;
  const start = normalized.toLocaleLowerCase("en-US").indexOf(marker.toLocaleLowerCase("en-US"));
  const after = start + marker.length;
  if (start < 0 || (normalized.length > after && normalized[after] !== "/")) throw new Error(`Mode extension is not installed from ${packageName}: ${path}`);
  return path.slice(0, after);
}

/** Compatibility adapters deliberately cover only these pinned upstream
 * releases. Package names alone are not a sufficient compatibility identity. */
function assertPinnedExtensionVersion(path: string, packageName: string, version: string): void {
  const root = packageRootFromEntry(path, packageName);
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`Selected ${packageName} is missing package.json: ${manifestPath}`);
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
  } catch (error) {
    throw new Error(`Selected ${packageName} has unreadable package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(`Unsupported ${packageName} compatibility adapter version: expected ${packageName}@${version}, found ${String(manifest.name)}@${String(manifest.version)}`);
  }
}

function siblingRuntimeEntry(path: string, ownerPackage: string, packageName: string, entry: string): string {
  const ownerRoot = packageRootFromEntry(path, ownerPackage);
  return join(dirname(ownerRoot), packageName, ...entry.split("/"));
}

function pinnedExtensionEntry(path: string, packageName: string, entry: string): string {
  const root = packageRootFromEntry(path, packageName);
  return path.replace(/\\/gu, "/").replace(/\/$/u, "") === root.replace(/\\/gu, "/")
    ? join(root, ...entry.split("/"))
    : path;
}

/** Programmatic config keeps the selected adapter private: it never reads a
 * project or global MCP configuration file. */
export function chromeDevToolsMcpConfigForExtension(path: string, cwd: string): {
  mcpServers: Record<string, { command: string; args: string[]; cwd: string; inheritEnv: boolean }>;
} {
  const entry = siblingRuntimeEntry(path, "pi-mcp-adapter", "chrome-devtools-mcp", "build/src/bin/chrome-devtools-mcp.js");
  if (!existsSync(entry)) throw new Error(`Selected pi-mcp-adapter is missing its private Chrome DevTools server: ${entry}`);
  return {
    mcpServers: {
      "chrome-devtools": {
        command: process.execPath,
        args: [entry, `--workspace=${cwd}`, "--headless", "--isolated", "--no-usage-statistics"],
        cwd,
        inheritEnv: true,
      },
    },
  };
}

async function loadPinnedMcpAdapterExtension(
  path: string,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime | undefined,
): Promise<LoadExtensionsResult> {
  assertPinnedExtensionVersion(path, "pi-mcp-adapter", "2.34.0");
  if (!runtime) throw new Error("Mode extension loader requires an extension runtime after the first extension");
  const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: loaderVirtualModules, tryNative: false });
  try {
    const { loadExtensionFromFactory } = await extensionLoader();
    const entry = pinnedExtensionEntry(path, "pi-mcp-adapter", "index.ts");
    const importedExtension = await loader.import(entry);
    const create = typeof importedExtension === "object" && importedExtension !== null && "createMcpAdapter" in importedExtension
      ? importedExtension.createMcpAdapter
      : undefined;
    if (typeof create !== "function") {
      return { extensions: [], errors: [{ path, error: "pi-mcp-adapter does not export createMcpAdapter" }], runtime };
    }
    const factory = create({ config: chromeDevToolsMcpConfigForExtension(path, cwd) });
    if (typeof factory !== "function") {
      return { extensions: [], errors: [{ path, error: "pi-mcp-adapter createMcpAdapter returned an invalid factory" }], runtime };
    }
    return { extensions: [await loadExtensionFromFactory(factory as ExtensionFactory, cwd, eventBus, runtime, entry)], errors: [], runtime };
  } catch (error) {
    return { extensions: [], errors: [{ path, error: `Failed to load extension: ${error instanceof Error ? error.message : String(error)}` }], runtime };
  }
}

function isPinnedSubagentAdapterModule(filename: string | undefined): "index" | "child-tool-plan" | "child-launch" | "child-session" | "async-execution" | undefined {
  const normalized = filename?.replace(/\\/gu, "/").toLocaleLowerCase("en-US") ?? "";
  if (normalized.includes("/node_modules/pi-subagents/src/extension/index.")) return "index";
  if (normalized.includes("/node_modules/pi-subagents/src/runs/shared/child-tool-plan.")) return "child-tool-plan";
  if (normalized.includes("/node_modules/pi-subagents/src/runs/shared/child-launch.")) return "child-launch";
  if (normalized.includes("/node_modules/pi-subagents/src/runs/shared/child-session.")) return "child-session";
  if (normalized.includes("/node_modules/pi-subagents/src/runs/background/async-execution.")) return "async-execution";
  return undefined;
}

/** The detached runner is a separate Node process, so the host's Jiti transform
 * cannot reach it. This preload starts a private uncached Jiti instance and
 * changes only the known pinned runner's successful forced exit on Windows.
 * Failure exits remain upstream-owned and non-zero. */
export function windowsDetachedRunnerBootstrap(jitiCjsPath: string, scopedCodemode = false, platform: NodeJS.Platform = process.platform): string {
  const jitiUrl = pathToFileURL(jitiCjsPath).href;
  const script = `
import { createRequire } from "node:module";

const runner = process.argv[1];
const config = process.argv[2];
if (typeof runner !== "string" || !runner || typeof config !== "string" || !config) {
  throw new Error("Pi Web detached runner bootstrap requires runner and config arguments");
}
const normalize = (value) => value.replace(/\\\\/g, "/").toLocaleLowerCase("en-US");
const runnerIdentity = normalize(runner);
const { createJiti } = createRequire(${JSON.stringify(jitiUrl)})(${JSON.stringify(jitiCjsPath)});
const compiler = createJiti(runner, { moduleCache: false, fsCache: false, tryNative: false });
const loader = createJiti(runner, {
  moduleCache: false,
  fsCache: false,
  tryNative: false,
  transform(options) {
    if (${JSON.stringify(scopedCodemode)} && normalize(options.filename).includes("/node_modules/pi-subagents/src/runs/shared/child-session.")) {
      const expected = "factory: createCodemodeExtension()";
      if (options.source.split(expected).length !== 2) throw new Error("Unsupported pi-subagents child codemode source shape");
      return { code: compiler.transform({ ...options, source: options.source.replace(expected, "factory: createCodemodeExtension({ models: false })") }) };
    }
    if (normalize(options.filename) !== runnerIdentity) return { code: compiler.transform(options) };
    if (${JSON.stringify(platform !== "win32")}) return { code: compiler.transform(options) };
    const expected = "() => process.exit(0)";
    const occurrences = options.source.split(expected).length - 1;
    if (occurrences !== 1) throw new Error("Unsupported pi-subagents Windows runner exit source shape");
    const replacement = \`() => { process.exitCode = 0; if (process.env.PI_WEB_MODE_RUNNER_DIAGNOSTICS === "1") { const timer = setTimeout(() => { const handles = process._getActiveHandles().map((handle) => handle?.constructor?.name ?? typeof handle); console.error("[pi-web] detached runner is still alive after success", { handles }); }, 5_000); timer.unref(); } }\`;
    return { code: compiler.transform({ ...options, source: options.source.replace(expected, replacement) }) };
  },
});
await loader.import(runner);
`;
  return `data:text/javascript,${encodeURIComponent(script)}`;
}

/** The upstream package tags its host-tool inventory as builtin/auto. Pi Web's
 * Bash is an inline host-owned replacement so it retains its own executable
 * environment; expose only that exact provenance to the child-plan adapter.
 * This transform never broadens arbitrary extension tools into host builtins. */
function replacePinnedSource(source: string, expected: string, replacement: string, filename: string | undefined): string {
  if (!source.includes(expected)) throw new Error(`Unsupported pi-subagents@0.74.0 source shape: ${filename}`);
  return source.replace(expected, replacement);
}

/** Adapt the exact compiled upstream release without changing its installed bytes. */
export function transformHostSubagentModule(source: string, filename: string | undefined, permissionEntry?: string, modeScope?: string): string {
  const adapterModule = isPinnedSubagentAdapterModule(filename);
  const scopedCodemode = modeScope === "course-builder" || modeScope?.startsWith("study-research.") === true;
  if (adapterModule === "child-tool-plan" && permissionEntry) {
    const selection = /const permSystemExt = capabilityCeiling\?\.denyExtensions\s*\?\s*undefined\s*:\s*hasPermissionRules\(input\.permissionRules\)\s*\?\s*resolvePermissionSystemExtension\(\)\s*:\s*undefined;/u;
    if (!selection.test(source)) throw new Error(`Unsupported pi-subagents permission child-plan: ${filename}`);
    return source.replace(selection, `const permSystemExt = capabilityCeiling?.denyExtensions ? undefined : ${JSON.stringify(permissionEntry)};`);
  }
  if (adapterModule === "child-launch" && permissionEntry) {
    const point = "const session = {";
    const binding = `{ path: ${JSON.stringify(permissionEntry)}, parentSessionId: input.parentSessionId, modeScope: ${JSON.stringify(modeScope)} }`;
    source = replacePinnedSource(source, point, `${point}\n        ...(input.parentSessionId && extensionPaths.includes(${JSON.stringify(permissionEntry)}) ? { modePermission: ${binding} } : {}),`, filename);
    return replacePinnedSource(source, "        extensionPaths,\n        requiredExtensions:", `        extensionPaths: input.host === "parent" ? extensionPaths.filter(p => p !== ${JSON.stringify(permissionEntry)}) : extensionPaths,\n        requiredExtensions:`, filename);
  }
  if (adapterModule === "child-session") {
    if (permissionEntry) {
      const point = "const loader = new pi.DefaultResourceLoader({";
      source = replacePinnedSource(source, point, `if (launch.modePermission) { const { createIsolatedChildPermissionExtension } = require("pi-web-mode-extension-adapter"); const extension = await createIsolatedChildPermissionExtension(launch.modePermission); launch.hooks = [...launch.hooks, extension]; }\n            ${point}`, filename);
    }
    if (scopedCodemode) source = replacePinnedSource(source, "factory: createCodemodeExtension()", "factory: createCodemodeExtension({ models: false })", filename);
    return source;
  }
  if (adapterModule === "async-execution") {
    if (process.platform === "win32" || scopedCodemode) {
      const point = "? [...preload, runner, cfgPath]";
      const jitiPath = join(dirname(hostPluginDirectory("pi-subagents")), "jiti", "lib", "jiti.cjs");
      source = replacePinnedSource(source, point, `? [...preload, "--import", ${JSON.stringify(windowsDetachedRunnerBootstrap(jitiPath, scopedCodemode))}, runner, cfgPath]`, filename);
    }
    if (permissionEntry) {
      source = source.replace(/subagentOnlyExtensions: (a|agentConfig)\.subagentOnlyExtensions,/gu, `subagentOnlyExtensions: [...($1.subagentOnlyExtensions ?? []), ${JSON.stringify(permissionEntry)}],`);
      const point = "...omitGitRoutingEnv(omitExtensionBindingsEnv(process.env)),";
      const environment = permissionStateEnvironmentForExtension(permissionEntry, modeScope);
      source = replacePinnedSource(source, point, `${point}\n            PI_IS_SUBAGENT: "1", PI_AGENT_ROUTER_PARENT_SESSION_ID: launchSessionId, PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR: ${JSON.stringify(getAgentDir())}, PI_PERMISSION_SYSTEM_CONFIG_PATH: ${JSON.stringify(environment.PI_PERMISSION_SYSTEM_CONFIG_PATH)}, PI_PERMISSION_SYSTEM_LOGS_DIR: ${JSON.stringify(environment.PI_PERMISSION_SYSTEM_LOGS_DIR)},`, filename);
    }
  }
  return source;
}

/** The Host owns one current engine. Mode archives no longer carry another scheduler. */
export async function createHostSubagentFactory(permissionEntry?: string, modeScope?: string, modePackOwnsCeiling = false): Promise<ExtensionFactory> {
  assertHostPluginInstalled("pi-subagents");
  const root = hostPluginDirectory("pi-subagents");
  const entry = join(root, "src", "extension", "index.js");
  const virtualModules = loaderVirtualModules;
  const compiler = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules, tryNative: false });
  const environment = { PI_SUBAGENTS_TEMP_ROOT: join(getAgentDir(), "subagents", "work"), PI_CODING_AGENT_DIR: getAgentDir() };
  const loader = createJiti(import.meta.url, {
    moduleCache: false, fsCache: false, virtualModules, tryNative: false,
    transform(options) {
      const own = options.filename?.replaceAll("\\", "/").startsWith(`${root.replaceAll("\\", "/")}/`);
      const prelude = own ? `import hostProcess from "node:process"; const process = Object.assign(Object.create(hostProcess), { env: Object.assign(Object.create(hostProcess.env), ${JSON.stringify(environment)}) });\n` : "";
      return { code: compilePinnedModule(`host-subagents:${modeScope ?? ""}:${permissionEntry ?? ""}`, options.filename, options.source,
        () => compiler.transform({ ...options, source: `${prelude}${transformHostSubagentModule(options.source, options.filename, permissionEntry, modeScope)}` })) };
    },
  });
  const factory = await loader.import(entry, { default: true });
  if (typeof factory !== "function") throw new Error(`Invalid pi-subagents factory: ${entry}`);
  return async (pi) => {
    await (factory as ExtensionFactory)(pi);
    // The committed Mode Pack owns its registered-capability ceiling. A second
    // active-only ceiling would exclude native tools enabled within this turn.
    if (modePackOwnsCeiling) return;
    let ceiling: SubagentCapabilityCeilingHandle | null = null;
    const refresh = async (ctx: { sessionManager: { getSessionId(): string } }) => {
      ceiling?.dispose();
      ceiling = await registerModeSubagentCapabilityCeiling({ sessionId: ctx.sessionManager.getSessionId(), extensionPaths: [], allowedTools: pi.getActiveTools() });
    };
    pi.on("session_start", (_event, ctx) => refresh(ctx));
    pi.on("before_agent_start", (_event, ctx) => refresh(ctx));
    pi.on("session_shutdown", () => { ceiling?.dispose(); ceiling = null; });
  };
}

/** Public ceiling registry is keyed by the real parent Pi session, including Host-loaded engines. */
export async function registerModeSubagentCapabilityCeiling(options: {
  sessionId: string;
  extensionPaths: readonly string[];
  allowedTools: readonly string[];
}): Promise<SubagentCapabilityCeilingHandle | null> {
  const apiPath = join(hostPluginDirectory("pi-subagents"), "src", "api", "capability-ceiling.js");
  if (!existsSync(apiPath)) return null;
  const api = await createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: loaderVirtualModules, tryNative: false }).import(apiPath);
  if (!api || typeof api !== "object" || !("registerSubagentCapabilityCeiling" in api) || typeof api.registerSubagentCapabilityCeiling !== "function") throw new Error(`Missing public subagent ceiling API: ${apiPath}`);
  return api.registerSubagentCapabilityCeiling({ sessionId: options.sessionId, source: "pi-web-mode-pack", ceiling: { allowedTools: [...new Set(options.allowedTools)].sort() } }) as SubagentCapabilityCeilingHandle;
}

/** Configure the original extension through its public command after its
 * session_start hook has created an in-memory manager. The bootstrap Node
 * executable is the host runtime; the LSP server module itself is the selected
 * private dependency, so no global language server or PATH mutation is used. */
export async function configureSelectedModeRuntimeDependencies(
  session: { prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void> },
  extensionPaths: readonly string[],
): Promise<void> {
  const lspEntry = extensionPaths.find(isPinnedLspExtension);
  if (!lspEntry) return;
  assertPinnedExtensionVersion(lspEntry, "pi-lsp-extension", "1.3.0");
  const serverEntry = siblingRuntimeEntry(lspEntry, "pi-lsp-extension", "typescript-language-server", "lib/cli.mjs");
  if (!existsSync(serverEntry)) throw new Error(`Selected pi-lsp-extension is missing its private TypeScript language server: ${serverEntry}`);
  const importExpression = `import(${JSON.stringify(pathToFileURL(serverEntry).href)})`;
  if (/\s/u.test(importExpression)) throw new Error("Private TypeScript language-server URL must be command-parser safe");
  await session.prompt(`/lsp-config typescript node -e ${importExpression} dummy --stdio`, { expandPromptTemplates: true });
}

async function loadPinnedLspExtension(
  path: string,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime | undefined,
): Promise<LoadExtensionsResult> {
  assertPinnedExtensionVersion(path, "pi-lsp-extension", "1.3.0");
  const entry = pinnedExtensionEntry(path, "pi-lsp-extension", "src/index.ts");
  const compiler = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: loaderVirtualModules, tryNative: false });
  const loader = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    virtualModules: loaderVirtualModules,
    tryNative: false,
    transform(options) {
      return { code: compilePinnedModule(`lsp:${path}`, options.filename, options.source,
        () => compiler.transform({ ...options, source: transformPinnedLspModule(options.source, options.filename) })) };
    },
  });
  const factory = await loader.import(entry, { default: true });
  if (typeof factory !== "function") {
    return { extensions: [], errors: [{ path, error: `Extension does not export a valid factory function: ${path}` }], runtime: runtime! };
  }
  if (!runtime) throw new Error("Mode extension loader requires an extension runtime after the first extension");
  const { loadExtensionFromFactory } = await extensionLoader();
  const before = new Set(process.listeners("uncaughtException") as UncaughtExceptionListener[]);
  // Calling loadExtensionFromFactory starts this non-async upstream factory
  // immediately. Remove exactly its synchronous EPIPE handler before awaiting
  // anything else, so another extension cannot be mistaken for pi-lsp.
  const pending = loadExtensionFromFactory(factory as ExtensionFactory, cwd, eventBus, runtime, entry);
  for (const listener of process.listeners("uncaughtException") as UncaughtExceptionListener[]) {
    if (!before.has(listener)) process.removeListener("uncaughtException", listener);
  }
  try {
    return { extensions: [await pending], errors: [], runtime };
  } catch (error) {
    return { extensions: [], errors: [{ path, error: `Failed to load extension: ${error instanceof Error ? error.message : String(error)}` }], runtime };
  }
}

/** Shadow snapshots can include legitimate source paths beyond MAX_PATH.
 * Apply this per command, keeping the user's Git configuration and the pinned
 * upstream package untouched. Errors retain their original exit status. */
export function workspaceHistoryApi(pi: ExtensionAPI, platform: NodeJS.Platform = process.platform): ExtensionAPI {
  if (platform !== "win32") return pi;
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "exec") return Reflect.get(target, property, receiver);
      return ((command, args, options) => target.exec(command,
        command.toLowerCase() === "git" ? ["-c", "core.longpaths=true", ...args] : args,
        options)) as ExtensionAPI["exec"];
    },
  });
}

async function loadPinnedWorkspaceHistoryExtension(
  path: string,
  cwd: string,
  eventBus: EventBus,
  runtime: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
  assertPinnedExtensionVersion(path, "pi-workspace-history", "0.4.3");
  const loader = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules: loaderVirtualModules, tryNative: false });
  const factory = await loader.import(path, { default: true });
  if (typeof factory !== "function") throw new Error(`Workspace history does not export a factory: ${path}`);
  const { loadExtensionFromFactory } = await extensionLoader();
  const adapted: ExtensionFactory = (pi) => factory(workspaceHistoryApi(pi));
  return { extensions: [await loadExtensionFromFactory(adapted, cwd, eventBus, runtime, path)], errors: [], runtime };
}

/**
 * Mode packages are allowed to use original upstream extension files, but must
 * never share their module instance with another AgentSession. The SDK's public
 * resource loader intentionally caches normal extensions; this narrow adapter
 * calls its uncached loader only for the host-selected package paths.
 */
export async function loadModeExtensions(
  paths: string[],
  cwd: string,
  eventBus: EventBus,
  runtime?: ExtensionRuntime,
  portableArchive?: PortableModePackage,
  modeScope?: string,
  additionalPortableArchives: readonly PortableModePackage[] = [],
): Promise<LoadExtensionsResult> {
  const resolvedEventBus = eventBus ?? createEventBus();
  const { loadExtensions } = await extensionLoader();
  let result = await loadExtensions([], cwd, resolvedEventBus, runtime);
  const portablePaths = new Map<string, { archive: PortableModePackage; id: string }>();
  for (const candidate of [portableArchive, ...additionalPortableArchives]) {
    if (candidate?.runtimeAssets?.length) {
      const root = portableModePackageDirectory(candidate.packageContentHash);
      for (const resource of candidate.resources) {
        if (resource.kind === "extension" && resource.source.type === "bundled") {
          portablePaths.set(resolve(root, resource.source.path), { archive: candidate, id: resource.id });
        }
      }
    }
  }
  for (const path of paths) {
    const loadStartedAt = Date.now();
    const declared = portablePaths.get(resolve(path));
    const shared = declared ? null : registeredPortableExtensionAtPath(path);
    const portableId = declared?.id ?? (shared?.archive.runtimeAssets?.length ? shared.resourceId : undefined);
    const extensionArchive = declared?.archive ?? shared?.archive;
    const loaded = portableId
      ? await (async () => {
          const factory = (await loadPortableModeRuntime(extensionArchive!)).extensions[portableId];
          if (typeof factory !== "function") throw new Error(`Portable extension factory is absent: ${portableId}`);
          const { loadExtensionFromFactory } = await extensionLoader();
          return { extensions: [await loadExtensionFromFactory(factory, cwd, resolvedEventBus, result.runtime, path)], errors: [], runtime: result.runtime };
        })()
      : isPinnedLspExtension(path)
      ? await loadPinnedLspExtension(path, cwd, resolvedEventBus, result.runtime)
      : isPackageEntry(path, "pi-workspace-history")
      ? await loadPinnedWorkspaceHistoryExtension(path, cwd, resolvedEventBus, result.runtime)
      : isPermissionExtension(path)
      ? await loadPinnedPermissionExtension(path, cwd, resolvedEventBus, result.runtime, modeScope)
        : isPinnedMcpAdapterExtension(path)
          ? await loadPinnedMcpAdapterExtension(path, cwd, resolvedEventBus, result.runtime)
          : await loadExtensions([path], cwd, resolvedEventBus, result.runtime);
    result = {
      extensions: [...result.extensions, ...loaded.extensions],
      errors: [...result.errors, ...loaded.errors],
      runtime: loaded.runtime,
    };
    if (process.env.PI_WEB_TRACE_MODE_SWITCH === "1") console.info("[mode-pack] extension load timing", {
      path, durationMs: Date.now() - loadStartedAt, errors: loaded.errors.length,
    });
  }
  return result;
}
