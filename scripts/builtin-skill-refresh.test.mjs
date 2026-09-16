import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';

test('new catalogs read edited built-in Skills while prior snapshots stay immutable',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-skill-refresh-'));
 const original=process.env.PI_SKILLS_DIR;
 try {
  cpSync(resolve('skills'),root,{recursive:true});
  process.env.PI_SKILLS_DIR=root;
  const module=await import('../packages/profile-resource-host/src/index.ts');
  const id='teacher.course-planning-beamer';
  const before=module.createDefaultResourceCatalog().get('skill',id);
  const frozen=module.BUILTIN_MODE_RESOURCES.find(item=>item.id===id);
  const path=join(root,'course-planning-beamer','SKILL.md');
  const changed=readFileSync(path,'utf8')+'\nFresh skill instruction for hot-update regression.\n';
  writeFileSync(path,changed);
  const after=module.createDefaultResourceCatalog().get('skill',id);
  assert.notEqual(after.contentHash,before.contentHash,'new catalog must not reuse the import-time Skill hash');
  const fresh=module.createBuiltinModeResources().find(item=>item.id===id);
  assert.equal(fresh.instructions.join('\n\n'),changed);
  assert.equal(frozen.contentHash,before.contentHash);
  assert.equal(after.contentHash,fresh.contentHash);
  writeFileSync(path,'   ');
  assert.throws(()=>module.createDefaultResourceCatalog(),/empty/);
  rmSync(path);
  assert.throws(()=>module.createDefaultResourceCatalog(),/missing/);
 } finally {
  if(original===undefined)delete process.env.PI_SKILLS_DIR;else process.env.PI_SKILLS_DIR=original;
  assert.ok(resolve(root).startsWith(resolve(tmpdir())));
  rmSync(root,{recursive:true,force:true});
 }
});
