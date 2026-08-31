# OpenMAIC adaptation notice

This checkpoint was informed by the public `THU-MAIC/OpenMAIC` repository at commit `f6cf8fd4b74ac83ea969e88b6dc2c974931b4d65`, distributed under the MIT License.

The implementation in `pi_own` does **not** import the OpenMAIC runtime, classroom Director, UI, slide DSL, or generated course artifacts. The new code is an independent implementation adapted to this repository's existing Pi Runtime Host, Resource Snapshot, Course Host, Grounding, Assessment, and Visual Host boundaries.

Ideas retained and rewritten for this project include:

- explicit Skill loading rather than name-only selection;
- backward lesson design;
- learner-first Teach-back;
- learning-to-learn actions;
- curriculum and spiral progression;
- focused fact checking and a claim-to-source research ledger;
- surgical editing;
- prediction-first interactive learning;
- evidence-backed personal Skill creation.

Ideas deliberately not adopted include:

- a second agent runtime or mandatory Director;
- mandatory virtual classroom roles, audio, video, or PPT workflows;
- loading every Skill on every turn;
- prompt-only safety claims;
- a universal ban on consecutive use of the same widget;
- page/slide production as the default representation of learning.

When substantial OpenMAIC code is copied in a future change, that change must preserve the upstream copyright and MIT permission notice in the copied portion. This checkpoint's Skill prose and Host implementation were rewritten for `pi_own` rather than copied verbatim.
