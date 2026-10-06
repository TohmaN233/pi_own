import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** One source of truth for the durable custom Mode Pack store location.
 * Keep this low-level so the portable package registry does not import the
 * store (which itself builds inventories). */
export function modePackStorePathFromEnvironment(): string {
  const explicit = process.env.PI_MODE_PACK_STORE_PATH;
  if (explicit) return resolve(explicit);
  const harnessDirectory = process.env.PI_LEARNING_HARNESS_DIR;
  return resolve(harnessDirectory ? join(harnessDirectory, "mode-packs.json") : join(getAgentDir(), "mode-packs.json"));
}

/** Locate shipped project data from this Host module, never the user's workspace. */
export function bundledDomainWorkflowsDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  let installedApp: string | undefined;
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (manifest.name === "pi-monorepo") return join(directory, "mode-packs", "domain-workflows");
      if (manifest.name === "@agegr/pi-web") installedApp = directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      if (installedApp) return join(installedApp, "runtime", "domain-workflows");
      throw new Error("Bundled domain Workflow project data could not be located from the Host module");
    }
    directory = parent;
  }
}
