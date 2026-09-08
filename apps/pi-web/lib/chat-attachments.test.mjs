import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { saveChatAttachment, readChatAttachment } = await createJiti(import.meta.url).import("./chat-attachments.ts");
test("chat files retain original bytes, support arbitrary text extensions and enforce conversation/Assignment scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-attachments-"));
  const scope = { sessionId: "teacher", assignmentId: null };
  try {
    const file = new File(["x <- 42"], "exercise.custom", { type: "application/octet-stream" });
    const saved = await saveChatAttachment(cwd, file, scope);
    assert.equal(await readFile(saved.path, "utf8"), "x <- 42");
    assert.equal(await readChatAttachment(cwd, saved.id, scope), "x <- 42");
    await assert.rejects(readChatAttachment(cwd, saved.id, { ...scope, sessionId: "other" }), /another conversation/);
    await assert.rejects(readChatAttachment(cwd, saved.id, { ...scope, assignmentId: "homework" }), /Assignment/);
    const collision = await saveChatAttachment(cwd, new File(["plain"], "attachment.json"), scope);
    assert.equal(await readChatAttachment(cwd, collision.id, scope), "plain");
    await writeFile(saved.path, "changed");
    await assert.rejects(readChatAttachment(cwd, saved.id, scope), /changed/);
    await assert.rejects(saveChatAttachment(cwd, new File(["bad"], "../bad"), scope), /filename/);
  } finally { assert.ok(cwd.startsWith(join(tmpdir(), "pi-chat-attachments-"))); await rm(cwd, { recursive: true, force: true }); }
});
