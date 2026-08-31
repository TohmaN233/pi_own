# Mode Packs

Mode Pack is the user-facing unit that turns the same Pi runtime into a focused working mode. A pack fixes the prompt, Skills, plugins, workflows, tools, model preferences, and context policy that belong together for one purpose.

The safety boundary remains the existing Profile / Resource Snapshot system:

- **Profile runtime mode** determines role, tool safety, course binding, and whether a switch is hot, warm, or hard.
- **Mode Pack** supplies the pinned behavior bundle inside that boundary.
- **Resource Snapshot** is the immutable activation record. It contains exact resource version/hash pins and the compiled prompt instructions.
- **Pi JSONL** remains the only conversation transcript. Harness SQLite stores the durable current snapshot and transition history.

A Mode Pack name in the UI is not evidence that it is active. Activation resolves every required component against the installed Resource Catalog, creates a content-addressed definition, prepares a new immutable snapshot, verifies the candidate Pi runtime, and only then advances the session binding.

## Built-in packs

| Pack | Runtime envelope | Current state |
| --- | --- | --- |
| Tutor (`student-learn`) | course-bound student / grounded publication | Installed |
| Practice | course-bound student / no Pi coding tools | Installed |
| Teach-back | course-bound student / grounded publication | Installed |
| Visual Lab | course-bound student / structured visual tools | Declared; unavailable until the visual tools and HTML Stage are installed |
| Teacher Prep | teacher | Declared; requires a hard role/build transition |
| Coding | general | Declared; requires a hard transition out of a bound learner session |
| Creative | general | Declared; requires a hard transition out of a bound learner session |
| General | general | Declared; requires a hard transition out of a bound learner session |

Tutor, Practice, and Teach-back share the existing verified learner runtime. Teach-back changes the prompt, Skill and workflow bundle while retaining the same course and Pi session identity.

## Adapted education components

The first education catalog distills the useful parts of OpenMAIC's MIT-licensed Skills into smaller Pi-native components. The implementation and wording here are original and avoid OpenMAIC-specific classroom, slide, voice, and virtual-agent assumptions.

Installed components include:

- backward lesson blueprint;
- learning-to-learn actions such as retrieval, prediction, and self-explanation;
- Feynman-style teach-back;
- evidence ledger and fact checking;
- curriculum continuity and structural concept revisits;
- minimum-edit revision discipline;
- learning-by-doing;
- evidence-based personal Skill extraction;
- Tutor, Practice, Teach-back, Visual Lab, Coding, and Creative workflows.

These are guidance resources. Tool allowlists, course isolation, assessment capabilities, answer publication, and snapshot commits remain code-enforced Host boundaries.

## Custom learner packs

The Harness **Modes** panel creates a custom course-bound learner pack. The current custom entry supports Tutor-, Practice-, or Teach-back-based workflows and installed education Skills.

A custom pack must:

- use an id under `custom.*`;
- remain in the student role;
- require the current course;
- use the `student-learn` or `practice` runtime envelope;
- declare no Pi coding tools;
- use only components that the server lists as installed;
- include a non-empty user prompt.

The server strictly parses the draft, pins every selected component by version and SHA-256 content hash, compiles the user prompt into the immutable snapshot, and rejects missing required resources or unsafe tools. A committed custom pack remains in the session's snapshot history and can be selected again after restart.

Custom prompt text is user-configured task guidance. It cannot change platform security, the active tool allowlist, course isolation, assessment gates, or system/developer instructions.

## Activation trace

```text
Mode Pack draft or built-in id
        ↓ strict parser
installed Resource Catalog lookup
        ↓ exact version/hash pins
content-addressed Mode Pack definition
        ↓ Profile safety + course checks
immutable Resource Snapshot
        ↓ candidate Pi runtime + active-tool verification
Pi binding revision commit
```

Failed preparation changes neither the live runtime nor the active snapshot. A failed candidate build releases the pending transition and leaves the old durable binding authoritative.

## Current boundary

This checkpoint completes the common Mode Pack contract, built-in catalog, custom course-bound entry, prompt injection, activation inspection, and durable learner switching. It does not yet implement:

- a global cross-session custom Mode Pack library;
- hard transitions from a bound learner session into Coding, Creative, General, or Teacher roles;
- Visual Lab's separate sandbox runner and interactive HTML Stage;
- plugin installation from inside the Mode Pack editor;
- full P5 evaluation/release evidence.

Those remain later P3–P5 work on top of the same contract rather than separate mode systems.
