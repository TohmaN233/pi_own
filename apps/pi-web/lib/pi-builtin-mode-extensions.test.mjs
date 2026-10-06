import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSessionFromServices, createAgentSessionServices, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createPiBuiltinModeExtensions } = await jiti.import("./pi-builtin-mode-extensions.ts");
const { AuthStorage } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href);

test("native Codemode, MCP and standalone search register independently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-builtins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [selection, mcp, expectedTools, expectedCommands] of [
    [["codemode"], false, ["codemode"], []],
    [[], true, [], ["mcp"]],
    [["tool_search"], true, ["tool_search"], ["mcp"]],
    [["codemode"], true, ["codemode"], ["mcp"]],
  ]) {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: SettingsManager.create(root, root),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: createPiBuiltinModeExtensions(selection, { mcp }),
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extensions = loader.getExtensions().extensions;
  const tools = extensions.flatMap((extension) => [...extension.tools.keys()]);
  const commands = extensions.flatMap((extension) => [...extension.commands.keys()]);
  assert.deepEqual(tools.sort(), expectedTools);
  assert.deepEqual(commands.sort(), expectedCommands);
  }
});

test("native scripts retain Host tool admission and cannot reach inactive raw tools or extra models", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-script-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Provider/network calls are forbidden in this test"); };
  let session;
  t.after(async () => { session?.dispose(); globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); });
  const faux = createFauxCore({});
  const credentials = AuthStorage.inMemory();
  await credentials.modify("faux", async () => ({ type: "api_key", key: "fixture" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(root, "models.json"), allowModelNetwork: false });
  const model = faux.getModel();
  modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
  const admitted = [], calls = [];
  const host = (pi) => {
    pi.registerTool({ name: "host_read", label: "Host read", description: "Read an admitted course source", parameters: Type.Object({ id: Type.String() }), execute: async (_id, args) => {
      admitted.push(args.id);
      return { content: [{ type: "text", text: `SOURCE:${args.id}` }], details: {} };
    } });
    pi.on("tool_call", (event) => { if (event.toolName === "host_read") { calls.push(event.input.id); if (event.input.id === "blocked") return { block: true, reason: "Host rejected source" }; } });
  };
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager: SettingsManager.create(root, root), modelRuntime,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [...createPiBuiltinModeExtensions(["codemode"], { mcp: false }), host] } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(root, join(root, "sessions")), model }));
  session.agent.streamFunction = faux.stream;
  await session.bindExtensions({});
  session.setActiveToolsByName(["codemode", "host_read"]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: 'const found = await searchTools("Read an admitted course source"); text(found.map(t => t.name)); const results = await Promise.allSettled([tools.host_read({id:"allowed"}), tools.host_read({id:"blocked"})]); text(results.map(r => r.status === "fulfilled" ? r.value : r.reason.message)); text({rawRead: "read" in tools, extraModels: typeof models});' })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  await session.prompt("Read only the admitted source using a script.");
  const results = session.messages.filter((message) => message.role === "toolResult").flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text)).join("\n");
  assert.match(results, /Script completed/);
  assert.match(results, /SOURCE:allowed/);
  assert.match(results, /Host rejected source/);
  assert.match(results, /"rawRead":false/);
  assert.match(results, /"extraModels":"undefined"/);
  assert.deepEqual(calls.sort(), ["allowed", "blocked"]);
  assert.deepEqual(admitted, ["allowed"]);
});

test("ordinary conversations persist independent native switches without binding a Mode Pack", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-native-switches-"));
  const env = { PI_CODING_AGENT_DIR: join(root, "agent"), PI_LEARNING_HARNESS_DIR: join(root, "harness"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), ANTHROPIC_API_KEY: "offline-fixture" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network calls are forbidden in this test"); };
  const rpc = await jiti.import("./rpc-manager.ts");
  const { getSessionModeSettings } = await jiti.import("./mode-settings-service.ts");
  let live;
  t.after(async () => {
    await live?.shutdown();
    globalThis.__piLearningHarness?.close(); globalThis.__piLearningHarness = undefined;
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  ({ session: live } = await rpc.startRpcSession("native-switch-fixture", "", root, { toolNames: ["read", "codemode"] }));
  const sessionId = live.sessionId, modelId = live.inner.model.id;
  const manager = live.inner.sessionManager;
  // Persist fixture messages locally; no model runs or provider calls.
  manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "fixture" }], provider: live.inner.model.provider, model: modelId, api: live.inner.model.api, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const file = live.sessionFile;
  assert.equal((await getSessionModeSettings(sessionId)).modePackId, null);
  const first = live;
  ({ session: live } = await rpc.setRpcSessionTools(sessionId, file, ["read", "tool_search"]));
  assert.notEqual(live, first);
  assert.equal(live.sessionId, sessionId);
  assert.equal(live.inner.model.id, modelId);
  assert.ok(live.inner.getActiveToolNames().includes("tool_search"));
  assert.ok(!live.inner.getAllTools().some((tool) => tool.name === "codemode"));
  const settings = await getSessionModeSettings(sessionId);
  assert.equal(settings.modePackId, null);
  assert.deepEqual(settings.tools, ["read", "tool_search"]);
  await live.shutdown();
  ({ session: live } = await rpc.startRpcSession(sessionId, file, undefined));
  assert.ok(live.inner.getActiveToolNames().includes("tool_search"));
  assert.ok(!live.inner.getAllTools().some((tool) => tool.name === "codemode"));
  ({ session: live } = await rpc.setRpcSessionTools(sessionId, file, ["read", "codemode"]));
  assert.ok(live.inner.getActiveToolNames().includes("codemode"));
  assert.ok(!live.inner.getAllTools().some((tool) => tool.name === "tool_search"));
  assert.equal((await getSessionModeSettings(sessionId)).modePackId, null);
});
