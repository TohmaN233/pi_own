import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createExactSystemPromptExtension } = await jiti.import("./exact-system-prompt.ts");

test("Pi's before_agent_start hook supplies the current exact host prompt", () => {
  const handlers = new Map();
  const promptRef = { current: () => "first prompt" };
  const extension = createExactSystemPromptExtension(promptRef);
  extension.factory({ on: (event, handler) => handlers.set(event, handler) });

  assert.equal(typeof handlers.get("before_agent_start"), "function");
  assert.deepEqual(handlers.get("before_agent_start")(), { systemPrompt: "first prompt" });

  promptRef.current = () => "updated prompt";
  assert.deepEqual(handlers.get("before_agent_start")(), { systemPrompt: "updated prompt" });
});
