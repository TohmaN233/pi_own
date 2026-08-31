import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../eval/mode-pack/checkpoint.json', import.meta.url), 'utf8'),
);

test('Mode Pack evaluation manifest is closed, uniquely identified, and evidence-layered', () => {
  assert.deepEqual(Object.keys(manifest).sort(), ['baseCommit', 'cases', 'checkpoint', 'levels', 'version']);
  assert.equal(manifest.version, 1);
  assert.match(manifest.baseCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(manifest.levels).sort(), ['browserE2E', 'deterministic', 'modelQuality']);
  assert.ok(Array.isArray(manifest.cases));
  assert.ok(manifest.cases.length >= 15);
  const ids = new Set();
  for (const entry of manifest.cases) {
    assert.deepEqual(Object.keys(entry).sort(), ['claim', 'id', 'level', 'status']);
    assert.match(entry.id, /^[a-z]+-[0-9]{3}$/);
    assert.equal(ids.has(entry.id), false, `duplicate case ${entry.id}`);
    ids.add(entry.id);
    assert.ok(Object.hasOwn(manifest.levels, entry.level));
    assert.ok(entry.status === 'implemented' || entry.status === 'future');
    assert.equal(typeof entry.claim, 'string');
    assert.ok(entry.claim.length >= 20);
  }
});

test('unimplemented browser/model claims remain future rather than inheriting deterministic PASS', () => {
  for (const entry of manifest.cases) {
    if (entry.level !== 'deterministic') assert.equal(entry.status, 'future', entry.id);
  }
});

test('the manifest does not overclaim live Mode Pack activation or Teacher split', () => {
  assert.equal(manifest.cases.find((entry) => entry.id === 'wire-002').status, 'future');
  assert.equal(manifest.cases.find((entry) => entry.id === 'wire-003').status, 'future');
  assert.equal(manifest.cases.find((entry) => entry.id === 'teacher-001').status, 'future');
});
