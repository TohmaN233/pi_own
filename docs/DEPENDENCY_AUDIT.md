# Production dependency audit

CI keeps the complete `npm audit --omit=dev --audit-level=moderate --json`
report, fails on unreviewed moderate/high/critical findings and registry errors,
and continues checking registry signatures. Do not blanket-disable the audit or
raise its severity threshold to make a run green.

## Reviewed upstream finding (2026-10-06)

[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
affects RSA PKCS#1 v1.5 signature verification in `node-forge`. The registry's
latest release, 1.4.0, remains affected and has no published fix.

The monorepo includes it solely through the optional, private
`packages/coding-agent/examples/extensions/gondolin` example:
`@earendil-works/gondolin@0.12.0` → `node-forge@1.4.0`.
It is not a dependency of the published Pi core or Pi Web. Gondolin uses Forge
for its local certificate operations, including certificate verification; this
exception does **not** claim the library or the example has been patched.

`scripts/audit-production.mjs` treats this exact advisory and its one derived
Gondolin finding as a visible reviewed upstream warning rather than failing the
whole daily job. It verifies the pinned versions, dependency consumers and
reported advisory before applying the exception. Another advisory, an available
fix, a new consumer, a changed version or an independent Gondolin finding still
fails CI. The full vulnerable entries remain in the report and GitHub step
summary. Remove the exception and upgrade when upstream publishes a fix.

Pi Web's `source-map-js` finding
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
is fixed by locking the registry-signed 1.2.2 patch release. It has no exception.

Run the reviewed root audit with `node scripts/audit-production.mjs` and its
regressions with `node --test scripts/audit-production.test.mjs`. Pi Web keeps
using the ordinary `npm audit` command.
