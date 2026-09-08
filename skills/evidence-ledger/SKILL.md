---
name: evidence-ledger
description: Check consequential claims and maintain a bounded source and conflict ledger.
---

# Evidence and research

Use this when claims materially affect correctness: disputed statements, exact quotations, specialist assertions, dates, statistics, definitions that vary by source, or conflicting conventions. Stable textbook knowledge does not need a research ceremony for every lesson.

## Triage and ledger

First distinguish creation from review. During creation, track claims as they enter the artifact. During review, read the real persisted artifact and shortlist the claims whose failure would change the conclusion or teaching design.

For each consequential claim, maintain:

- the claim in checkable form;
- source ID and location or URL when available;
- publication date, version or scope when material;
- evidence type: supplied material, direct observation, derivation, deterministic computation, external source or insufficient support;
- supporting or conflicting evidence;
- resolution and remaining caveat.

Start with supplied materials. Use external research only for current, disputed or specialist claims when the runtime exposes a research tool. Prefer primary and authoritative sources. Research breadth and search counts are budgets chosen for the task, not universal fixed numbers.

## Conflict rules

When sources disagree, preserve both claims and identify differences in date, population, assumptions, definition or measurement. Resolve only when evidence supports a resolution. If an approved input conflicts with another source and the teacher's intended convention matters, surface the choice rather than silently overriding it.

"No reliable evidence found" means the search was insufficient to establish the claim. It does not mean the claim is false. Never invent a material ID, citation, search result, date or verification receipt.

## Course Builder boundary

Read imported materials through bounded `read_material` calls and follow pagination. Associate source IDs with analysis, plans and decks. Put terminology conflicts and sequence conflicts in material analysis; put unresolved limitations in rationale or lesson notes.

The Course Builder tool does not provide web search. If a lesson depends on an external current claim, request a source or label it unverified. Do not claim that loading this Skill grants browsing.

For an explicitly requested research task in a capable mode, bound the question into a few useful facets, maintain the claim-to-source ledger, read the sources themselves and synthesize only supported conclusions. Optional research must not expand an ordinary lesson into an unrelated investigation.

Before saving, check that every high-impact claim is traceable, conflicts are visible and source absence is described accurately.

Adapted for Pi Own from OpenMAIC's `fact-check` and `deep-research` Skills at commit `1e10f60b151cedb59ac21ddbcceb5ee0eed9c984` (MIT).
