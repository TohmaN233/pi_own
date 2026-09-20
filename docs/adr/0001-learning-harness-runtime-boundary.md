# ADR 0001: Keep Pi native and add a deterministic Harness control plane

- Status: Accepted for V1 implementation; amended 2026-09-20
- Date: 2026-08-29
- Plan: `docs/PI_LEARNING_HARNESS_DETAILED_PLAN_V001.md`

## Decision

The Learning Harness will not implement a second Agent loop.

Pi remains authoritative for model calls, native `AgentSession` / `AgentSessionRuntime` behavior, message/tool turns, retries, queues, steering, follow-up, compaction, abort, and the Pi JSONL transcript.

New Learning Harness packages own deterministic product state and validation outside that loop. The first shared boundary is `packages/harness-contracts`.

## Host authority

The V1 Host topology is modular, not a microservice topology:

- Runtime Host: session lifecycle binding and reconciliation.
- Profile Host: immutable effective resource snapshots.
- Course Host: immutable course versions and session/course binding.
- Knowledge Host: source spans and grounding packets.
- Learning Host: timeline and mastery projection.
- Assessment Host: attempts, hints, answer capabilities, and solution isolation.
- Visual Host: structured visualization specs, sandbox execution, and artifacts.
- Workflow Gate: publication and completion validation.
- Teacher Host: optional package that may be absent from student builds.

Each authoritative state family has one writer. Other modules request changes through typed commands.

## Hard rules

- Course changes never silently rebind an existing session.
- Resource/profile changes resolve to immutable snapshots.
- Student answer gating is enforced by Host capability checks, not prompt wording.
- Course material is data, never executable system instruction.
- Visual output has two explicit contracts. Fixed-renderer visuals are derived from structured specs. Teacher-authored standalone interactive visuals must be linked course-material HTML, validated before registration and again before serving, and run under a network-denying Content Security Policy.
- Harness JSONL entries are metadata references only; Pi JSONL remains the transcript source of truth.
- Contract parsing fails closed on unsupported versions and unknown fields.

## Consequences

The initial implementation can progress without Pi Web present in this repository. UI integration becomes a later adapter problem rather than a prerequisite for establishing security and state contracts.

Any future change that duplicates Pi queueing, retries, transcript ownership, or tool-loop semantics requires a new ADR and must explain why a thin adapter was insufficient.
