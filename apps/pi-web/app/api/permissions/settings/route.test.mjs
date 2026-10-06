import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT } = await jiti.import("./route.ts");
const { parsePermissionPolicy, permissionPreset } = await jiti.import("../../../../lib/permission-policy.ts");

test("permission UI persistence rejects malformed rules, concurrent edits and cross-site writes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-permission-ui-"));
  const original = process.env.PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR;
  process.env.PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR = root;
  t.after(() => { if (original === undefined) delete process.env.PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR; else process.env.PI_PERMISSION_SYSTEM_POLICY_AGENT_DIR = original; rmSync(root, { recursive: true, force: true }); });
  const get = () => GET(new Request("http://localhost/api/permissions/settings", { headers: { Host: "localhost" } }));
  const put = (body, headers = {}) => PUT(new Request("http://localhost/api/permissions/settings", { method: "PUT", headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const initial = await (await get()).json();
  const source = JSON.stringify(permissionPreset({}, "read"));
  const request = { scope: "global", source, expectedContentHash: initial.contentHash };
  assert.equal((await put(request)).status, 200);
  assert.equal(parsePermissionPolicy(readFileSync(join(root, "pi-permissions.jsonc"), "utf8")).tools.read, "allow");
  const current = await (await get()).json();
  assert.equal((await put({ ...request, source: '{"tools":{"read":"maybe"}}', expectedContentHash: current.contentHash })).status, 400);
  assert.equal((await put({ ...request, source: "{}" })).status, 409);
  assert.equal((await put(request, { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal(readFileSync(join(root, "pi-permissions.jsonc"), "utf8"), source);
});

test("permission presets retain explicit denials and validation never silently ignores typos", () => {
  const policy = { defaultPolicy: { tools: "deny" }, tools: { "write:*": "deny" }, bash: { "git push*": "deny" }, special: { external_directory: "ask" } };
  const autonomous = permissionPreset(policy, "auto");
  assert.equal(autonomous.defaultPolicy.tools, "deny");
  assert.equal(autonomous.tools["*"], "deny");
  assert.equal(autonomous.tools["write:*"], "deny");
  assert.equal(autonomous.bash["git push*"], "deny");
  assert.equal(autonomous.special.external_directory, "ask");
  assert.throws(() => parsePermissionPolicy('{"toolz":{"read":"allow"}}'), /Unknown permission category/);
  assert.equal(parsePermissionPolicy('{/*comment*/"tools":{"read":"allow",},}').tools.read, "allow");
});
