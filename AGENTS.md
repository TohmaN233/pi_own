# Development Rules

Course Builder's physical extension owns a persistent production delivery loop (`pi-web:course-delivery` in native Pi JSONL). Both direct chat and workspace prompts route semantic requirements to a saved product, then `agent_end` queues a native follow-up until `delivery_finish` verifies a new artifact, complete quote evidence and current deck compile/review. Do not equate assistant `stop`, a save, or compile success with product completion. Teacher revision tasks complete only after this delivery gate. Keep user abort, repeated no-progress and exhausted continuation budget visibly unfinished. Semantic relevance of the requirement checklist remains the model's responsibility; substring evidence is not a universal correctness proof. Native faux-provider regression: `apps/pi-web/lib/course-builder-delivery.integration.test.mjs`.

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
