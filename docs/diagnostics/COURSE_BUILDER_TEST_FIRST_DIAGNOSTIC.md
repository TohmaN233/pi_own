# Course Builder test-first diagnostic

Run SHA: `c663626f7470d8404ed3483c820c42a8cb2ea609`

## download-source

```text
  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0
100  9.8M  100  9.8M    0     0  58.2M      0 --:--:-- --:--:-- --:--:-- 58.2M
exit=0

```

## unpack-source

```text
exit=0

```

## entry-green

```text
✔ Course Builder package exposes a real importable entrypoint (102.593847ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 184.179565
exit=0

```

## lockfile

```text

up to date, audited 341 packages in 989ms

54 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
exit=0

```

## root-install

```text
npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

added 321 packages, and audited 341 packages in 6s

54 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
exit=0

```

## course-builder-tests

```text
✔ Course Builder package exposes a real importable entrypoint (93.695483ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 207.584539
exit=0

```

## mode-pack-tests

```text
✔ built-in Mode Packs pin prompt, skill, plugin, and workflow identities (34.670928ms)
✔ custom Mode Packs are strictly parsed, content-addressed, and resolved into immutable snapshots (4.933694ms)
✔ Mode Pack compilation and profile safety fail closed (2.286801ms)
✔ missing optional custom components degrade without blocking compilation (0.548865ms)
✔ uninstalled Visual Lab runtime tools remain an explicit availability failure (1.599507ms)
✔ LearningHarness activates and recovers a custom course-bound Mode Pack (103.622918ms)
✔ generic Mode Pack bindings are immutable, chained, recoverable, and runtime-verifiable (320.087714ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 424.801106
exit=0

```

## root-check

```text

> pi-monorepo@0.0.3 check
> biome check --write --error-on-warnings . && npm run check:pinned-deps && npm run check:ts-imports && npm run check:shrinkwrap && npm run check:install-lock:coding-agent && tsgo --noEmit && npm run check:browser-smoke

packages/course-builder-host/src/host.ts:123:9 lint/suspicious/useIterableCallbackReturn ━━━━━━━━━━━

  × This callback passed to forEach() iterable method should not return a value.
  
    121 │ export function assertNoAgentApprovalFields(value: unknown, path = "draft"): void {
    122 │ 	if (Array.isArray(value)) {
  > 123 │ 		value.forEach((item, index) => assertNoAgentApprovalFields(item, `${path}[${index}]`));
        │ 		      ^^^^^^^
    124 │ 		return;
    125 │ 	}
  
  i Either remove this return or remove the returned value.
  
    121 │ export function assertNoAgentApprovalFields(value: unknown, path = "draft"): void {
    122 │ 	if (Array.isArray(value)) {
  > 123 │ 		value.forEach((item, index) => assertNoAgentApprovalFields(item, `${path}[${index}]`));
        │ 		                               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    124 │ 		return;
    125 │ 	}
  

Checked 1139 files in 4s. Fixed 4 files.
Found 1 error.
check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Some errors were emitted while applying fixes.
  

exit=1

```

## root-tests

```text
0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/7443-model-command-cached-match.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/7731-tui-method-wrapping.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/7829-invalid-settings-warning.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/7911-json-stream-usage.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/7925-toolcall-start-metadata.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/8237-node-sea-extension-loading.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/8261-subagent-project-trust.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/8328-zero-usage-auto-compaction.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/8423-extension-factory-failure.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/8537-custom-message-tool-result-ordering.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/8611-thinking-toggle-pending-bash-output.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/extension-factory-cache.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/pre-prompt-compaction-no-continue.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/startup-session-rebind-duplicate-subscription.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A

::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/suite/regressions/tree-during-streaming.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path /home/runner/work/pi_own/pi_own/packages/coding-agent
npm error workspace @earendil-works/pi-coding-agent@0.84.4
npm error location /home/runner/work/pi_own/pi_own/packages/coding-agent
npm error command failed
npm error command sh -c vitest --run


> @earendil-works/pi-evals@0.84.4 test
> vitest run --config vitest.test.config.ts


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.9 [39m[90m/home/runner/work/pi_own/pi_own/packages/evals[39m

 [32m✓[39m test/vitest-evals/summary.test.ts [2m([22m[2m9 tests[22m[2m)[22m[32m 20[2mms[22m[39m
 [32m✓[39m test/vitest-evals/artifacts.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 25[2mms[22m[39m
 [32m✓[39m test/vitest-evals/harness-table.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 17[2mms[22m[39m
 [31m❯[39m test/pi-harness.test.ts [2m([22m[2m0 test[22m[2m)[22m

[31m⎯⎯⎯⎯⎯⎯[39m[1m[41m Failed Suites 1 [49m[22m[31m⎯⎯⎯⎯⎯⎯⎯[39m

[41m[1m FAIL [22m[49m test/pi-harness.test.ts[2m [ test/pi-harness.test.ts ][22m
[31m[1mError[22m: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts[39m
[36m [2m❯[22m ../ai/src/providers/amazon-bedrock.models.ts:[2m4:1[22m[39m
    [90m  2|[39m [90m// Do not edit manually - run 'npm run generate-models' to update[39m
    [90m  3|[39m
    [90m  4|[39m [35mimport[39m values [35mfrom[39m [32m"./data/amazon-bedrock.json"[39m [35mwith[39m { type[33m:[39m [32m"json"[39m }[33m;[39m
    [90m   |[39m [31m^[39m
    [90m  5|[39m import { flattenModelCatalog, type ModelCatalog } from "../model-catal…
    [90m  6|[39m
[90m [2m❯[22m ../ai/src/models.generated.ts:[2m4:1[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯[22m[39m


[2m Test Files [22m [1m[31m1 failed[39m[22m[2m | [22m[1m[32m3 passed[39m[22m[90m (4)[39m
[2m      Tests [22m [1m[32m17 passed[39m[22m[90m (17)[39m
[2m   Start at [22m 01:46:39
[2m   Duration [22m 920ms[2m (transform 422ms, setup 0ms, import 252ms, tests 63ms, environment 1ms)[22m


::error file=/home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts,title=test/pi-harness.test.ts,line=4,column=1::Error: Cannot find module './data/amazon-bedrock.json' imported from /home/runner/work/pi_own/pi_own/packages/ai/src/providers/amazon-bedrock.models.ts%0A ❯ ../ai/src/providers/amazon-bedrock.models.ts:4:1%0A ❯ ../ai/src/models.generated.ts:4:1%0A%0A⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯%0ASerialized Error: { code: 'ERR_MODULE_NOT_FOUND' }%0A
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path /home/runner/work/pi_own/pi_own/packages/evals
npm error workspace @earendil-works/pi-evals@0.84.4
npm error location /home/runner/work/pi_own/pi_own/packages/evals
npm error command failed
npm error command sh -c vitest run --config vitest.test.config.ts


> @earendil-works/pi-protocol@0.84.4 test
> vitest --run


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.9 [39m[90m/home/runner/work/pi_own/pi_own/packages/protocol[39m

[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m

[2m Test Files [22m [1m[32m3 passed[39m[22m[90m (3)[39m
[2m      Tests [22m [1m[32m147 passed[39m[22m[90m (147)[39m
[2m   Start at [22m 01:46:40
[2m   Duration [22m 879ms[2m (transform 249ms, setup 0ms, import 1.22s, tests 531ms, environment 0ms)[22m


> @earendil-works/pi-server@0.84.4 test
> vitest --run


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.9 [39m[90m/home/runner/work/pi_own/pi_own/packages/server[39m

[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m

[31m⎯⎯⎯⎯⎯⎯[39m[1m[41m Failed Suites 3 [49m[22m[31m⎯⎯⎯⎯⎯⎯⎯[39m

[41m[1m FAIL [22m[49m test/conformance.test.ts[2m [ test/conformance.test.ts ][22m
[41m[1m FAIL [22m[49m test/server.test.ts[2m [ test/server.test.ts ][22m
[31m[1mError[22m: Failed to resolve entry for package "@earendil-works/pi-ai". The package may have incorrect main/module/exports specified in its package.json.[39m
[36m [2m❯[22m src/protocol.ts:[2m1:1[22m[39m
    [90m  1|[39m [35mimport[39m {
    [90m   |[39m [31m^[39m
    [90m  2|[39m  type [33mImageContent[39m [35mas[39m [33mAiImageContent[39m[33m,[39m
    [90m  3|[39m  type [33mTextContent[39m [35mas[39m [33mAiTextContent[39m[33m,[39m
[90m [2m❯[22m src/index.ts:[2m3:1[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯[22m[39m

[41m[1m FAIL [22m[49m test/protocol.test.ts[2m [ test/protocol.test.ts ][22m
[31m[1mError[22m: Failed to resolve entry for package "@earendil-works/pi-ai". The package may have incorrect main/module/exports specified in its package.json.[39m
[36m [2m❯[22m src/protocol.ts:[2m1:1[22m[39m
    [90m  1|[39m [35mimport[39m {
    [90m   |[39m [31m^[39m
    [90m  2|[39m  type [33mImageContent[39m [35mas[39m [33mAiImageContent[39m[33m,[39m
    [90m  3|[39m  type [33mTextContent[39m [35mas[39m [33mAiTextContent[39m[33m,[39m
[90m [2m❯[22m test/protocol.test.ts:[2m4:1[22m[39m

[31m[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯[22m[39m


[2m Test Files [22m [1m[31m3 failed[39m[22m[2m | [22m[1m[32m4 passed[39m[22m[90m (7)[39m
[2m      Tests [22m [1m[32m20 passed[39m[22m[90m (20)[39m
[2m   Start at [22m 01:46:41
[2m   Duration [22m 1.55s[2m (transform 420ms, setup 0ms, import 1.41s, tests 468ms, environment 1ms)[22m


::error file=/home/runner/work/pi_own/pi_own/packages/server/src/protocol.ts,title=test/conformance.test.ts,line=1,column=1::Error: Failed to resolve entry for package "@earendil-works/pi-ai". The package may have incorrect main/module/exports specified in its package.json.%0A ❯ src/protocol.ts:1:1%0A ❯ src/index.ts:3:1%0A%0A

::error file=/home/runner/work/pi_own/pi_own/packages/server/src/protocol.ts,title=test/protocol.test.ts,line=1,column=1::Error: Failed to resolve entry for package "@earendil-works/pi-ai". The package may have incorrect main/module/exports specified in its package.json.%0A ❯ src/protocol.ts:1:1%0A ❯ test/protocol.test.ts:4:1%0A%0A

::error file=/home/runner/work/pi_own/pi_own/packages/server/src/protocol.ts,title=test/server.test.ts,line=1,column=1::Error: Failed to resolve entry for package "@earendil-works/pi-ai". The package may have incorrect main/module/exports specified in its package.json.%0A ❯ src/protocol.ts:1:1%0A ❯ src/index.ts:3:1%0A%0A
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path /home/runner/work/pi_own/pi_own/packages/server
npm error workspace @earendil-works/pi-server@0.84.4
npm error location /home/runner/work/pi_own/pi_own/packages/server
npm error command failed
npm error command sh -c vitest --run


> @earendil-works/pi-telemetry@0.84.4 test
> vitest --run


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.9 [39m[90m/home/runner/work/pi_own/pi_own/packages/telemetry[39m

 [32m✓[39m test/telemetry.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 10[2mms[22m[39m
 [32m✓[39m test/conformance.test.ts [2m([22m[2m10 tests[22m[2m)[22m[32m 10[2mms[22m[39m

[2m Test Files [22m [1m[32m2 passed[39m[22m[90m (2)[39m
[2m      Tests [22m [1m[32m15 passed[39m[22m[90m (15)[39m
[2m   Start at [22m 01:46:43
[2m   Duration [22m 239ms[2m (transform 104ms, setup 0ms, import 148ms, tests 21ms, environment 0ms)[22m


> @earendil-works/pi-tui@0.84.4 test
> node --test --test-reporter=dot --test-reporter-destination=stdout test/*.test.ts

....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
....................
..............

> @earendil-works/pi-session-backend-sqlite-node@0.84.4 test
> vitest --run


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.9 [39m[90m/home/runner/work/pi_own/pi_own/packages/session-backends/sqlite-node[39m

[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m[33m[39m[32m·[39m

[2m Test Files [22m [1m[32m11 passed[39m[22m[90m (11)[39m
[2m      Tests [22m [1m[32m87 passed[39m[22m[90m (87)[39m
[2m   Start at [22m 01:46:52
[2m   Duration [22m 3.13s[2m (transform 1.35s, setup 0ms, import 5.91s, tests 1.34s, environment 2ms)[22m

exit=1

```

## root-build

```text

> pi-monorepo@0.0.3 build
> cd packages/tui && npm run build && cd ../telemetry && npm run build && cd ../ai && npm run build && cd ../agent && npm run build && cd ../session-backends/sqlite-node && npm run build && cd ../../protocol && npm run build && cd ../client && npm run build && cd ../server && npm run build && cd ../coding-agent && npm run build


> @earendil-works/pi-tui@0.84.4 build
> tsgo -p tsconfig.build.json


> @earendil-works/pi-telemetry@0.84.4 build
> tsgo -p tsconfig.build.json


> @earendil-works/pi-ai@0.84.4 build
> npm run generate-models && npm run build:offline


> @earendil-works/pi-ai@0.84.4 generate-models
> node scripts/generate-models.ts --strict

Fetching models from models.dev API...
Fetching models from NVIDIA NIM API...
Fetched 81 model IDs from NVIDIA NIM
Loaded 702 tool-capable models from models.dev
Fetching models from OpenRouter API...
Fetched 364 tool-capable models from OpenRouter
Fetching models from Vercel AI Gateway API...
Fetched 237 tool-capable models from Vercel AI Gateway
Generated provider catalogs and src/models.generated.ts
Generated JSON model values under src/providers/data/

Model Statistics:
  Total tool-capable models: 1348
  Reasoning-capable models: 1093
  amazon-bedrock: 121 models
  anthropic: 14 models
  google: 22 models
  google-vertex: 14 models
  openai: 39 models
  groq: 7 models
  cerebras: 2 models
  cloudflare-workers-ai: 18 models
  cloudflare-ai-gateway: 50 models
  xai: 4 models
  zai: 7 models
  zai-coding-cn: 10 models
  mistral: 32 models
  huggingface: 71 models
  fireworks: 20 models
  nvidia: 20 models
  together: 21 models
  baseten: 20 models
  opencode: 63 models
  opencode-go: 27 models
  github-copilot: 28 models
  minimax: 3 models
  minimax-cn: 3 models
  kimi-coding: 4 models
  moonshotai: 10 models
  moonshotai-cn: 10 models
  xiaomi: 3 models
  xiaomi-token-plan-cn: 2 models
  xiaomi-token-plan-ams: 2 models
  xiaomi-token-plan-sgp: 2 models
  qwen-token-plan: 18 models
  qwen-token-plan-individual: 8 models
  qwen-token-plan-cn: 18 models
  openrouter: 366 models
  vercel-ai-gateway: 237 models
  deepseek: 3 models
  ant-ling: 3 models
  openai-codex: 7 models
  azure-openai-responses: 39 models

> @earendil-works/pi-ai@0.84.4 build:offline
> npm run check:model-data && tsgo -p tsconfig.build.json && shx rm -rf dist/providers/data && shx cp -r src/providers/data dist/providers/data


> @earendil-works/pi-ai@0.84.4 check:model-data
> node scripts/check-model-data.ts

Generated model data is valid.

> @earendil-works/pi-agent-core@0.84.4 build
> tsgo -p tsconfig.build.json


> @earendil-works/pi-session-backend-sqlite-node@0.84.4 build
> tsgo -p tsconfig.build.json && node ./scripts/prepare-dist.mjs copy-sqlite-migrations


> @earendil-works/pi-protocol@0.84.4 build
> tsgo -p tsconfig.build.json


> @earendil-works/pi-client@0.84.4 build
> tsgo -p tsconfig.build.json


> @earendil-works/pi-server@0.84.4 build
> tsgo -p tsconfig.build.json


> @earendil-works/pi-coding-agent@0.84.4 build
> npm run build:unbundled && node ../../scripts/build-coding-agent-bundle.mjs


> @earendil-works/pi-coding-agent@0.84.4 build:unbundled
> tsgo -p tsconfig.build.json && shx chmod +x dist/cli.js dist/rpc-entry.js && npm run copy-assets


> @earendil-works/pi-coding-agent@0.84.4 copy-assets
> shx mkdir -p dist/modes/interactive/theme && shx cp src/modes/interactive/theme/*.json dist/modes/interactive/theme/ && shx mkdir -p dist/modes/interactive/assets && shx cp src/modes/interactive/assets/*.png dist/modes/interactive/assets/ && shx mkdir -p dist/core/export-html/vendor && shx cp src/core/export-html/template.html src/core/export-html/template.css src/core/export-html/template.js dist/core/export-html/ && shx cp src/core/export-html/vendor/*.js dist/core/export-html/vendor/

Built packages/coding-agent/dist/bundle (48 files, 7.1 MiB)
exit=0

```

## web-install

```text
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead

added 892 packages, and audited 893 packages in 19s

276 packages are looking for funding
  run `npm fund` for details

2 moderate severity vulnerabilities

To address all issues, run:
  npm audit fix

Run `npm audit` for details.
exit=0

```

## web-tsc

```text
exit=0

```

## web-lint

```text

> @agegr/pi-web@0.8.11 lint
> eslint .


/home/runner/work/pi_own/pi_own/apps/pi-web/lib/mode-pack-store.ts
  275:26  warning  '_contentHash' is assigned a value but never used  @typescript-eslint/no-unused-vars
  281:46  warning  '_version' is defined but never used               @typescript-eslint/no-unused-vars
  281:69  warning  '_hash' is defined but never used                  @typescript-eslint/no-unused-vars
  288:24  warning  '_contentHash' is assigned a value but never used  @typescript-eslint/no-unused-vars
  293:44  warning  '_version' is defined but never used               @typescript-eslint/no-unused-vars
  293:67  warning  '_hash' is defined but never used                  @typescript-eslint/no-unused-vars

✖ 6 problems (0 errors, 6 warnings)

exit=0

```

## web-tests

```text
dispatched to extensions for session 01a06f40-906d-7e0f-8859-ab59eef9acdc
✔ profile candidate failure aborts pending state and the transition lock rejects mutations (93.952981ms)
✔ profile transition acquisition rejects a prompt already waiting for extension admission (6.963773ms)
✔ reopening a journal-ahead profile uses the reconciled snapshot allowlist in both directions (155.636709ms)
✔ get_tools preserves the SDK tool definition fields (4.480156ms)
✔ RPC session startup preloads extension-registered providers before restoring models (1.208867ms)
✔ built-in subagents persist their selected resource policy (1.757482ms)
✔ running snapshots expose sessions with suppressed completion notifications (1.54777ms)
✔ RPC session startup resolves and passes the SDK-native enabled model scope (1.606129ms)
✔ RPC session startup treats only sessions with messages as continuing (1.243101ms)
✔ RPC session startup opens an existing session file only once and trusts its cwd (2.021024ms)
✔ RPC wrapper avoids per-chunk idle maintenance (1.210721ms)
✔ normal session teardown paths use graceful extension shutdown (1.550785ms)
✔ clone copies the requested leaf into a child session (0.986211ms)
✔ grounded outbound gate suppresses raw assistant deltas and exposes only the canonical final message (1.175775ms)
✔ root fork materializes an empty child JSONL linked to its exact parent (9.45784ms)
✔ session replacement rejects active work and clone writes one reopenable child (5.857978ms)
✔ cancelled session replacement releases its lock (0.691321ms)
✔ clone cancels an assistant-free branch without creating a file (1.819838ms)
✔ new-session route applies model scope during construction instead of follow-up commands (1.030254ms)
✔ prompt routes mark only preflight failures as rejected (1.251878ms)
✔ the wrapper reapplies an exact prompt after SDK preflight (1.182138ms)
✔ RPC session startup persists explicit preferences without replaying setters (0.946807ms)
✔ custom extension UI receives the fixed headless terminal facade (1.196354ms)
✔ reloading a session invalidates the models cache (1.184793ms)
✔ normal sessions restore persisted tool selections before loading resources (1.22109ms)
✔ crossing the Chat-only boundary persists and rebuilds the wrapper (1.089044ms)
✔ lists an accepted new prompt before its session file exists (3.004761ms)
✔ keeps an idle runtime visible once its JSONL file exists (0.997372ms)
(node:8774) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/search-tree.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ groups flat paths into directories with files at the root level (100.846623ms)
✔ builds arbitrarily deep nesting (0.609679ms)
✔ sorts directories before files and alphabetically within each level (0.500875ms)
✔ deduplicates repeated paths (0.413091ms)
✔ returns an empty tree for empty input (0.399646ms)
✔ treats a lone segment as a root file, not a directory (0.489013ms)
✔ groups nested subagents under their main session and uses family activity for sorting (9.702767ms)
✔ does not promote orphaned or cyclic subagent metadata into the main session list (0.357097ms)
(node:8793) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/session-file-references-core.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ detects exact external file paths referenced in session entries (67.602139ms)
✔ does not authorize sibling files by prefix match (0.616411ms)
✔ authorizes full output only from a bash execution message (0.443538ms)
✔ validates session ids before resolving session paths (0.502929ms)
(node:8800) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/session-path.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ normalizes Windows separators and casing for session identity (55.571644ms)
✔ preserves case when session paths are case-sensitive (0.38533ms)
✔ sliceActiveBranch returns the most-recent `tail` ancestors, in time order (2.556634ms)
✔ sliceActiveBranch walks from leaf back toward root, not forward (1.107311ms)
✔ sliceActiveBranch defaults to the last entry when leafId is null (0.268822ms)
✔ deep linear chain (5000 entries) slices without overflowing the stack (10.07889ms)
✔ buildSessionContext with tail returns only the tail window (3.015971ms)
✔ buildSessionContext without tail still returns the full chain (0.360924ms)
✔ buildSessionContext excludeLeaf pages upward without duplicating `before` (0.757935ms)
✔ pagination stops before the root instead of returning it again (0.303277ms)
✔ pagination cursor follows the raw page boundary across compaction (0.724092ms)
✔ tail pagination preserves settings from earlier entries (0.747435ms)
✔ buildSessionContext accepts a large tail and returns the whole chain (40.066553ms)
✔ real sessions may store assistant content as a string (deferThinking guard) (0.46562ms)
✔ session stats cover the full file independently of the displayed tail (0.82479ms)
✔ renders the SDK compaction-aware context with aligned entry IDs (4.056315ms)
✔ uses only the latest compaction on the active path (0.606201ms)
✔ uses the selected leaf's path before a later compaction (1.008453ms)
✔ returns an empty context for a null leaf (0.284531ms)
✔ defers historical thinking without changing live-session content (0.559194ms)
✔ does not defer empty historical thinking blocks (0.619897ms)
✔ defers only base64 images from historical tool results (1.196394ms)
✔ preserves hidden custom messages so the UI can render them collapsed (0.341778ms)
✔ preserves valid epoch timestamps on synthetic UI messages (0.467172ms)
✔ reads only a bounded session header, including headers larger than 4 KiB (1.602552ms)
✔ returns null for malformed or unbounded session headers (3.50778ms)
✔ session listing reads subagent relations and terminal status without reopening full session files (38.613427ms)
✔ keeps forward and reverse session path caches in sync (0.89398ms)
✔ resolves a matching session header without a catalogue scan (4.847514ms)
✔ does not resolve a parent path outside the default session storage (1.132215ms)
✔ preserves project symlinks exposed by the session catalogue (2.810187ms)
✔ falls back to the catalogue when a targeted candidate header is invalid (1.852699ms)
✔ falls back to the catalogue when a targeted lookup finds duplicate IDs (8.721817ms)
✔ forced session listing bypasses the fresh server cache (0.649942ms)
✔ a scan invalidated in flight retries before returning to its caller (0.405657ms)
✔ disk sessions replace runtime snapshots with the same id (1.092239ms)
(node:8821) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/session-row-context-menu.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ leaves the native context menu unclaimed when no listener is installed (1.163522ms)
✔ delivers the stable session-row detail without requiring a listener to claim it (0.257381ms)
✔ reports the menu as handled when a listener cancels the extension event (0.280794ms)
✔ sums usage across ALL entries, including history compacted away (2.086736ms)
✔ counts tool calls and includes tool result usage (0.449058ms)
✔ includes branch summary usage (0.400998ms)
✔ tolerates entries without usage (older session files) (0.291073ms)
✔ returns zeros for an empty session (1.177399ms)
✔ full-file stats never shrink relative to the post-compaction context (0.682985ms)
✔ adds messages completed after load to compacted file totals (0.687694ms)
✔ empty or single-entry session yields zero (1.98693ms)
✔ counts active gaps within a turn (0.274162ms)
✔ drops human idle before the next user message (0.392493ms)
✔ keeps compacted history and compaction time in append order (0.288168ms)
✔ counts work appended on every branch exactly once (0.30557ms)
✔ treats user-initiated bash as a boundary (0.480818ms)
✔ ignores metadata without breaking the active interval (0.243414ms)
✔ counts branch summaries and custom messages (0.36416ms)
✔ skips invalid timestamps and ignores negative gaps (1.621277ms)
✔ cleans common session title response wrappers (5.118257ms)
✔ rejects responses without a usable title (8.975988ms)
✔ folds the title request into a trailing user message without mutating the source (1.264471ms)
✔ leaves a completed conversation unchanged before adding the title turn (0.194724ms)
✔ waits for the source reply before sending the title prompt (4.935977ms)
✔ generates a title when compaction removed all literal user messages (1.276884ms)
✔ temporary title agent preserves the provider-facing prefix (1.642798ms)
✔ keeps only tool calls with adjacent matching results (0.445151ms)
✔ removes incomplete tool calls before invoking the title provider (3.153686ms)
✔ a missing tool-selection entry identifies a legacy session (1.555695ms)
✔ an empty selection is distinct from a missing selection (1.101827ms)
✔ the newest valid tool selection wins and invalid newer entries are ignored (0.466661ms)
✔ tool selections accept only built-in tools (0.784084ms)
✔ appending a selection writes the versioned custom entry (0.397271ms)
✔ only subagents nest while forks remain independent roots (15.741714ms)
✔ orphaned subagents become roots and every level is sorted newest first (0.412439ms)
✔ cyclic relation metadata cannot hide sessions or recurse forever (0.406589ms)
✔ deep subagent trees are sorted without recursive traversal (193.302439ms)
✔ restores the last settings section and falls back without a project (1.786876ms)
✔ keeps project settings selections isolated by cwd (0.505443ms)
✔ shares the models selection globally (0.272429ms)
✔ ignores malformed and unavailable browser storage (0.570456ms)
(node:8878) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/skill-frontmatter.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
▶ setDisableModelInvocation
  ✔ adds the key after the opening fence when absent (8.166519ms)
  ✔ creates a frontmatter block when the file has none (0.433449ms)
  ✔ replaces an explicit false value instead of adding a duplicate key (1.59019ms)
  ✔ updates and removes indented quoted keys (2.925712ms)
  ✔ rejects unsupported key formatting instead of silently succeeding (1.620135ms)
  ✔ preserves CRLF line endings when updating or adding the key (0.74981ms)
  ✔ keeps a single key when disabling an already-true skill (0.752265ms)
  ✔ removes the key when disabling is turned off (1.44095ms)
  ✔ removes the key when it is the last frontmatter line before the closing fence (0.596715ms)
  ✔ is a no-op when disabling is off and the key is absent (0.541531ms)
  ✔ preserves unrelated frontmatter formatting and body lines that mention the key (1.877757ms)
✔ setDisableModelInvocation (22.699816ms)
✔ uses the CLI global lock location (1.518805ms)
✔ annotates only lock entries that exist in the matching Pi scope (4.604778ms)
✔ ignores stale lock entries and malformed lock files (1.487076ms)
✔ does not compare a project ref with the default skills.sh snapshot (1.464294ms)
✔ compares a global lock version with the remote Git tree (32.151955ms)
✔ uses the repository hash for a root global skill (0.750412ms)
✔ compares a project lock version with the skills.sh snapshot (1.077883ms)
✔ returns unsupported without making a remote request (0.322311ms)
✔ returns a scoped error when the remote check fails (0.730664ms)
✔ falls back to Git when the GitHub API is rate limited (0.601212ms)
✔ builds Pi-only update commands for each scope (1.292373ms)
✔ reuses one remote request for skills from the same GitHub source (2.82268ms)
(node:8902) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/slash-display.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ restores a complete SDK skill expansion with arguments (4.366362ms)
✔ restores a complete SDK skill expansion without arguments (0.240318ms)
✔ restores multiline arguments (0.234517ms)
✔ uses the final closing tag when the skill body contains an example (0.19779ms)
✔ does not collapse incomplete or lookalike user text (0.209752ms)
✔ collapse keeps session auto-naming free of skill XML (3.656477ms)
✔ plain first messages pass through unchanged for naming (0.211625ms)
✔ persists explicit effective model and thinking defaults (31.649857ms)
✔ does not persist implicit scope selections (3.841703ms)
✔ does not persist a model when startup resolved a different model (2.22789ms)
✔ does not replace a reasoning default with off for a non-thinking model (3.061176ms)
✔ builds thinking and text blocks from official assistant deltas (3.169969ms)
✔ a reconnect snapshot replaces the old partial before deltas continue (0.435564ms)
✔ text deltas update immutably so React observes each chunk (0.311802ms)
✔ shows and streams a tool call after thinking, then accepts the authoritative end (0.665212ms)
✔ restores the raw tool input from a reconnect snapshot (0.323504ms)
✔ ignores deltas without a baseline and unknown future deltas (0.25164ms)
✔ normalizes tool calls in snapshots and clears on end (0.258854ms)
✔ integrated extension exposes the legacy-compatible tool names (6.083058ms)
✔ integrated extension registers no tools while its feature is disabled (0.840139ms)
✔ Agent tool description lists enabled effective profiles and refreshes when its factory reloads (1.941635ms)
✔ integrated extension removes a legacy extension that owns the same tools (0.818528ms)
✔ integrated extension removes recognized legacy extensions with any reserved tool (0.764256ms)
✔ foreground Agent streams updates and returns the completed result (1.125371ms)
✔ foreground Agent reports startup and execution failures as tool errors (2.455886ms)
✔ background Agent returns immediately and delegates one completion notification (0.967407ms)
✔ get_subagent_result covers missing, running, completed, failed, and aborted runs (1.974306ms)
✔ get_subagent_result wait honors abort signals (2.620743ms)
✔ steer_subagent returns success and runtime failures (0.99075ms)
✔ legacy preference leaves unrelated and partial-overlap extensions intact (0.233787ms)
✔ loads cwd-relative UTF-8 files and formats them as delegated user input (13.778137ms)
✔ rejects direct files outside cwd (3.478745ms)
✔ rejects symlink targets outside cwd (3.554908ms)
✔ rejects invalid UTF-8 and bounded input sets (5.1784ms)
✔ a tool-free subagent uses only its profile as the exact system prompt (2.395834ms)
✔ a tool-enabled subagent retains inherited context in its appended system prompt (0.252031ms)
✔ a resource-enabled tool-free subagent keeps the normal system prompt pipeline (0.333273ms)
✔ completion notification reopens an idle parent and uses its current session (3.030659ms)
✔ disabled built-in subagents reject stale Agent calls before starting (1.485002ms)
✔ subagent settings default the built-in extension to disabled (21.810876ms)
✔ subagent settings persist both states and preserve unrelated fields (30.356165ms)
✔ damaged settings fail closed and are not overwritten (5.749455ms)
✔ built-in profile IDs use lowercase kebab-case and read-only profiles cannot execute shell commands (4.258124ms)
✔ override detection follows scope precedence case-insensitively (0.341769ms)
✔ project profiles override built-ins and round-trip their runtime settings (45.199541ms)
✔ legacy extension selectors are omitted from lightweight profile tools (5.131438ms)
✔ persisted subagent metadata reconstructs the final run (0.607997ms)
✔ persisted subagent resources restore the exact isolated prompt and tools (0.328875ms)
✔ legacy subagent resource snapshots keep skills and extensions disabled (0.18696ms)
✔ extension tools are merged while subagent control tools stay excluded (0.169427ms)
✔ an empty tool selection round-trips without restoring default tools (4.283302ms)
✔ saved profiles normalize runtime values and reject invalid settings (3.338785ms)
✔ project profiles override workspace profiles and deletion restores the workspace version (4.621474ms)
✔ global and project sources with the same name stay visible while project wins at runtime (4.757929ms)
✔ global profiles round-trip and deleting an override restores the built-in (1.915393ms)
✔ disabled profiles cannot be resolved for execution (6.184286ms)
✔ persisted runs distinguish interrupted, failed, aborted, and latest results (0.274413ms)
✔ project profile directories cannot escape cwd through symbolic links (4.840283ms)
(node:8981) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/terminal-input.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ maps navigation and editing keys to terminal sequences (68.893129ms)
✔ maps legacy control and alt keys used by pi-tui (0.52455ms)
✔ leaves printable text to the text input and wraps pasted text (0.481079ms)
✔ uses the latest non-empty text line from a partial tool result (1.060072ms)
✔ ignores partial tool results without displayable text (0.220853ms)
✔ bounds long progress lines while preserving the latest text (0.312685ms)
✔ defaults missing or invalid preferences to the default preset (1.041789ms)
✔ round-trips every supported tool preset (0.32588ms)
✔ falls back safely when browser storage is unavailable (0.335097ms)
✔ falls back when accessing window.localStorage throws (0.289983ms)
✔ maps every tool preset to its built-in tools (1.52899ms)
✔ recognizes presets while ignoring active custom tools (0.499304ms)
✔ returns fresh tool arrays that callers can safely modify (0.170088ms)
✔ recognizes PowerShell as the shell in standard presets (0.211826ms)
✔ extracts a file from a successful write tool call (3.209814ms)
✔ extracts a file from a successful edit tool call using input.path (0.341588ms)
✔ accepts namespaced write/edit tool names from MCP servers (0.338593ms)
✔ skips a tool call whose result errored (0.248044ms)
✔ skips a tool call whose result has not arrived (streaming) (0.268632ms)
✔ deduplicates the same file written then edited (0.290653ms)
✔ resolves a relative path against cwd (0.323825ms)
✔ resolves extensionless and dot-prefixed filenames against cwd (0.387094ms)
✔ preserves path characters that have special meaning in hrefs (0.375041ms)
✔ normalizes Windows-relative tool paths against a Windows cwd (0.387264ms)
✔ skips non-writing tools like read and bash (0.254266ms)
✔ ignores paths that only appear in the reply text (0.200666ms)
✔ lists only the file actually written, not others named in the text (0.224801ms)
✔ skips a write call missing both file_path and path (0.171371ms)
✔ returns an empty array for an empty or text-only turn (0.162975ms)
(node:9021) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/pi_own/pi_own/apps/pi-web/lib/web-auth.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to /home/runner/work/pi_own/pi_own/apps/pi-web/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ enables password authentication only for a non-empty configured password (57.22897ms)
✔ accepts only the fixed pi username and configured password (1.567601ms)
✔ supports UTF-8 passwords and colons in the password (0.436737ms)
✔ rejects missing, malformed, and non-canonical authorization values (0.531454ms)
✔ does not authenticate when password protection is disabled (0.594071ms)
✔ generates and persists VAPID keys when no state exists (1.754782ms)
✔ reuses persisted VAPID keys (0.207358ms)
✔ addSubscription upserts by endpoint and persists (0.234228ms)
✔ addSubscription persists even after getVapidPublicKey already saved (0.163837ms)
✔ notifySessionComplete sends localized payloads with the session name (0.533207ms)
✔ notifySessionComplete falls back to the localized generic title (0.233257ms)
✔ notifySessionComplete prunes subscriptions dropped by the push service (0.393647ms)
✔ localeText falls back to English for unknown locales (0.199473ms)
✔ returns null for an unknown workspace (1.57765ms)
✔ set then get round-trips the remembered session (0.281877ms)
✔ workspaces are remembered independently (0.236773ms)
✔ clearLastOpen removes only the named workspace (0.330238ms)
✔ clearing the last entry removes the storage key entirely (0.393466ms)
✔ ignores a corrupt stored map (0.265156ms)
✔ ignores a stored map of the wrong shape (0.314879ms)
✔ recovers from an array-shaped stored map (0.199774ms)
✔ ignores an empty or non-string session id (0.318355ms)
✔ falls back to null / no-ops when browser storage is unavailable (0.879706ms)
✔ falls back when browser storage access throws (0.50271ms)
✔ workspaceKeyOf prefers projectKey, then projectRoot, then cwd (0.235881ms)
✔ main and linked worktrees share one canonical project root (144.622689ms)
✔ push shows a notification when no window is visible (1.833459ms)
✔ push skips the system notification when a window is visible (0.966688ms)
✔ push ignores malformed payloads (0.182902ms)
✔ notification click focuses an existing client at the session URL (0.511948ms)
✔ notification click navigates an existing client to the session (0.407332ms)
✔ notification click opens a window and rejects cross-origin targets (0.263573ms)
ℹ tests 885
ℹ suites 10
ℹ pass 884
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 32019.381709
exit=0

```

## web-build

```text

> @agegr/pi-web@0.8.11 build
> next build --webpack

▲ Next.js 16.3.1 (webpack)
✓ Running next.config.ts took 26ms
⚠ No build cache found. Please configure build caching for faster rebuilds. Read more: https://nextjs.org/docs/messages/no-cache
Attention: Next.js now collects completely anonymous telemetry regarding usage.
This information is used to shape Next.js' roadmap and prioritize features.
You can learn more, including how to opt-out if you'd not like to participate in this anonymous program, by visiting the following URL:
https://nextjs.org/telemetry


  Creating an optimized production build ...
⚠ Compiled with warnings in 16.9s

./app/api/sessions/[id]/export/route.ts
Critical dependency: the request of a dependency is an expression

Import trace for requested module:
./app/api/sessions/[id]/export/route.ts

✓ Compiled successfully in 27.8s
  Running TypeScript ...
  Finished TypeScript in 11.5s ...
  Collecting page data using 3 workers ...
  Generating static pages using 3 workers (0/22) ...
  Generating static pages using 3 workers (5/22) 
  Generating static pages using 3 workers (10/22) 
  Generating static pages using 3 workers (16/22) 
✓ Generating static pages using 3 workers (22/22) in 2.3s
  Finalizing page optimization ...
  Collecting build traces ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/agent/[id]
├ ƒ /api/agent/[id]/bash-output
├ ƒ /api/agent/[id]/events
├ ƒ /api/agent/new
├ ƒ /api/agent/running
├ ƒ /api/app-update
├ ƒ /api/auth/api-key/[provider]
├ ƒ /api/auth/login/[provider]
├ ƒ /api/auth/logout/[provider]
├ ƒ /api/auth/providers
├ ƒ /api/cwd/browse
├ ƒ /api/cwd/validate
├ ƒ /api/default-cwd
├ ƒ /api/file-index
├ ƒ /api/files/[...path]
├ ƒ /api/git/diff
├ ƒ /api/git/status
├ ƒ /api/harness/active-course
├ ƒ /api/harness/courses
├ ƒ /api/harness/practice
├ ƒ /api/harness/practice/attempt
├ ƒ /api/harness/practice/hint
├ ƒ /api/harness/practice/solution
├ ƒ /api/harness/profile
├ ƒ /api/harness/search
├ ƒ /api/harness/spans/[spanId]
├ ƒ /api/harness/status
├ ƒ /api/harness/timeline
├ ƒ /api/home
├ ƒ /api/mode-packs
├ ƒ /api/mode-packs/activate
├ ƒ /api/mode-packs/status
├ ƒ /api/models
├ ƒ /api/models-config
├ ƒ /api/models-config/catalog
├ ƒ /api/models-config/discover
├ ƒ /api/models-config/test
├ ƒ /api/plugins
├ ƒ /api/project-trust
├ ƒ /api/push/config
├ ƒ /api/push/subscribe
├ ƒ /api/sessions
├ ƒ /api/sessions/[id]
├ ƒ /api/sessions/[id]/auto-name
├ ƒ /api/sessions/[id]/context
├ ƒ /api/sessions/[id]/entries/[entryId]/thinking
├ ƒ /api/sessions/[id]/entries/[entryId]/tool-result-image
├ ƒ /api/sessions/[id]/export
├ ƒ /api/sessions/[id]/state
├ ƒ /api/skills
├ ƒ /api/skills/check
├ ƒ /api/skills/install
├ ƒ /api/skills/search
├ ƒ /api/skills/update
├ ƒ /api/subagents/[id]
├ ƒ /api/subagents/profiles
├ ƒ /api/subagents/settings
├ ƒ /api/tools/settings
├ ƒ /api/worktrees
├ ○ /manifest.webmanifest
└ ○ /mode-packs


ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand

exit=0

```

