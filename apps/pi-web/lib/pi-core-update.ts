import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isNewerStableVersion } from "./app-update.ts";

const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
export const PI_CORE_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
}

interface PackageLockEntry {
  version?: string;
  integrity?: string;
  resolved?: string;
}

interface PackageLock {
  packages?: Record<string, PackageLockEntry>;
}

interface CodeModePackageManifest {
  packages?: Array<{
    package?: string;
    version?: string;
    integrity?: string;
    tarball?: string;
  }>;
}

export interface PiCoreInstallResult {
  previousVersion: string;
  currentVersion: string;
  updated: boolean;
  restartRequired: boolean;
  bundledCodeRuntimeUpdated: boolean;
}

export type PiCoreCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

function isStableVersion(version: string): boolean {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return false;
  return match.slice(1).every((part) => Number.isSafeInteger(Number(part)));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function isPiWebPackageDirectory(path: string): boolean {
  const packagePath = join(path, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    return readJson<PackageManifest>(packagePath).name === "@agegr/pi-web";
  } catch {
    return false;
  }
}

export function locatePiWebPackageDirectory(start = process.cwd()): string {
  const candidates = [
    process.env.PI_WEB_PACKAGE_DIR,
    start,
    join(start, "apps", "pi-web"),
    resolve(start, ".."),
    resolve(start, "..", "apps", "pi-web"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of new Set(candidates.map((value) => resolve(value)))) {
    if (isPiWebPackageDirectory(candidate)) return candidate;
  }
  throw new Error(`Cannot locate the @agegr/pi-web package from ${resolve(start)}`);
}

export function getPiCoreReleaseUrl(version: string): string | null {
  if (!isStableVersion(version)) return null;
  return `https://github.com/earendil-works/pi/releases/tag/v${version}`;
}

export function buildPiCoreInstallArgs(version: string): string[] {
  if (!isStableVersion(version)) throw new Error(`Invalid stable Pi core version: ${version}`);
  return ["install", "--ignore-scripts", "--save-exact", ...PI_CORE_PACKAGES.map((name) => `${name}@${version}`)];
}

export function readPiCoreDependencyVersion(appDirectory: string): string {
  const manifestPath = join(appDirectory, "package.json");
  const manifest = readJson<PackageManifest>(manifestPath);
  if (manifest.name !== "@agegr/pi-web") throw new Error(`Unexpected package at ${manifestPath}`);
  const versions = PI_CORE_PACKAGES.map((name) => manifest.dependencies?.[name]);
  if (versions.some((version) => !version || !isStableVersion(version))) {
    throw new Error("Pi core dependencies must all use exact stable versions");
  }
  if (new Set(versions).size !== 1) {
    throw new Error(`Pi core dependency versions have drifted: ${versions.join(", ")}`);
  }
  return versions[0]!;
}

function npmCliPath(): string {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Cannot locate npm-cli.js for the Pi core update");
  return found;
}

const runCommand: PiCoreCommandRunner = (executable, args, options) => new Promise((resolvePromise, rejectPromise) => {
  execFile(executable, [...args], {
    cwd: options.cwd,
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) {
      rejectPromise(new Error([
        `Command failed: ${executable} ${args.join(" ")}`,
        stderr.trim(),
        stdout.trim(),
      ].filter(Boolean).join("\n"), { cause: error }));
      return;
    }
    resolvePromise({ stdout, stderr });
  });
});

function verifyInstalledPiCore(appDirectory: string, version: string): PackageLockEntry {
  const declared = readPiCoreDependencyVersion(appDirectory);
  if (declared !== version) throw new Error(`Pi dependency update wrote ${declared}, expected ${version}`);
  const lock = readJson<PackageLock>(join(appDirectory, "package-lock.json"));
  for (const name of PI_CORE_PACKAGES) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry?.version !== version) throw new Error(`Pi lock entry ${name} is ${entry?.version ?? "missing"}, expected ${version}`);
    const installed = readJson<{ version?: string }>(join(appDirectory, "node_modules", name, "package.json"));
    if (installed.version !== version) throw new Error(`Installed ${name} is ${installed.version ?? "missing"}, expected ${version}`);
  }
  const codingAgent = lock.packages?.["node_modules/@earendil-works/pi-coding-agent"];
  if (!codingAgent?.integrity || !codingAgent.resolved) throw new Error("Pi coding-agent lock entry has no verified registry identity");
  return codingAgent;
}

async function synchronizeBundledCodeRuntime(
  appDirectory: string,
  version: string,
  codingAgent: PackageLockEntry,
  runner: PiCoreCommandRunner,
): Promise<boolean> {
  const repository = resolve(appDirectory, "..", "..");
  const packagePinsPath = join(repository, "third_party", "code-mode-packages.json");
  const buildScript = join(repository, "scripts", "build-portable-code-mode-archive.mjs");
  if (!existsSync(packagePinsPath) && !existsSync(buildScript)) return false;
  if (!existsSync(packagePinsPath) || !existsSync(buildScript)) {
    throw new Error("Source checkout has an incomplete bundled Code Mode update path");
  }
  const manifest = readJson<CodeModePackageManifest>(packagePinsPath);
  const pin = manifest.packages?.find((entry) => entry.package === "@earendil-works/pi-coding-agent");
  if (!pin) throw new Error("Bundled Code Mode has no Pi coding-agent runtime pin");
  pin.version = version;
  pin.integrity = codingAgent.integrity;
  pin.tarball = codingAgent.resolved;
  await writeFile(packagePinsPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await runner(process.execPath, [buildScript], { cwd: repository });
  return true;
}

export async function installPiCoreUpdate(options: {
  appDirectory: string;
  version: string;
  runner?: PiCoreCommandRunner;
}): Promise<PiCoreInstallResult> {
  const appDirectory = locatePiWebPackageDirectory(options.appDirectory);
  const previousVersion = readPiCoreDependencyVersion(appDirectory);
  if (options.version === previousVersion) {
    return {
      previousVersion,
      currentVersion: previousVersion,
      updated: false,
      restartRequired: false,
      bundledCodeRuntimeUpdated: false,
    };
  }
  if (!isNewerStableVersion(options.version, previousVersion)) {
    throw new Error(`Refusing Pi core downgrade from ${previousVersion} to ${options.version}`);
  }
  const runner = options.runner ?? runCommand;
  await runner(process.execPath, [npmCliPath(), ...buildPiCoreInstallArgs(options.version)], { cwd: appDirectory });
  const codingAgent = verifyInstalledPiCore(appDirectory, options.version);
  const bundledCodeRuntimeUpdated = await synchronizeBundledCodeRuntime(
    appDirectory,
    options.version,
    codingAgent,
    runner,
  );
  return {
    previousVersion,
    currentVersion: options.version,
    updated: true,
    restartRequired: true,
    bundledCodeRuntimeUpdated,
  };
}

export { isNewerStableVersion };
