# Learning Harness composition root

This package composes the Course, Knowledge, Learning, Profile, and Pi Runtime
hosts for the first durable Learning Harness vertical slice. It keeps Pi's
`AgentSession` and JSONL transcript authoritative while storing Harness-owned
course, session, snapshot, source, and learning state in SQLite/WAL.

The composition root provides:

- immutable CourseVersion publication and SHA-256-addressed source storage;
- one Student Snapshot and one CourseVersion binding per Pi session;
- explicit child bindings that preserve course/snapshot scope across Pi fork and clone, including arbitrary validated copied ancestry;
- strict reconciliation between the Pi Runtime journal and SQLite state;
- current-course retrieval, citation validation, and source recovery;
- append-only learning events and mastery projection across process restarts.

Normal composition rejects an empty child journal. Pi Web may use the narrowly
privileged direct-empty inheritance API only after it has verified that the child
JSONL header points to the supplied parent session exactly. It intentionally does not own Pi's model loop, message queue, retry behavior,
compaction, or transcript. It also does not yet implement the planned normalized
FTS schema or filesystem content store. A failed SQLite transaction makes the
live composition root unavailable, including a failure to acquire `BEGIN IMMEDIATE`;
reopening it restores only committed state.
