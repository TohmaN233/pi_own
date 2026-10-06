import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isBuiltInSubagentsEnabled, writeBuiltInSubagentsEnabled } from "./subagent-settings";

export const HOST_PLUGIN_VERSIONS = {
  "pi-subagents": "0.74.0",
  "@eko24ive/pi-ask": "1.2.0",
  "pi-context-usage": "2.1.0",
  "@ff-labs/pi-fff": "0.11.0",
  "pi-caw": "0.2.31",
} as const;
export type HostPluginId = keyof typeof HOST_PLUGIN_VERSIONS;

export function hostPluginDirectory(id: HostPluginId): string {
  return join(dirname(dirname(getPackageDir())), ...id.split("/"));
}

export function readHostPluginSettings(): Partial<Record<HostPluginId, boolean>> {
  const file = join(getAgentDir(), "host-plugins.json");
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Host plugin settings");
  for (const [id, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(HOST_PLUGIN_VERSIONS, id) || typeof value !== "boolean") throw new Error(`Invalid Host plugin setting: ${id}`);
  }
  return parsed as Partial<Record<HostPluginId, boolean>>;
}

export function isHostPluginEnabled(id: HostPluginId): boolean {
  return readHostPluginSettings()[id] ?? (id === "pi-subagents" ? isBuiltInSubagentsEnabled() : true);
}

export function writeHostPluginEnabled(id: HostPluginId, enabled: boolean): void {
  const file = join(getAgentDir(), "host-plugins.json");
  mkdirSync(dirname(file), { recursive: true });
  writePrivateFileAtomicSync(file, `${JSON.stringify({ ...readHostPluginSettings(), [id]: enabled }, null, 2)}\n`);
  if (id === "pi-subagents") writeBuiltInSubagentsEnabled(enabled);
}

export function assertHostPluginInstalled(id: HostPluginId): void {
  const file = join(hostPluginDirectory(id), "package.json");
  if (!existsSync(file)) throw new Error(`Enabled Host plugin is missing: ${id}. Reinstall or disable it in Settings > Plugins.`);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
  if (manifest.name !== id || manifest.version !== HOST_PLUGIN_VERSIONS[id]) {
    throw new Error(`Unsupported Host plugin: expected ${id}@${HOST_PLUGIN_VERSIONS[id]}, found ${manifest.name}@${manifest.version}`);
  }
}
