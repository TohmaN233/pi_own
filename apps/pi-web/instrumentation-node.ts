import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { configureHttpDispatcher } from "./lib/http-dispatcher";

export function registerNodeInstrumentation(): void {
  configureHttpDispatcher();
  console.info("[pi-web] runtime storage", {
    agentDirectory: getAgentDir(),
    harnessDirectory: resolve(process.env.PI_LEARNING_HARNESS_DIR || join(getAgentDir(), "learning-harness")),
  });
}
