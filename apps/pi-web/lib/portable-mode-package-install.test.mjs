import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
const { bundledCodeModePackage } = await jiti.import("./bundled-code-mode-package.ts");
const { ensurePortableModePackageInstalled, invalidatePortableRuntimeVerification, portablePackageRuntimeDirectory, resolvePortableNpmInvocation } = await jiti.import("./portable-mode-package-install.ts");

test("resolves a packaged POSIX npm executable without npm_execpath", { skip: process.platform === "win32" }, (t) => {
  const root = join(tmpdir(), `pi-own-npm-path-${Date.now()}`);
  const bin = join(root, "bin"); const npm = join(bin, "npm");
  mkdirSync(bin, { recursive: true }); writeFileSync(npm, "#!/bin/sh\nexit 0\n"); chmodSync(npm, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(resolvePortableNpmInvocation({ environment: { PATH: bin }, platform: "linux", executablePath: join(root, "node", "bin", "node") }), { command: npm, prefix: [] });
});

test("portable installer publishes and repairs independent zero-npm selections", { concurrency: false }, async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR; const root = join(tmpdir(), `pi-own-installer-${Date.now()}`); process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const archive = bundledCodeModePackage();
  const first = { resources: [{ kind: "skill", id: "grill-me", enabled: true }] };
  const second = { resources: [{ kind: "skill", id: "incremental-implementation", enabled: true }] };
  const legacyIdentity = contentHash({ packageContentHash: archive.packageContentHash, dependencies: [] }).slice("sha256:".length);
  const legacyDirectory = join(root, "mode-packs", "runtimes", legacyIdentity);
  assert.equal(dirname(resolve(legacyDirectory)), resolve(root, "mode-packs", "runtimes"));
  mkdirSync(legacyDirectory, { recursive: true });
  assert.equal(portablePackageRuntimeDirectory(archive, first), legacyDirectory, "an existing archive runtime stays in place during the shared-cache migration");
  rmSync(legacyDirectory, { recursive: true, force: true });
  const firstDir = portablePackageRuntimeDirectory(archive, first); const secondDir = portablePackageRuntimeDirectory(archive, second);
  assert.equal(firstDir, secondDir, "selections with no npm dependencies share the empty immutable runtime identity");
  await ensurePortableModePackageInstalled(archive, first);
  assert.ok(existsSync(join(firstDir, ".portable-install.json")));
  assert.deepEqual(JSON.parse(readFileSync(join(firstDir, ".portable-install.json"), "utf8")).dependencies, []);
  writeFileSync(join(firstDir, ".portable-install.json"), "not json");
  await ensurePortableModePackageInstalled(archive, first);
  assert.deepEqual(JSON.parse(readFileSync(join(firstDir, ".portable-install.json"), "utf8")).dependencies, [], "corrupt marker is repaired atomically");
  await ensurePortableModePackageInstalled(archive, second);
  assert.ok(existsSync(join(secondDir, ".portable-install.json")));
});

test("generic npm selections use isolated runtimes and repair tampered entry bytes", { concurrency: false }, async (t) => {
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, npm: process.env.npm_execpath };
  const root = join(tmpdir(), `pi-own-installer-npm-${Date.now()}`);
  const fakeNpm = join(root, "fake-npm.cjs");
  mkdirSync(root, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(fakeNpm, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `fs.appendFileSync(${JSON.stringify(join(root, "installs.log"))}, "install\\n");`,
    'const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));',
    'const packages = {};',
    'for (const [name, version] of Object.entries(pkg.dependencies)) {',
    '  const dir = path.join(process.cwd(), "node_modules", name); fs.mkdirSync(dir, { recursive: true });',
    '  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version })); fs.writeFileSync(path.join(dir, "index.js"), `${name}@${version}`); fs.mkdirSync(path.join(dir, "src")); fs.writeFileSync(path.join(dir, "src", "implementation.js"), `${name}@${version}:implementation`);',
    '  packages[`node_modules/${name}`] = { integrity: name === "fixture-a" ? "sha512-YQ==" : "sha512-Yg==" };',
    '}',
    'fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), JSON.stringify({ packages }));',
  ].join("\n"));
  process.env.npm_execpath = fakeNpm;
  t.after(() => { if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent; if (previous.npm === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous.npm; rmSync(root, { recursive: true, force: true }); });
  const archive = {
    packageContentHash: `sha256:${"a".repeat(64)}`,
    files: [],
    resources: [
      { kind: "extension", id: "fixture.a", source: { type: "npm", package: "fixture-a", version: "1.0.0", integrity: "sha512-YQ==", entries: ["index.js"] } },
      { kind: "extension", id: "fixture.b", source: { type: "npm", package: "fixture-b", version: "2.0.0", integrity: "sha512-Yg==", entries: ["index.js"] } },
    ],
  };
  const first = { resources: [{ kind: "extension", id: "fixture.a", enabled: true }, { kind: "extension", id: "fixture.b", enabled: false }] };
  const second = { resources: [{ kind: "extension", id: "fixture.a", enabled: false }, { kind: "extension", id: "fixture.b", enabled: true }] };
  const firstDir = await ensurePortableModePackageInstalled(archive, first);
  const secondDir = await ensurePortableModePackageInstalled(archive, second);
  assert.notEqual(firstDir, secondDir, "optional selection has its own private runtime identity");
  assert.equal(readFileSync(join(firstDir, "node_modules", "fixture-a", "index.js"), "utf8"), "fixture-a@1.0.0");
  const installsBeforeMetadataTouch = readFileSync(join(root, "installs.log"), "utf8").trim().split("\n").length;
  const touched = new Date(Date.now() + 5_000);
  utimesSync(join(firstDir, "node_modules", "fixture-a", "index.js"), touched, touched);
  invalidatePortableRuntimeVerification(firstDir);
  await ensurePortableModePackageInstalled(archive, first);
  assert.equal(readFileSync(join(root, "installs.log"), "utf8").trim().split("\n").length, installsBeforeMetadataTouch, "metadata-only drift refreshes the marker without reinstalling identical bytes");
  writeFileSync(join(firstDir, "node_modules", "fixture-a", "src", "implementation.js"), "tampered");
  invalidatePortableRuntimeVerification(firstDir);
  await ensurePortableModePackageInstalled(archive, first);
  assert.equal(readFileSync(join(firstDir, "node_modules", "fixture-a", "src", "implementation.js"), "utf8"), "fixture-a@1.0.0:implementation", "marker verification detects and repairs changed package implementation bytes");
  rmSync(firstDir, { recursive: true, force: true });
  const completedInstalls = readFileSync(join(root, "installs.log"), "utf8").trim().split("\n").length;
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    ensurePortableModePackageInstalled(archive, first),
    ensurePortableModePackageInstalled(archive, first),
  ]);
  assert.equal(concurrentFirst, concurrentSecond);
  assert.equal(readFileSync(join(root, "installs.log"), "utf8").trim().split("\n").length, completedInstalls + 1, "the second session waits for the existing install transaction");

  const sharedDependency = {
    ...archive,
    packageContentHash: `sha256:${"b".repeat(64)}`,
    resources: [
      { kind: "skill", id: "fixture.shared.one", source: { type: "bundled", path: "resources/one.md" }, runtimeDependencies: [{ package: "fixture-a", version: "1.0.0", integrity: "sha512-YQ==", entries: ["index.js"] }] },
      { kind: "skill", id: "fixture.shared.two", source: { type: "bundled", path: "resources/two.md" }, runtimeDependencies: [{ package: "fixture-a", version: "1.0.0", integrity: "sha512-YQ==", entries: ["index.js"] }] },
    ],
  };
  const sharedDir = await ensurePortableModePackageInstalled(sharedDependency, {
    resources: [{ kind: "skill", id: "fixture.shared.one", enabled: true }, { kind: "skill", id: "fixture.shared.two", enabled: true }],
  });
  assert.equal(sharedDir, firstDir, "different mode archives reuse a shared component only when its exact version and integrity match");
  assert.equal(readFileSync(join(sharedDir, "node_modules", "fixture-a", "index.js"), "utf8"), "fixture-a@1.0.0", "identical selected runtime pins install once");
  const conflictingDependency = {
    ...sharedDependency,
    packageContentHash: `sha256:${"c".repeat(64)}`,
    resources: [
      ...sharedDependency.resources.slice(0, 1),
      { kind: "skill", id: "fixture.shared.conflict", source: { type: "bundled", path: "resources/conflict.md" }, runtimeDependencies: [{ package: "fixture-a", version: "2.0.0", integrity: "sha512-YQ==", entries: ["index.js"] }] },
    ],
  };
  await assert.rejects(
    ensurePortableModePackageInstalled(conflictingDependency, {
      resources: [{ kind: "skill", id: "fixture.shared.one", enabled: true }, { kind: "skill", id: "fixture.shared.conflict", enabled: true }],
    }),
    /runtime dependency conflicts: fixture-a/u,
  );
});

test("integrity accepts an internal npm .bin symlink and still detects changed targets", { skip: process.platform === "win32" }, async (t) => {
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, npm: process.env.npm_execpath };
  const root = join(tmpdir(), `pi-own-installer-symlink-${Date.now()}`); const fakeNpm = join(root, "fake-npm.cjs");
  mkdirSync(root, { recursive: true }); process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(fakeNpm, [
    'const fs=require("node:fs"),path=require("node:path"); fs.appendFileSync(' + JSON.stringify(join(root, "installs.log")) + ', "install\\n"); const pkg=JSON.parse(fs.readFileSync(path.join(process.cwd(),"package.json"),"utf8")); const packages={};',
    'for(const [name,version] of Object.entries(pkg.dependencies)){const dir=path.join(process.cwd(),"node_modules",name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name,version}));fs.writeFileSync(path.join(dir,"index.js"),`${name}@${version}`);packages[`node_modules/${name}`]={integrity:"sha512-YQ=="};}',
    'fs.mkdirSync(path.join(process.cwd(),"node_modules",".bin"),{recursive:true});fs.symlinkSync("../fixture-link/index.js",path.join(process.cwd(),"node_modules",".bin","fixture-link"));fs.writeFileSync(path.join(process.cwd(),"package-lock.json"),JSON.stringify({packages}));',
  ].join("\n")); process.env.npm_execpath = fakeNpm;
  t.after(() => { if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent; if (previous.npm === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = previous.npm; rmSync(root, { recursive: true, force: true }); });
  const archive = { packageContentHash: `sha256:${"d".repeat(64)}`, files: [], resources: [{ kind: "extension", id: "fixture.link", source: { type: "npm", package: "fixture-link", version: "1.0.0", integrity: "sha512-YQ==", entries: ["index.js"] } }] };
  const selection = { resources: [{ kind: "extension", id: "fixture.link", enabled: true }] };
  const target = await ensurePortableModePackageInstalled(archive, selection);
  assert.ok(existsSync(join(target, "node_modules", ".bin", "fixture-link")));
  assert.equal(readFileSync(join(root, "installs.log"), "utf8").trim().split("\n").length, 1);
  await ensurePortableModePackageInstalled(archive, selection);
  assert.equal(readFileSync(join(root, "installs.log"), "utf8").trim().split("\n").length, 1, "a published .bin symlink runtime remains valid on a warm activation");
  writeFileSync(join(target, "node_modules", "fixture-link", "index.js"), "tampered");
  invalidatePortableRuntimeVerification(target);
  await ensurePortableModePackageInstalled(archive, selection);
  assert.equal(readFileSync(join(target, "node_modules", "fixture-link", "index.js"), "utf8"), "fixture-link@1.0.0");
});
