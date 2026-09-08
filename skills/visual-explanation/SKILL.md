---
name: visual-explanation
description: Create and verify a purposeful visualization for teaching or learner exploration.
---

# Visual explanation

Start from the concept and the misconception the visual should resolve. State the learner's prediction question, the quantities or relationships to show, the meaningful comparison and the explanation requested afterward. Prefer a simple accurate diagram to decoration.

## Teaching design

Define an action-observation-conclusion contract:

- what the learner predicts and why;
- which cases, parameters, states or transformations appear;
- what the learner compares or follows;
- what visual encoding represents each quantity;
- what observation matters;
- what conclusion and transfer question follow.

Use a visual when spatial relationship, change over steps, comparison, transformation or state makes the concept clearer. Use text, equations or a table when those express the idea more directly. Do not add a graphic solely to fill a frame.

## Course Builder execution

1. Read `state` and the relevant approved lesson. Choose a visual that supports an objective and respects source constraints.
2. Call `visual_templates` to obtain current executable kinds, exact payload fields, limits and examples. The returned machine contract is authoritative; do not guess keys or invent a renderer.
3. Call `visual` with `id=lessonPlanId`, a purpose that describes the learning activity, and `specJson` containing one complete supported spec. Use the current `projectId` as `courseVersionId`. Use a positive revision. A changed definition must follow the Visual Host's spec identity rules.
4. Inspect returned data, deterministic trace and artifact identity. Check mathematical meaning, units, scale, labels, ordering, boundary cases and whether the comparison actually supports the purpose.
5. Direct the teacher to open the workspace preview. Fixed validation is not visual inspection and is not evidence of student understanding.

The fixed Host supports polynomial function plots, 2×2 matrix transformations, insertion-sort or bubble-sort traces, breadth-first graph traversal and state-machine traces. It emits self-contained static HTML with deterministic data and trace. It does not execute arbitrary HTML, JavaScript, Python or R and does not provide slider-based simulation.

## Beamer relationship

For another bounded diagram, use self-contained TikZ or pgfplots through the approved deck workflow when appropriate. Verify coordinate systems, labels, clipping, scale, color meaning and legibility. Do not claim that a standalone HTML artifact was inserted into Beamer automatically.

Keep the prediction prompt, reveal point and follow-up explanation in the lesson plan even when the figure is static. A visual is complete only when the artifact renders, its trace matches its meaning, and the teacher has a clear activity for using it.

Adapted for Pi Own from OpenMAIC's `deep-interactive`, `workshop-style` and `slide-craft` principles at commit `1e10f60b151cedb59ac21ddbcceb5ee0eed9c984` (MIT).
