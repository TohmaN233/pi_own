# Course Builder approval boundary

Agent tools may create and revise material analyses, Semester Plans, Lesson Plans, Beamer Deck drafts, compilation requests, and review requests. They may not write teacher-controlled approval, rejection, acceptance, reviewer, target revision, target hash, or accepted-receipt fields.

Teacher decisions arrive through dedicated same-origin UI/API actions, carry the expected object revision and content hash, and are rejected when stale. A newer Semester Plan invalidates dependent lesson work; a newer Lesson Plan invalidates dependent deck, compile, review, and acceptance work. Final acceptance requires the current approved Lesson Plan, current Deck revision, current successful Compile Receipt, and current review result.
