# Pi Learning Harness progress

Last updated: 2026-08-31
Reference plan: `docs/PI_LEARNING_HARNESS_DETAILED_PLAN_V001.md`

## Current status

The repository contains a reviewed **Learning Harness foundation and library-level prototype**. It is not yet a complete V1 application.

Windows local launch and the current manual verification path are documented in [LOCAL_TESTING.zh-CN.md](LOCAL_TESTING.zh-CN.md).

PR #1 establishes the contracts and core Host boundaries needed to continue implementation without replacing Pi's native Agent loop or transcript. It also contains early in-memory reference implementations for later milestones. Those reference implementations prove interfaces and hard invariants; they do not by themselves satisfy the full product exit conditions in the plan.

## Mode Pack checkpoint

The first Mode Pack vertical slice is implemented on top of the existing Profile / Resource Snapshot boundary. Tutor, Practice, and Teach-back compile fixed prompts, pinned Skills/plugins/workflows, and runtime policy into immutable snapshots. The Harness Modes panel can create a strict custom course-bound learner pack; its selected resources and prompt survive restart in snapshot history. Coding, Creative, General, Teacher Prep, and Visual Lab are declared in the same registry but remain unavailable where a hard role/runtime transition or missing visual tools would be required.

See [MODE_PACKS.md](MODE_PACKS.md) for the contract and current boundary.

## Status vocabulary

- **Complete**: the milestone's current repository-level exit condition is implemented and reviewed.
- **Prototype**: the core library behavior exists, but product integration, durable storage, UI, or full verification remains.
- **Future**: not implemented in the repository.

## Milestone status

| Milestone | Status | What exists now | What remains |
| --- | --- | --- | --- |
| M0 — baseline and architecture | **Complete** | Pi upstream identity, reproducibly vendored Pi Web v0.8.11 tree and manifest, YN reference identity, and ADR 0001 freezing Pi as the only Agent runtime/transcript owner | Broaden the upstream contract suite before a future Pi Web sync |
| M1 — Harness contracts and Runtime Host | **Integrated vertical slice** | Versioned contracts; fail-closed parsers; Pi custom-entry Runtime journal; binding, snapshot, idempotency, workflow transition, recovery rules; arbitrary validated fork/clone binding ancestry; navigation recovery only from an exact durable ancestor; Pi Web permits a direct empty fork only after verifying its JSONL header names the supplied parent; failed child inheritance and failed new-session binding discard only the new JSONL and invalidate its caches; real Pi JSONL parent/child/grandchild, copied-history, direct-fork, and rollback tests | Browser-level crash/reconnect E2E and late-SSE workflow reconciliation |
| M2 — Profile / Resource Snapshot | **Integrated vertical slice** | Durable immutable Snapshot history and pending-transition recovery; a course-bound student session can warm-switch `student-learn ↔ practice` without changing its Pi session ID or JSONL; binding revisions advance in the Runtime journal; real Pi active tools are strictly snapshot-limited (student: publication submit only; practice: none); Profile selector and Snapshot Inspector expose runtime verification and unavailable modes | Snapshot-backed loading of additional real Pi Skills/packages; exhaustive process-crash injection around the cross-store commit boundary; hard course/role transition; Visual and Teacher runtimes |
| M3 — Course Host and isolation | **Integrated vertical slice** | Immutable CourseVersion objects; SQLite/WAL durable composition; SHA-256-addressed source bytes; Markdown/text/code/notebook parsing; concrete bounded `pdftotext` adapter; ZIP/PDF import UI; durable A/B isolation and restart tests | Normalized manifest/FTS tables, filesystem content store, exact PDF page anchors, and duplicate-import UI polish |
| M4 — Grounded teaching and Timeline | **Integrated vertical slice** | A course-bound Pi `AgentSession` now issues a current-course Grounding Packet before each run, stages only structured claims through an inline Pi tool, revalidates and atomically publishes the receipt plus an `answer-published` event, and replaces the final JSONL/SSE message with canonical cited Markdown. Raw assistant deltas and snapshots are withheld until that gate succeeds. The typed Timeline panel is durable, shared by local learner/course across sessions, and opens cited spans in the existing Source Inspector. | Semantic claim-entailment review, computation and external evidence receipts, richer Timeline projections, and a bounded model repair policy beyond the tool's validation feedback |
| M5 — Assessment and answer gate | **Integrated vertical slice** | A protected SQLite private-solution vault, public Assessment state in the Harness transaction, meaningful attempts, first-result evaluation, hint ladder, server-scoped one-use capability, restart-safe consume/replay checks, and a bound-session Practice panel | Rich rubric evaluation, prompt-injection/direct-tool bypass testing, authoring UI and authorization, teacher-only exercise workflow, and broader browser E2E coverage |
| M6 — Visual Lab | **Prototype** | Structured specs and five deterministic static renderers: function plot, matrix transform, algorithm trace, graph trace, and state machine | Separate no-network sandbox runner; computation receipt Host; artifact revision/publication gate; HTML Stage and popup integration; snapshot/accessibility tests |
| M7 — detachable Teacher Studio | **Prototype** | Teacher draft/controller interfaces and object-level student manifest scanning | Physically optional package/build graph; concrete authorization; teacher UI; immutable publication workflow; recursive scan of real built artifacts and exported course packages |
| M8 — external evaluation, security, release | **Future** | No complete M8 implementation. PR #1 only adds narrow deterministic unit-style checks for the foundation | Frozen benchmark courses/cases, Run Manifest pipeline, multi-seed/provider evaluation, threat-model execution, full CI evidence, release packaging, migration, backup, and rollback |

## Completed code boundaries

The following repository components now form the foundation and first integrated vertical slice:

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
- `packages/learning-harness`
- `apps/pi-web`

They are intentionally separate from Pi's native model loop, queue, retry, compaction, and JSONL transcript code.

## Review corrections made before merge

The final review closed three blocking fail-closed defects:

1. Answer drafts now pass through an exact runtime contract parser. Unknown Claim scopes and unknown fields cannot bypass the publication rules; an empty Claim list is rejected.
2. Solution Capabilities now validate their deterministic identity, content hash, declared use count, issued/expiry timestamps, invalid read timestamps, and the exact expiry boundary. Tampered restored state is rejected.
3. Once a Pi session is course-bound, its Runtime journal cannot record a Resource Snapshot for another CourseVersion.

Regression coverage was added under `scripts/learning-harness-review-hardening.test.mjs`, and the existing Runtime Host test was updated for course-bound Snapshot isolation.

## Important limitations of the merged foundation

- Visual, Teacher, and several Profile Hosts remain reference implementations. Assessment now persists public state in the Harness SQLite transaction and stores immutable private solutions in a separate table; it is not exported through the general state blob.
- Pi Web is vendored and has a typed Local API, course/Mode Pack bar, ZIP/PDF import, Source Inspector, durable shared Timeline, a bound-session Practice panel, a Snapshot Inspector, and a custom learner Mode Pack editor. Tutor, Practice, and Teach-back use the installed learner runtime. Visual Lab, Teacher Prep, Coding, Creative, and General remain explicit unavailable hard/missing-runtime transitions rather than pretend working modes.
- PDF extraction requires the shipped `pdftotext` adapter and a local `pdftotext` binary. It bounds PDF input, extracted stdout, stderr, execution time, extracted text, total course text, and span count. Validated size-budget rejections return 413; extractor configuration, spawn, stdout/stderr, cleanup, and timeout failures are operational errors, are logged, and return 500. Exact page-number anchors are not implemented.
- Source bytes are content-addressed SQLite BLOBs in this vertical slice; the planned filesystem content store and normalized/FTS schema remain future work.
- A SQLite write failure, including failure to acquire `BEGIN IMMEDIATE`, poisons the live composition root so uncommitted in-memory Host state cannot be used or persisted later; the process must reopen the last committed database state.
- Course request bodies and decompressed supported ZIP entries are bounded. Import still buffers accepted material bytes because immutable CourseVersion publication requires their complete content.
- Visual rendering is bounded and static, but it is not yet executed in a separate OS/container sandbox.
- The student scanner examines structured bundle data, not a real packaged application or recursive filesystem tree.
- Grounding verifies issued/current Span identities and scope rules and blocks raw model prose from the course-bound browser stream until a publication receipt exists. It does not prove semantic entailment of arbitrary model prose, create computation receipts, or validate external-source receipts.
- GitHub Actions produced no run for PR #1. The repository therefore does not claim independent remote CI success for this merge.

## Planning pause after the M2 vertical slice

The M2 integrated vertical slice has passed implementation review and an independent final review. Product implementation is paused here at the owner's request while the remaining work is replanned. The items below are planning inputs, not an approved execution sequence; do not start them until a replacement plan is accepted.

1. **Harden the completed vertical slice** — add browser crash/reconnect E2E, normalized SQLite migrations/FTS, filesystem source storage, and PDF page anchors.
2. **Mode Pack activation hardening** — extend the current content-addressed prompt/Skill/plugin/workflow catalog with plugin installation, complete fault injection around runtime replacement, a global custom-pack library, and hard course/role transitions.
3. **Assessment hardening** — richer rubric evaluation, prompt/direct-tool bypass tests, authoring and teacher authorization, and browser E2E.
4. **Visual sandbox and Stage** — separate runner, computation receipts, artifact revision gate, and five renderer views.
5. **Physical Teacher split** — distinct student/teacher builds and recursive private-asset scan.
6. **Evaluation and release** — frozen benchmark, real-provider smoke, multi-seed report, CI, packaging, migration, backup, and rollback.

## Definition of the merged checkpoint

This checkpoint is successful when future work can build on stable contracts and tested Host invariants without modifying Pi's Agent loop. It must not be presented as a finished end-user Learning Harness or as completion of the full M0–M8 plan.
