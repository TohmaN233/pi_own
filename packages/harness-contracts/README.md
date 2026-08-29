# Pi Learning Harness Contracts

Versioned, fail-closed contracts shared by the Learning Harness Hosts.

This directory intentionally has no standalone `package.json` in WP-01. The current repository is still the upstream Pi workspace, and adding another npm workspace would require a lockfile rewrite before the runtime/UI repository shape is frozen. Root TypeScript checks already include `packages/*/src/**/*`, and the contract smoke test runs from `scripts/learning-harness-contracts.test.mjs`.

A later work packet may promote this directory to a publishable/private workspace without changing the V1 wire contracts.

Current V1 contracts:

- `SessionBinding`
- `ResourceSnapshotRef`
- `WorkflowRun`
- `HostCommand`
- `ValidatorResult`
- `HarnessJsonlEntry`

Every parser rejects unknown top-level fields, invalid revisions, unsupported enum values, and non-JSON payloads. Later packages may add richer schemas, but they must preserve the V1 wire contract or introduce a new explicit version.
