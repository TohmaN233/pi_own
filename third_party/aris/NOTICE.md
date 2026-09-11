# ARIS planning attribution

Source: https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep
Frozen commit: `f1bd907b58f653131ebe6807c482e2554e07f9b9`
License: MIT; retained in LICENSE.

The original Pi Own Skills adapt planning concepts from `skills/experiment-plan/SKILL.md`, `skills/research-refine/SKILL.md`, `skills/ablation-planner/SKILL.md` and `skills/proof-checker/SKILL.md`. They do not vendor ARIS's runtime.

Adopted: problem/claim/evidence alignment, strong simple alternatives, decisive ablations, resource budgets, negative-result interpretation and explicit proof obligations. Excluded: autonomous experiment deployment, GPU acquisition, sleep loops, model-score-driven convergence, silent shell fallbacks and self-approval. Native Host authority gates override Skill suggestions.
