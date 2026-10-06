import {
  createBashToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
  createPowerShellToolDefinition,
  getAgentDir,
  type BashOperations,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const HOST_EXTENSION_NAME = "pi-web-project-command-environment";
const HOST_EXTENSION_PATH = `<inline:${HOST_EXTENSION_NAME}>`;
const HOST_POWERSHELL_EXTENSION_NAME = "pi-web-project-command-environment-powershell";

type ProjectShellSettings = {
  getShellCommandPrefix(): string | undefined;
  getShellPath(): string | undefined;
};

type ProjectCommandBashOperationsOptions = {
  agentBinDir?: string;
  runtimeBinDirs?: string[];
  baseEnvironment?: NodeJS.ProcessEnv;
  localOperations?: BashOperations;
  platform?: NodeJS.Platform;
  shellPath?: string;
};

function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName.startsWith("NEXT_");
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}

function withBinDirectories(
  environment: NodeJS.ProcessEnv,
  binDirectories: readonly string[],
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const pathKey = platform === "win32"
    ? Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const currentPath = environment[pathKey] ?? "";
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  const additions = binDirectories.filter((directory) => !pathEntries.includes(directory));
  if (additions.length) {
    environment[pathKey] = [...additions, currentPath].filter(Boolean).join(pathDelimiter);
  }
  return environment;
}

export function createProjectCommandBashOperations(
  options: ProjectCommandBashOperationsOptions = {},
): BashOperations {
  const {
    agentBinDir = join(getAgentDir(), "bin"),
    runtimeBinDirs = [],
    baseEnvironment = process.env,
    localOperations = createLocalBashOperations({ shellPath: options.shellPath }),
    platform = process.platform,
  } = options;

  return {
    exec(command, cwd, executionOptions) {
      const environment = withBinDirectories(
        sanitizeProjectCommandEnvironment(executionOptions.env ?? baseEnvironment, platform),
        [agentBinDir, ...runtimeBinDirs],
        platform,
      );
      return localOperations.exec(command, cwd, {
        ...executionOptions,
        env: environment,
      });
    },
  };
}

/** PowerShell receives the identical command-local environment as Bash. The
 * private runtime bin path is supplied only to the spawned command, never by
 * mutating the web host's process environment. */
export function createProjectCommandPowerShellOperations(
  options: ProjectCommandBashOperationsOptions = {},
): BashOperations {
  const {
    agentBinDir = join(getAgentDir(), "bin"),
    runtimeBinDirs = [],
    baseEnvironment = process.env,
    localOperations = createLocalPowerShellOperations(),
    platform = process.platform,
  } = options;

  return {
    exec(command, cwd, executionOptions) {
      const environment = withBinDirectories(
        sanitizeProjectCommandEnvironment(executionOptions.env ?? baseEnvironment, platform),
        [agentBinDir, ...runtimeBinDirs],
        platform,
      );
      return localOperations.exec(command, cwd, { ...executionOptions, env: environment });
    },
  };
}

export function createProjectCommandBashExtension(options: {
  cwd: string;
  settings: ProjectShellSettings;
  runtimeBinDirs?: string[];
}): InlineExtension {
  return {
    name: HOST_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const displayDefinition = createBashToolDefinition(options.cwd);
      pi.registerTool({
        ...displayDefinition,
        execute(toolCallId, params, signal, onUpdate, context) {
          const executionDefinition = createBashToolDefinition(options.cwd, {
            commandPrefix: options.settings.getShellCommandPrefix(),
            operations: createProjectCommandBashOperations({
              shellPath: options.settings.getShellPath(),
              runtimeBinDirs: options.runtimeBinDirs,
            }),
          });
          return executionDefinition.execute(toolCallId, params, signal, onUpdate, context);
        },
      });
    },
  };
}

/** Register PowerShell only when a selected portable runtime contributes a
 * private executable directory. General and education sessions retain their
 * native shell selection unchanged. It is deliberately separate from Bash:
 * a user Bash override must not discard this unrelated private CLI bridge. */
export function createProjectCommandPowerShellExtension(options: {
  cwd: string;
  runtimeBinDirs: string[];
}): InlineExtension | null {
  if (options.runtimeBinDirs.length === 0) return null;
  return {
    name: HOST_POWERSHELL_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const powerShellDefinition = createPowerShellToolDefinition(options.cwd);
      pi.registerTool({
        ...powerShellDefinition,
        execute(toolCallId, params, signal, onUpdate, context) {
          const executionDefinition = createPowerShellToolDefinition(options.cwd, {
            operations: createProjectCommandPowerShellOperations({
              runtimeBinDirs: options.runtimeBinDirs,
            }),
          });
          return executionDefinition.execute(toolCallId, params, signal, onUpdate, context);
        },
      });
    },
  };
}

export function createProjectCommandExtensions(options: {
  cwd: string;
  settings: ProjectShellSettings;
  runtimeBinDirs?: string[];
}): InlineExtension[] {
  const runtimeBinDirs = options.runtimeBinDirs ?? [];
  const powershell = createProjectCommandPowerShellExtension({ cwd: options.cwd, runtimeBinDirs });
  return [
    createProjectCommandBashExtension({ ...options, runtimeBinDirs }),
    ...(powershell ? [powershell] : []),
  ];
}

export function preferUserBashExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const hostExtensionIndex = base.extensions.findIndex((extension) => extension.path === HOST_EXTENSION_PATH);
  if (hostExtensionIndex < 0) return base;

  const userBashOwner = base.extensions
    .slice(0, hostExtensionIndex)
    .find((extension) => extension.tools.has("bash"));
  if (!userBashOwner) return base;

  return {
    ...base,
    extensions: base.extensions.filter((_, index) => index !== hostExtensionIndex),
    errors: base.errors.filter((error) => !(
      error.path === HOST_EXTENSION_PATH
      && error.error === `Tool "bash" conflicts with ${userBashOwner.path}`
    )),
  };
}
