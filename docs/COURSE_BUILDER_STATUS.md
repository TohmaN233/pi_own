# Course Builder checkpoint status

The Course Builder checkpoint provides the first teacher-side vertical slice for turning existing course material into a reviewed semester plan, lesson plan, and Beamer deck.

## Included

- a versioned `course-builder` Mode Pack;
- a persistent Course Builder Host under the existing Learning Harness SQLite/WAL ownership boundary;
- bounded PPTX semantic extraction plus PDF, TeX, Markdown, text, and supported asset inputs;
- versioned material analysis, Semester Plan, Lesson Plan, Beamer Deck, compile receipt, review, and teacher acceptance objects;
- teacher-controlled approval gates that are unavailable to the model tools;
- a dedicated Beamer compiler boundary using `-no-shell-escape`, path confinement, time/output/log budgets, and content hashes;
- stale-plan and stale-deck rejection;
- deterministic VisualHost bridging for the supported renderer set;
- a Pi Web Course Builder workspace and same-origin API;
- pinned and attributed guidance adapted from Noi1r/beamer-skill;
- focused and product-integration tests plus a formal Course Builder CI workflow;
- a Chinese user acceptance checklist.

## Product boundary

This is a usable course-authoring checkpoint, not the final teacher product. PPTX import extracts semantic slide text and speaker notes but does not preserve masters, animations, SmartArt, native charts, or exact object placement. The checkpoint produces and verifies Beamer source/PDF; it does not generate editable PowerPoint. The TeX compiler is hardened but is not an operating-system sandbox. Automated browser screenshot approval and the physical Teacher/Student build split remain future work.
