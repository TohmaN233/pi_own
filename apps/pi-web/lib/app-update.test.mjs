import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getPiWebReleaseUrl, isNewerStableVersion } = await jiti.import("./app-update.ts");

test("manual Pi Web update check bypasses cached status and reports upstream errors", async () => {
  const routeJiti = createJiti(import.meta.url, { alias: { "@": resolve(dirname(fileURLToPath(import.meta.url)), "..") } });
  const previousVersion = process.env.NEXT_PUBLIC_APP_VERSION;
  const previousSkip = process.env.PI_WEB_SKIP_VERSION_CHECK;
  const originalFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_APP_VERSION = "0.8.11";
  delete process.env.PI_WEB_SKIP_VERSION_CHECK;
  delete globalThis.__piWebAppUpdateCache;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 3) throw new Error("registry unavailable");
    return new Response(JSON.stringify({ version: calls === 1 ? "0.8.11" : "0.8.12" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const { GET } = await routeJiti.import("../app/api/app-update/route.ts");
    const cached = await GET(new Request("http://localhost/api/app-update"));
    const refreshed = await GET(new Request("http://localhost/api/app-update?refresh=1"));
    const failed = await GET(new Request("http://localhost/api/app-update?refresh=1"));
    assert.equal((await cached.json()).updateAvailable, false);
    assert.equal((await refreshed.json()).updateAvailable, true);
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /registry unavailable/u);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__piWebAppUpdateCache;
    if (previousVersion === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION; else process.env.NEXT_PUBLIC_APP_VERSION = previousVersion;
    if (previousSkip === undefined) delete process.env.PI_WEB_SKIP_VERSION_CHECK; else process.env.PI_WEB_SKIP_VERSION_CHECK = previousSkip;
  }
});

test("detects newer stable Pi Web versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("builds a release-notes URL only for stable versions", () => {
  assert.equal(
    getPiWebReleaseUrl("0.8.8"),
    "https://github.com/agegr/pi-web/releases/tag/v0.8.8",
  );
  assert.equal(getPiWebReleaseUrl("0.8.8-beta.1"), null);
});
