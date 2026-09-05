#!/usr/bin/env bash
# Local checks only. This script never publishes, dispatches Actions, or merges.
# Run from a normal checkout after installing the lockfile-pinned dependencies.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

required=(
  packages/course-builder-host/src/index.ts
  packages/course-builder-host/src/host.ts
  packages/course-builder-host/src/types.ts
  packages/course-builder-host/src/beamer.ts
  packages/course-builder-host/src/commands.ts
  packages/course-builder-host/src/pptx.ts
  packages/learning-harness/src/index.ts
  apps/pi-web/app/course-builder/page.tsx
  apps/pi-web/app/api/course-builder/route.ts
  apps/pi-web/app/api/course-builder/import/route.ts
  apps/pi-web/app/api/course-builder/export/route.ts
  apps/pi-web/lib/course-builder-extension.ts
  apps/pi-web/lib/course-builder-service.ts
  apps/pi-web/lib/course-builder-defaults.ts
  apps/pi-web/lib/course-builder.test.mjs
  scripts/course-builder-host.test.mjs
  scripts/course-builder-integration.test.mjs
  scripts/course-builder-pptx.test.mjs
  third_party/noi1r-beamer-skill/LICENSE
  docs/COURSE_BUILDER.md
)
for path in "${required[@]}"; do
  if [[ ! -s "$path" ]]; then
    printf 'Missing product file: %s\n' "$path" >&2
    exit 1
  fi
done

# Report all missing direct packages together instead of a succession of remote failures.
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const errors = [];
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) errors.push(`Node >=22.19.0 required; actual ${process.versions.node}`);
for (const directory of ['.', 'apps/pi-web']) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const expected = lock.packages[`node_modules/${name}`]?.version;
    try {
      const installed = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
      if (!expected || installed.version !== expected) errors.push(`${directory}: ${name}: expected ${expected ?? 'lockfile entry'}, actual ${installed.version}`);
    } catch { errors.push(`${directory}: ${name}: locked dependency not installed`); }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  console.error('Local prerequisites failed. No build, publishing or merge was attempted.');
  process.exit(1);
}
JS

tex="${PI_XELATEX_PATH:-xelatex}"
command -v "$tex" >/dev/null || { printf 'XeLaTeX unavailable: %s\n' "$tex" >&2; exit 1; }
"$tex" --version

# The missing-entry regression imports executable code; it is not a filename-only gate.
PI_TEST_XELATEX=1 node --experimental-strip-types --test scripts/course-builder*.test.mjs
npm run build
npm run check
bash ./test.sh
(
  cd apps/pi-web
  node node_modules/typescript/bin/tsc --noEmit
  npm run lint
  npm test
  npm run build
)
git diff --check
printf '\nLOCAL_GATES_PASSED: local checks completed; remote state has not been changed.\n'
