import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import type { AgentSessionLike } from "./pi-types";

/** Call only after a profile binding commits, or when restoring a committed one.
 * SDK construction restores messages but does not journal explicit model overrides
 * for existing sessions. The normal session reader must see the same selection.
 */
export function persistCommittedRuntimeSettings(inner: Pick<AgentSessionLike, "model" | "agent" | "sessionManager">): void {
  const manager = inner.sessionManager;
  const previous = manager.buildSessionContext();
  const model = inner.model;
  const thinking = inner.agent.state?.thinkingLevel;
  const modelChanged = !!model && (previous.model?.provider !== model.provider || previous.model?.modelId !== model.id);
  const thinkingChanged = thinking !== undefined && previous.thinkingLevel !== thinking;
  if (modelChanged) manager.appendModelChange(model.provider, model.id);
  if (thinkingChanged) manager.appendThinkingLevelChange(thinking as ThinkingLevel);
  const file = manager.getSessionFile();
  const saved = file && existsSync(file) ? SessionManager.open(file).buildSessionContext() : manager.buildSessionContext();
  if ((model && (saved.model?.provider !== model.provider || saved.model?.modelId !== model.id)) || (thinking !== undefined && saved.thinkingLevel !== thinking)) {
    throw new Error("Committed runtime model/thinking settings could not be recovered from the session transcript");
  }
  if (modelChanged || thinkingChanged) console.info("[session-settings] committed", {
    sessionId: manager.getSessionId(), provider: model?.provider, modelId: model?.id, thinkingLevel: thinking,
  });
}
