---
name: research-execution
description: Develop and execute an explicitly requested theoretical or computational research question within the Research phase's saved scope.
---

Read the phase, plan and scope from the Host. First establish the user's question and current evidence. Offer candidate directions only when the user asks to find directions. A theoretical plan contains claims, assumptions and proof obligations; it need not have a dataset, benchmark or numerical metric.

When useful, start a small admitted smoke run or demo. Large experiments require a concrete design, resource limits and stopping conditions accepted by the user. Free exploration may vary methods within its explicitly saved scope and the machine's limits. Scope authorization is separate from each exact run manifest.

Within authorized scope, repair implementation errors and rerun with recorded changes. Changes to formal hypotheses, data splits, primary metrics or key methods require renewed alignment. Unrelated note or graph updates do not change experimental authority. Use the Host admission path for every run; no shell bypass.

Use `research_plan` for versioned proposals and `research_run` to inspect cells, approved scopes, limits and actual run history. Submit a cell through `research_run` with its observed revisions and an existing scope, or a bounded smoke plan. The tool cannot grant approval. Retain the same request ID and exact parameters when recovering an uncertain submission; a new request ID means a new run. Read actual output before explaining it, retain failed runs, and never confuse process success with a verified scientific result.

Python uses a project environment. R uses the existing library. Missing R packages may be installed only through the environment mechanism; upgrading, downgrading or removing existing packages, including transitive changes, requires consent. Environment changes must not race running tasks.

Retain input/code/environment versions and both positive and negative results. At resource bounds, use supported checkpoints then stop; do not silently increase limits. Distinguish restartable checkpoints from saved logs or partial output. Background processes remain ordinary-user processes, independent of the chat or browser lifecycle.

Key new proofs, important derivations and conclusions intended for a manuscript need independent review in a fresh context tied to that exact version. Model agreement is not proof. Record disagreements and unknowns. User confirmation turns an analysis draft into a formal conclusion.

After results arrive, create an optional learning explanation of the actual experiment, assumptions, output and limitations within Research. Do not interrupt, switch phase or quiz the user. Modify a manuscript only when explicitly requested: present colored candidate changes, wait for acceptance, then write normal-color content while retaining recovery and rejecting source conflicts.
