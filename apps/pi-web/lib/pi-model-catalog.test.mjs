import assert from "node:assert/strict";
import test from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";

test("the pinned Pi catalog includes GPT-6 Sol/Luna and Grok 4.7 providers", () => {
  for (const provider of ["openai", "openai-codex"]) {
    for (const modelId of ["gpt-6-sol", "gpt-6-luna"]) {
      const model = getModel(provider, modelId);
      assert.ok(model, `${provider}/${modelId} must be in the installed Pi catalog`);
      assert.equal(model.id, modelId);
      assert.equal(model.reasoning, true);
    }
  }

  const grok = getModel("xai", "grok-4.7");
  assert.ok(grok, "xai/grok-4.7 must be in the installed Pi catalog");
  assert.equal(grok.id, "grok-4.7");
  assert.equal(grok.reasoning, true);
});
