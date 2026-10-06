---
name: course-lesson-artifact-workflow
description: Generate one new selected lesson draft, learner-facing Beamer source/PDF and executable R Markdown from a bounded course task, without loading the entire course preparation pipeline.
---

# One lesson, bounded artifacts

This workflow generates a new lesson bundle. Its input is a Host-created `taskId` and the teacher's `task`. The Host binds the course, approved semester slot, material selection, output directory and observed revisions before execution. The author must return both a complete `lessonDraft` and the requested `files`; the draft is required. A model must never choose another project, invent identities or approve a teacher draft. Missing semester prerequisites stop before a model call. The new teacher-facing lesson draft remains pending teacher approval; that pending review permits standalone experimental TeX/PDF/Rmd generation and compilation.

## Selected context

Invoke the registered deterministic `course_task_context` tool with the Host-supplied taskId. Bind its top-level `bindingSha256` output directly to the next Host tool's `bindingSha256` input. Each Host tool emits this required top-level field equal to its retained `binding.sha256`; the nested binding remains for external CAS auditing, not a compact graph binding. Do not have the author copy IDs, hashes, CAS revisions or unchanged metadata. Give the author only the selected lesson context, relevant source windows, the requested artifact kinds and teacher requirements. Do not read the entire course state, repeat the whole semester, inherit unrelated deliveries or load Assignment/lecture-script/HTML instructions for this lesson bundle.

## Author the requested bundle

One independent, explicitly bound Pi Provider authors the lesson draft and the requested files in the `sources` subdirectory of the Host-bound task directory, with a write grant restricted to `sources`. Other task files are read-only; Host control records live outside the child's workspace. It gets the selected context and full relevant pedagogical references in `references/lesson-and-beamer.md`; it does not get the conversation history. Read that reference before authoring. Use a single child, not a planning/review conversation for each file. The teacher's language, duration and Beamer profile govern the output.

Plan backward from transferable understanding and observable evidence: prerequisites → motivating concrete example → definitions and derivation → comparison or boundary → learner attempt → transfer. Objectives, activities and evidence must correspond. Assume earlier scheduled lessons have been taught, while making unverified prerequisites explicit in the teacher draft. Do not invent student performance. Keep the lesson plan teacher-facing and the slides learner-facing.

Create the requested new files with descriptive filenames beneath `sources/`. This graph does not perform small edits or file-only revisions; those use a separately bound revision workflow. Preserve the approved semester plan and unrelated lesson products.

The author emits only the new lesson draft's semantic fields and its newly chosen relative `sources/` file paths. It does not copy hashes or paths from context or tool-result metadata into structured output. Read `references/semantic-output.md` for the exact field format. The Host computes byte identities and carries the resulting exact references to compilation. A source file is not a compile receipt.

## Persist exact artifacts

Invoke registered `course_artifact_commit` using the preceding exact Host binding plus the author's semantic draft and new file paths. The Host validates physical files beneath `sources/`, computes their SHA-256 hashes and byte counts, checks revisions, project ownership and parent status, then saves a new draft and returns exact file references. It must preserve previously accepted versions. This step never approves a lesson or accepts a deck. A pending lesson draft may have standalone experimental TeX/PDF/Rmd artifacts, clearly pending teacher review; those artifacts are not an approved Course Builder deck.

## Execute and deliver

Use registered `course_artifact_compile` on commit's exact `files` and top-level `bindingSha256` outputs, through graph bindings. XeLaTeX produces the Beamer PDF; installed R/knitr executes the R Markdown and retains real output and diagnostics. Rendering with rmarkdown is distinct from knitting: unavailable Pandoc is an explicit render prerequisite, not permission to claim a rendered Rmd PDF. The Beamer PDF and executed Rmd can be delivered independently of an Rmd PDF.

The final acceptance is this deterministic Host tool, with its required `succeeded` boolean and receipt-bound artifact hashes. Every requested product must pass; a partial PDF, a saved Rmd that never ran, or a model's completion claim is insufficient. No extra Main turn or generic entire-course delivery loop is needed to verify a successful bundle. Return the concrete paths and remaining teacher review state.

An ordinary code/TeX error retains exact diagnostics and source for a separately bound repair. Retain successfully compiled products. A Host identity/CAS/capability failure stops with actionable diagnostics; repeating model turns cannot resolve it. Small edits and repair requests consume the retained artifact in their own workflow instead of widening this new-lesson graph.

## Provenance

Adapted from Pi Own's `lesson-blueprint` and the Beamer/R Markdown sections of `course-planning-beamer`, including their OpenMAIC backward-design and interactive-learning attribution. Host delivery, approvals and exact revision identity remain executable code contracts, not model-authored claims.
