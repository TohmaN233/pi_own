import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sdkDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const sdkPackage = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));

test("SDK resolves repaired dependencies and exposes upstream unbundled entrypoints", () => {
  const requireSdk = createRequire(join(sdkDir, "package.json"));
  assert.equal(requireSdk("undici/package.json").version, "8.11.2");
  const requireMinimatch = createRequire(requireSdk.resolve("minimatch"));
  assert.equal(requireMinimatch("brace-expansion/package.json").version, "5.0.12");
  assert.equal(sdkPackage.bin.pi, "dist/cli.js");
  assert.equal(sdkPackage.exports["./rpc-entry"].import, "./dist/rpc-entry.js");
  assert.equal(existsSync(join(sdkDir, "dist/bundle")), false);
  assert.match(readFileSync(join(sdkDir, "LICENSE"), "utf8"), /Copyright \(c\) 2025 Mario Zechner/);
});

test("SDK CLI and RPC load a TypeScript extension through the upstream SDK alias", { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sdk-security-smoke-"));
  let child;
  let closed;
  let lines;
  t.after(async () => {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    rmSync(directory, { recursive: true, force: true });
  });
  const environment = {
    PATH: process.env.PATH,
    ...Object.fromEntries(["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]])),
    USERPROFILE: directory,
    HOME: directory,
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    ANTHROPIC_API_KEY: "offline-sdk-smoke-invalid-key",
  };
  const fixture = join(directory, "extension.ts");
  writeFileSync(fixture, `
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("sdk-security-smoke", {
    description: getAgentDir(),
    handler: async () => { throw new Error("Smoke command must never invoke a model"); },
  });
}
`);
  const baseArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes"];
  const runCli = async (flag) => {
    const child = spawn(process.execPath, [join(sdkDir, sdkPackage.bin.pi), flag], { cwd: directory, env: environment, timeout: 40_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    return stdout;
  };
  assert.equal((await runCli("--version")).trim(), sdkPackage.version);
  assert.match(await runCli("--help"), /--mode/);
  child = spawn(process.execPath, [
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
    ...baseArgs, "--extension", fixture,
  ], { cwd: directory, env: environment });
  closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  lines = createInterface({ input: child.stdout });
  const responses = new Map();
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`SDK RPC smoke timeout: ${stderr}`)), 40_000);
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.id === "state" || value.id === "commands") responses.set(value.id, value);
        if (responses.size === 2) { clearTimeout(timeout); resolve(); }
      } catch (error) { clearTimeout(timeout); reject(error); }
    });
    closed.then(([code]) => {
      clearTimeout(timeout);
      if (responses.size !== 2) reject(new Error(`SDK RPC exited ${code}: ${stderr}`));
    }, reject);
  });
  child.stdin.write(`${JSON.stringify({ type: "get_state", id: "state" })}\n`);
  child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "commands" })}\n`);
  await received;
  assert.equal(responses.get("state").success, true);
  assert.equal(responses.get("state").data.isStreaming, false);
  assert.equal(responses.get("commands").success, true);
  assert.ok(responses.get("commands").data.commands.some((command) =>
    command.name === "sdk-security-smoke" && command.source === "extension" && command.description === environment.PI_CODING_AGENT_DIR),
  `SDK extension import/registration failed: ${stderr}`);
});
