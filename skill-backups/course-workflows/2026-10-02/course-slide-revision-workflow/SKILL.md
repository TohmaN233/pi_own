---
name: course-slide-revision-workflow
description: Make a bounded correction to an existing selected Beamer deck and compile its new revision, preserving the lesson, semester plan and unrelated assets.
---

# Revise one existing deck

Input is a Host-created taskId, the teacher's specific change request, Host-created commitRequestId and compileRequestId, and Host constants kind="deck", format="tex", documentKind="beamer". The task selects an existing lesson/deck; no model allocates course identities. This workflow makes a new deck draft and real PDF, pending teacher review. It does not create or revise a semester plan or lesson plan.

First use course_task_context with taskId. For an ordinary wording, symbol, layout or local formula change, the Host selects no course reference files. Read the frozen original with read_workspace using the exact currentArtifact.workspacePath supplied by the Host, plus the existing profile and request. Its retained source reference is compile/CAS evidence, not an absolute-path read instruction. If the correction actually needs new source evidence, stop with the specific missing source rather than inject the whole course.

One independently bound writer makes the smallest changes that meet the request. Read the existing TeX, preserve every unaffected frame, formula, asset, preamble and filename reference. Write the changed complete source to one new descriptive .tex filename inside sources. Do not rewrite the deck from scratch unless the teacher explicitly abandons it. An accepted version remains historical; save a new draft. No unlock or fresh semester approval is needed for a bounded deck correction.

Return only a newly chosen relative artifact path under the path field, such as sources/revised-slides.tex. This is an independently chosen destination filename for a new artifact. Do not return copied title, outline, course identities, existing paths, hash, revision or source metadata. The Host captures actual file bytes and identity. The writer must not claim compilation or teacher approval.

Then use course_artifact_commit with Root kind, the author's new path, and the exact context top-level bindingSha256, taskId and Root commitRequestId bound to requestId by the graph. The Host preserves the current title, outline, assets and lesson parent when they are unchanged, applies CAS and saves the next draft. Use course_artifact_compile on commit's exact returned source and top-level bindingSha256, Root format, documentKind, taskId and compileRequestId bound to requestId. Compact graph bindings select top-level outputs, never nested binding.sha256. All those machine values are graph bindings, never model transcription.

The deterministic compile tool is the required finalizer. Require succeeded=true and retain its real PDF and diagnostics; no final Main or whole-course delivery loop follows success. Compilation does not approve the deck. If compilation fails, this Run retains its failed receipt and source. Continuing the user task requires a newly Host-prepared scoped repair task with fresh Host request IDs, using this saved draft and exact diagnostics; repair only the failed file and retain the original successful PDF. Never replay a changed file under an old commit/compile ID, rebuild the lesson, or claim the failed Run completed. Host/CAS/capability errors stop with their actual diagnostic rather than repeated model attempts.
