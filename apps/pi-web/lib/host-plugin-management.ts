import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { resolvePortableNpmInvocation } from "./portable-mode-package-install";
import { HOST_PLUGIN_VERSIONS, assertHostPluginInstalled, hostPluginDirectory, isHostPluginEnabled, writeHostPluginEnabled, type HostPluginId } from "./host-plugin-settings";
import lockfile from "proper-lockfile";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);

export async function manageHostPlugin(id: HostPluginId, action: "install" | "remove" | "enable" | "disable"): Promise<void> {
  if (!Object.hasOwn(HOST_PLUGIN_VERSIONS, id)) throw new Error(`Unknown Host plugin: ${id}`);
  if (action === "enable" || action === "disable") {
    if (action === "enable") assertHostPluginInstalled(id);
    writeHostPluginEnabled(id, action === "enable");
    return;
  }
  const release = await lockfile.lock(getAgentDir(), { realpath: false, lockfilePath: `${getAgentDir()}/host-plugin-management.lock`, retries: 0 });
  const previouslyEnabled = isHostPluginEnabled(id);
  try {
    if (action === "remove") writeHostPluginEnabled(id, false);
    const npm = resolvePortableNpmInvocation();
    const appDirectory = dirname(dirname(dirname(getPackageDir())));
    // Our private plugin is shipped with Pi Web; never substitute a registry package.
    const installSource = id === "pi-caw" ? `file:host-plugins/pi-caw-${HOST_PLUGIN_VERSIONS[id]}.tgz` : `${id}@${HOST_PLUGIN_VERSIONS[id]}`;
    if (action === "install" && id === "pi-caw" && !existsSync(`${appDirectory}/host-plugins/pi-caw-${HOST_PLUGIN_VERSIONS[id]}.tgz`)) {
      throw new Error(`Bundled pi-CAW installation archive is missing in ${appDirectory}/host-plugins`);
    }
    const args = action === "install"
      ? ["install", "--save-exact", "--ignore-scripts", installSource]
      : ["uninstall", "--ignore-scripts", id];
    console.info("[plugins/host] operation started", { id, action, directory: appDirectory });
    await run(npm.command, [...npm.prefix, ...args], { cwd: appDirectory, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (action === "remove" && existsSync(hostPluginDirectory(id))) throw new Error(`npm retained ${id} as a dependency; its files have not been deleted`);
    if (action === "install") {
      assertHostPluginInstalled(id);
      writeHostPluginEnabled(id, true);
    }
    console.info("[plugins/host] operation completed", { id, action });
  } catch (error) {
    if (action === "remove" && existsSync(hostPluginDirectory(id))) writeHostPluginEnabled(id, previouslyEnabled);
    console.error("[plugins/host] operation failed", { id, action, error });
    throw error;
  } finally { await release(); }
}
