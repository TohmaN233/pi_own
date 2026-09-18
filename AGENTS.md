# Development Rules

Construct runtime and default resource catalogs with `createBuiltinModeResources()` so local Skill edits are read at catalog construction, not frozen at module import. Existing resource snapshots remain immutable; required missing/empty files and mid-read drift still fail explicitly. The legacy `BUILTIN_MODE_RESOURCES` export is a captured snapshot, not the runtime catalog source.

Teacher scripts now deliver TeX and PDF. Reuse the bounded XeLaTeX engine with a distinct `teacher-notes` document class policy and independent receipt/log/PDF ledger; never manufacture Beamer identities for scripts. `compile_teacher_notes` and `read_teacher_notes_compile_log` support the native repair loop, and script delivery requires a successful current script revision/hash receipt. Desktop TeX editing places source on the left and PDF on the right, each scrollable; preserve draft and revision-conflict handling. PDF transport remains JSON/base64 through `PdfPreview`, not a raw iframe URL.

Teacher TeX uses soft wrapping without modifying source bytes. Bidirectional source/PDF navigation uses the exact successful receipt's persisted SyncTeX map, never text guessing or proportional scrolling. Keep old receipts readable without maps; recompiling enables navigation. Verify project, notes revision/hash and map/PDF integrity before lookup, and reject stale async results. Viewer messages must match the same-origin iframe and file identity; PDF coordinates are points from the top left.

Course references are only non-Assignment `local-link` records under teacher-selected folders. Generated image copies are internal assets exposed separately as `generatedAssets`, never reference-reading inputs. Orphan cleanup must trace all historical products, checkpoints and teacher scripts before atomically deleting records and source blobs; never delete teacher folder files. Teacher lecture scripts are independent versioned TeX products in `course_builder_teacher_notes`, Host-bound to an existing deck and its observed revision/hash. They can be generated or patched for an accepted old deck without altering the deck or requiring fresh semester approval. Combined Beamer deliveries retain their deck target and cannot finish before matching lecture notes exist.

Course reference acquisition is `course_builder add_material`, distinct from generated Beamer assets. Resolve destination from the bound course's existing `local-link` source roots; never invent a new material directory. Uploads and model imports share lazy-reference registration in `course-builder-material-library.ts`, retain existing files/planning, and fail clearly when a root is absent or ambiguous. HTML capture preserves source structure as Markdown through a real HTML parser, with URL provenance and explicit extraction failures; it is page capture, not an implicit site crawl. Native browser/terminal acquisition may produce a local file for the same importer when dynamic/authenticated pages need it. Standalone acquisition uses the `materials` delivery kind bound to the Host-owned project and verified imported IDs; auxiliary imports retain a lesson/deck delivery target. Assignment sources must never enter the course library implicitly.

Course Builder teacher defaults include native read/write/edit and a platform-resolved terminal. Skill instructions must not contradict that capability or mistake TeX compiler restrictions for Agent file permissions. Source generation uses the native Pi tools; generated PNG/JPEG/PDF assets are imported from `cwd/.pi/course-builder/<projectId>/` through `import_generated_asset`, whose Host boundary owns material IDs, course/lesson scope, byte identity and replay. `patch_deck.addAssetMaterialIds` appends assets atomically while retaining existing source and asset baselines. Never extend these teacher defaults to Study/Research's scoped tool policy. Test the real R Markdown → PNG → import → patch → XeLaTeX chain with `PI_TEST_RSCRIPT` and `PI_TEST_XELATEX=1` in `apps/pi-web/lib/course-builder-generated-chain.test.mjs`.

An existing non-student conversation may move into a course from `/projects`. Activate and verify its Course Builder Mode Pack before creating the irreversible Course Builder session binding; only then move its folder membership and return the course workspace URL. Preserve the Pi JSONL and chat history. Already-bound course conversations cannot move out or rebind to another course.

## Study & Research direction (engineering integrated; academic acceptance pending)

Implementation boundaries and checks are documented by topic under `docs/STUDY_*.zh-CN.md`; local acceptance records tied to private papers, course inputs or machine paths stay outside Git. Full academic release acceptance remains pending. `study-mode-policy.ts` rejects raw builtin tools and out-of-phase resources during runtime-plan construction; preserve that boundary when adding personal settings or restore paths. The custom visual renderer runs generated calculation code in a bounded Worker inside an opaque sandbox frame; renderer messages are display evidence only and never grant validation or publication.

The repository code, topic documentation and automated tests are the maintained source of truth for implemented behavior. Private planning packets and local acceptance artifacts are not release evidence and must not be committed. The old overlay, Skills and M0 evidence are not the final requirements.

First release includes both Study and Research execution on the user's local Windows machine, shared durable background tasks, R/Python code cells, customizable visualizations with programmatic validation plus independent review, source-first TeX/Word and mathematical PDF reading, synchronized notes/graph, explicit manuscript changes and teaching reuse. Study does not initiate research ideas or quizzes. Research starts explicitly in the same conversation; scoped authorization allows smoke runs, approved experiments and bounded exploration without per-command reapproval. Python uses project environments; R uses the existing global library, with consent before upgrading/downgrading/removing existing packages. No model-cost/token-budget feature. Preserve existing Pi runtime/JSONL, shared Harness database and project ownership. Follow the full plan and latest evidence matrix for implemented boundaries and pending user-model academic acceptance.

Use the user's Codex Agents Workflow for implementation and review: discover matching enabled Workflows and honor their pinned Providers, assign bounded work without duplicate exploration, retain real run/task evidence, and keep architecture and final acceptance in the primary agent. Before broad implementation create a branch and preserve existing uncommitted Course Builder changes. Do not install the old foundation registration/Skills unchanged and call the mode complete.

The Study & Research pack is dedicated (general role/runtime, no course binding), not the default generic pack's builtin preset. Phase-specific snapshots keep learning capabilities in Research while excluding research-starting Skills/tools from Study. Neither phase may use raw builtin shell/read/write/grep as a bypass around scoped Host source access and execution admission. Background tasks retain their own authorized snapshots across interactive phase changes; task viewing/cancellation remains available. See plan section 4.1 and acceptance E06/S02.

Background reading now uses `LearningHarness.studyAgentQueue` and a packaged detached Pi SDK worker with one conservative shared model slot. Each task has an independently allocated native Pi JSONL and a frozen, cited packet; the original conversation remains available for immediate questions. Fsync the report before product completion. Unknown post-dispatch errors reconcile the original context and never silently issue another model turn. Completion rejects evidence whose source is no longer current, and updates read checkpoints, automatic notes and graph in one transaction while protecting human edits. Local faux/HTTP fixtures prove this protocol only; they do not establish academic correctness.

Research's `research_run` tool consumes existing user-approved execution scopes or bounded smoke defaults; it cannot issue grants. Browser authorization requires the dedicated same-origin mutation guard, and raw HTTP/shell capabilities must never be added to this mode without reassessing that boundary. Reconstruct immutable run intent and replay committed requests before rejecting new work on current phase/plan checks. Scope/run/promotion records retain complete scientific plan snapshots so later revisions cannot erase old hypotheses or methods. Implementation-repair provenance must bind a failed Research record, the same cell's newer changed code, and unchanged scientific semantics. Process completion, numerical checks, independent review and user-confirmed conclusions remain separate facts.

Package changes use the shared Harness ledger and environment-identity lock. Claiming installation waits for active execution; claiming new execution waits for package locks in the same SQLite transaction. Unknown installer state retains its lock for reconciliation. The detached environment worker imports only the Harness and package engine, never frontend RPC/session activation. Preserve actual before/after inventory and explicit consent for changes to existing packages.

Numerical visual receipts and their canonical Host validation must commit or roll back together. Numerical success does not establish browser interaction, academic review or formal-use approval. Source-free result reviews cite the exact frozen result and origin, never invented source fragments; they retain findings without creating unlocated source notes. Preserve the original source-reading packet protocol when extending result review so old JSONL remains readable.

Frozen supplementary inputs use one shared 16 MiB per-file / 32 MiB total limit and canonical byte hashes. Native running telemetry uses the real process stopwatch and captured stdout/stderr bytes; artifact output is accounted at terminal harvesting, not represented as live filesystem usage. No automatic execution checkpoint/resume is provided; disclose retained partial output and new-run semantics before launch. Installer recovery requires an absolute supervisor helper and durable process-creation FILETIME; incomplete legacy identity must remain locked. Preserve command-specific installer environment variables through the supervisor.

Result-learning prompts carry only exact result/task identity and revision. Both phases can use `study_paper action=read_result`; Research can also use `study_results action=read_result`. Read a single allowlisted frozen field per page, at most 8000 UTF-16 units, using the returned contentHash as the next fieldHash. Check project identity again after asynchronous state resolution. Model-facing state/save responses omit full code/log origins; browser result state remains separate. Do not replace user-model academic acceptance with the offline protocol provider or a small numerical smoke.

## Existing Course Builder invariants

Course delivery identity is Host-owned. `course-builder-delivery-target.ts` resolves typed product/lesson/slot references against the bound course; workspace dispatch journals a one-use prompt-bound selection in `pi-web:course-delivery-request`. Never lock a model string as an unverified product ID or infer identity from overlapping field names. Saves bind their actual returned artifact; `delivery_finish` requires no product ID. Validate/inject selected parent IDs before writes while retaining observed revision guards. Restore legacy deck/lesson misbindings from real ownership, append a repair record, and preserve the task baseline, artifact revisions, evidence and teacher approval. A repair alone is not completed delivery.

Course Builder's physical extension owns a persistent production delivery loop (`pi-web:course-delivery` in native Pi JSONL). Both direct chat and workspace prompts route semantic requirements to a saved product, then `agent_end` queues a native follow-up until `delivery_finish` verifies a new artifact, typed content/Host operational evidence and current deck compile/review. Do not equate assistant `stop`, a save, or compile success with product completion. Teacher revision tasks complete only after this delivery gate. Keep user abort, repeated no-progress and exhausted continuation budget visibly unfinished. Semantic relevance of the requirement checklist remains the model's responsibility; substring evidence is not a universal correctness proof. Native faux-provider regression: `apps/pi-web/lib/course-builder-delivery.integration.test.mjs`.

Beamer presentation validation blocks malformed line-break/formatting commands (`TEX_COMMAND_LEAK`, with source lines) at save, compile and teacher acceptance, including acceptance of legacy reviews. Keep valid TeX commands and literal code examples legal. Accepted decks can immediately produce a requested next draft without a UI unlock; acceptance cancellation is a teacher-only action that retains source and evidence.

## Learning Harness

- `apps/pi-web` vendors Pi Web v0.8.11 at commit `28bab3c25f5f6770c9b0b745ebbfec1c27f7b948`. Keep upstream changes traceable through `docs/pi-web-upstream-manifest.json` and `docs/pi-web-upstream-map.md`.
- Pi remains the only `AgentSession` runtime and Pi JSONL remains the only conversation transcript. Harness SQLite stores deterministic product state and Pi custom entries store binding/snapshot references.
- `packages/learning-harness` is the durable SQLite/WAL composition root. Do not create a second store or bypass Host APIs from Pi Web routes.
- PDF course import uses `PdftotextExtractor`. Set `PI_PDFTOTEXT_PATH` when `pdftotext` is not on `PATH`.
- Windows local launch and the first vertical-slice test path are documented in `docs/LOCAL_TESTING.zh-CN.md`; use `start-learning-harness.bat` or `start-learning-harness.ps1` from the repository root.
- The default product database is under the Pi agent directory at `learning-harness/learning-harness.sqlite`; `PI_LEARNING_HARNESS_DIR` overrides the directory for tests and development.
- Run `node --test scripts/learning-harness-*.test.mjs` for core checks. Run Pi Web checks from `apps/pi-web` with `npm test`, `node_modules/.bin/tsc --noEmit`, and `npm run lint`.
- Course Builder uses the same LearningHarness SQLite connection and an ordinary Pi session with the `course-builder` Mode Pack. Follow `docs/COURSE_BUILDER.md` and the current `docs/HARNESS_ACCEPTANCE_CHECKLIST.zh-CN.md`; `docs/MANUAL_ACCEPTANCE_CHECKLIST.zh-CN.md` describes the older pre-Course-Builder baseline.
- Direct Course Builder creation must work without a preselected conversation. Only an explicit create submission materializes a named Pi JSONL and binds the validated project; timestamp-based retries reuse the existing project/session without model startup. New-course fields support per-tab draft recovery and import/export.
- Course Builder workspace reads, teacher edits, material links and exports use durable ordinary-session identity without requiring a live model. The same-page Agent pane starts/upgrades the original session on entry, and model/tool tasks verify its current Mode Pack again; never create replacement blank conversations to escape stale Skill identities. Agent startup failure must leave saved course editing available. The project chooser resumes existing session bindings, and settings edits use the revision captured when the form opens.
- Course Builder local folders are stored as read-only path bindings with a lightweight file manifest. Do not eagerly inject or persist every linked file body; `read_material` resolves one bounded course source on demand. Every Assignment owns a separate folder manifest and revision; `read_assignment_material` must carry its Assignment identity, and Host code must reject course/Assignment and cross-Assignment source access. File extensions select an extraction adapter, never whether a source may be linked.
- Built-in education Skills live under `skills/` (override: `PI_SKILLS_DIR`) and are the content source for both the default catalog and Pi Web runtime inventory. Generic Mode Pack Skills load through Pi's ResourceLoader with complete prompt blocks; learner Skills are injected as complete Host-owned prompt text. Required files must be non-empty and their SHA-256 identities must match; names and menu entries alone are not loading evidence. Keep `docs/SKILL_PARITY_AUDIT_2026-09-05.zh-CN.md` and third-party notices current when adapting upstream teaching workflows.
- Pi Web uses the pinned Pi SDK 0.85.1. Session model/thinking/prompt/Skill changes create new immutable snapshots through `session-settings.ts` and the existing activation transaction; never mutate only the SDK model or prompt behind a pinned binding. Settings stay scoped to the session and mode and are restored when switching back. Runtime invalidations refresh chat controls and open settings across pages. Course Builder embeds the existing ChatWindow on the same page and activates the original session on entry, while saved course editing remains independent of model availability.
- On Windows, flush Mode Pack writes through a writable file handle. Close the process-wide LearningHarness before deleting its test directory; an open SQLite connection prevents cleanup.
- Generic/teacher Mode Packs permit normal builtin tool selection and reload through verified snapshot revisions. Resolve Bash/PowerShell from the runtime's platform and SettingsManager, keeping workflow extensions active independently of builtin presets. Learner activity tool boundaries remain enforced. Pi's original sidebar-header New control is the conversation entry; do not duplicate it inside Course Builder. Reserve the Mode Pack bar's layout row and offset fixed mobile sidebars so it cannot cover Pi's original controls. Lesson/Beamer shortcuts select a real semester slot and the server validates the current lesson and approvals before dispatch.
- Host home-directory discovery uses `apps/pi-web/lib/runtime-home.ts`. Do not let build-time file tracing evaluate and recursively include the runtime user's home; the real-tracer regression is `apps/pi-web/lib/runtime-home.test.mjs`.

Skill library rule: keep Pi Web's add/search/update controls alongside session mode selections, including in the teacher pane. New installs and their updates target configured `skills/` (`PI_SKILLS_DIR` override), preserve entire folders, and record native source/version metadata in `skills/.skills-lock.json`. Stage and validate CLI output before publishing; installation alone must not enable a mode Skill.

Course Builder planning validity uses `project.planningRevision` / `semester.projectPlanningRevision`, independently of the aggregate revision used for optimistic writes. Material import/reindexing and presentation/attribution edits do not invalidate approved planning. Shared `semesterPlanningIssue` governs both Host and UI; preserve legacy approvals and validate observable calendar/goals when planning-only history was not recorded. Task buttons pass teacher `additionalRequirements` into server-composed prompts; freeform send uses only the entered text.

Course Builder's `/course-builder/lesson` page renders and edits the persisted lesson draft without a model request. `edit_lesson` is a teacher workspace action guarded by course ownership, slot identity, expected lesson revision and semester parent revision. Save creates a new draft; approval remains explicit. Browser drafts are scoped to session/lesson and keep their original revisions to prevent overwriting newer work.

Mode Pack activation must refresh saved personal settings against the current mode definition when enabled resource identities change. Reapply model/thinking/prompt/tools and the effective optional Skill selection to a freshly resolved base, then verify and commit through the existing transaction. Never reuse stale Skill text, mutate past snapshots, or reset personal selections. Missing required resources still block activation; retries must resolve the same refreshed settings deterministically.

Project folders at `/projects` contain multiple independent Pi conversations. `LearningHarness.projectWorkspaces` stores membership and default resource snapshots on the existing SQLite connection; filesystem cwd identity remains separate from product project identity. Existing Course Builder bindings supply course membership without rewriting historical JSONL. New project conversations inherit refreshed default model/prompt/Skills settings but no messages or parent-session lineage; individual settings remain independent. Explicitly saving a conversation as project defaults affects subsequent new conversations only. Course materials, planning and artifacts remain project-owned, and Assignment runtime scope remains session-specific. Do not infer project/course membership from cwd or from the outside New button.

Course artifact PDF exports are inline by default (`download=1` explicitly downloads). The TeX sidebar editor uses teacher-only `edit_deck` with expected deck and lesson revisions; saving creates a fresh unaccepted draft without starting a model. Browser source drafts retain their base revisions. The automatic semester review shortcut is shown once for revision 1, recorded by semester identity across conversations; reloads, lesson saves and later revisions must not reopen it.

Course overview snapshots deliberately omit Beamer source. Editors must read `/api/course-builder/deck` for a complete source/revision pair and use the explicit `deck` returned by `edit_deck`; never cast the overview into an editable deck. PDF previews use the local PDF.js HTML/canvas viewer in `public/pdf-viewer.*`, shared by course artifacts and filesystem PDFs. A native PDF iframe or an `inline` header alone is insufficient: browser preferences and embedded browsers can still download it. Regression checks must verify saved TeX content before/after editing and painted PDF pixels, including attachment responses.

PDF preview transport is `/api/pdf-content`, which calls the existing authorized file/course readers in-process and sends JSON/base64 to the viewer. Never fetch PDF MIME responses from the browser for preview: native download managers on this host can hijack even fetch requests, return HTTP 204, and launch downloads. Explicit download links still use the original binary endpoints. Test both course and filesystem authorization plus zero browser downloads and rendered pixels.

Course Builder preparation checkpoints live in `course_builder_checkpoint` on the shared LearningHarness SQLite connection. Each lesson has one coverage entry per source file: materialId/sourceHash, summary, optional position text and nextLesson handoff. Reject duplicate file entries, never split by read batches. Historical range rows retain original hash-verified history and normalize to file entries when read. Independent revisions preserve lesson approval; source/parent changes make records stale. Teacher confirmation remains explicit. Model state/read_checkpoints expose these records; save_checkpoint saves planned entries. Tests: scripts/course-coverage-checkpoints.test.mjs and the workspace browser smoke.

Existing assets are the default revision baseline; full rewriting requires the user's explicit instruction to abandon them. `patch_deck` performs atomic exact-match source replacements with current deck/lesson revisions and keeps unrelated bytes and assets. Ordinary chat supports attachments through `/api/chat-attachments`; store copies under cwd/.pi/chat-attachments and send links, not whole documents in context. Course read_attachment checks conversation and Assignment identity plus source hash; attachments never implicitly join a material library.

Course Builder compilation must return actionable engine diagnostics, including traditional `!` errors without a source line, and a bounded failure log excerpt. `read_compile_log` exposes hash-verified persisted logs by receipt ID with pagination and existing project/Assignment scope checks. Ordinary TeX errors should lead the Agent through read/log/source/repair/recompile, not stop at an exit code; partial PDFs never qualify as successful compilation. Regression: `PI_TEST_XELATEX=1 node --test scripts/course-builder-host.test.mjs`.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI verifies and announces the npm release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required. After publishing, `announce-pi-dev-release` verifies every public workspace package resolves at the exact release version and that its npm tarball is available, then writes the verified release marker to R2. `pi.dev/api/latest-version` reads that marker; it must never announce a release from npm before this job succeeds.

5. **If CI publish or announcement fails**: inspect the failed job. The publish helper is idempotent and skips package versions already present on npm; the announcement job rechecks availability before updating the R2 marker. Rerun the failed job or workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

- Course delivery evidence is explicitly typed. `delivery_status` is the authoritative requirement/finish contract; compile/review/checkpoint/import proof comes from Host records, while content quotes use saved source or actual read_material windows. Never replace operational proof with an unrelated artifact substring or silently classify legacy requirements. Keep checkpoint revisions scoped per lesson and expose local-link availability without eager content ingestion.
