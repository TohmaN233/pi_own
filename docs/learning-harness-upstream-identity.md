# Learning Harness upstream identity

This file freezes the implementation baseline for the first Learning Harness work branch.

## Repository role

`TohmaN233/pi_own` is currently an exact fork of the Pi monorepo at upstream commit `853a80d26c90a14c1886f0ebb8ffaae133ca2185`, plus the Learning Harness plan. It is therefore treated as the **umbrella/core repository**, not as a Pi Web fork.

That differs from the directory shape proposed in the planning document, which assumed a Pi Web fork as the product repository. The implementation rule is:

1. Keep Pi's Agent loop, provider layer, session format, queueing, retry, compaction, and tool loop native.
2. Put new deterministic Harness logic in new packages instead of modifying Pi runtime internals unless a later integration proves a thin hook is required.
3. Pi Web is now reproducibly vendored under `apps/pi-web`; keep downstream changes in the Harness routes, client, and component boundaries documented in `docs/pi-web-upstream-map.md`.
4. Treat Pi Web `v0.8.11` / `28bab3c25f5f6770c9b0b745ebbfec1c27f7b948` as the frozen frontend baseline. `docs/pi-web-upstream-manifest.json` records the exact upstream tree.
5. Treat YN Translation Workshop `419dc457a8a4bccd2c6ce0f0d5f29faa68668c8c` as an architecture reference, never as a runtime dependency.

The machine-readable copy is `docs/learning-harness-upstream-identity.json` and is checked by `scripts/learning-harness-baseline.test.mjs`. Its explicit Pi Web modification list includes the narrow `lib/rpc-manager.ts` root-fork header materialization hook and its regression, plus the `SessionSidebar` polling generation-invalidation fix and regression, alongside the Harness integration paths. The app still uses Pi Web's frozen Pi 0.84.3 dependency baseline; upgrading that dependency remains a separate compatibility change from Harness integration.
