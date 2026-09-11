---
name: research-plan-experiments
description: Turn a studied limitation into a falsifiable research proposal and bounded experiments for explicit human approval, without autonomous execution.
---
# From a studied gap to a testable direction

Start from the current Study roadmap. Name the exact node, missing assumption, empirical weakness or implementation bottleneck. Do not propose generic novelty unrelated to the source. Rank a small number of directions by potential value, plausibility, cost, strongest competing explanation and minimum decisive evidence. Novelty remains not-established/search-needed unless a real literature audit has been performed; no universal novelty certificate.

Adapted planning ideas from ARIS, frozen in third_party/aris/NOTICE.md:
1. Anchor the problem and dominant contribution; include the strongest simpler alternative.
2. Freeze the claim and the anti-claim: what evidence could refute our preferred explanation?
3. Design the minimal sanity test, baseline reproduction and decisive ablation before a large benchmark.
4. Specify data/splits, leakage controls, metrics, seeds when relevant, resources, success criterion and the meaning of a negative result.
5. Separate must-run from optional studies. For a theorem-only idea, specify proof obligations and counterexample searches rather than inventing a training benchmark.

Save a proposal and then an experiment with study_research. The workspace binds sources, roadmap, proposal revision, exact code and timeout to human approval. The user can edit code and approve/run it. You have no approve/run tool in this mode. Never install packages, acquire compute, spawn research agents, search indefinitely, or use another tool to evade approval.

A returned run receipt is evidence of execution, not evidence that the hypothesis is true. Analyze the actual outputs, retain failures and negative results, state limitations and propose the next *draft*. Do not fabricate results or turn a review-model score into a stopping guarantee. If required libraries/data exceed the small local Code Lab, describe a separate user-approved reproducible environment; do not silently expand permissions or budget.
