# Pi Learning Harness Runtime Host

Thin deterministic session control layer for the Learning Harness.

`RuntimeSessionHost` deliberately does **not** write Pi JSONL files itself. It targets the small structural surface already provided by Pi `SessionManager`: `getSessionId()`, `getBranch()`, and `appendCustomEntry()`. A real Pi `SessionManager` therefore satisfies the adapter, while tests can use a deterministic in-memory fake.

The runtime journal is stored as Pi native `custom` entries with custom type `learning-harness:runtime-journal/v1`. Pi defines `custom` entries as extension state that does not participate in LLM context.

V1 guarantees:

- active-branch recovery with strict monotonically increasing journal sequence;
- one persisted use of each idempotency key;
- exact replay of the same command returns the original native Pi entry id;
- reuse of an idempotency key with different data fails closed;
- a session binding can only reference the active Pi session and an already-recorded resource snapshot;
- copied fork/clone history may carry an arbitrary validated binding ancestry; each child binding starts at revision 1 and retains the inherited course, snapshot, and role;
- an empty child journal is not generic copied history and is rejected by the public inheritance path; the Pi Web adapter may admit a direct empty fork only after verifying its JSONL header points to the supplied parent exactly;
- `recover()` reports a binding only when the active Pi session has its own binding. Callers that intentionally reconcile copied ancestor history can inspect the separately validated binding lineage and explicitly append the active session's durable binding only after matching that ancestor to durable Harness state;
- course version, role, binding identity, and creation time are immutable inside one session;
- a replacement resource snapshot must remain in the bound course;
- workflow revisions and workflow-local sequence numbers advance exactly by one;
- workflow state transitions follow an explicit allow-list and terminal states cannot restart;
- malformed or inconsistent persisted Harness entries make recovery fail closed.

This package does not yet own Profile resolution, course files, retrieval, assessments, or visualization. Those arrive behind their own Host boundaries.
