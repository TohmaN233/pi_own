# Course Builder smoke prompt

Use this prompt only after opening a normal Pi session, selecting Course Builder, creating a project, and importing a small set of course materials.

```text
Analyze every material in the current Course Builder project. Produce a material analysis that identifies the knowledge dependency chain, duplicates, gaps, notation conflicts, possible exercises, and visualization opportunities. Then create a complete Semester Plan draft for the configured weeks and sessions. Stop at the teacher approval gate. Do not approve the plan yourself and do not create lesson slides yet.
```

After approving the Semester Plan in the teacher UI:

```text
Create the Lesson Plan for week 1, session 1 from the approved Semester Plan. Include observable outcomes, prerequisites, misconceptions, timing, teacher actions, learner actions, checks for understanding, one worked example, one retrieval/prediction activity, and visual requirements. Stop at the teacher approval gate.
```

After approving the Lesson Plan:

```text
Create a frame-by-frame Beamer outline, then generate the first lesson deck using the current Beamer Profile. Compile it through the dedicated Course Builder compiler. Report the real exit status, pages, unresolved references, undefined commands, overfull boxes, current source/PDF/log hashes, and slides requiring human visual inspection. Do not grant final acceptance yourself.
```
