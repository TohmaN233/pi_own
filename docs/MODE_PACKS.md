# Mode Packs

Mode Pack is the user-facing unit that turns one Pi runtime into a focused working mode. A pack versions the prompt, Skills, plugins, workflows, tools, model preference, thinking level, and context policy that belong together for one purpose.

The implementation keeps four boundaries separate:

- **Mode Pack definition** describes the reusable configuration.
- **Resource Snapshot** pins the exact resolved resources and compiled instructions for one activation.
- **Pi AgentSession** is the only agent runtime.
- **Pi JSONL** is the authority for the active generic Mode Pack binding and its immutable activation history.

Course-bound learner state continues to use the reviewed Learning Harness SQLite transaction plus Pi JSONL references. Generic Mode Packs do not create a second transcript or a second learning database.

## Built-in packs

| Pack | Runtime envelope | P1 status |
| --- | --- | --- |
| Tutor (`student-learn`) | course-bound student | Active through Learning Harness |
| Practice | course-bound student | Active through Learning Harness |
| Teach-back | course-bound student | Active through Learning Harness |
| Visual Lab | course-bound student | Declared; P4 sandbox/HTML stage remains future |
| Teacher Prep | teacher build | Declared; P5 detachable teacher build remains future |
| Coding | ordinary Pi session | Generic runtime activation implemented |
| Creative | ordinary Pi session | Generic runtime activation implemented |
| General | ordinary Pi session | Generic runtime activation implemented |

## Generic activation protocol

A generic Mode Pack is not considered active merely because its name appears in the UI.

```text
Mode Pack id
  → resolve installed inventory without executing unselected plugins
  → verify exact version/content hashes
  → compile immutable Resource Snapshot and prompt markers
  → create an unregistered candidate AgentSession
  → load only selected extension/Skill/prompt/theme paths
  → activate declared built-in tools plus tools registered by selected plugins
  → verify tools, resources, prompt marker, and snapshot hash
  → stop the old idle runtime
  → append the binding to the same Pi JSONL
  → read the binding back
  → publish the candidate into the live Pi Web registry
```

If candidate construction or verification fails before the JSONL commit, the old binding remains authoritative and Pi Web reopens the previous runtime. A binding that reached JSONL is never silently rolled back; restart recovery reconstructs that committed snapshot and fails closed when a required resource disappeared or changed identity.

Mode Pack sessions reject direct `set_tools`, model, thinking-level, and generic reload commands. They must be changed through another versioned activation. Direct shell commands are also rejected unless the active snapshot enables a shell tool.

## Runtime resource inventory

The inventory contains:

- Pi built-in tools;
- Pi Own synthetic prompt, Skill, and workflow resources;
- installed package extensions grouped by package source and scope;
- installed Skills, prompt templates, and themes as individually addressable resources.

Installed file resources receive stable `runtime.*` identifiers and content hashes. A custom pack pins those identifiers. Moving to a machine where a required resource is missing, or editing a pinned file in place, makes the pack unavailable rather than quietly substituting another resource.

Selected physical Skills and prompts are both loaded through Pi's `DefaultResourceLoader` and embedded in the immutable Mode Pack prompt. Synthetic Pi Own guidance has no filesystem path and is loaded through explicit prompt resource markers. Unselected extension paths are not loaded into the candidate runtime.

## Custom packs

The full editor is available at `/mode-packs?sessionId=<pi-session-id>` for an ordinary Pi session. It supports:

- forking a built-in pack;
- creating `custom.*` packs;
- editing the complete JSON contract;
- selecting discovered Skill/plugin/prompt/theme ids;
- immutable revisions with optimistic revision checks;
- deleting custom packs;
- activating a saved pack into the selected live session;
- inspecting discovered resources and runtime verification state.

Custom global packs must use:

```text
role = general
runtimeMode = general
courseRequired = false
```

They cannot include the course-only `learning-harness` extension. The custom library is an atomic configuration file (`PI_MODE_PACK_STORE_PATH`, or `PI_LEARNING_HARNESS_DIR/mode-packs.json`, or the Pi agent directory). Active session state is still recorded in Pi JSONL, so deleting a library entry does not erase or rewrite past session bindings.

Course-bound custom learner packs remain available from the Learning Harness Modes panel and keep the stricter student/course boundary.

## Shared selector

`HarnessShell` preserves the existing learner workbench and adds one shared Mode Pack overlay:

- on a learner session it calls the existing Learning Harness prepare/verify/commit path;
- on an ordinary session it calls the generic candidate-rebuild protocol;
- it remains disabled while the session is busy, while a transition is in progress, or when the currently committed runtime cannot be verified.

## Current boundary after P1

P1 now includes the common contract, built-in packs, custom generic library/editor, installed-resource inventory, real AgentSession resource filtering, verified activation, JSONL recovery, fork inheritance, rollback behavior, and the shared selector.

The following remain outside P1:

- P2: finish product integration of the recommended education Skills and their workflow UI;
- P3: persist concept evidence and curriculum-revisit state into the existing Harness transaction/Timeline;
- P4: independent computation sandbox, interactive HTML Stage, artifact UI, and visual accessibility/browser checks;
- P5: detachable teacher build, adversarial evaluation, release packaging, backup, migration, and rollback evidence;
- installing or upgrading third-party packages directly from the Mode Pack editor.
