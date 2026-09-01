import { existsSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  MODE_PACK_BINDING_CUSTOM_TYPE,
  parseModePackSessionBinding,
  recoverModePackBindingHistory,
} from "../../../packages/mode-pack-host/src/index.ts";
import type { AgentSessionWrapper } from "./rpc-manager-base";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";

/** Copy with Pi's SessionManager, including its legitimate pre-assistant branch. */
export async function forkGenericModePackSession(
  wrapper: AgentSessionWrapper,
  entryId: unknown,
  persistUnflushed: (manager: SessionManager) => void,
): Promise<{ cancelled: boolean; newSessionId?: string }> {
  await wrapper.waitUntilReady();
  if (!wrapper.isAlive() || !wrapper.tryAcquireProfileTransition()) {
    throw new Error("Cannot fork while the Pi session is running or changing Mode Packs.");
  }
  try {
    if (typeof entryId !== "string" || !entryId) throw new Error("Invalid entry ID for forking");
    const sessionFile = wrapper.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) throw new Error("Mode Pack fork requires a persisted Pi transcript");
    const parent = SessionManager.open(sessionFile, wrapper.inner.sessionManager.getSessionDir());
    if (parent.getSessionId() !== wrapper.sessionId) throw new Error("Mode Pack fork source identity changed");
    const recovery = recoverModePackBindingHistory(parent.getEntries(), parent.getSessionId());
    if (!recovery.current) throw new Error("Mode Pack fork source has no committed binding");
    const entry = parent.getEntry(entryId);
    if (!entry) throw new Error("Invalid entry ID for forking");

    const child = SessionManager.open(sessionFile, parent.getSessionDir());
    if (entry.parentId) {
      child.createBranchedSession(entry.parentId);
    } else {
      child.newSession({ parentSession: sessionFile });
    }
    if (child.getSessionId() === parent.getSessionId()) throw new Error("Mode Pack fork did not create a child identity");

    // A fork keeps the source's active Mode Pack even when its message cut point
    // precedes activation. Carry forward only validated host binding metadata;
    // never invent assistant messages to force the SDK's deferred first flush.
    recoverModePackBindingHistory(child.getEntries(), child.getSessionId());
    const copied = new Set(child.getEntries()
      .filter((item) => item.type === "custom" && item.customType === MODE_PACK_BINDING_CUSTOM_TYPE)
      .map((item) => parseModePackSessionBinding(item.data).requestHash));
    for (const item of parent.getEntries()) {
      if (item.type !== "custom" || item.customType !== MODE_PACK_BINDING_CUSTOM_TYPE) continue;
      const binding = parseModePackSessionBinding(item.data);
      if (!copied.has(binding.requestHash)) {
        child.appendCustomEntry(MODE_PACK_BINDING_CUSTOM_TYPE, binding);
        copied.add(binding.requestHash);
      }
    }
    const model = wrapper.inner.model;
    if (model) child.appendModelChange(model.provider, model.id);
    persistUnflushed(child);

    const childFile = child.getSessionFile();
    if (!childFile || !existsSync(childFile)) throw new Error("Mode Pack fork was not persisted");
    const reopened = SessionManager.open(childFile, child.getSessionDir());
    const inherited = recoverModePackBindingHistory(reopened.getEntries(), reopened.getSessionId()).inherited;
    if (reopened.getSessionId() !== child.getSessionId() || inherited?.requestHash !== recovery.current.requestHash) {
      throw new Error("Mode Pack fork did not preserve its committed parent binding");
    }
    cacheSessionPath(child.getSessionId(), childFile);
    invalidateSessionListCache();
    try {
      await wrapper.shutdown();
    } catch (error) {
      console.error("[mode-pack] fork persisted, but source shutdown failed:", error instanceof Error ? error.message : error);
    }
    return { cancelled: false, newSessionId: child.getSessionId() };
  } finally {
    wrapper.releaseProfileTransition();
  }
}
