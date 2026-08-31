import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  EDUCATION_SKILLS,
  EDUCATION_SKILL_SETS,
} from '../packages/education-mode-host/src/index.ts';
import {
  loadEducationSkill,
  loadEducationSkillSet,
  verifyEducationSkillLoadReceipt,
} from '../packages/education-mode-host/src/skills.ts';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function functionBlock(text, name) {
  const start = text.indexOf(name);
  assert.notEqual(start, -1, `${name} was not found`);
  const open = text.indexOf('{', start);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body did not close`);
}

test('existing grounded publication renderer exposes claim.reason', () => {
  const text = source('apps/pi-web/lib/learning-harness-extension.ts');
  const block = functionBlock(text, 'canonicalMarkdown');
  assert.match(block, /claim\.reason|groundedClaimsToMarkdown/);
});

test('existing Host entry points export Mode Pack contracts and registry', () => {
  assert.match(source('packages/profile-resource-host/src/index.ts'), /export \* from ["']\.\/mode-packs\.ts["']/);
  assert.match(source('packages/learning-harness/src/index.ts'), /export \* from ["']\.\/mode-pack-registry\.ts["']/);
});

test('every accepted education Skill has a file whose frontmatter id and content hash verify', () => {
  for (const id of Object.keys(EDUCATION_SKILLS)) {
    const loaded = loadEducationSkill(id);
    assert.equal(loaded.id, id);
    assert.match(loaded.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(loaded.body.length > 100);
  }
});

test('required and optional education Skill sets issue reproducible load receipts', () => {
  for (const resources of Object.values(EDUCATION_SKILL_SETS)) {
    const loaded = loadEducationSkillSet(resources, { loadedAt: '2026-08-31T13:00:00.000Z' });
    verifyEducationSkillLoadReceipt(resources, loaded.receipt);
    assert.deepEqual(
      loaded.required.map((skill) => skill.id),
      resources.required,
    );
  }
});

test('custom Mode Pack UI and write API are present and distinguish preview from activation', () => {
  const page = source('apps/pi-web/components/mode-pack-manager.tsx');
  const api = source('apps/pi-web/app/api/mode-packs/route.ts');
  assert.match(page, /不是 Runtime 激活回执/);
  assert.match(page, /发布新版本/);
  assert.match(api, /CROSS_ORIGIN_REQUEST_REFUSED/);
  assert.match(api, /MAX_BODY_BYTES/);
});
