# Dependency audit — 2026-09-30

The September 29 and 30 [scheduled audit failures](https://github.com/TohmaN233/pi_own/actions/runs/36727304597) ran on September 20's `7db59006c`, whose original build/check/test CI had passed. New vulnerability reports made that unchanged dependency graph fail. Repairs are isolated from the uncommitted portable-mode development checkout.

## Root workspace repair

- Pin coding-agent's direct undici to 8.11.2.
- Resolve brace-expansion to 5.0.12 and Gondolin's undici to 6.29.0, retaining its declared 6.x dependency range.
- Regenerate coding-agent's published shrinkwrap and standalone install lock; update the Gondolin example lock.

Commit `b37edb57f` contains this repair. Clean installation with lifecycle scripts disabled, production audit, registry signatures and `npm run check` pass locally. Audit reports zero vulnerabilities; 142 registry packages and 19 attestations verify. HTTP dispatcher tests pass. The Harness fingerprint record is synchronized with the reviewed coding-agent manifest change, preserving its exact source-identity check.

## Fresh catalog CI failure

The [first repair CI](https://github.com/TohmaN233/pi_own/actions/runs/36731762908) built successfully but failed typechecking: fresh production model generation removed historical Together/Fireworks/OpenCode IDs hardcoded by tests. Local checks against older generated JSON had missed that condition.

Commit `734f5d1ca` separates historical compatibility fixtures from the live catalog. Offline regressions use typed snapshots validated by the production schema. Together live tests select a current model with required reasoning, vision and API capabilities, and fail explicitly if none exists. Current-catalog registration tests retain API/endpoint checks. Production generation and removal of discontinued models remain intact. With fresh model data, `npm run check` passes; eight targeted offline files pass 132 tests with four credential-gated cases skipped.

## Independent Pi Web installation

Pi Web has its own lock outside the root workspace. Direct pins use Next.js/eslint-config-next 16.3.7, undici 8.11.2 and js-yaml 5.4.2, with related sharp and brace-expansion updates.

SDK 0.85.1's published shrinkwrap reinstalled vulnerable undici and brace-expansion despite outer updates, overrides and `npm audit fix`. SDK 0.99.1 still retained vulnerable brace-expansion, so a broad API migration was insufficient. Its CLI/RPC bundles also embed vulnerable code that ordinary npm audits cannot inspect.

The reviewed security tarball authenticates the original SDK with pinned SHA-512 and records a complete file manifest. Only package/shrinkwrap metadata change, and 51 old bundle files are removed. Upstream's existing unbundled CLI/RPC replace them. All 1,003 retained nonmetadata files and modes match upstream; the upstream MIT copyright/license is added as `LICENSE` because npm omitted it. The artifact has its own integrity and is not registry-signed. See `third_party/pi-web-sdk/NOTICE.md` and `source.json` for provenance and license.

The app lock explicitly retains `hasShrinkwrap` and the original SDK dependency versions except the two approved fixes. The offline verifier checks that boundary; fresh local-file resolution can otherwise upgrade unrelated SDK dependencies. Clean `npm ci` and subsequent `npm install` both pass audit with zero vulnerabilities and retain the repaired lock. Registry verification covers 383 packages and 101 attestations.

Five archive integrity/scope regressions pass. SDK imports, CLI help/version, native RPC state, a TypeScript extension importing the SDK, proxy routing, Mode Pack switching/restart/fork/recovery and Course Builder workspace tests pass on local Windows. Pi Web typechecking passes. These checks make no real provider calls. Pi Web lint reports zero errors and 21 existing warnings outside this repair.

The audit workflow now runs on relevant pushes and schedules. It checks the independent Pi Web installation, archive integrity, SDK entrypoints, registry signatures and repeat-install stability on Windows and Linux. Remote CI provides final platform acceptance evidence.

The first matrix run exposed an installation-toolchain mismatch: Node 22's bundled npm removed `libc` lock metadata on Linux, while Windows' prefix-based install entered the repository's prepare flow. Pi Web now declares npm 11.12.1 (minimum 11.11.0); its audit matrix installs that exact version and runs app installs from the app directory. The strict lock stability and script-disabled installation gates remain enabled. See [npm's libc lockfile bug](https://github.com/npm/cli/issues/8514) and the [install command's explicit global-install guard](https://github.com/npm/cli/blob/v11.12.1/lib/commands/install.js).
