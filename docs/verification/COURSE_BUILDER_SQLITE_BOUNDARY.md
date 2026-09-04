# Course Builder storage boundary

Course Builder product state is stored under the same configured Learning Harness SQLite/WAL database ownership boundary. It does not create another conversation transcript, another agent loop, or an independently authoritative course store. Pi JSONL remains the conversation and Mode Pack binding authority; Course Builder tables hold deterministic project, material, planning, deck, compile, review, and acceptance state.

A failed SQLite write must not leave uncommitted in-memory state usable as if durable. Recovery reopens the last committed state and revalidates revision/hash chains.
