# Learning Harness upstream identity

This file freezes the implementation baseline for the first Learning Harness work branch.

## Repository role

`TohmaN233/pi_own` is currently an exact fork of the Pi monorepo at upstream commit `853a80d26c90a14c1886f0ebb8ffaae133ca2185`, plus the Learning Harness plan. It is therefore treated as the **umbrella/core repository**, not as a Pi Web fork.

That differs from the directory shape proposed in the planning document, which assumed a Pi Web fork as the product repository. The implementation rule is:

1. Keep Pi's Agent loop, provider layer, session format, queueing, retry, compaction, and tool loop native.
2. Put new deterministic Harness logic in new packages instead of modifying Pi runtime internals unless a later integration proves a thin hook is required.
3. Integrate/adapt Pi Web only when the Profile/UI work reaches that dependency. Do not copy Pi Web into the repository during WP-00/WP-01 merely to match the planned tree.
4. Treat Pi Web `v0.8.11` / `28bab3c25f5f6770c9b0b745ebbfec1c27f7b948` as the planned frontend baseline until that integration begins.
5. Treat YN Translation Workshop `419dc457a8a4bccd2c6ce0f0d5f29faa68668c8c` as an architecture reference, never as a runtime dependency.

The machine-readable copy is `docs/learning-harness-upstream-identity.json` and is checked by `scripts/learning-harness-baseline.test.mjs`.
