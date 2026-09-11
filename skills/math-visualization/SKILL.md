---
name: math-visualization
description: Create shared, validated interactive 2D and 3D mathematical illustrations using fixed numeric specs instead of arbitrary executable HTML.
---
# Shared mathematical visualization

Use math_visualization schema first. Choose polynomial, matrix2d, surface3d or scatter2d/scatter3d. All numbers must be finite and within documented budgets. No free expressions, URLs, JavaScript, HTML or arbitrary Plotly configurations.

State the learning purpose, what the user can predict, which parameter/control they can vary, what to observe and what the illustration cannot establish. Label coordinates and units accurately. For a function use ascending polynomial coefficients; for matrix2d explain the transformed unit square and determinant/degeneracy. For 3D surfaces explain that viewpoint and scale may hide features. A scatter plot is not a proof of causation or clustering quality.

Artifacts are content-addressed, scoped to the actual course/Assignment or Study project, and rendered locally with the pinned strict Plotly build. Numeric validation and browser rendering are different checks. If WebGL is unavailable the viewer must say so, not claim a successful 3D render. Provide the numerical data and a text explanation as alternatives.

The plugin is shared by Course Builder and Study & Research. It does not execute arbitrary Python/R, run Manim, automatically place an image in a Beamer frame or certify mathematical claims. Those are separate explicitly approved workflows.
