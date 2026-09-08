import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getDraft, setDraft, clearDraft, rekeyDraft } = await createJiti(import.meta.url).import("./draft-store.ts");

test("text attachment drafts restore per conversation after reload and clear after send", () => {
  const storage = new Map([["pi-chat-draft-text:restored", "[附件：notes.custom](</fixture/notes.custom>)"]]);
  globalThis.window = { sessionStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  } };
  try {
    assert.match(getDraft("restored").value, /notes.custom/);
    assert.equal(getDraft("other"), null);
    rekeyDraft("restored", "new-session");
    assert.equal(storage.has("pi-chat-draft-text:restored"), false);
    assert.match(storage.get("pi-chat-draft-text:new-session"), /notes.custom/);
    setDraft("new-session", { value: "review this attachment", images: [{ data: "image-bytes", mimeType: "image/png" }] });
    assert.equal(storage.get("pi-chat-draft-text:new-session"), "review this attachment");
    clearDraft("new-session");
    assert.equal(getDraft("new-session"), null);
    assert.equal(storage.size, 0);
  } finally { delete globalThis.window; }
});
