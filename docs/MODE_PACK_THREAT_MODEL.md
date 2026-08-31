# Mode Pack threat model

## Assets

- Pi session identity, JSONL transcript, and branch lineage;
- active Resource Snapshot and Mode Pack activation receipt;
- CourseVersion sources and citation Spans;
- workspace and creative-project roots;
- protected assessment solutions and one-use capabilities;
- custom Mode Pack and custom Skill definitions;
- Visual Activity Specs, receipts, and published artifacts;
- Teacher-only drafts, answer keys, and authoring tools.

## Trust levels

1. **System / developer policy and Host code** — authority for permissions and validation.
2. **Built-in Mode Pack and Skill files shipped by the repository** — versioned product guidance, still unable to grant permissions by prose.
3. **User-authored Mode Packs, Skills, course materials, workspaces, creative-project files, and chat history** — user-controlled data and low-priority guidance.
4. **External web material and plugin output** — untrusted content requiring source and capability boundaries.
5. **Model output** — untrusted proposal until the relevant publication or mutation gate accepts it.

## Threats and required controls

### Name-only or UI-only activation

**Threat:** The UI displays a selected Mode Pack while the model still sees the previous prompt or tools.

**Control:** Candidate runtime preparation, inspection of exact effective prompt/resources, matching activation receipt, and commit only after verification. Preview responses are explicitly not activation receipts.

### Prompt accumulation

**Threat:** Switching modes appends new prompts while old mode instructions remain active.

**Control:** A Mode Pack compiles one complete effective prompt. The runtime adapter replaces the candidate prompt and the prompt Hash must match before commit.

### Missing required Skill/plugin/package

**Threat:** A mode silently runs without a load-bearing method or tool.

**Control:** Required resources fail closed; only optional resources may degrade, with an explicit list. Skill files have path and content-Hash receipts.

### Custom instruction privilege escalation

**Threat:** A custom Mode Pack or Skill asks the runtime to enable tools, read another course/workspace, reveal secrets, or override higher-priority instructions.

**Control:** Custom text is user-controlled guidance. The parser cannot grant resources; actual tools and context are intersected with server-installed and owner-authorized resources. Runtime receipt verification cannot enlarge the declaration.

### Cross-context warm switching

**Threat:** A course-bound learner session becomes a coding or creative session while retaining inappropriate context or permissions.

**Control:** Role, context-kind, and bound/unbound changes are hard transitions requiring a new Pi session or explicit fork. Existing JSONL lineage remains authoritative.

### Stale or replayed workflow writes

**Threat:** Two browser tabs or a replayed request overwrite newer Practice/Teach-back state or reuse a learner turn.

**Control:** Durable workflow compare-and-swap revision, session/course/mode-content rebinding checks, and unique learner-turn ids.

### Early solution reveal

**Threat:** Prompt injection or direct tool calls reveal a protected answer before an attempt.

**Control:** Private solutions stay outside general state, and reveal remains capability-gated. The Practice state machine requires an attempt before feedback/reveal transitions. Model-output adversarial tests are still required because state protection alone does not prove prose never leaks an answer.

### External evidence confusion

**Threat:** Missing evidence is labelled false, stale information is taught as current, or an invented URL is presented as research.

**Control:** Research Ledger separates verified, contradicted, unsupported, and not-yet-verified; current external claims require source identity/date; URLs must come from user input or actual search output.

### Visual arbitrary-code or network execution

**Threat:** A visual activity embeds JavaScript, URLs, prototype pollution, filesystem access, shell commands, or unbounded computation.

**Control:** Closed data-only Spec, exact activity allowlist, dangerous-string/prototype checks, finite-number checks, input/output/step/time budgets, separate worker process, deterministic receipt, and no arbitrary HTML/code path. This is not claimed to be a general sandbox.

### Artifact publication without verification

**Threat:** A UI displays a draft or tampered computation as a verified learning artifact.

**Control:** Immutable draft → verified → published revisions; spec/result/receipt Hash checks; accessible fallback required; stale revisions rejected.

### Teacher data in student build

**Threat:** Teacher drafts, answer keys, or authoring tools are bundled into the student application.

**Control:** Physical package/build split and recursive production-artifact scan are required P5 exit criteria. Structured-object scans alone are insufficient and this checkpoint does not claim closure.

## Security non-claims

- Skill prose is not a security boundary.
- A green deterministic unit test is not browser E2E or process-crash evidence.
- A data-only worker is not a general-purpose sandbox.
- A source-tree resource declaration is not proof of live runtime activation.
- Keeping a transcript does not make previous prompt influence disappear; hard transitions use new sessions/forks.
