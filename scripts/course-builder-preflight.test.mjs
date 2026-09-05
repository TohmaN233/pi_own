// These tests check only local gate control flow, not product/build success.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const gate = new URL("./verify-course-builder-local.sh", import.meta.url);

test("Course Builder has a local-only pre-submission gate", () => {
  assert.ok(existsSync(gate), "Missing local pre-submission gate");
  const source = readFileSync(gate, "utf8");
  assert.match(source, /set -euo pipefail/);
  assert.match(source, /PI_TEST_XELATEX=1/);
  assert.match(source, /npm run build\nnpm run check/);
  assert.match(source, /npm run check/);
  assert.match(source, /npm run lint/);
  assert.match(source, /npm run build/);
  assert.doesNotMatch(source, /\bgit\s+push\b|\bgh\s+pr\s+merge\b|workflow_dispatch|repository_dispatch/);
});

test("missing Course Builder entrypoint fails before invoking tests, installers or remote commands", () => {
  const root = mkdtempSync(join(tmpdir(), "cb-preflight-negative-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(gate, join(root, "scripts", "verify-course-builder-local.sh"));
    mkdirSync(join(root, "tools"));
    const marker = join(root, "unexpected-command");
    // A command reached here would be a gate defect. No network process is started.
    for (const name of ["node", "npm", "git", "gh"]) {
      writeFileSync(join(root, "tools", name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\nexit 71\n`, { mode: 0o755 });
    }
    const result = spawnSync("bash", [join(root, "scripts", "verify-course-builder-local.sh")], {
      encoding: "utf8", env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing product file: packages\/course-builder-host\/src\/index\.ts/);
    assert.equal(existsSync(marker), false, "An incomplete product tree must never reach external commands");
    assert.doesNotMatch(result.stdout, /LOCAL_GATES_PASSED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
