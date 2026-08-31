# Mode Pack / Education checkpoint — 2026-08-31

Base commit: `4bc23f831b2da0f98a3736c24facd225debc9508`

This document describes the branch checkpoint. It distinguishes implemented deterministic boundaries from product wiring and evaluation that remain future work.

## P0 — Current education experience

Implemented in this branch:

- a canonical grounded-Markdown renderer that exposes each Claim's public `reason`;
- an integration check requiring the existing grounded publication renderer to contain `claim.reason` or call the canonical helper;
- regression checks for cited links and Claim scope display.

Exit condition:

- `scripts/mode-pack-integration.test.mjs` must confirm that the existing `learning-harness-extension.ts` publication path, not only a new helper, exposes the reason.

## P1 — Mode Pack foundation and custom entry

Implemented:

- closed versioned Mode Pack contract;
- built-in Education Tutor, Practice, Teach-back, Visual Lab, Coding, Creative, and General definitions;
- compatibility aliases for `student-learn` and `practice`;
- required versus optional Skill/plugin/package resources;
- effective prompt replacement and Hashing;
- candidate Runtime prepare → inspect → receipt verify → commit contract;
- hard transition detection for role or context-kind changes;
- immutable custom revisions in SQLite/WAL with parent Hash validation;
- durable workflow state with compare-and-swap revision and rebinding refusal;
- `/mode-packs` custom editor and bounded same-origin `/api/mode-packs` validation/publication endpoint;
- explicit separation between source-tree resource preview and actual Runtime activation.

Still required before calling P1 a complete end-user mode switcher:

- connect `ModeRuntimeAdapter` to the existing live Pi `AgentSession` replacement seam;
- persist the verified activation receipt in the same recovery protocol as the existing Resource Snapshot transition;
- expose the active receipt in the existing session Snapshot Inspector;
- browser E2E for switch, crash, reconnect, fork, and late-SSE reconciliation.

## P2 — Accepted education Skills

Implemented as separate Hash-verified Skill files:

- grounded tutor;
- backward design;
- Teach-back;
- learning-to-learn;
- curriculum planning;
- spiral revisits;
- focused fact check;
- deep research ledger;
- surgical editing;
- learn-by-doing;
- evidence-based personal Skill creation.

The loader verifies path containment, frontmatter identity, content Hash, required/optional sets, and a reproducible Skill-load receipt. These Skills do not grant permissions; their machine-enforced boundaries live in Hosts and Workflows.

## P3 — Durable education workflows and concept evidence

Implemented deterministic contracts for:

- LessonBlueprint with evidence and transfer requirements;
- Tutor/Practice/Teach-back/Curriculum/Spiral/Fact-check/Research/Learn-by-doing/Personal-Skill/Visual workflow kinds;
- learner-turn gates and replay protection;
- Practice attempt-before-feedback;
- Teach-back explanation → at most two gaps → revision → transfer;
- durable workflow recovery through the Mode Pack Registry;
- ConceptLearningRecord spiral-growth validation;
- research status separation: verified / contradicted / unsupported / not-yet-verified;
- evidence plus explicit user approval before personal Skill publication.

Still required:

- UI projections for Teach-back and concept records;
- richer rubric evaluation and authoring authorization;
- model-level tests proving output behavior under adversarial prompts, in addition to the deterministic state-machine checks.

## P4 — Visual Lab

Implemented deterministic vertical slice:

- data-only VisualActivitySpec;
- matrix transform and insertion-sort trace activities;
- separate bounded Node worker with no filesystem, shell, VM, dynamic-import, or network API in its implementation;
- input/output/step/time/cancellation budgets;
- computation receipt verification;
- immutable draft → verified → published Visual Artifact revisions;
- result Hash matching and accessible text fallback;
- prediction → verified observation → learner observation → transfer workflow.

This is not described as a general security sandbox. It accepts only two closed data-only activity kinds. The remaining static renderer types need the same worker/receipt path before Visual Lab is complete.

## P5 — Security, evaluation, release, and Teacher boundary

Implemented in this checkpoint:

- deterministic cross-platform CI on Node 22.19 for Ubuntu and Windows;
- source-wiring integration checks;
- exact tests for parser closure, activation mismatch, immutable custom versions, recovery, learner gates, visual receipts, and publication ordering;
- architecture decision and OpenMAIC adaptation notice.

Not yet complete:

- physical Teacher Studio package/build separation;
- recursive scan of real production bundles and exported course packages;
- browser E2E and process-crash fault injection;
- frozen real-provider/model benchmark runs;
- migration/backup/rollback commands for the combined existing Harness DB plus Mode Pack and Visual databases;
- release packaging and remote CI evidence from the merge commit.

## Deterministic check

```powershell
node --experimental-strip-types --test scripts/mode-pack-*.test.mjs
```

A green deterministic check establishes the stated contracts. It does not establish that a model is pedagogically effective, that every browser path is wired, or that Teacher resources are physically absent from a production student bundle.
