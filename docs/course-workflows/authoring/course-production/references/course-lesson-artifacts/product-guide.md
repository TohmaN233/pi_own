# Backward course and lesson design

For each substantial unit, decide in this order:

- the concept and transferable understanding;
- required prerequisites and likely misconceptions;
- observable performance that would demonstrate understanding;
- explanation, example, learner action, feedback and retry;
- a new case that tests transfer or a boundary.

Every objective needs corresponding evidence and an activity. Every activity needs a stated instructional purpose. Schedule prerequisites before dependent ideas. A revisit must add complexity, a relationship, abstraction, formalization, representation, transfer distance or a boundary/counterexample. Repeating the same explanation under a new heading is not progression.

Use realistic timing. Lesson segment minutes must fit within `minutesPerSession`; leave space for learner attempts and feedback rather than filling the whole session with presentation. For teach-back activities, plan the learner's first explanation, one or two diagnostic questions, a revision and a transfer case. Do not invent the learner's answers or mark planned learning as completed.

# Beamer authoring

A Beamer frame is a learner-facing page of subject matter. Visible text is a definition, derivation, example, diagram, table, code, or a mathematical question. It is not a script for the teacher.

Never print teacher-action language: Check verbally, Say, Ask, Predict, Prediction, Question, Try, Retest, Answer, Board cue, Expected, Transition, Pause, Reveal, or Misconception. Do not use a bold label to tell the teacher what to do. A title names the mathematics, not a classroom move.

A calculation the class should perform is written only as the problem. Leave a blank, a question mark, or the unresolved question. Do not print the numerical result, the selected category, or a sentence that gives that result away on the same frame. The solution, the expected reasoning, and any timing belong in the lecture notes, so the teacher can withhold them while students calculate. A derivation the teacher is presenting may show its algebra. An exercise may not show its solution.

Open a new idea with the concrete case that makes the definition necessary, then state the definition and one contrast or boundary. Keep one purpose on a frame, but do not leave it as a name without the formula the learner must use. If a slide uses a gamma, exponential, uniform, or other named density, write that density on the slide, including its support and parameters. A frame that only says "gamma target" or "exponential candidate" is incomplete. Equations, tables, and code must remain readable from the back of the room; split the frame instead of shrinking type or omitting the density. A diagram needs labeled axes. On a code frame, use `fragile` and show what each consequential expression computes. Do not use three or more `\\[1em]` breaks on one frame; the review counter treats each as displayed mathematics.

Preserve the configured theme, preamble, author, institute, language, aspect ratio, font size, overlay policy, reference policy, backup slide count, and notes setting. Do not force SJTU, Madrid, 10pt, 16:9, overlays, a references slide, or backup slides when the profile says otherwise. Use inline `thebibliography` when references are required because no BibTeX workflow is exposed.

Imported image assets use `assets/MATERIAL_ID.ext` with the actual supported extension and must be listed in `assetMaterialIds`. Text extracted from PDF or PPTX does not reproduce the source layout, image meaning, animation, or master theme.

Use TikZ or pgfplots for a bounded, self-contained vector diagram when the geometry carries the idea. Check coordinate systems, labels, clipping, arrow direction, legend meaning, and scale. Decorative graphics must not compete with the content.
