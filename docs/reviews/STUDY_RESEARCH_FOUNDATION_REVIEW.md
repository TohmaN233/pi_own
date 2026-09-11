# Study & Research foundation review

Baseline: `00b19b026bb5a0c14462aa4a1b3d4e7270f0a25a`.
This is AI-assisted source and regression review, not independent human certification.

## Scope and decisions

- Reuse the native Pi AgentSession/JSONL and existing LearningHarness SQLite connection. No second chat loop or database.
- Read-only directory metadata and bounded on-demand extraction; source byte hash, text hash, exact quote and extracted-text line anchors. PDF coordinates and perfect formula extraction are not claimed.
- Explicit prerequisite DAG, explanatory nodes and epistemic states. `argument-given` is an explanation, not a verified proof. Agent claims are not learner progress.
- User and agent note authorship are separate; stale revision writes reject.
- Research proposals do not automatically start experiments. Only an explicit local user can approve and run the current saved code/plan. Approval is one-use and bound to source, roadmap, proposal and experiment versions.
- The trusted code runner has time/output bounds and filtered environment, but **is not an OS sandbox**. It has the local account's filesystem/network authority. Default off; no model run/approve tool. No stdin/PTY, package installation, scheduler or GPU claims.
- One physical math plugin serves Study and Course Builder; scope is derived from session/course/Assignment bindings. Plotly strict is exactly pinned to 4.1.0; no runtime CDN, arbitrary JavaScript or free-form Plotly options.

## Source checks and regressions

Root `npm run check`: passed, including type/format/import/lock checks.
Root `build:offline`: passed using hash-verified pinned model data.
Root isolated `bash test.sh` as non-root `oai`: exit 0.
Complete Pi Web tests: 932 passed, 0 failed, 3 pre-existing skips.
Complete Pi Web zero-warning lint: exit 0.
Production Pi Web build: exit 0; actual Study and math API routes emitted.
Core Study/runner/math plus source/identity regressions: 21 passed, 0 failed, 0 skipped.
Native Pi activation/read/note/project-conversation tests use actual SDK sessions without paid model calls.

Cases cover false source quotes, prerequisite cycles, cross-project access, user-note overwrite, concurrent revision conflicts, stale plan/proposal/source invalidation, approval replay, real Python/JavaScript execution, timeout/output budget and visualization corruption/scope. A deliberately false paper claim is represented as a candidate error with a concrete counterexample, not presumed true.

## Existing baseline test corrections

The upgraded Course Builder baseline intentionally preserves unsupported file bytes and represents coverage by file. Two older tests still asserted rejected unsupported extensions and range-shaped coverage. Their assertions now match the documented current interfaces while retaining path/encoding/signature checks. A Windows-only temporary-path test now uses platform `join`. Existing Course tool/inventory tests now expect the added shared plugin. Documented pre-existing downstream fingerprints were recorded instead of changing frozen upstream identity or removing the identity check.

## Browser evidence and release gate

The local fixed renderer painted an actual 2D polynomial using installed Plotly strict under a script-hash CSP. Local managed Chromium blocks navigation to the live local application, and its WebGL is unavailable. These are **not** reported as a successful live UI/3D test.

The permanent `Study Research Foundation` CI runs a real production server with isolated native Pi sessions, math notes, user-approved Python, 2D rendering, 3D camera rotation and Course Builder scope isolation. It uses synthetic material, no model responses and no paid providers. Its result must be read from the exact PR/head; a source file or screenshot filename is not a passing browser gate.

## Remaining limits

No mathematical correctness oracle, formal proof checker, autonomous literature novelty certificate, pedagogical quality guarantee, live multi-user authorization system, PDF coordinate highlights, complete TeX note export, notebook/PTY runtime, GPU experiment scheduling, Manim video pipeline or automatic visualization-to-Beamer insertion.

Before wider deployment: add OS-isolated runners, source-level proof obligations, structured PDF extraction, stronger access controls and real human learning evaluation. Current delivery is a trusted single-user foundation.
