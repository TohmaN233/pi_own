import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  chromeDevToolsMcpConfigForExtension,
  configureSelectedModeRuntimeDependencies,
  createIsolatedChildPermissionExtension,
  createHostSubagentFactory,
  loadModeExtensions,
  permissionStateEnvironmentForExtension,
  registerModeSubagentCapabilityCeiling,
  windowsDetachedRunnerBootstrap,
  transformHostSubagentModule,
  workspaceHistoryApi,
} = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./mode-extension-loader.ts");

test("Windows workspace snapshots stage long source paths and preserve Git failures", { skip: process.platform !== "win32" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-history-longpath-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const sourceDir = join(cwd, "a".repeat(100), "b".repeat(100), "c".repeat(100));
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "long-source-file.ts"), "export const value = 1;\n");
  const gitDir = join(root, "shadow.git");
  assert.equal(spawnSync("git", ["init", "--bare", gitDir]).status, 0);
  const exec = async (command, args, options) => {
    const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
    if (result.error) throw result.error;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, killed: false };
  };
  const raw = { exec };
  const args = ["--git-dir", gitDir, "--work-tree", cwd, "add", "-A", "--", "."];
  const broken = await raw.exec("git", ["-c", "core.longpaths=false", ...args], { cwd });
  assert.match(broken.stderr, /Filename too long/u);
  const incomplete = await raw.exec("git", ["--git-dir", gitDir, "ls-files"], { cwd });
  assert.doesNotMatch(incomplete.stdout, /long-source-file\.ts/u, "Git can return zero while silently omitting a long directory");
  const adapted = workspaceHistoryApi(raw);
  assert.equal((await adapted.exec("git", args, { cwd })).code, 0);
  const files = await adapted.exec("git", ["--git-dir", gitDir, "ls-files"], { cwd });
  assert.match(files.stdout, /long-source-file\.ts/u);
  assert.notEqual((await adapted.exec("git", ["invalid-history-command"], { cwd })).code, 0);
  assert.equal(workspaceHistoryApi(raw, "linux"), raw);
});

test("permission extension mutable state is outside its immutable portable runtime", () => {
  const runtime = join(tmpdir(), "portable-runtime-fixture");
  const extension = join(runtime, "node_modules", "pi-permission-system", "src", "index.ts");
  const environment = permissionStateEnvironmentForExtension(extension);
  assert.match(environment.PI_PERMISSION_SYSTEM_CONFIG_PATH, /mode-packs[\\/]state[\\/]portable-runtime-fixture[\\/]pi-permission-system[\\/]config\.json$/u);
  assert.match(environment.PI_PERMISSION_SYSTEM_LOGS_DIR, /mode-packs[\\/]state[\\/]portable-runtime-fixture[\\/]pi-permission-system[\\/]logs$/u);
  assert.equal(environment.PI_PERMISSION_SYSTEM_CONFIG_PATH.startsWith(runtime), false);
  assert.equal(environment.PI_PERMISSION_SYSTEM_LOGS_DIR.startsWith(runtime), false);
  const coding = permissionStateEnvironmentForExtension(extension, "coding");
  const clone = permissionStateEnvironmentForExtension(extension, "custom.coding-clone");
  assert.notEqual(coding.PI_PERMISSION_SYSTEM_CONFIG_PATH, clone.PI_PERMISSION_SYSTEM_CONFIG_PATH, "modes sharing exact npm bytes still own separate mutable permission policy");
  assert.equal(coding.PI_PERMISSION_SYSTEM_CONFIG_PATH.startsWith(runtime), false);
});

function waitForProcess(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Detached runner bootstrap exceeded ${timeoutMs}ms; pid=${child.pid ?? "unknown"}; stderr=${stderr}; stdout=${stdout}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function writeIsolationFixtures(root) {
  const permission = join(root, "permission.ts");
  const lsp = join(root, "node_modules", "pi-lsp-extension", "src", "index.ts");
  mkdirSync(join(root, "node_modules", "pi-lsp-extension", "src"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pi-lsp-extension", "package.json"), JSON.stringify({ name: "pi-lsp-extension", version: "1.3.0" }));
  writeFileSync(permission, `let yolo = false;
export default function permission(pi) {
  const api = { getYoloMode: () => yolo, setYoloMode: (next) => { yolo = next; } };
  globalThis.__modePermissionFixture = api;
  pi.on("session_shutdown", () => { if (globalThis.__modePermissionFixture === api) delete globalThis.__modePermissionFixture; });
}\n`);
  writeFileSync(lsp, `export default function lsp(pi) {
  process.on("uncaughtException", function fixtureLspHandler() {});
  pi.on("session_shutdown", () => {});
}\n`);
  return { permission, lsp };
}

test("mode extension adapter gives sessions independent module factories and removes only the LSP listener", async (t) => {
  const root = join(tmpdir(), `pi-own-mode-extension-loader-${Date.now()}`);
  const cwd = join(root, "project"); mkdirSync(cwd, { recursive: true });
  t.after(() => { delete globalThis.__modePermissionFixture; rmSync(root, { recursive: true, force: true }); });
  const { permission, lsp } = writeIsolationFixtures(root);
  const before = process.listeners("uncaughtException").length;
  const first = await loadModeExtensions([permission, lsp], cwd);
  assert.deepEqual(first.errors, []);
  assert.equal(process.listeners("uncaughtException").length, before, "LSP listener must not survive its factory invocation");
  const firstApi = globalThis.__modePermissionFixture;
  const second = await loadModeExtensions([permission, lsp], cwd);
  assert.deepEqual(second.errors, []);
  assert.equal(process.listeners("uncaughtException").length, before, "later sessions must not accumulate LSP listeners");
  const secondApi = globalThis.__modePermissionFixture;
  secondApi.setYoloMode(true);
  assert.equal(firstApi.getYoloMode(), false, "configuration belongs to the isolated factory module");
  for (const extension of first.extensions) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, {});
  assert.equal(globalThis.__modePermissionFixture, secondApi, "closing one session must preserve the later session API");
});

test("selected private runtime dependencies use command-local paths and no ambient MCP config", async (t) => {
  const root = join(tmpdir(), `pi own-mode-runtime-dependencies-${Date.now()}`);
  const cwd = join(root, "project with spaces");
  const lsp = join(root, "node_modules", "pi-lsp-extension", "src", "index.ts");
  const mcp = join(root, "node_modules", "pi-mcp-adapter", "index.ts");
  const tsServer = join(root, "node_modules", "typescript-language-server", "lib", "cli.mjs");
  const chrome = join(root, "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js");
  mkdirSync(join(root, "node_modules", "pi-lsp-extension", "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pi-mcp-adapter"), { recursive: true });
  mkdirSync(join(root, "node_modules", "typescript-language-server", "lib"), { recursive: true });
  mkdirSync(join(root, "node_modules", "chrome-devtools-mcp", "build", "src", "bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pi-lsp-extension", "package.json"), JSON.stringify({ name: "pi-lsp-extension", version: "1.3.0" }));
  writeFileSync(lsp, "export default () => {};\n");
  writeFileSync(mcp, "export default () => {};\n");
  writeFileSync(tsServer, "export {};\n");
  writeFileSync(chrome, "export {};\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const config = chromeDevToolsMcpConfigForExtension(mcp, cwd);
  assert.deepEqual(Object.keys(config.mcpServers), ["chrome-devtools"]);
  assert.equal(config.mcpServers["chrome-devtools"].command, process.execPath);
  assert.deepEqual(config.mcpServers["chrome-devtools"].args.slice(1), [
    `--workspace=${cwd}`,
    "--headless",
    "--isolated",
    "--no-usage-statistics",
  ]);
  const commands = [];
  await configureSelectedModeRuntimeDependencies({ prompt: async (text) => { commands.push(text); } }, [lsp]);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^\/lsp-config typescript node -e import\("file:\/\/\//u);
  assert.match(commands[0], /pi%20own-mode-runtime-dependencies/u);
  assert.match(commands[0], / dummy --stdio$/u);
});

test("Host subagent ceiling uses the current public API and disposes per session", async () => {
  const api = await createJiti(import.meta.url).import("../node_modules/pi-subagents/src/api/capability-ceiling.js");
  const handle = await registerModeSubagentCapabilityCeiling({ sessionId: "ceiling-test", extensionPaths: [], allowedTools: ["read", "bash", "read"] });
  assert.deepEqual(api.resolveSubagentCapabilityCeiling("ceiling-test").allowedTools, ["bash", "read"]);
  handle.dispose();
  assert.equal(api.resolveSubagentCapabilityCeiling("ceiling-test"), undefined);
});

test("Windows detached runner bootstrap reaches the spawned Jiti process and drains after a successful exit", async (t) => {
  const root = join(tmpdir(), `pi-own-detached-runner-bootstrap-${Date.now()}`);
  const runner = join(root, "subagent-runner.ts");
  const config = join(root, "runner-config.json");
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(config, "{}\n");
  writeFileSync(runner, `import { writeFileSync } from "node:fs";
await fetch("data:text/plain,runner-cleanup");
setTimeout(() => writeFileSync(process.argv[2], "drained\\n"), 25);
function startConfiguredSubagent() {
  return Promise.resolve().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
void startConfiguredSubagent();
`);
  const jitiCjs = join(import.meta.dirname, "..", "node_modules", "jiti", "lib", "jiti.cjs");
  const result = await waitForProcess(spawn(process.execPath, ["--import", windowsDetachedRunnerBootstrap(jitiCjs), "-e", "", runner, config], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_WEB_MODE_RUNNER_DIAGNOSTICS: "1" },
  }), 10_000);
  assert.equal(result.code, 0, `runner must report a normal terminal exit; stderr=${result.stderr}`);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stderr, /still alive after success/u);
  assert.equal(readFileSync(config, "utf8"), "drained\n", "the runner must drain its pending cleanup; an upstream forced exit would leave the original config bytes");
});

const upstreamModules = process.env.PI_MODE_EXTENSION_UPSTREAM_NODE_MODULES;
test("actual pinned permission and LSP extensions isolate when an upstream fixture is supplied", { skip: !upstreamModules }, async (t) => {
  const root = join(tmpdir(), `pi-own-mode-extension-upstream-${Date.now()}`);
  const cwd = join(root, "project"); mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const permission = join(upstreamModules, "pi-permission-system", "src", "index.ts");
  const lsp = join(upstreamModules, "pi-lsp-extension", "src", "index.ts");
  const before = process.listeners("uncaughtException").length;
  const first = await loadModeExtensions([permission, lsp], cwd);
  const second = await loadModeExtensions([permission, lsp], cwd);
  assert.deepEqual([...first.errors, ...second.errors], []);
  assert.equal(process.listeners("uncaughtException").length, before);
  const context = { cwd, hasUI: false, sessionManager: { getEntries: () => [] }, ui: { setStatus: () => {} } };
  for (const extension of first.extensions.filter((item) => item.path.includes("pi-permission-system"))) for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, context);
  for (const extension of second.extensions.filter((item) => item.path.includes("pi-permission-system"))) for (const handler of extension.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, context);
  assert.equal(second.runtime.pendingProviderRegistrations.length, first.runtime.pendingProviderRegistrations.length, "second permission session must not inherit a process-global provider guard");
  assert.equal(Object.hasOwn(globalThis, "__piPermissionSystem"), false, "permission runtime API must not leak into unrelated modes");
  assert.equal(Object.hasOwn(globalThis, "__piPermissionSystemModelOptionGuardedApis"), false, "provider guard state must remain session-private");
  for (const extension of first.extensions) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, {});
  assert.equal(Object.hasOwn(globalThis, "__piPermissionSystem"), false);
});

test("current Host subagent engine compiles the selected permission and detached dispatch adapters", { skip: !upstreamModules }, async (t) => {
  const root = join(tmpdir(), `pi-own-mode-extension-subagents-${Date.now()}`);
  const cwd = join(root, "project"); mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const permission = join(upstreamModules, "pi-permission-system", "src", "index.ts");
  const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(root, "agent"), noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [{ name: "pi-web-subagents", factory: await createHostSubagentFactory(permission, "coding") }] });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], `Host subagents must load without a transformed-source error: ${JSON.stringify(loaded.errors)}`);
  const extension = loaded.extensions.find((item) => item.path === "<inline:pi-web-subagents>");
  assert.ok(extension, "the selected pi-subagents extension must be present");
  assert.ok(extension.tools.has("subagent"), "the loaded upstream extension must expose its native tool");
});

test("scoped foreground and detached child codemode retains the parent's model API boundary", () => {
  const child = join(import.meta.dirname, "../node_modules/pi-subagents/src/runs/shared/child-session.js");
  const dispatch = join(import.meta.dirname, "../node_modules/pi-subagents/src/runs/background/async-execution.js");
  const source = readFileSync(child, "utf8");
  const scoped = transformHostSubagentModule(source, child, undefined, "study-research.study");
  assert.match(scoped, /factory: createCodemodeExtension\(\{ models: false \}\)/u);
  assert.equal(transformHostSubagentModule(source, child, undefined, "coding"), source);
  const background = transformHostSubagentModule(readFileSync(dispatch, "utf8"), dispatch, undefined, "study-research.study");
  assert.match(background, /--import/u);
  const script = decodeURIComponent(windowsDetachedRunnerBootstrap(join(import.meta.dirname, "../node_modules/jiti/lib/jiti.cjs"), true).slice("data:text/javascript,".length));
  assert.match(script, /createCodemodeExtension\(\{ models: false \}\)/u);
});

test("actual pinned child permission factory keeps forwarding state out of host globals", { skip: !upstreamModules }, async () => {
  const permission = join(upstreamModules, "pi-permission-system", "src", "index.ts");
  const beforeEnvironment = {
    PI_IS_SUBAGENT: process.env.PI_IS_SUBAGENT,
    PI_AGENT_ROUTER_PARENT_SESSION_ID: process.env.PI_AGENT_ROUTER_PARENT_SESSION_ID,
    PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR: process.env.PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR,
  };
  const extension = await createIsolatedChildPermissionExtension({ path: permission, parentSessionId: "parent-session-fixture" });
  assert.equal(extension.name, "pi-web-isolated-child-permission");
  assert.equal(typeof extension.factory, "function");
  assert.deepEqual({
    PI_IS_SUBAGENT: process.env.PI_IS_SUBAGENT,
    PI_AGENT_ROUTER_PARENT_SESSION_ID: process.env.PI_AGENT_ROUTER_PARENT_SESSION_ID,
    PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR: process.env.PI_PERMISSION_SYSTEM_FORWARDING_AGENT_DIR,
  }, beforeEnvironment, "loading a child adapter cannot alter host process environment");
  assert.equal(Object.hasOwn(globalThis, "__piPermissionSystem"), false);
  assert.equal(Object.hasOwn(globalThis, "__piPermissionSystemModelOptionGuardedApis"), false);
});
