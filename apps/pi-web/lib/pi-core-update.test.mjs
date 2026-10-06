import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": appRoot } });
const {
  buildPiCoreInstallArgs,
  getPiCoreReleaseUrl,
  isNewerStableVersion,
  locatePiWebPackageDirectory,
  readPiCoreDependencyVersion,
} = await jiti.import("./pi-core-update.ts");
const previousSkipCheck = process.env.PI_WEB_SKIP_VERSION_CHECK;
const previousPiSkipCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalFetch = globalThis.fetch;

test("builds official Pi release links only for stable versions", () => {
  assert.equal(
    getPiCoreReleaseUrl("0.87.1"),
    "https://github.com/earendil-works/pi/releases/tag/v0.87.1",
  );
  assert.equal(getPiCoreReleaseUrl("0.87.1-rc.1"), null);
  assert.equal(getPiCoreReleaseUrl("not-a-version"), null);
});

test("compares stable Pi core versions numerically", () => {
  assert.equal(isNewerStableVersion("0.87.1", "0.85.1"), true);
  assert.equal(isNewerStableVersion("0.87.1", "0.87.1"), false);
  assert.equal(isNewerStableVersion("0.85.1", "0.87.1"), false);
});

test("builds one exact install command for every Pi core package", () => {
  assert.deepEqual(buildPiCoreInstallArgs("0.99.2"), [
    "install",
    "--ignore-scripts",
    "--save-exact",
    "@earendil-works/pi-agent-core@0.99.2",
    "@earendil-works/pi-ai@0.99.2",
    "@earendil-works/pi-coding-agent@0.99.2",
    "@earendil-works/pi-tui@0.99.2",
  ]);
});

test("serves a cached official release check against the embedded Pi version", async () => {
  delete process.env.PI_WEB_SKIP_VERSION_CHECK;
  delete process.env.PI_SKIP_VERSION_CHECK;
  delete globalThis.__piWebPiCoreUpdateCache;
  const currentVersion = readPiCoreDependencyVersion(locatePiWebPackageDirectory(appRoot));
  const parts = currentVersion.split(".").map(Number);
  const latestVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  let fetchCount = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://pi.dev/api/latest-version");
    fetchCount += 1;
    return new Response(JSON.stringify({ version: latestVersion }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { GET } = await jiti.import("../app/api/pi-core-update/route.ts");
    const request = new Request("http://127.0.0.1:30141/api/pi-core-update");
    const first = await GET(request);
    const second = await GET(request);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      currentVersion,
      latestVersion,
      updateAvailable: true,
      releaseUrl: `https://github.com/earendil-works/pi/releases/tag/v${latestVersion}`,
    });
    assert.equal(second.status, 200);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__piWebPiCoreUpdateCache;
    if (previousSkipCheck === undefined) delete process.env.PI_WEB_SKIP_VERSION_CHECK;
    else process.env.PI_WEB_SKIP_VERSION_CHECK = previousSkipCheck;
    if (previousPiSkipCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previousPiSkipCheck;
  }
});
