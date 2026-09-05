// PR #7 integration: generated Next.js imports are not authored source.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const script = fileURLToPath(new URL('./check-ts-relative-imports.mjs', import.meta.url));

test('ignore generated Next output while keeping authored .js import rejection', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ts-import-scope-'));
  try {
    mkdirSync(join(cwd, 'apps/web/.next/types'), { recursive: true });
    mkdirSync(join(cwd, 'apps/web/lib'), { recursive: true });
    writeFileSync(join(cwd, 'apps/web/.next/types/route.ts'), 'import x from "../route.js";\n');
    writeFileSync(join(cwd, 'apps/web/lib/ok.ts'), 'import x from "./helper.ts";\n');
    const clean = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    writeFileSync(join(cwd, 'apps/web/lib/bad.ts'), 'import x from "./helper.js";\n');
    const bad = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bad\.ts/);
    assert.doesNotMatch(bad.stderr, /\.next/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
