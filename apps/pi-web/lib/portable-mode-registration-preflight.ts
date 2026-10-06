import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { PortableModeImportConflictError } from "./portable-mode-import-preflight";
import { portableModePackageDirectory, portableModeTemporaryDirectory } from "./portable-mode-pack-registry";

const execFileAsync = promisify(execFile);
const PROBE_PREFIX = "PI_OWN_REGISTRATION_PROBE:";

function probeScriptPath(): string {
  const candidates = [
    join(process.cwd(), "lib", "portable-registration-probe.mjs"),
    join(process.cwd(), "apps", "pi-web", "lib", "portable-registration-probe.mjs"),
    join(process.cwd(), "runtime", "portable-registration-probe.mjs"),
    join(process.cwd(), "apps", "pi-web", "runtime", "portable-registration-probe.mjs"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Portable registration probe script is missing from the Pi host: ${candidates.join(" or ")}`);
  return found;
}

/** Execute registration factories in a disposable Pi agent directory. Package
 * and exact npm bytes are mounted read-only by convention through directory
 * links; extension-owned mutable state is confined to this directory. */
export async function preflightPortablePublicRegistrations(
  archive: PortableModePackage,
  cwd: string,
  overrides: Readonly<Record<string, { packageContentHash: string; resourceId: string }>> = {},
): Promise<void> {
  if (!archive.resources.some((resource) => resource.kind === "extension")) return;
  const moduleId = archive.moduleId ?? archive.definition.modePackId;
  const temporaryRoot = resolve(portableModeTemporaryDirectory());
  const probeRoot = resolve(temporaryRoot, `registration-probe-${randomUUID()}`);
  if (dirname(probeRoot) !== temporaryRoot || !basename(probeRoot).startsWith("registration-probe-")) {
    throw new Error(`Portable registration probe escaped its temporary root: ${probeRoot}`);
  }
  const agentDir = join(probeRoot, "agent");
  const scopedModePacks = join(agentDir, "mode-packs");
  const packageRoot = dirname(portableModePackageDirectory(archive.packageContentHash));
  const sharedRuntimeRoot = join(dirname(packageRoot), "r");
  const links: string[] = [];
  mkdirSync(scopedModePacks, { recursive: true });
  try {
    for (const [name, source] of [["packages", packageRoot], ["r", sharedRuntimeRoot]] as const) {
      const destination = join(scopedModePacks, name);
      if (existsSync(source)) {
        symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
        links.push(destination);
      } else mkdirSync(destination);
    }
    const scope = `probe.${randomUUID()}`;
    const script = probeScriptPath();
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, portableModePackageDirectory(archive.packageContentHash), cwd, scope, JSON.stringify(overrides)], {
      cwd: dirname(script),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_LEARNING_HARNESS_DIR: join(agentDir, "harness") },
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const line = stdout.split(/\r?\n/u).filter((item) => item.startsWith(PROBE_PREFIX)).at(-1);
    if (!line) throw new Error(`Registration probe returned no signed result; stdout=${stdout.slice(-4000)}; stderr=${stderr.slice(-4000)}`);
    const result = JSON.parse(line.slice(PROBE_PREFIX.length)) as { registrations?: unknown; qualified?: unknown };
    if (!Array.isArray(result.registrations) || !Array.isArray(result.qualified)) throw new Error("Registration probe result is malformed");
    console.info("[mode-pack] public registration preflight passed", { moduleId, extensions: result.registrations.length, qualified: result.qualified.length });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    throw new PortableModeImportConflictError([{ kind: "public-registration", moduleId, diagnostic }]);
  } finally {
    for (const link of links.reverse()) {
      if (!lstatSync(link).isSymbolicLink()) throw new Error(`Portable registration probe link was replaced: ${link}`);
      unlinkSync(link);
    }
    if (existsSync(probeRoot)) rmSync(probeRoot, { recursive: true, force: true });
  }
}
