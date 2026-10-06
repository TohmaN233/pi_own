import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "apps", "pi-web", "runtime", "module-frontends");

test("Course Builder and Study & Research have complete independent frontend trees", () => {
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-portable-module-frontends.mjs")], {
    cwd: root, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const expectations = new Map([
    ["course-builder", ["course-builder", "lesson", "study-assets"]],
    ["study-research", ["study"]],
  ]);
  for (const [moduleId, pages] of expectations) {
    const directory = join(output, moduleId);
    const manifest = JSON.parse(readFileSync(join(directory, "frontend-manifest.json"), "utf8"));
    assert.equal(manifest.format, "pi-own-portable-frontend/v1");
    assert.equal(manifest.moduleId, moduleId);
    assert.deepEqual(Object.keys(manifest.entries), pages);
    const assets = new Set(manifest.assets.map((asset) => asset.path));
    for (const entry of Object.values(manifest.entries)) assert.ok(assets.has(entry));
    for (const asset of manifest.assets) {
      assert.ok(!asset.path.startsWith("/") && !asset.path.split("/").includes(".."));
      const path = join(directory, asset.path);
      assert.ok(existsSync(path), path);
      const bytes = readFileSync(path);
      assert.equal(bytes.byteLength, asset.bytes, asset.path);
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, asset.contentHash, asset.path);
      if (asset.contentEncoding === "gzip") assert.ok(gunzipSync(bytes).byteLength > bytes.byteLength, asset.path);
    }
  }
});
