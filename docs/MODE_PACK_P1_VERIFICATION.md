# Mode Pack P1 verification map

## Implemented boundaries

| Boundary | Implementation | Evidence |
| --- | --- | --- |
| Strict generic binding | `packages/mode-pack-host` | malformed hashes, revisions, chains, and idempotency reuse fail closed |
| Persistent custom library | `apps/pi-web/lib/mode-pack-store.ts` | lock, temporary file, fsync, atomic rename, immutable revision check |
| Installed inventory | `apps/pi-web/lib/mode-pack-inventory.ts` | package resources are inventoried before candidate execution and pinned by content hash |
| Real Pi activation | `apps/pi-web/lib/rpc-manager.ts` | selected resources build a new candidate `AgentSession`; no second agent loop |
| Resource deactivation | candidate loader uses `noExtensions/noSkills/noPromptTemplates/noThemes` plus selected paths | unselected package resources are absent rather than merely discouraged |
| Runtime verification | `collectModePackRuntimeEvidence` + `verifyModePackRuntime` | exact active tools, Skills, plugins, prompts, themes, prompt marker, and snapshot hash |
| Transcript commit | `pi-own:mode-pack-binding` custom entries | binding is appended to and recovered from the same Pi JSONL |
| Failure rollback | activation candidate remains outside registry until verified and committed | pre-commit failures reopen the old runtime; post-commit state is recovered on restart |
| Fork recovery | inherited binding creates a child-session binding after candidate verification | parent session id is never adopted as the child binding id |
| User entry | shared overlay and `/mode-packs` editor | built-in selection, custom revisions, resource inspection, activation |

## Required checks

Root repository:

```bash
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

Pi Web:

```bash
npm ci --prefix apps/pi-web --ignore-scripts
apps/pi-web/node_modules/.bin/tsc --noEmit -p apps/pi-web/tsconfig.json
npm run lint --prefix apps/pi-web
npm test --prefix apps/pi-web
npm run build --prefix apps/pi-web
```

The CI workflow contains separate root and Pi Web jobs so a green root build cannot hide a broken Mode Pack editor or runtime adapter.
