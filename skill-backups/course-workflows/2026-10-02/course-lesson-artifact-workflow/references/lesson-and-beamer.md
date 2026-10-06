# Lesson and learner-facing Beamer

Use one or two central questions to plan the lesson. For each objective, specify evidence that distinguishes understanding from imitation, the activity producing that evidence, and the example or explanation preparing it. Reserve actual time for attempts and feedback. Include a changed-context task or boundary case; repetition of the same calculation does not establish transfer.

Each frame has one purpose, with enough formula, definition, diagram, table or code to make the subject usable. Motivate the formal definition with a concrete case. Named densities include support and parameters. Derivations retain their assumptions and important steps. Comparisons state their cost basis and uncertainty. Never promise that a variance reduction technique always improves variance.

Visible slide text concerns the subject. Remove internal workflow, checkpoints, delivery, source-limited flags, framework acronyms and teacher-action labels. Timing, expected student responses, teaching cues, solutions to exercises and misconceptions belong in the teacher draft or notes. An exercise does not print its solution on the same page. Definitions and worked derivations may show complete algebra.

Follow the supplied language, theme, preamble, author, institute, font size, aspect ratio, overlay and reference settings. Do not invent a replacement theme. Prefer readable fonts and bounded formulas to shrinking content. Use `fragile` for code frames. A valid `\texttt{...}` is normal TeX; a double-escaped `\\texttt{...}` can expose the command name and must be corrected. Avoid unnecessary overlays when the teacher requests a page count. References can use inline `thebibliography` without an unconfigured BibTeX pipeline.

R Markdown must contain executable examples with reproducible seeds, explicit assumptions, uncertainty estimates and meaningful numerical checks. Use installed packages only. Compare methods fairly in target evaluations or other stated cost; pair correlation and fitted control coefficients require honest treatment. Do not use the computation itself as its only mathematical oracle. Verify exact analytical cases or independent boundary checks when available. Never call a source listing executed output.

In a revision, preserve the current correct content and its assets. Resolve a mismatch by reading the saved source, not by rewriting correct mathematics to match an old quote. Compilation and file hashes are Host evidence; they do not establish academic correctness or human approval.
