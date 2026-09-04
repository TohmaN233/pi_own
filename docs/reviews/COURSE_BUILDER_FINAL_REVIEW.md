# Course Builder final review

Review target: `feat/course-builder-beamer` against `main`.

## Reviewed boundaries

- Course Builder state shares the Learning Harness SQLite/WAL ownership boundary rather than creating a second transcript or agent loop.
- Course projects, material analyses, Semester Plans, Lesson Plans, Beamer Decks, compilation receipts, reviews, and final acceptance use explicit immutable revisions.
- Agent-submitted drafts cannot include teacher-controlled approval, review, acceptance, target revision, or target hash fields.
- A newer Semester Plan makes dependent Lesson Plans stale; a newer Lesson Plan makes dependent Beamer Decks stale.
- Only the current Deck revision bound to the current approved Lesson Plan can compile, review, publish, or receive final acceptance.
- A failed later compilation does not leave a partial PDF that can be treated as the current successful artifact.
- PPTX is parsed as bounded ZIP/XML input and is described as semantic extraction, not layout fidelity.
- TeX compilation uses a dedicated adapter, `-no-shell-escape`, bounded runtime/output/logs, project-confined paths, and content-addressed receipts. It is not described as an OS sandbox.
- Course Builder Mode Pack activation must load the declared planning, Beamer, evidence, revision, visual, and workflow resources and expose only its dedicated tools.
- Pi remains the sole AgentSession runtime and Pi JSONL remains the sole conversation transcript.
- Noi1r `beamer-skill` material is pinned, attributed, and redistributed under its MIT license.

## Merge gate

The branch is mergeable only when all of the following are true on the final head:

1. root `npm ci --ignore-scripts`;
2. root `npm run check`;
3. all Course Builder and Mode Pack regression tests;
4. complete root tests and build;
5. Pi Web install, TypeScript, lint, tests, and production build;
6. no recovery-only `chatgpt-course-builder-*` workflow remains;
7. the formal `.github/workflows/course-builder.yml` succeeds on the pull request;
8. no unresolved blocking review thread remains.

## Deliberate non-claims

The checkpoint does not claim pixel-faithful PowerPoint editing, editable PPTX export, arbitrary-code execution, container-level TeX isolation, automatic screenshot-based visual approval, or the final physical Teacher/Student package split. Those remain separate milestones and are listed in the user acceptance checklist.
