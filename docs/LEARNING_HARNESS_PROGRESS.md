# Pi Learning Harness progress

Last updated: 2026-08-29  
Reference plan: `docs/PI_LEARNING_HARNESS_DETAILED_PLAN_V001.md`

## Current status

The repository contains a reviewed **Learning Harness foundation and library-level prototype**. It is not yet a complete V1 application.

PR #1 establishes the contracts and core Host boundaries needed to continue implementation without replacing Pi's native Agent loop or transcript. It also contains early in-memory reference implementations for later milestones. Those reference implementations prove interfaces and hard invariants; they do not by themselves satisfy the full product exit conditions in the plan.

## Status vocabulary

- **Complete**: the milestone's current repository-level exit condition is implemented and reviewed.
- **Prototype**: the core library behavior exists, but product integration, durable storage, UI, or full verification remains.
- **Future**: not implemented in the repository.

## Milestone status

| Milestone | Status | What exists now | What remains |
| --- | --- | --- | --- |
| M0 — baseline and architecture | **Complete** | Pi upstream identity, Pi Web target identity, YN reference identity, and ADR 0001 freezing Pi as the only Agent runtime/transcript owner | A reproducible Pi Web import/sync mechanism and its upstream contract suite |
| M1 — Harness contracts and Runtime Host | **Complete at foundation scope** | Versioned contracts; fail-closed parsers; Pi custom-entry Runtime journal; binding, snapshot, idempotency, workflow transition, and recovery rules | Bind the Host to a real `AgentSession` service lifecycle; process restart integration test; browser/SSE reconciliation |
| M2 — Profile / Resource Snapshot | **Prototype** | Built-in profiles, resource catalogue, immutable snapshot resolution, student tool restrictions, and hot/warm/hard switch classification | Durable profile store; real Pi package/Skill/tool activation; rollback fault injection; Snapshot Inspector and switch UI |
| M3 — Course Host and isolation | **Prototype** | Immutable in-memory CourseVersion objects, content hashes, stable normalized spans, session/course checks, Markdown/text/code/notebook parsing, and a PDF extractor interface | Content-addressed file store; SQLite manifest/index; concrete PDF extraction; exact source-page anchors; import UI; durable A/B course isolation tests |
| M4 — Grounded teaching and Timeline | **Prototype** | Deterministic lexical retrieval, Grounding Packets, current-course citation checks, fail-closed answer-draft parsing, publication receipts, append-only learning events, and mastery projection | Service/API composition; clickable Source Inspector; semantic claim-entailment review; computed/external evidence receipts; durable cross-session Timeline; repair loop |
| M5 — Assessment and answer gate | **Prototype** | Public/private exercise split, meaningful-attempt check, hint access, answer evaluation, scoped one-use Capability, expiry/integrity checks, and state export/restore contracts | Protected durable solution vault; authoritative service wiring; capability persistence transaction; adversarial bypass suite; student UI blocks; richer rubric evaluation |
| M6 — Visual Lab | **Prototype** | Structured specs and five deterministic static renderers: function plot, matrix transform, algorithm trace, graph trace, and state machine | Separate no-network sandbox runner; computation receipt Host; artifact revision/publication gate; HTML Stage and popup integration; snapshot/accessibility tests |
| M7 — detachable Teacher Studio | **Prototype** | Teacher draft/controller interfaces and object-level student manifest scanning | Physically optional package/build graph; concrete authorization; teacher UI; immutable publication workflow; recursive scan of real built artifacts and exported course packages |
| M8 — external evaluation, security, release | **Future** | No complete M8 implementation. PR #1 only adds narrow deterministic unit-style checks for the foundation | Frozen benchmark courses/cases, Run Manifest pipeline, multi-seed/provider evaluation, threat-model execution, full CI evidence, release packaging, migration, backup, and rollback |

## Completed code boundaries

The following repository components are present after PR #1:

- `packages/harness-contracts`
- `packages/harness-core`
- `packages/pi-runtime-host`
- `packages/profile-resource-host`
- `packages/course-host`
- `packages/knowledge-host`
- `packages/learning-host`
- `packages/assessment-host`
- `packages/visual-host`
- `packages/teacher-studio`
- `packages/student-build`

They are intentionally separate from Pi's native model loop, queue, retry, compaction, and JSONL transcript code.

## Review corrections made before merge

The final review closed three blocking fail-closed defects:

1. Answer drafts now pass through an exact runtime contract parser. Unknown Claim scopes and unknown fields cannot bypass the publication rules; an empty Claim list is rejected.
2. Solution Capabilities now validate their deterministic identity, content hash, declared use count, issued/expiry timestamps, invalid read timestamps, and the exact expiry boundary. Tampered restored state is rejected.
3. Once a Pi session is course-bound, its Runtime journal cannot record a Resource Snapshot for another CourseVersion.

Regression coverage was added under `scripts/learning-harness-review-hardening.test.mjs`, and the existing Runtime Host test was updated for course-bound Snapshot isolation.

## Important limitations of the merged foundation

- New Hosts are in-memory reference implementations; there is no SQLite/WAL authority yet.
- No Learning Harness Local API, composition root, or production process exists.
- Pi Web source is not present and `piWeb.integrated` remains `false` in the upstream identity file.
- There is no browser workflow, course switcher, Timeline UI, Practice UI, Source Inspector, Visual Stage, or Teacher Studio application.
- PDF support is an injected extractor contract, not a shipped parser.
- Visual rendering is bounded and static, but it is not yet executed in a separate OS/container sandbox.
- The student scanner examines structured bundle data, not a real packaged application or recursive filesystem tree.
- Grounding verifies issued/current Span identities and scope rules; it does not prove semantic entailment of arbitrary model prose.
- GitHub Actions produced no run for PR #1. The repository therefore does not claim independent remote CI success for this merge.

## Next implementation sequence

The next work should remain incremental:

1. **Persistence and composition** — add a single durable Host store, transaction/revision rules, and one composition root that owns all current in-memory Hosts.
2. **Real Pi lifecycle integration** — bind Resource Snapshot and CourseVersion before the first model turn; recover from a real Pi JSONL session and process restart.
3. **Pi Web integration** — import or reproducibly vendor the frozen Pi Web baseline, add typed Local API clients, and implement Profile/Course/Snapshot UI without creating another transcript.
4. **First vertical slice** — two Markdown courses, one session per course, current-course retrieval, clickable Span, forged cross-course citation rejection, refresh/restart recovery.
5. **Assessment product gate** — durable private vault, adversarial tests, student exercise/attempt/hint/solution UI.
6. **Visual sandbox and Stage** — separate runner, computation receipts, artifact revision gate, and five renderer views.
7. **Physical Teacher split** — distinct student/teacher builds and recursive private-asset scan.
8. **Evaluation and release** — frozen benchmark, real-provider smoke, multi-seed report, CI, packaging, migration, backup, and rollback.

## Definition of the merged checkpoint

This checkpoint is successful when future work can build on stable contracts and tested Host invariants without modifying Pi's Agent loop. It must not be presented as a finished end-user Learning Harness or as completion of the full M0–M8 plan.
