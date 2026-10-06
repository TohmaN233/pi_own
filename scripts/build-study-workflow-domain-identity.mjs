import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const files=['study-workflow-domain','workflow-domain-data','study-workflow-tasks','study-workflow-admission','study-research-service','study-mode-policy','study-source-bytes','study-source-reader','study-source-preference','path-security','paths'].map(name=>join(root,`apps/pi-web/lib/${name}.ts`));
for(const name of ['study-research-host','harness-core','course-host']){const dir=join(root,`packages/${name}/src`);files.push(...readdirSync(dir).filter(name=>name.endsWith('.ts')).map(name=>join(dir,name)));}
const hash=createHash('sha256');for(const file of files.sort())hash.update(relative(root,file).replaceAll('\\','/')+'\n').update(readFileSync(file,'utf8').replaceAll('\r\n','\n'));
writeFileSync(join(root,'apps/pi-web/lib/study-workflow-domain-identity.ts'),`// Generated from the scoped Study Workflow domain and approved Host source readers.\nexport const STUDY_WORKFLOW_IMPLEMENTATION_SHA256 = ${JSON.stringify(hash.digest('hex'))};\n`);
