import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { packPortableOfflineRuntime, unpackPortableOfflineRuntime } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./portable-mode-offline-runtime.ts");

test("offline npm runtime round-trips exact local bytes without network access", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-own-offline-runtime-"));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  mkdirSync(join(source, "node_modules", "fixture"), { recursive: true });
  mkdirSync(target);
  writeFileSync(join(source, "package.json"), JSON.stringify({ private: true, dependencies: { fixture: "1.0.0" } }));
  writeFileSync(join(source, "package-lock.json"), JSON.stringify({ packages: { "node_modules/fixture": { integrity: "sha512-YQ==" } } }));
  writeFileSync(join(source, "node_modules", "fixture", "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(join(source, "node_modules", "fixture", "index.js"), "export default 'offline';\n");
  const compressed = join(root, "runtime.tar.gz");
  await packPortableOfflineRuntime(source, compressed);
  assert.ok(existsSync(compressed));
  await unpackPortableOfflineRuntime(compressed, target);
  assert.equal(readFileSync(join(target, "node_modules", "fixture", "index.js"), "utf8"), "export default 'offline';\n");
  assert.deepEqual(JSON.parse(readFileSync(join(target, "package-lock.json"), "utf8")), JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8")));
});
