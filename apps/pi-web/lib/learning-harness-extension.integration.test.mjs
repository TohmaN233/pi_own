import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { LearningHarness } from "../../../packages/learning-harness/src/index.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createLearningHarnessExtension } = await jiti.import("./learning-harness-extension.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { AuthStorage } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js", import.meta.url).href);

function assistantText(message) {
  return (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("one Pi AgentSession publishes a canonical grounded final and never forwards faux-provider prose", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-grounded-faux-"));
  const faux = createFauxCore({});
  const authStorage = AuthStorage.inMemory();
  await authStorage.modify("faux", async () => ({ type: "api_key", key: "faux-key" }));
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(directory, "models.json") });
  const model = faux.getModel();
  modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl }] });
  const harnessStore = new LearningHarness({ databasePath: join(directory, "learning-harness.sqlite") });
  const course = await harnessStore.publishCourseVersion("faux-course", [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Course\n\nA variable represents an unknown value." }], { createdAt: "2026-08-30T23:00:00.000Z" });
  const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
  let session;
  const { extension, outboundGate } = createLearningHarnessExtension(() => session.sessionId, harnessStore);
  const services = await createAgentSessionServices({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.create(directory, directory), modelRuntime, resourceLoaderOptions: { extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager, model }));
  session.agent.streamFunction = faux.stream;
  const wrapper = new AgentSessionWrapper(session, { groundedAnswerGate: outboundGate });
  t.after(() => {
    wrapper.destroy();
    session.dispose();
    harnessStore.close();
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  });
  harnessStore.openStudentSession({ sessionStore: sessionManager, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T23:00:00.000Z" });
  await session.bindExtensions({});
  assert.ok(session.getAllTools().some((tool) => tool.name === "submit_grounded_answer"));
  session.setActiveToolsByName(["submit_grounded_answer"]);
  assert.deepEqual(session.getActiveToolNames(), ["submit_grounded_answer"]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("submit_grounded_answer", { claims: [{ claimId: "claim", text: "A variable represents an unknown value.", scope: "direct", citationSpanIds: [course.spans[0].spanId], reason: null }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("raw faux-provider answer must not persist"),
  ]);
  const outbound = [];
  wrapper.onEvent((event) => outbound.push(event));
  wrapper.start();
  await session.prompt("What is a variable?");

  assert.ok(session.messages.some((message) => message.role === "toolResult"), `faux tool call must execute: ${JSON.stringify(session.messages)}`);
  assert.ok(session.messages.some((message) => message.role === "toolResult" && !message.isError), "grounded draft must stage");
  const final = session.messages.filter((message) => message.role === "assistant").at(-1);
  assert.ok(final);
  assert.match(assistantText(final), /learning-harness:published/);
  assert.doesNotMatch(assistantText(final), /raw faux-provider/);
  assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 2);
  assert.equal(outbound.some((event) => JSON.stringify(event).includes("raw faux-provider")), false);
  assert.equal(harnessStore.getCurrentTimeline(session.sessionId).length, 1);
});
