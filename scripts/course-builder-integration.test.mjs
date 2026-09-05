// Regression for PR #7: never attempt integration with an incomplete product tree.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = [
  'packages/course-builder-host/src/index.ts',
  'packages/course-builder-host/src/host.ts',
  'packages/course-builder-host/src/types.ts',
  'packages/course-builder-host/src/beamer.ts',
  'apps/pi-web/lib/course-builder-service.ts',
  'apps/pi-web/lib/course-builder-extension.ts',
  'apps/pi-web/app/course-builder/page.tsx',
  'apps/pi-web/app/api/course-builder/route.ts',
  'docs/COURSE_BUILDER.md',
  'third_party/noi1r-beamer-skill/LICENSE',
];

test('PR #7: complete Course Builder product tree is present', () => {
  const missing = required.filter(path => !existsSync(resolve(root, path)));
  assert.deepEqual(missing, [], `Missing product files: ${missing.join(', ')}`);
});

test('PR #7: public entry point exports executable Host and compiler', async () => {
  const api = await import('../packages/course-builder-host/src/index.ts');
  assert.equal(typeof api.CourseBuilderHost, 'function');
  assert.equal(typeof api.compileBeamer, 'function');
  assert.equal(typeof api.reviewBeamer, 'function');
});

test('PR #7: UI, API, runtime extension and composition root are wired', () => {
  const read = p => readFileSync(resolve(root, p), 'utf8');
  assert.match(read('packages/learning-harness/src/index.ts'), /CourseBuilderHost/);
  assert.match(read('apps/pi-web/lib/mode-pack-inventory.ts'), /course-builder/);
  assert.match(read('apps/pi-web/app/api/course-builder/route.ts'), /isApiRequestAllowed/);
  assert.match(read('apps/pi-web/app/course-builder/page.tsx'), /api\/course-builder/);
  const extension = read('apps/pi-web/lib/course-builder-extension.ts');
  assert.match(extension, /registerTool/);
  assert.doesNotMatch(extension, /name:\s*['"](?:approve|accept|review_semester|review_lesson)/);
});

// Static UI wiring regression; real browser behavior is a separate build/E2E gate.
test('PR #7: workspace is remounted per Pi session and obsolete refreshes are cancelled', () => {
  const page = readFileSync(resolve(root, 'apps/pi-web/app/course-builder/page.tsx'), 'utf8');
  assert.match(page, /<Workspace\s+key=\{sessionId\}\s+sessionId=\{sessionId\}/);
  assert.match(page, /refreshRequest\.current\?\.abort\(\)/);
  assert.match(page, /signal:\s*request\.signal/);
});
