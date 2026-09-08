---
name: learning-to-learn
description: Embed a few purposeful retrieval, prediction and self-explanation actions in learning.
---

# Learning actions

Embed a small number of useful learning actions in the concept work. Do not create a detached page of generic study advice, and do not require a novice to explain material they have not yet encountered.

## Select the learning move

Keep a concept goal and, when useful, a parallel learning-process goal. Choose one or two strategies that fit the cognitive work:

- **Retrieval:** recall a prerequisite, distinction or procedure before revealing it. Keep the prompt small enough to be attempted.
- **Prediction:** predict a result and give a reason before a computation, experiment, diagram or worked example is shown.
- **Self-explanation:** explain why one load-bearing step, representation or choice is valid. Avoid narrating every trivial step.
- **Contrast:** compare examples that differ in one meaningful feature and explain which feature changes the outcome.
- **Feedback and retry:** locate the smallest actionable discrepancy, give a focused hint and preserve another attempt.
- **Transfer:** change one structural condition and ask what remains valid, what changes and why.

Use retrieval for something the learner has had a fair chance to learn. Use prediction when the later observation can confirm or challenge a reason. Use self-explanation after enough material exists to explain. Do not turn every activity into a quiz.

## Place actions in the lesson

At the opening, use one brief retrieval or prediction to activate relevant prior knowledge and expose assumptions. During the body, place self-explanation at a conceptual hinge, not after every sentence. In hands-on work, require an attempt before feedback, make the consequence visible and allow a retry. At the close, ask for the concept learned, the evidence that changed the learner's thinking and one future retrieval cue.

For teacher preparation, write the actual prompt, expected evidence and feedback opportunity into `learnerAction`, `checkForUnderstanding`, exercises or notes. Do not simulate a student's answer or mark a planned action as completed. For live tutoring, wait for the learner's response whenever the action depends on it.

For a visualization, connect prediction → manipulation or meaningful comparison → observation → explanation → one changed case. A static visual may support comparison, reveal or annotation; do not describe controls that do not exist.

## Quality gate

Check that the selected action changes what the learner does, produces observable evidence, fits the learner's prior exposure and leaves a retry or transfer path. Remove strategy labels from learner-facing prose unless naming the strategy itself is part of the goal.

Adapted for Pi Own from OpenMAIC's `learning-to-learn` Skill at commit `1e10f60b151cedb59ac21ddbcceb5ee0eed9c984` (MIT).
