import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const appRoot = resolve(import.meta.dirname, "..");
const repository = resolve(appRoot, "../..");
const require = createRequire(resolve(appRoot, "package.json"));
const manifest = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8"));

test("all installed official Pi packages match the exact configured core version", () => {
  const names = ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"];
  const expected = manifest.dependencies["@earendil-works/pi-coding-agent"];
  assert.match(expected, /^\d+\.\d+\.\d+$/);
  const pins = JSON.parse(readFileSync(resolve(repository, "third_party/code-mode-packages.json"), "utf8"));
  const codeRuntime = pins.packages.find((entry) => entry.package === "@earendil-works/pi-coding-agent");
  const lock = JSON.parse(readFileSync(resolve(appRoot, "package-lock.json"), "utf8"));
  const installedIdentity = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
  assert.equal(codeRuntime.version, expected, "portable Code runtime must follow the native core update");
  assert.equal(codeRuntime.integrity, installedIdentity.integrity);
  assert.equal(codeRuntime.tarball, installedIdentity.resolved);
  for (const name of names) {
    const fullName = `@earendil-works/${name}`;
    assert.equal(manifest.dependencies[fullName], expected, fullName);
    const installed = JSON.parse(readFileSync(resolve(appRoot, "node_modules", fullName, "package.json"), "utf8"));
    assert.equal(installed.version, expected, fullName);
  }
  const cli = spawnSync(process.execPath, [resolve(appRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "--version"], {
    cwd: appRoot, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`\\b${expected.replaceAll(".", "\\.")}\\b`));
});

test("installed pi-CAW comes from the complete archive named by its provenance", () => {
  const provenance = JSON.parse(readFileSync(resolve(repository, "third_party/pi-caw.json"), "utf8"));
  assert.equal(manifest.dependencies["pi-caw"], `file:host-plugins/pi-caw-${provenance.version}.tgz`);
  const bytes = readFileSync(resolve(repository, provenance.installationArchive));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.archiveSha256);
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, provenance.integrity);
  const installed = JSON.parse(readFileSync(require.resolve("pi-caw/package.json"), "utf8"));
  assert.equal(installed.version, provenance.version);
  assert.ok(readFileSync(resolve(appRoot, "node_modules/pi-caw/extensions/pi-caw.ts"), "utf8").length > 0);
});
