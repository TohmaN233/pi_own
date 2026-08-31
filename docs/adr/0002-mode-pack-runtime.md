# ADR 0002: Versioned Mode Packs extend the existing Pi runtime host

- Status: Accepted for implementation checkpoint
- Date: 2026-08-31
- Base: `4bc23f831b2da0f98a3736c24facd225debc9508`

## Context

The product needs named modes such as Education, Coding, Creative, and future user-defined modes. A mode must replace a coherent set of prompt layers, Skills, plugins or packages, tools, workflows, context bindings, UI capabilities, and artifact types. Merely appending a prompt fragment or toggling a toolbar does not establish that the model received the selected resources.

The repository already treats Pi as the sole agent-loop and transcript owner and already has immutable Resource Snapshots, session bindings, transition recovery, and course isolation. A second profile/session system would create conflicting authorities.

## Decision

1. **Mode Pack is a versioned resource declaration.** Built-in and user Mode Packs use the same closed contract. User edits publish a new immutable revision with a parent content Hash.
2. **The existing Profile / Resource Snapshot path remains authoritative.** Mode Pack resolution is an input to that path, not a replacement runtime or transcript.
3. **Selection, preview, preparation, inspection, and activation are distinct states.** A UI preview may use a server declaration of available resources. Activation requires a candidate Pi runtime to report the exact effective prompt and loaded Skill/plugin/package/tool/workflow set. The candidate is committed only after the receipt matches.
4. **Required resources fail closed.** Optional resources may be omitted only with an explicit degradation list.
5. **Prompt layers are compiled into a new effective prompt.** Switching modes replaces the previous mode prompt; it does not keep appending fragments.
6. **Warm transitions are limited to the same role and context kind.** Role changes, course↔workspace↔creative-project changes, or bound↔unbound changes require a new Pi session or explicit fork.
7. **Custom Mode Packs and Skills are user-controlled guidance.** They cannot enlarge tool permissions, context roots, owner access, or system/developer authority.
8. **Education methods are small composable Skills plus durable Workflows.** Skill text determines teaching behavior. Workflow state and Host validators enforce learner-turn gates, evidence identity, revisions, and publication rules.
9. **Visual Lab accepts data-only deterministic Specs.** It does not execute arbitrary HTML or learner code. Computation receipts and immutable artifact revisions are required before publication.

## Rejected alternatives

- Importing the OpenMAIC runtime or Director as a second agent loop.
- Loading every education Skill into every answer.
- Treating a selected Skill name or prompt instruction as proof that the file was loaded.
- Mandatory virtual classmates, narration, audio, video, or slide-deck generation for ordinary learning.
- Prompt-only protection of private solutions, tool access, or cross-course boundaries.
- Forcing consecutive activities to use different widgets regardless of learning intent.
- Last-write-wins editing protected only by an instruction to read first.

## Consequences

- Existing `student-learn` and `practice` names remain compatibility aliases for built-in Education Mode Packs.
- Existing snapshots stay immutable; editing a custom Mode Pack affects only explicitly selected future revisions.
- A concrete Pi Web adapter still has to connect the candidate activation contract to the live session replacement seam. Until that integration and its browser E2E pass, a published Mode Pack definition is not automatically an active mode.
- Teacher-only resources, arbitrary code execution, and private assessment data remain outside student Mode Packs.
