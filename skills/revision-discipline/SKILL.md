---
name: revision-discipline
description: Inspect persisted artifacts, revise narrowly and verify the saved result.
---

# Artifact revision

Read the persisted target and its current revision before editing. Preserve the user's intent, established facts, neighbouring content, style and explicit template constraints.

## Choose the operation

Use the tool's structured `draft` object for exact edits and structured `spec` for delivery verification. Legacy `draftJson` examples need not be double-encoded; prefer their object form to avoid TeX escaping errors.

Identify the smallest leaf that expresses the request and the evidence that will confirm the change. Existing assets are the default starting point. Change only what the user requested and preserve all other content, examples, figures, ordering and styling. A request to improve, revise, regenerate, or fix an existing asset is not permission to discard it. Rewrite from scratch only when the user explicitly says to abandon or replace the existing asset. If a larger structural change seems necessary, explain the conflict and obtain that decision rather than silently replacing the asset.

Read enough context to understand references, dependencies, layout and source identity. When an API accepts a complete document, carry every unchanged field forward exactly rather than inventing a replacement. For a source-backed artifact, trace changed claims to their sources.

Use the currently observed `expectedRevision` and approved `parentRevision`. A revision conflict means state changed: reread, compare and decide again. Never retry by guessing a larger revision number.

An accepted deck is not locked against future revisions. A user's request to change it authorizes creating the next draft with `patch_deck` immediately; the Host preserves the accepted historical revision and clears acceptance on the new draft. Never demand that the user first cancel acceptance or visit another page. Only the teacher may accept or cancel acceptance; you may always create a requested revision.

## Verify persisted output

After saving, read the artifact back and compare the relevant section to the request. For slides or figures, compile or render when the capability exists, then inspect the output that the tool actually exposes. Use a look → edit → look loop for layout work.

Check cross-artifact consistency: titles and references, narration and visible content, exercises and answers, visuals and captions, lesson objectives and deck frames. A narrow revision must not silently break an approved ancestor or leave a stale descendant treated as current.

In Course Builder, use `read_deck` pagination for exact source, then `patch_deck` with `id`, observed `expectedRevision`, approved lesson `parentRevision`, and `draftJson:{edits:[{oldText,newText}]}` for precise changes. Each oldText must match exactly once; a failed match saves nothing. Use enough surrounding source to make it unique. `save_deck` is for first creation or an explicitly authorized full replacement. Then compile and review. A compiler receipt confirms compilation, not visual inspection. Surface any ancestor changes that invalidate downstream work.

A failed or rejected write leaves the previous durable artifact authoritative. Report the exact error and diagnostic next step. Never claim that an edit, compile, review or visual inspection succeeded without its corresponding evidence.

Adapted for Pi Own from OpenMAIC's `pro-editing` Skill at commit `1e10f60b151cedb59ac21ddbcceb5ee0eed9c984` (MIT).
