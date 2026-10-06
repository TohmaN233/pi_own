import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPiWebBuildTraces } from "./check-pi-web-build-traces.mjs";

test("build trace gate catches runaway host directory tracing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-build-traces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const route = join(root, "app", "api", "cwd", "route.js.nft.json");
  await mkdir(join(root, "app", "api", "cwd"), { recursive: true });
  await writeFile(route, JSON.stringify({ files: ["../../chunks/1.js", "../../package.json"] }));
  assert.deepEqual(await checkPiWebBuildTraces(root, 2), {
    traces: 1,
    largest: { path: join("app", "api", "cwd", "route.js.nft.json"), files: 2 },
  });
  await assert.rejects(checkPiWebBuildTraces(root, 1), /contains 2 files/u);
  await writeFile(route, JSON.stringify({ files: ["../../../../C:/Users/build/AppData/Local/Temp/private.txt"] }));
  await assert.rejects(checkPiWebBuildTraces(root), /build-host user file/u);
});
