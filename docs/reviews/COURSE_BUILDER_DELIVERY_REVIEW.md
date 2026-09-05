# Course Builder delivery review — 2026-09-05

## Scope and identity

This is the actual source integration, not a source-transfer workflow. It preserves
Pi as the only agent/transcript runtime and the existing LearningHarness SQLite/WAL
connection as the product-state owner. The parent for remote delivery is
`4d6c2ae043fb86568ef0b0399b26b9c353ed5123`. Recovery payloads/workflows previously
merged without the product are removed from the delivered tree.

## Review performed

Implementation and tests were checked together for executable exports, real UI/API
and Mode Pack integration, source import budgets, teacher-only approval operations,
optimistic concurrency, current-parent revisions, persistence/recovery ordering,
actual PDF/log hash binding, and asynchronous runtime re-admission. This is an
AI-assisted code review, not an independent human security certification.

Regression repairs include optional author/institute defaults, awaiting runtime
admission before mutations and again after compilation, and clearing the workspace
when its session changes. Template instructions are scoped guidance, not authority
to bypass Host gates. Agent commands do not include approve or accept.

## Local execution evidence

The executable-entry/integration regression was run against the old baseline and
failed (four tests), then against the candidate and passed. The full Course Builder
suite passed **29 tests, zero failures, zero skips**, with `PI_TEST_XELATEX=1`,
including real XeLaTeX, PDF persistence, review, acceptance and fresh Host recovery.

Using Node 22.20.0 and the unchanged root/Pi Web lockfiles:

| Command | Observed exit code |
| --- | ---: |
| `npm run build:offline` (verified pinned model data already hydrated) | 0 |
| `npm run check` | 0 |
| `bash ./test.sh` (isolated non-root, non-provider test environment) | 0 |
| Pi Web `tsc --noEmit` | 0 |
| Pi Web `npm run lint -- --max-warnings=0` | 0 |
| Pi Web `npm test` | 0 |
| Pi Web `npm run build` | 0 |

The root suite retains its existing credential/network/platform skips; they are
not represented as passed live-provider tests. Stale Copilot catalog identifiers
in three tests were replaced with current **local catalog** fixtures without
changing their policy/filtering assertions or production provider implementation.
No dependency versions or minimum Node requirements were lowered.

Pi Web no longer fetches Google fonts during the build. Its existing system-font
stack remains in use. The TypeScript import checker ignores generated Next output,
with a regression proving source imports still fail correctly. The permanent CI
workflow builds pinned model data before typechecking and runs real TeX and Pi Web
checks. It neither changes repository source nor performs automatic merges.

## Remaining boundaries, not claimed as complete

This is a trusted single-user local workspace. Origin checking and the teacher UI
header are not a multi-user identity system. TeX execution is disabled unless the
owner sets `PI_COURSE_BUILDER_TRUSTED_TEX=1`; budgeted `-no-shell-escape` is not an
OS/container sandbox. Use only trusted/generated self-contained source.

PPTX import is semantic text/notes extraction, not faithful layout reconstruction.
VisualHost outputs are separate deterministic artifacts, not automatic frame
insertion. Editable PPTX export, automated screenshot approval, complete physical
Teacher/Student distribution separation, and real-provider pedagogy evaluation
remain future work. Human PDF inspection is required before final acceptance.

Remote merge status is deliberately not asserted by this document: use the actual
PR merge record, exact-head checks and the `main` Git tree. A document saying PASS
is not a substitute for executable code or GitHub state.
