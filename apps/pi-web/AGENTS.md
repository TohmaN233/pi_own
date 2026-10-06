# Pi Web - Development Notes

Host program-only updates resolve compatible registered tool interfaces through pi-CAW, without Workflow republication. Actual implementation fingerprints remain in execution receipts. Shared Course/Study launch state distinguishes exact pre-creation refusals from unknown dispatch: preserve the old diagnostic/Run identity in `previousLaunches`, allow a new intent for the same unexecuted task, and expose `重试此任务` in the teacher pane. Neither current directory absence alone nor a confirmed Run authorizes replay. Historical `HOST_TOOL_BINDING_STALE` was a pre-creation refusal, not an uncertain model execution. Keep trusted folder references readable regardless of the legacy `asset` file-kind classification.

Workflow chat cards use the installed pi-CAW read-only inspector through the exact conversation event bus. Render one card at the first visible Run position with its latest facts, preserving expansion and selection. Node tasks, messages/tool results, attempts/loop rounds and fan-out sessions load only on expansion; collapse stops polling. Show failures and cleaned history explicitly. Reuse MessageView for transcripts. This shared chat UI is independent of Course Builder. Never read guessed plugin directories, copy entire child histories into model context, or start model turns for visualization.

Markdown output links and turn-written files share `LocalFileLink`. Its context menu requests `/api/files/reveal` to show the existing path in the server host's file manager (Windows selects the file). Preserve normal preview clicks, visible missing-file/launch errors, same-origin request validation and the existing root/session-reference file authorization. This is a human UI action; it must not start an Agent turn or execute a caller-supplied shell command.

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
ESLint excludes generated `runtime/**` payloads; their TypeScript source and build/package verification remain checked separately.
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

### Dev server troubleshooting

- Before starting a server, run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse the existing Pi Web process when it is healthy. A second `next dev` for the same checkout cannot use a different port as a workaround because both processes contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph; it does not prove the server or source is broken. First call the browser's explicit reload action, then compare the current server log and a direct HTTP/API request.
- Restart only after the failure reproduces from a fresh page and the server-side checks also fail. Stop the exact dev process gracefully, move `.next` into a `mktemp -d` backup, and restart with the standard `npm run dev` command.
- Do not use `next dev --webpack` as a fallback. This repository's development graph can fail on `undici` imports such as `node:console`; development is expected to use Turbopack.
- Next.js may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md` when `next dev` starts. Treat that as generated tooling output, verify it with `git status`, and do not include it in an unrelated feature commit.

---

## Architecture

Workflow chat feedback is compact native `pi-caw:status`, excluded from model context and coalesced to the latest card for each Run. Preserve the adjacent node panel. pi-CAW retains completed process data for 24 hours by default; confirmed failed/cancelled records clean immediately. Course and Workbench offer one-click cleanup, retaining product files and initiating chats. Automatic cleanup preserves exact pre-Run refusals so the teacher can retry the same task. Explicit human cleanup may discard their private task workspace and records that decision; restore retryable refusals hidden by the old automatic policy while retaining the cleanup timestamp. Absence alone never permits cleanup or replay. Retired Runs preserve a compact exact result for `get` and product evidence, and reject execution/recovery. Course task catalogs hide cleaned process records; teacher review remains separate from workflow completion.

The service worker must not cache `/_next/` scripts: development URLs are reused across edits. Fresh development HTML updates an existing same-origin Pi worker even if an older cached client bundle skips registration. Do not auto-reload pages with drafts. TeX API changes that add Host members require an idle service restart because the process-global Harness retains its original class instance; validate the real source endpoint and rendered PDF afterward. Beamer editor reads return the latest exact revision/source-hash compile receipt for reopening its PDF.

Production `postbuild` checks every Next server file trace and fails when a route captures more than 20,000 files or a Windows build-host user directory. Keep runtime home and temp paths out of expressions that the Next file tracer can evaluate at build time: use `runtimeHomeDirectory()` for home expansion, and let `path.relative(tmpdir(), candidate)` normalize its operands without calling `resolve(tmpdir())`. A failed trace check is a source dependency bug; inspect the traced parent before changing build memory limits.

Teacher-script PDF compilation uses teacher action `compile_teacher_notes` and the same-named Agent command. `/api/course-builder/teacher-notes` restores the latest matching receipt with exact source/revision; exports use `teacher-notes-pdf` and `teacher-notes-log`, with PDF bytes transported only through `/api/pdf-content` for embedded preview. Save/compile errors retain edits, failed or stale receipts never appear as current success. Desktop Beamer and script editors show source and preview side by side; narrow screens may stack them. Both editors must use `TexSourcePdfEditor`: soft-wrap persisted TeX without changing its bytes, keep the last successful PDF visible while edits are dirty or compilation fails, and keep source/PDF double-click SyncTeX navigation receipt-, revision-, and source-hash-bound. `Ctrl+S` saves dirty TeX and compiles that saved revision before refreshing the preview. Do not fork this editor logic into either business container.

Course Builder uses the sticky, clickable section navigation as its only workflow index; do not restore a second decorative numbered strip. Growing collections show the three most recently updated entries first. Historical entries are not mounted until the teacher expands the collection, then remain searchable and can be collapsed again. Apply this pattern to courses, linked materials, Assignments, revision requests, lesson plans, decks, and visuals. Teacher TeX keeps source/PDF navigation on direct double-click without consuming editor height with a separate locate control.

Course material catalogs and `read_material` expose only teacher-selected local-folder references; generated figure copies are separate internal `generatedAssets`. Cleanup traces historical products/checkpoints/lecture scripts before deleting unreferenced stored assets. Teacher scripts use `teacher_notes_task` and `edit_teacher_notes`, independent of Beamer acceptance. `TeacherNotesSourceEditor` fetches exact TeX through `/api/course-builder/teacher-notes`, preserves local drafts and observed revisions, and exports `kind=teacher-notes`. The Beamer task's optional `teacherNotes` checkbox becomes a Host delivery flag; completion requires notes matching the final deck revision/hash. Saving TeX does not imply compilation.

Model-authored Course products use `workflow_prepare` and `workflow_start`; the Host allocates IDs and freezes the exact existing artifact baseline. Selected product/branch context is loaded into the Workflow rather than repeating the full Course state in Main. Main acknowledges the Run and ends its turn; the Workflow owns continuation and verified persistence/compilation. Teacher approval remains separate. Legacy `course-builder-delivery.ts` entries retain read/recovery support for historical tasks, but must not restart the retired direct-chat production loop. Supporting material acquisition, deterministic Host reads and review controls remain available.

In-place course file edits are refreshed by `add_material` on that exact path with the current project revision. Preserve the material ID, nested path and unrelated links through partial local sync; do not demand an unavailable folder-reindex tool or manufacture copies. Interactive visual saves allocate immutable IDs, so the successful same-lesson Host save advances the active delivery binding while preserving requirements/baseline. Routing cannot switch an existing product arbitrarily. Interactive delivery verifies the bound HTML hash again and reads content evidence from that HTML or this delivery's imported companions (Rmd, etc.), never visual registration metadata. `delivery_status.contentSources` supplies exact read/refresh/register templates.

Historical visual import attempts are an audit trail, not current file dependencies. Verify the bound HTML plus submitted companion source checks; material-only deliveries still verify all imports. Recover old post-save visual binding failures only from the same task's native tool call/error and unique Host artifact in that call's time window. Apply recovery through the authoritative session manager (workspace read or actual tool use); speculative activation candidate entries are discarded at commit and cannot alone establish durable repair. Recovery preserves blocked/incomplete status and never grants teacher approval.

Course Builder's module navigation stays inside the teacher scroll pane, above its content. Measure its height for anchor offsets and preserve hash links after async workspace loading; jumps must also move keyboard focus. Deck acceptance shows the specific missing prerequisite and current review issues. Match compile/review evidence by deck revision, source hash and receipt identity; a new receipt invalidates the browser's visual confirmation. Never bypass the Host's teacher acceptance checks. Browser regression: `node scripts/course-workspace-navigation-smoke.mjs` (all API traffic intercepted).

`CoverageCheckpoints` edits one file entry per lesson/materialId (summary, optional position, nextLesson), not read ranges. Keep the revision captured when editing opens; polling must not overwrite unsaved file records or hide conflicts. The selector disables already-selected files and Host validation rejects duplicates. Old range history normalizes by file without losing original rows. Confirmation records the teacher's reviewed preparation coverage. Course Builder plans later lessons assuming earlier scheduled lessons have been taught. ChatInput's attachment picker/paste/drop accepts files as well as images; document links survive draft recovery and upload completion must not leak into a newly selected conversation.

Product projects: `/projects` is the shared folder/conversation directory, separate from native cwd/worktree grouping. `lib/project-workspaces-service.ts` composes Course Builder ownership and `LearningHarness.projectWorkspaces`; `ProjectConversations` exposes course-local switching and creation. Creation writes a fresh Pi JSONL and a verified mode snapshot without instantiating an Agent or copying chat. Course-list creation uses project defaults; creation from a conversation retains its current mode and settings. Project defaults are explicitly saved from a member conversation; existing conversations retain their own settings. `/api/projects` uses request security and creation idempotency. TeX editing is teacher-only, preserves deck ownership, and creates a new draft; PDF exports default to inline with explicit download support.

TeX source is fetched on demand via `/api/course-builder/deck`, together with its revision; the course overview omits source. `PdfPreview` embeds `public/pdf-viewer.html`, which renders PDF bytes using pinned local `pdfjs-dist` assets served by the allowlisted `/api/pdfjs` route. It must work without a native browser PDF plugin and must never navigate the iframe directly to PDF bytes. No CDN or external document service is used.

The browser receives PDF preview data only as JSON/base64 from `/api/pdf-content`; that route reuses existing authorized readers in-process. Raw PDF fetches are also intercepted by native download managers here (HTTP 204 plus an automatic download), so changing Content-Disposition alone or fetching a PDF blob is not a solution. Binary exports remain explicit download actions.

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

Workspace-history snapshots use a shadow Git repository rooted at session cwd;
they do not inherit an ancestor repository's ignore rules. Keep the app's
`.gitignore` exclusions for local diagnostics, test artifacts and course outputs
aligned with the root. The Host wraps `pi-workspace-history@0.4.3` Git execution
with command-local `core.longpaths=true` on Windows; preserve its upstream bytes
and nonzero failures. Extension errors must be logged with session, extension
path and event before forwarding to the browser, so expiring notices remain
diagnosable.

`SettingsPanel` exposes Permissions through `/api/permissions/settings`. Global
rules follow the permission plugin's policy-agent override or `getAgentDir()`;
project overrides derive cwd from the selected session, never a caller-supplied
path. Parse JSONC strictly, preserve preset deny rules, compare source hashes
before atomic writes, and show errors/conflicts. Upstream permissions reload
rules by file stamp on subsequent calls; do not restart active Agents to apply
policy changes. The UI must distinguish a loaded permission extension from
defaults edited for a mode which has not loaded it.

---

## File Map

```
app/api/
  harness/status/route.ts           GET durable Harness state for the selected browser/session
  harness/courses/route.ts          GET courses | POST ZIP/PDF/text course import
  harness/active-course/route.ts    POST course selection for the next new Pi session
  harness/search/route.ts           GET current-course Grounding Packet spans
  harness/spans/[spanId]/route.ts   GET one current-course source span
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  pi-core-update/route.ts         GET stable Pi status | POST loopback-only exact core update
  skills/route.ts                 GET/PATCH/DELETE loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  harness-server.ts      process-wide LearningHarness composition root + Pi JSONL reconciliation
  harness-course-import.ts ZIP/material classification for immutable course versions
  harness-client.ts      typed browser client for /api/harness
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  harness/HarnessShell.tsx course/profile bar, import panel, and clickable Source Inspector
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  AgentsConfig.tsx    native subagent management facade; commands `/subagents` and `/subagents-fleet` expose the installed plugin
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### Mode activation and isolation
- `MODE_PACK_TOOL_NAMES` in profile-resource-host is the shared catalog/settings authority for Mode-selectable core tools, including native `codemode` and `tool_search`. Load each orchestration factory only when that tool is selected. Built-in tool-using modes default to Codemode on and standalone tool search off; Settings > General > Tool capabilities persists each switch through the existing per-session/per-mode settings transaction. Raw tool preset changes preserve these independent selections; pure Chat only loads neither. Pi's native MCP is independent and follows its server configuration in unscoped tool-using sessions. Never register an unselected orchestration tool that MCP could automatically activate. Only native MCP tools configured with `direct` exposure join the mode's direct-tool ceiling, including tools connected after startup; preserve `codemode`, `deferred`, and `hidden` exposure.
- Scoped learning and Study & Research may select Codemode or standalone tool search to orchestrate/search their admitted Host tools. They still load no ambient MCP or Codemode model API, and scripts pass through the original Host tool-call checks. Enabling orchestration grants no raw filesystem, shell, or extra source access.
- Mode bindings and activation locks are per conversation. Two live conversations may use different modes concurrently. Cache the SDK loader code and content-keyed transforms only; use uncached `loadExtensions`, independent module factories, runtimes and event buses for each session.
- First activation of a new exact dependency identity may install npm components. Later switches reuse the verified runtime. Keep the target switch visible, retain the committed mode until success, and expose loading/activation failures. Log session/mode and elapsed failure diagnostics without prompt or credential contents.
- Next instrumentation must import Node-only storage and dispatcher code inside the explicit `NEXT_RUNTIME === "nodejs"` branch; a return guard around top-level Node imports still contaminates Edge compilation.

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and uses Pi's configured tools with Codemode on by default; an empty array means Chat only. Generic Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Course-bound sessions have a scoped Learning Harness resource loader with the installed native subagent plugin. Crossing the Chat-only boundary or changing either native orchestration switch rebuilds the wrapper; changes between nonempty raw tool presets update it in place. Ordinary conversations use the same tool-capabilities settings UI without first binding a Mode Pack. New learner construction registers the default profile's selected orchestration factories before binding, but keeps them inactive until the Host commits that profile. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; the deleted custom `Agent`, `get_subagent_result`, and `steer_subagent` protocol must not be restored. See `docs/adr/0002-chat-only-tool-selection.md`.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Model defaults for new sessions
- Rebuilding an existing SDK session with a model/thinking override does **not** append its change entries. Mode Pack and learner transitions must call `persistCommittedRuntimeSettings` only after binding commit; startup also reconciles committed settings before registration. Verify the runtime, session GET response, disk JSONL and next SDK turn together. Never journal a candidate's settings before verification/commit.
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### File access allow-list
- Course Builder review links use `#semester-plan` / `#review`; targets arrive after the workspace API, so reveal the requested section after loading and on hash changes. Semester plans render their real structured fields for teacher review, with raw JSON as optional diagnostics. Approval remains an explicit, revision-bound teacher action.
- A `request-changes` review also dispatches a native Pi prompt, with a request ID and the reviewed target/revision. `course-builder-revisions.ts` journals task states in `pi-web:course-revision` entries, scopes Assignment work before dispatch, and completes only after a successful save of that target at a newer revision. Prompt acceptance/agent termination alone is not completion. Preserve failed requests for retry; never auto-approve the resulting draft. The chat review shortcut is dismissible per saved plan version, independently of the permanent workspace navigation.
- Message Markdown normalizes Windows/file URLs before sanitization without allowing executable URL schemes. Both AppShell and the teacher ChatWindow must supply `onOpenFile`; Course Builder previews local paths through FileViewer with `sourceSessionId` and previews Host exports through their existing session-scoped export route. Never turn a preview click into a new session or add its contents to model context.
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` includes the configured Pi-local `skills/` library as well as SDK-discovered paths. With a selected session, SkillsConfig uses `/api/mode-packs/settings`, displaying that session's active selections and actual complete loading evidence. Required Skills cannot be disabled; optional selections and prompt edits create a new snapshot without changing the shared Skill files.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `resolveSavedModeSettings` rebases stale personal settings onto freshly resolved mode resources during activation, including Course Builder startup. Snapshots contain effective resources only, so optional Skills absent from the saved snapshot remain off. Fresh mode instructions replace old resource text; user prompt/model/tool choices survive. The normal candidate verification, identity journal and idempotency checks still apply.
- Course Builder task availability uses the Host's shared planning-only revision policy; source import/reindexing must not invalidate an approved outline. Task button `additionalRequirements` are appended by the server, while standalone sends remain unchanged. The independent `/course-builder/lesson` review page renders persisted content, keeps local unsaved drafts keyed by session/lesson/base revision, and saves via the teacher-only `edit_lesson` action without starting a model. Never discard concurrent lesson revisions or carry approval into a newly edited draft.
- Keep native library add/market/check/update controls alongside the current-mode tab, including the teacher pane. `/api/skills` returns `installDirectory`. `local-skill-install.ts` stages native `skills add --agent pi --copy`, validates full directories and metadata, then publishes to the configured library with rollback on failure. New installs cannot redirect to a caller's cwd or global scope; managed updates use the same library and `.skills-lock.json`. Installing refreshes mode inventory without automatically enabling the new Skill.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Built-in subagents
- `pi-caw@0.2.31` is the separate portable Workflow Workbench plugin. Every installed normal Workflow remains selectable in every mode; modes provide editable defaults only. Course Builder defaults to the consolidated `course-production`, Study/Research to `study-explanation`, and other modes to globally enabled generic Workflows. Domain admission still binds tools, targets and sources to the exact task. Preserve the portable UI, complete Roles, two system authoring Workflows, conversion, resource/history/cache management, recovery, patch review and human acceptance. Main workers may isolate context; orchestration Main retains the initiating conversation. `/caw` opens the Workbench without controlling an external browser. Reinstall from the pinned archive in `host-plugins/`, never a registry namesake or adjacent development checkout. Native MCP and `pi-subagents` remain independent capabilities. Plugin state stays under `getAgentDir()/pi-CAW`.
- The only engine is Host-pinned `pi-subagents@0.74.0`. Do not restore the deleted `Agent` dispatcher or separate profile CRUD. Historical records use read-only decoders. `/subagents` and `/subagents-fleet` provide the same upstream role/run management as the Web UI.
- `host-baseline-plugins.ts` also loads `@eko24ive/pi-ask@1.2.0` and `pi-context-usage@2.1.0`; FFF remains `0.11.0`. Preserve dynamic tool selection, parent ceilings, isolated permissions and Windows detached cleanup. Installing these plugins must not force delegation or Skill reading.
- Disabling/unlinking and deleting files are different operations. `resource-deletion.ts` composes updated mode references, excludes removed dependencies from offline payloads, erases retired archives/runtimes, and journals explicit uninstall for conversation restoration. Check canonical containment before recursive deletion. Missing files without explicit uninstall remain errors. See `docs/adr/0003-built-in-subagent-toggle.md`.

### Auth and model config

- Restarts must preserve the effective `PI_CODING_AGENT_DIR` and `PI_LEARNING_HARNESS_DIR`. The source launcher uses `.learning-harness-data/pi-agent` and `.learning-harness-data`; bare npm startup otherwise falls back to Pi's user-home directory. This machine's paths belong in ignored `.env.local`, never checked-in code. `instrumentation.ts` prints `[pi-web] runtime storage` on startup; verify known session IDs before claiming a restart is healthy.

- Pi Web's four direct Pi dependencies are pinned together at 1.0.4. The Host uses Pi's SDK-native Codemode, MCP and standalone tool search with independent registration and settings, without an additional MCP adapter. `/api/pi-core-update` checks the official stable Pi release and supports a loopback-only one-click exact-version update of all four packages. In a source checkout it also refreshes the bundled Code Mode Pi runtime pin and rebuilds its immutable archive. Successful updates require a Pi Web restart before the new runtime is used. Dynamic provider refresh and local model configuration remain separate from dependency upgrades.
- Model and thinking selectors in Mode Pack sessions use the same immutable activation transaction as prompt/Skill changes. `session-configuration-events.ts` invalidates model/tool/prompt views across components and tabs. The Course Builder page mounts the existing ChatWindow alongside independently scrollable course controls and activates the original teacher session on entry.
- Generic/teacher tool presets and reload also use that transaction. Empty builtin selection preserves the selected mode's workflow extensions/Skills; its toolbar must not misreport `default`. Resolve logical shell tools against SettingsManager and the host platform for both application and verification. Failed tool changes must remain visible and must not update the selected preset. `POST /api/sessions/[id]/new` creates an ordinary blank JSONL in the same cwd, independent of any source course/mode or selected-course cookie; it does not start a model. Course Builder's `lesson_task` uses authoritative current semester/lesson state and explicit week/session, shared with the frontend through `course-builder-lesson-tasks.ts`.
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Portable Mode Ecosystem

All user-facing modules are intended to be independently exportable and installable
with their specialized harness, route validation, internal phases and frontend.
Course Builder and Study & Research are the two education-related modules;
`student-learn`, `practice`, `teach-back`, `visual-lab` and `teacher-prep` are
internal course-bound workflow/profile IDs, not five additional package entries.
The common constructor/parser now round-trips ordinary `general`
and `creative` modes and preserves a frontend when re-exporting an imported
package. A newly authored custom draft has no frontend source. Code now exports
its offline npm bytes in the common streamed `.mode-pack.tar` wire format;
installed manifests retain only file metadata. A module archive can now contain
multiple profiles with distinct frontend entries. Import and deletion commit all
profiles atomically, while renamed installs reuse the same content-addressed
payload. Typed harness and route-validation assets travel with the package and
are hash-checked; import loads their compiled runtime entrypoints and verifies
routes and extension exports before registration. Course Builder and Study &
Research export their complete specialized frontend and runtime trees, including
the PDF viewer assets, through the common package format. The host supplies only
the declared versioned capability interfaces.
Same-named, different-content implementation components in isolated modes may
coexist; a shared name alone is not an import conflict. Qualify public
registrations visible together with deterministic package-name prefixes, verify
the invocation mapping, and keep upstream package bytes unchanged. Skills are
excluded from prefixing and retain upstream names; source/version/hash is
separate metadata.
Candidate Mode Pack sessions qualify colliding extension tools and commands
before the SDK builds its public registry, including later map writes. Import
preflight loads the incoming package's factories in a disposable agent directory,
and rechecks installed peers that would bind to an upgraded shared extension.
Flags and shortcuts fail explicitly on duplicate registration. The shipped probe
is compiled into `runtime/portable-registration-probe.mjs`; preserve its build,
publish and trace inclusion so imports work without repository TypeScript files.
Import/assembly preflight must reject two selectable Skill providers with the
same name in one portable mode, even when their SKILL.md bytes match, while
allowing them in separate modes; do not depend on native Skill discovery's
first-wins collision resolution.
Successful import must expose the mode-specific frontend without rebuilding or
restarting Pi Web. Package frontend assets and capability bindings behind a
stable runtime host interface; a Next route compiled into the host does not by
itself satisfy portability.
Each archive targets a declared OS/architecture and carries all mode-owned
local bytes. Host-supplied external prerequisites must be declared and checked
during import; missing prerequisites are reported to the Pi agent and cannot
be deferred until mode activation.
Expose the portable import as a discoverable **导入工作模块** action in the Pi-own
conversation frontend; the management page's existing English `Import package`
button alone does not satisfy this entry point. Prefer a newer shared component
only after all installed modes explicitly declare compatibility and verification
passes; absent such declarations, require an exact version and content hash match.
An import conflict must be detected by a mechanical preflight before committing
package registration, changing shared dependencies, or activation. Disposable
private staging for verification is allowed. It must leave the active
installation unchanged, return a structured incoming-versus-installed
dependency comparison and prepared resolution prompt, and send that prompt to
the initiating Pi agent for a Pi-session import (or expose an explicit send
action in the frontend). A conflict first noticed during normal mode use is a
preflight failure to fix, not a routine user recovery flow.

The generated `runtime/mode-packs/coding.archive.json` is a package-time asset, not a
source of truth. `prebuild`, `predev` and `predev:lan` generate it for fresh checkouts; direct
app TypeScript checks must run the generator first. Runtime code must parse the
self-contained archive and private selected runtime only. Preserve the
built-in Code package's declared `uvx` host prerequisite for Spec Kit
initialization. Next production builds cap page-data workers at four via
`experimental.cpus`; the default 31 workers consumed over 11 GB RSS on a
high-core Windows host. Preserve that bound unless measured evidence supports
a different value. Preserve the historical
built-in hash registry, source lock provenance, exact npm pins/SRI, and opaque
snapshot/nonce frontend boundary. Do not restore the removed shared Code installer,
repository-root reads, global environment/PATH mutation, or MCP discovery from a
portable package extension. Pi's native Host MCP built-in is the sole ambient MCP
path in unscoped tool-using sessions and remains outside the archive identity.
It reads Pi's own server configuration independently of Codemode/tool-search
selection. Scoped learning and Study & Research do not load ambient MCP.
Portable snapshots also record the selected definition's default-prompt hash. Only
an explicit activation/reload adopts a newer definition, including a same-payload
revision; ordinary model/thinking/tool/Skill settings retain the committed definition.
Never manufacture that provenance for older JSONL snapshots: absent metadata may
represent a personal prompt and must keep the compatibility rebase path.
`systemPromptMode=replace` is the isolated default and must use ResourceLoader's
custom system prompt with project context and append files disabled. Code Mode alone
currently selects `append`, retaining Pi's upstream coding prompt, repository context,
and native Skill metadata. The mode settings list is metadata-only; fetch an exact
bound Skill body lazily by logical ID. Private package trees are fully hashed on first
process use or after explicit invalidation, then process-local trust avoids rescanning
the same immutable runtime during every mode switch.
When a portable archive is selected, its inventory reads only built-in tool
descriptors and that archive's resources/capabilities. Do not reintroduce
global Skill/package discovery or unrelated education-mode file reads on that
path; the ordinary unbound inventory still discovers those resources.
The dedicated Skill-list endpoint uses a Skill-only ResourceLoader; loading
extensions, templates, themes, or context there is unrelated startup work.
Portable Skill listing reads registered package manifests and verifies the
individual Skill files it displays; full frontend/runtime file verification
belongs to import and activation, not a list request. Built-in Skill metadata
comes from the embedded Code archive rather than repository `third_party/`.
Keep extension-owned mutable state outside `node_modules`. The pinned permission
adapter injects mode-private config/log paths under
`mode-packs/state/mode-<profile-hash>/` through a lexical process facade, including
foreground and detached children; do not replace this with global environment
mutation or allow the upstream default to dirty the verified runtime tree.
The pinned permission adapter also passes its private config path explicitly at
the upstream config-load call, because lexical `process.env` alone did not stop
`config.json` from being created inside the immutable npm tree. Pi Web owns
`@ff-labs/pi-fff` as a host-wide grep/find replacement, not a Coding component;
its pinned factory and mutable FFF databases belong to the host. A mode may
select search tools without inheriting another mode's Skills or plugin state.
The full Skill list includes Skills from installed portable packages. Their upstream
bytes remain pinned, while mode package membership and defaults are editable.
Composing a mode copies selected donor resources into a complete package before
registering its current definition under the same mode ID.
Disabled components keep their pinned identity in the definition and portable
archive; unlinking removes the component. A multi-profile package revision
updates all sibling profile revisions atomically, including when only one
phase's default resources changed.
Code's default Skills are enabled but optional. Do not equate "default" with
"required": users can turn one off in session settings or unlink it from a
current package. The Skill library renderer must include package-owned Skills
alongside project, global and path Skills; an API item without a visual group
is a listing bug. Export prunes unlinked Skill directories from package bytes.

Runtime preparation must precede portable integration tests in fresh checkouts. Native CAW catalog/inspection calls wait for extension binding before querying the exact session bus. Run root and Web integration suites sequentially when packaging shared runtime assets; bound test concurrency instead of allowing all CPU cores to exhaust memory.
