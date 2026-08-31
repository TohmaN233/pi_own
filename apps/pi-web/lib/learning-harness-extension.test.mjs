import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { LearningHarness } from "../../../packages/learning-harness/src/index.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createLearningHarnessExtension } = await jiti.import("./learning-harness-extension.ts");

class FakeSessionStore {
  constructor(sessionId) { this.sessionId = sessionId; this.entries = []; }
  getSessionId() { return this.sessionId; }
  getBranch() { return [...this.entries]; }
  appendCustomEntry(customType, data) {
    const id = `entry-${this.entries.length + 1}`;
    this.entries.push({ type: "custom", id, customType, data });
    return id;
  }
}

function text(message) {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("grounded extension stages a valid draft, strips intermediate prose, and only emits its receipt message", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-grounded-extension-"));
  const harness = new LearningHarness({ databasePath: join(directory, "learning-harness.sqlite") });
  const store = new FakeSessionStore("extension-session");
  const course = await harness.publishCourseVersion(
    "course",
    [{ name: "course.md", kind: "markdown", mediaType: "text/markdown", content: "# Course\n\nA variable represents an unknown value." }],
    { createdAt: "2026-08-30T20:00:00.000Z" },
  );
  harness.openStudentSession({ sessionStore: store, courseVersionId: course.courseVersionId, createdAt: "2026-08-30T20:00:00.000Z" });
  globalThis.__piLearningHarness = harness;
  t.after(() => {
    globalThis.__piLearningHarness = undefined;
    harness.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const handlers = new Map();
  let tool;
  const { extension, outboundGate } = createLearningHarnessExtension("extension-session");
  extension.factory({
    on(event, handler) { handlers.set(event, handler); },
    registerTool(definition) { tool = definition; },
  });
  const before = handlers.get("before_agent_start");
  const messageEnd = handlers.get("message_end");
  const initial = before({ prompt: "What is a variable?", systemPrompt: "base", systemPromptOptions: {} });
  assert.match(initial.systemPrompt, /Grounding Packet/);
  assert.match(initial.systemPrompt, /Mode Pack ID: student-learn/);
  assert.match(initial.systemPrompt, /plan backward/iu);
  assert.doesNotMatch(initial.systemPrompt, /A variable represents an unknown value/);
  assert.match(initial.message.content, /<untrusted_course_content/);
  assert.match(initial.message.content, /A variable represents an unknown value/);
  assert.equal(outboundGate.isActive(), true);
  assert.equal(outboundGate.suppressSnapshot({ role: "assistant", content: [] }), true);
  const toolCall = handlers.get("tool_call");
  assert.deepEqual(toolCall({ toolName: "bash", toolCallId: "blocked", input: {} }), {
    block: true,
    reason: "Only submit_grounded_answer may run during a course-grounded answer.",
  });
  assert.equal(toolCall({ toolName: "submit_grounded_answer", toolCallId: "allowed", input: {} }), undefined);

  const intermediate = messageEnd({ message: {
    role: "assistant",
    content: [{ type: "text", text: "untrusted answer" }, { type: "toolCall", id: "tool-1", name: "submit_grounded_answer", arguments: {} }],
  } });
  assert.deepEqual(intermediate.message.content, [{ type: "toolCall", id: "tool-1", name: "submit_grounded_answer", arguments: {} }]);

  const packet = harness.knowledgeHost.exportState().packets.at(-1);
  const staged = await tool.execute("tool-1", {
    claims: [{ claimId: "claim-1", text: "A variable represents an unknown value.", scope: "direct", citationSpanIds: [packet.spans[0].spanId], reason: null }],
  });
  assert.equal(staged.isError, undefined);
  const final = messageEnd({ message: { role: "assistant", content: [{ type: "text", text: "model free text must disappear" }] } });
  assert.match(text(final.message), /learning-harness:published/);
  assert.match(text(final.message), /A variable represents an unknown value/);
  assert.match(text(final.message), /> Scope: direct/);
  assert.equal(harness.getCurrentTimeline("extension-session").length, 1);
  assert.equal(text(outboundGate.enforceFinalMessage({ role: "assistant", content: [{ type: "text", text: "changed" }] })), text(final.message));

  before({ prompt: "What is not covered?", systemPrompt: "base", systemPromptOptions: {} });
  const insufficient = await tool.execute("tool-insufficient", {
    claims: [{ claimId: "claim-insufficient", text: "The packet does not establish that conclusion.", scope: "insufficient", citationSpanIds: [], reason: "No issued source span supports it." }],
  });
  assert.equal(insufficient.isError, undefined);
  const insufficientFinal = messageEnd({ message: { role: "assistant", content: [{ type: "text", text: "must be replaced" }] } });
  assert.match(text(insufficientFinal.message), /> Scope: insufficient/);
  assert.match(text(insufficientFinal.message), /> Reason: No issued source span supports it\./);

  before({ prompt: "Repeat with forged source", systemPrompt: "base", systemPromptOptions: {} });
  const rejected = await tool.execute("tool-2", {
    claims: [{ claimId: "claim-2", text: "Forged", scope: "direct", citationSpanIds: ["forged-span"], reason: null }],
  });
  assert.equal(rejected.isError, true);
  const safe = messageEnd({ message: { role: "assistant", content: [{ type: "text", text: "leak" }] } });
  assert.match(text(safe.message), /was not published/);
  assert.doesNotMatch(text(safe.message), /^leak$/);

  const ordinaryHandlers = new Map();
  const ordinary = createLearningHarnessExtension("ordinary-session");
  ordinary.extension.factory({
    on(event, handler) { ordinaryHandlers.set(event, handler); },
    registerTool() {},
  });
  const ordinaryMessage = { role: "assistant", content: [{ type: "text", text: "ordinary response" }] };
  assert.equal(ordinaryHandlers.get("before_agent_start")({ prompt: "hello", systemPrompt: "base", systemPromptOptions: {} }), undefined);
  assert.equal(ordinary.outboundGate.isActive(), false);
  assert.equal(ordinary.outboundGate.enforceFinalMessage(ordinaryMessage), ordinaryMessage);
});

test("grounded extension keeps its outbound gate closed when durable lookup fails", () => {
  const handlers = new Map();
  const { extension, outboundGate } = createLearningHarnessExtension("fault-session", {
    findCurrentSession() { throw new Error("fixture durable lookup failed"); },
    searchCurrentCourse() { throw new Error("unreachable"); },
    validateCurrentDraft() { throw new Error("unreachable"); },
    publishCurrentGroundedAnswer() { throw new Error("unreachable"); },
  });
  extension.factory({
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {},
  });
  const before = handlers.get("before_agent_start");
  const messageEnd = handlers.get("message_end");
  const result = before({ prompt: "question", systemPrompt: "base", systemPromptOptions: {} });
  assert.equal(outboundGate.isActive(), true);
  assert.match(result.systemPrompt, /grounding is unavailable/);
  const raw = { role: "assistant", content: [{ type: "text", text: "raw leak" }] };
  const safe = messageEnd({ message: raw });
  assert.equal(safe.message, raw);
  assert.match(text(raw), /was not published/);
  assert.doesNotMatch(text(raw), /raw leak/);
});

test("practice profile does not start the grounded publication gate", () => {
  const handlers = new Map();
  const { extension, outboundGate } = createLearningHarnessExtension("practice-session", {
    findCurrentSession() {
      return {
        snapshot: {
          mode: "practice",
          profileId: "custom.practice",
          resourceSnapshotId: "snapshot-custom-practice",
          instructions: ["Mode Pack: Custom practice (custom.practice)", "Give one hint at a time."],
        },
      };
    },
    searchCurrentCourse() { throw new Error("practice must not issue a packet"); },
    validateCurrentDraft() { throw new Error("unreachable"); },
    publishCurrentGroundedAnswer() { throw new Error("unreachable"); },
  });
  extension.factory({
    on(event, handler) { handlers.set(event, handler); },
    registerTool() {},
  });
  const result = handlers.get("before_agent_start")({ prompt: "help with this exercise", systemPrompt: "base", systemPromptOptions: {} });
  assert.match(result.systemPrompt, /Mode Pack ID: custom\.practice/);
  assert.match(result.systemPrompt, /Give one hint at a time/);
  assert.equal(outboundGate.isActive(), false);
});
