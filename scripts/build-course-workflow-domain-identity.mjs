import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const packageName of ['course-builder-host', 'course-host', 'harness-core']) {
  const directory = join(repository, `packages/${packageName}/src`);
  files.push(...readdirSync(directory).filter(name => name.endsWith('.ts')).map(name => join(directory, name)));
}
for (const name of ['course-workflow-domain', 'workflow-domain-data', 'course-production-policy', 'course-builder-local-materials', 'course-builder-import', 'course-builder-interactive-visual', 'chat-attachments']) files.push(join(repository, `apps/pi-web/lib/${name}.ts`));
files.sort();
const hash = createHash('sha256');
for (const file of files) hash.update(relative(repository, file).replaceAll('\\', '/') + '\n').update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
const output = join(repository, 'apps/pi-web/lib/course-workflow-domain-identity.ts');
const content = `// Generated from the domain and all Course Builder Host sources. Rebuild before packaging.\nexport const COURSE_WORKFLOW_IMPLEMENTATION_SHA256 = ${JSON.stringify(hash.digest('hex'))};\n`;
if (!existsSync(output) || readFileSync(output, 'utf8') !== content) writeFileSync(output, content);
