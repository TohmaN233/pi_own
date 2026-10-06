import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

type State = { version: 1; archiveHashes: string[]; resourceKeys: string[] };
const statePath = () => join(getAgentDir(), "resource-uninstalls.json");
function readState(): State {
  if (!existsSync(statePath())) return { version: 1, archiveHashes: [], resourceKeys: [] };
  const value = JSON.parse(readFileSync(statePath(), "utf8")) as State;
  if (value.version !== 1 || !Array.isArray(value.archiveHashes) || !Array.isArray(value.resourceKeys)
    || value.archiveHashes.some(hash => !/^sha256:[a-f0-9]{64}$/u.test(hash))
    || value.resourceKeys.some(key => typeof key !== "string" || !/^(skill|extension):.+/u.test(key))) throw new Error("Invalid resource uninstall journal");
  return value;
}
export function recordResourceUninstall(archiveHashes: string[], resourceKeys: string[]): void {
  const previous = readState();
  writePrivateFileAtomicSync(statePath(), `${JSON.stringify({ version: 1, archiveHashes: [...new Set([...previous.archiveHashes, ...archiveHashes])], resourceKeys: [...new Set([...previous.resourceKeys, ...resourceKeys])] }, null, 2)}\n`);
}
export function isExplicitlyUninstalledPackage(hash: string): boolean { return readState().archiveHashes.includes(hash); }
export function hasExplicitlyUninstalledResources(resources: ReadonlyArray<{ kind: string; id: string }>, retainedResources: ReadonlyArray<{ kind: string; id: string }> = []): boolean {
  const removed = new Set(readState().resourceKeys);
  const retained = new Set(retainedResources.map(item => `${item.kind}:${item.id}`));
  return resources.some(item => removed.has(`${item.kind}:${item.id}`) && !retained.has(`${item.kind}:${item.id}`));
}
