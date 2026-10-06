import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export const SPEC_KIT_COMMANDS = ["speckit.specify", "speckit.plan", "speckit.tasks", "speckit.implement", "speckit.clarify", "speckit.analyze", "speckit.checklist", "speckit.converge", "speckit.constitution", "speckit.taskstoissues"] as const;
const execFileAsync = promisify(execFile);

export interface SpecKitStatus {
  /** `partial` is deliberately not initializable: explicit repair is safer than overwriting it. */
  state: "ready" | "uninitialized" | "partial";
  initialized: boolean;
  commands: string[];
  missingCommands: string[];
  promptDirectory: string;
}

export function inspectSpecKit(cwd: string): SpecKitStatus {
  const promptDir = join(resolve(cwd), ".pi", "prompts");
  const commands = SPEC_KIT_COMMANDS.filter((name) => existsSync(join(promptDir, `${name}.md`)));
  const missingCommands = SPEC_KIT_COMMANDS.filter((name) => !commands.includes(name));
  const initialized = existsSync(join(resolve(cwd), ".specify")) && missingCommands.length === 0;
  return {
    state: initialized ? "ready" : (existsSync(join(resolve(cwd), ".specify")) || commands.length > 0 ? "partial" : "uninitialized"),
    initialized,
    commands: [...commands],
    missingCommands: [...missingCommands],
    promptDirectory: promptDir,
  };
}

export async function initializeSpecKit(cwd: string): Promise<ReturnType<typeof inspectSpecKit>> {
  const root = resolve(cwd);
  const promptDir = join(root, ".pi", "prompts");
  if (existsSync(join(root, ".specify")) || (existsSync(promptDir) && readdirSync(promptDir).some((name) => name.startsWith("speckit.")))) throw new Error("Spec Kit is already initialized; resolve existing files instead of overwriting them.");
  const uvx = process.platform === "win32" ? "uvx.exe" : "uvx";
  await execFileAsync(uvx, ["--from", "specify-cli==1.0.5", "specify", "init", "--here", "--integration", "pi", "--script", process.platform === "win32" ? "ps" : "sh", "--ignore-agent-tools", "--non-interactive", "--force"], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const status = inspectSpecKit(root);
  if (!status.initialized) throw new Error(`Spec Kit initialization was incomplete; missing ${status.missingCommands.join(", ")}`);
  return status;
}
