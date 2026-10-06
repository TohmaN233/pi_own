import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { modePackDefinitionToDraft } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./mode-pack-client.ts");

test("imported immutable Mode Pack definitions become strict editable drafts", () => {
  const draft = modePackDefinitionToDraft({
    version: 1, modePackId: "custom.imported", revision: 1, title: "Imported", description: "d", category: "general", role: "general", runtimeMode: "general", provider: null, model: null, thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false, tools: ["read"], systemPrompt: "p", instructions: [], packageContentHash: "sha256:abc", contentHash: "sha256:definition", components: [{ type: "skill", id: "fixture", required: false, enabled: true, delivery: "native-skill", version: "v1", contentHash: "sha256:component" }],
  });
  assert.deepEqual(draft, {
    version: 1, modePackId: "custom.imported", revision: 1, title: "Imported", description: "d", category: "general", role: "general", runtimeMode: "general", provider: null, model: null, thinkingLevel: "medium", externalKnowledgePolicy: "allow", courseRequired: false, tools: ["read"], systemPrompt: "p", instructions: [], packageContentHash: "sha256:abc", components: [{ type: "skill", id: "fixture", required: false, enabled: true, delivery: "native-skill" }],
  });
  assert.equal(Object.hasOwn(draft, "contentHash"), false);
});
