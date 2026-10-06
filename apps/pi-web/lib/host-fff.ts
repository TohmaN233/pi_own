import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import { createJiti } from "jiti/static";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isHostPluginEnabled } from "./host-plugin-settings";

/** One Pi Web search capability for every session that enables workspace
 * search. It is installed with the host, never claimed by a mode package. */
export async function createHostFffExtensionFactory(): Promise<ExtensionFactory | null> {
  return async pi => {
    if (!isHostPluginEnabled("@ff-labs/pi-fff")) return;
    return (await loadHostFffExtensionFactory())(pi);
  };
}

async function loadHostFffExtensionFactory(): Promise<ExtensionFactory> {
  const packageRoot = join(dirname(dirname(codingAgent.getPackageDir())), "@ff-labs", "pi-fff");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
  if (manifest.name !== "@ff-labs/pi-fff" || manifest.version !== "0.11.0") {
    throw new Error(`Pi Web requires @ff-labs/pi-fff@0.11.0, found ${String(manifest.name)}@${String(manifest.version)}`);
  }
  const agentDir = codingAgent.getAgentDir();
  const stateRoot = join(agentDir, "fff");
  mkdirSync(stateRoot, { recursive: true });
  const environment = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_FFF_MODE: "override",
    FFF_FRECENCY_DB: join(stateRoot, "frecency"),
    FFF_HISTORY_DB: join(stateRoot, "history"),
  };
  const virtualModules = {
    "@earendil-works/pi-coding-agent": codingAgent,
    "@earendil-works/pi-tui": tui,
    "@sinclair/typebox": typebox,
  };
  const compiler = createJiti(import.meta.url, { moduleCache: false, fsCache: false, virtualModules, tryNative: false });
  const loader = createJiti(import.meta.url, {
    moduleCache: false, fsCache: false, virtualModules, tryNative: false,
    transform(options) {
      const filename = options.filename?.replace(/\\/gu, "/").toLocaleLowerCase("en-US") ?? "";
      const owner = packageRoot.replace(/\\/gu, "/").toLocaleLowerCase("en-US");
      const prelude = filename.startsWith(`${owner}/`)
        ? `import hostProcess from "node:process";\nconst process = Object.assign(Object.create(hostProcess), { env: Object.assign(Object.create(hostProcess.env), ${JSON.stringify(environment)}) });\n`
        : "";
      return { code: compiler.transform({ ...options, source: `${prelude}${options.source}` }) };
    },
  });
  const entry = join(packageRoot, "src", "index.ts");
  const factory = await loader.import(entry, { default: true });
  if (typeof factory !== "function") throw new Error(`Pi Web search extension does not export a factory: ${entry}`);
  return factory as ExtensionFactory;
}
