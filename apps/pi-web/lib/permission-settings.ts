import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { parsePermissionPolicy, type PermissionScope, type PermissionSettings } from "./permission-policy";
import { getRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

function sourceAt(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}\n"; throw error; }
}
function hash(source: string): string { return createHash("sha256").update(source).digest("hex"); }
function globalPath(): string { return join(process.env.PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR?.trim() ? resolve(process.env.PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR) : getAgentDir(), "pi-permissions.jsonc"); }

export async function readPermissionSettings(scope: PermissionScope, sessionId?: string): Promise<PermissionSettings> {
  const live = sessionId ? getRpcSession(sessionId) : undefined;
  let cwd = live?.cwd ?? null;
  if (sessionId && !cwd) {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) throw new Error("Session not found");
    cwd = SessionManager.open(sessionPath).getCwd();
  }
  if (scope === "project" && !cwd) throw new Error("Project permissions require an active conversation");
  const path = scope === "project" ? join(cwd!, ".pi", "agent", "pi-permissions.jsonc") : globalPath();
  const source = sourceAt(path);
  return {
    scope, path, source, contentHash: hash(source), policy: parsePermissionPolicy(source),
    globalPolicy: parsePermissionPolicy(sourceAt(globalPath())), cwd,
    active: live?.inner.extensionRunner.getRegisteredCommands().some((command) => command.invocationName === "permission-system") ?? false,
  };
}

export async function writePermissionSettings(scope: PermissionScope, sessionId: string | undefined, source: string, expectedContentHash: string): Promise<PermissionSettings> {
  parsePermissionPolicy(source);
  const current = await readPermissionSettings(scope, sessionId);
  // No awaits between comparison and atomic replacement.
  if (hash(sourceAt(current.path)) !== expectedContentHash) throw new Error("Permission settings changed; reload before saving");
  mkdirSync(dirname(current.path), { recursive: true });
  writePrivateFileAtomicSync(current.path, source);
  console.info("[pi-web] permission policy saved", { scope, sessionId, path: current.path, contentHash: hash(source) });
  return { ...current, source, contentHash: hash(source), policy: parsePermissionPolicy(source), ...(scope === "global" ? { globalPolicy: parsePermissionPolicy(source) } : {}) };
}
