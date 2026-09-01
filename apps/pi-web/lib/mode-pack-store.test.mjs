import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ModePackStore } = await jiti.import("./mode-pack-store.ts");

test("custom Mode Pack store keeps immutable revisions and fails on stale writers", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-mode-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "mode-packs.json");
  const store = new ModePackStore(path);
  const draft = {
    version: 1,
    modePackId: "custom.review",
    revision: 1,
    title: "Review",
    description: "Read-only review mode.",
    category: "general",
    role: "general",
    runtimeMode: "general",
    provider: null,
    model: null,
    thinkingLevel: "high",
    externalKnowledgePolicy: "allow",
    courseRequired: false,
    tools: ["find", "grep", "ls", "read"],
    components: [],
    systemPrompt: "Review evidence before conclusions.",
    instructions: [],
  };
  const first = await store.saveDraft(draft, root, 0);
  assert.equal(first.revision, 1);
  await assert.rejects(() => store.saveDraft({ ...draft, revision: 2 }, root, 0), /revision conflict/i);
  const second = await store.saveDraft({ ...draft, revision: 2, systemPrompt: "Review evidence and cite defects." }, root, 1);
  assert.equal(second.revision, 2);
  assert.equal(new ModePackStore(path).getCustom("custom.review")?.revision, 2);
  await assert.rejects(
    () => store.saveDraft({ ...draft, modePackId: "custom.bad", components: [{ type: "plugin", id: "learning-harness", required: true, enabled: true }] }, root, 0),
    /course-only learning-harness/i,
  );

  const historyBefore = JSON.parse(readFileSync(path, "utf8"));
  const writes = await Promise.allSettled([
    new ModePackStore(path).saveDraft({ ...draft, revision: 3, systemPrompt: "Concurrent writer A." }, root, 2),
    new ModePackStore(path).saveDraft({ ...draft, revision: 3, systemPrompt: "Concurrent writer B." }, root, 2),
  ]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const loser = writes.find((result) => result.status === "rejected");
  assert.match(String(loser?.reason), /revision conflict/i);
  const third = new ModePackStore(path).getCustom("custom.review");
  assert.equal(third?.revision, 3);
  const historyAfter = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(historyAfter.histories["custom.review"].slice(0, 2), historyBefore.histories["custom.review"]);
  assert.equal(historyAfter.histories["custom.review"].length, 3);
  await assert.rejects(() => store.deleteCustom("custom.review", 2), /revision conflict/i);
  await store.deleteCustom("custom.review", 3);
  assert.equal(store.getCustom("custom.review"), null);
});
