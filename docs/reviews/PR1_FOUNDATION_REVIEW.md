# PR #1 final foundation review

Review date: 2026-08-29  
Reviewed branch: `feat/learning-harness-m0-m1`  
Review scope: repository diff against `main`, including review-fix commits

## Verdict

**SHIP AS A FOUNDATION CHECKPOINT.**

There are no remaining blockers for merging this change when it is described as a contracts-and-Host prototype checkpoint.

This review does **not** approve the repository as a completed Learning Harness V1 product. The accurate implementation status is maintained in `docs/LEARNING_HARNESS_PROGRESS.md`.

## Blocking findings closed during review

### B1 — Unknown answer scope could bypass publication policy

`KnowledgeHost.validateDraft()` previously trusted the TypeScript type of model- or API-supplied data. At runtime an unknown `scope` string matched none of the policy branches and could receive a passing Validator result.

Closure:

- added exact `parseAnswerClaim()` and `parseAnswerDraft()` runtime contracts;
- changed Knowledge Host publication entry points to parse untrusted Draft input;
- reject empty Claim sets;
- preserve the first issued Grounding Packet instead of rewriting its audit timestamp under the same deterministic identity;
- added regression coverage for unknown scope, empty Claims, and rejected publication.

### B2 — Solution Capability time and restore integrity were fail-open

`AssessmentHost.readSolution()` accepted an invalid `at` string because `Date.parse()` returned `NaN`, and used `>` rather than `>=` at expiry. Restored Capability state checked references but did not recompute Capability identity or content hash.

Closure:

- validate the read timestamp;
- reject access at or after `expiresAt`;
- recompute Capability ID and content hash on read and restore;
- verify issued/expiry ordering and declared use count;
- reject duplicate or tampered restored Capabilities;
- validate evaluation timestamps;
- add regression coverage for invalid time, exact expiry, restored-state tampering, and one-use consumption.

### B3 — A bound Runtime journal could accept another course's Snapshot

A Session Binding could not be changed to another CourseVersion, but the same Runtime journal could still append a Resource Snapshot for another course after binding.

Closure:

- reject cross-course Snapshot append once a binding exists;
- reject the same condition during journal recovery;
- update the Runtime Host regression test.

## Non-blocking risks retained for later milestones

1. Most new Hosts are in-memory reference implementations. Durable transaction, crash recovery, and multi-process ownership are not implemented.
2. The repository has no Learning Harness service/composition root and no Local API.
3. Pi Web is only a frozen future baseline; no frontend source or adapter is present.
4. New Host directories are source modules inside the monorepo, not independently publishable packages with their own package metadata.
5. Course PDF support depends on an injected extractor and does not preserve page-level anchors.
6. Grounding enforces course/snapshot/Span identity and declared scope rules, but semantic entailment and computation/external-source receipts remain future work.
7. Assessment state export contains bearer Capability records and must remain behind an authoritative local service when persistence is added.
8. Visual Host is bounded static rendering, not a separate no-network process/container sandbox.
9. Teacher authorization is an interface boundary, not a concrete product authentication implementation.
10. Student bundle verification scans structured values, not actual release artifacts or a recursive filesystem tree.
11. The new Profile, Course, Knowledge, Learning, Assessment, Visual, Teacher, and Student modules need broader integration and recovery tests.
12. GitHub Actions returned no workflow run/status for this PR; remote CI success is not claimed.

## Review evidence

The review inspected the full changed-file set and focused on:

- exact runtime contracts and unknown-field rejection;
- Pi JSONL ownership and Runtime journal recovery;
- immutable Session/Course binding;
- current-course retrieval and citation validation;
- answer-gate Capability scope, time, replay, and restore behavior;
- deterministic Visual output and active-content rejection;
- teacher/student boundary claims;
- test discovery under the existing `scripts/*.test.mjs` root test command;
- mismatch between the earlier PR description and the actual repository contents.

## Merge condition

Merge only with the PR and project documentation describing this as a reviewed foundation/prototype checkpoint. Do not claim M0–M8 product completion, Pi Web integration, remote CI success, or real-provider evaluation.
