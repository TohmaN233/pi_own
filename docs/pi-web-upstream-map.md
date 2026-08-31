# Pi Web upstream map

Frozen upstream: `agegr/pi-web` v0.8.11 at `28bab3c25f5f6770c9b0b745ebbfec1c27f7b948`.

The complete upstream tree is vendored under `apps/pi-web`. `docs/pi-web-upstream-manifest.json` records every upstream Git blob. The baseline test verifies every retained file and requires all downstream modifications to be named explicitly.

## Retained directly

- Pi `AgentSession` creation and registry in `lib/rpc-manager.ts`, apart from the documented direct-root-fork header materialization hook.
- Pi JSONL session browsing, restoration, branching, and export.
- Agent command transport and SSE reconnection.
- Provider/model, plugin, Skill, file, worktree, Markdown, KaTeX, Mermaid, and PWA behavior.

## Thin adaptations to upstream files

- `app/page.tsx` mounts the Learning Harness shell around the native `AppShell`.
- Pi agent routes bind or reconcile Harness metadata before a model command and on SSE restoration; fork/clone recovery validates arbitrary copied binding ancestry and only re-adopts from an exact durable ancestor. A direct empty fork is the sole exception: the privileged adapter first verifies that its JSONL header names the supplied parent exactly.
- `lib/rpc-manager.ts` writes the new child JSONL header during a root fork with no copied entries, then discards that temporary manager. This makes the existing Pi parent link observable to the privileged adapter; `lib/rpc-manager.test.mjs` covers the reopenable direct-fork file. It also installs a hidden per-session course-grounding extension and gates only assistant start/update/snapshot output for an active grounded run; user messages and tool execution progress remain on the native transport.
- `components/SessionSidebar.tsx` invalidates stale running-session polling responses by generation instead of aborting normal development-mode fetches, which Next reported as an issue during StrictMode cleanup. `components/SessionSidebar.test.mjs` guards that polling boundary.
- `components/AppShell.file-viewer-state.test.mjs` and `hooks/useAgentSession.test.mjs` normalize vendored CRLF source text before inspecting source-level invariants. `lib/project-command-env.test.mjs` uses the explicitly simulated platform delimiter. `lib/directory-browser.test.mjs` and `lib/subagent-input.test.mjs` keep their non-link assertions unconditional, while only their separate symbolic-link cases skip when Windows itself refuses link creation. `lib/model-discovery.test.mjs` isolates the SDK auth directory for its credential-resolution test.
- `next.config.ts`, its tracing contract test, and `tsconfig.json` allow the vendored app to consume typed Harness source packages from the repository root.
- `package.json` declares `jszip` directly for course archive import.

## Downstream additions

- `components/harness/*`: course switcher, Student Learn snapshot identity, course import, clickable Source Inspector, shared Timeline, and bound-session Practice panel.
- `app/api/harness/*`: typed local course, status, search, source, Timeline, and Practice endpoints. Practice keeps public DTOs allowlisted and returns private solution text only from its one-use `practice/solution` POST response; all Practice responses are `private, no-store`. Shared status mapping keeps validation and scope errors in the 4xx range, while Harness persistence, SQLite/unknown operational failures, and extractor configuration/spawn/stdout/stderr/cleanup/timeout failures are logged and returned as 500; validated size budgets return 413.
- `lib/harness-server.ts`: one process-wide SQLite composition root plus Pi JSONL reconciliation and child-session inheritance adapter. Failed inheritance or failed new-session course binding shuts down only the new wrapper, discards only its new JSONL, and invalidates its path/list caches.
- `lib/harness-course-import.ts`: wire-bounded and decompression-bounded ZIP/PDF/text/code/notebook import classification; the Course Host bounds PDF input/stdout/stderr/time plus extracted-text, course-text, and span expansion.
- `lib/harness-client.ts`: browser API types and fetch helpers.
- `lib/learning-harness-extension.ts`: the per-session Pi inline extension that injects a Grounding Packet, accepts structured claims through `submit_grounded_answer`, and replaces only a receipt-backed final assistant message. The extension and wrapper keep Pi's one AgentSession, tool loop, JSONL, and SSE registry.

## Deliberate boundary

The integration does not add a second transcript, agent loop, retry queue, or SSE registry. Pi Web still owns browser transport and Pi still owns `AgentSession` plus the JSONL transcript. Harness state contains course, profile, learning, and validation state together with references written into Pi custom entries. This is an audited vertical slice, not a complete Learning Harness V1.
