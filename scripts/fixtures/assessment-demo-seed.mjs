export function createS4Ci3DemoExercises(courseVersionId, createExercisePrivate) {
  return [
    {
      public: {
        exerciseId: "s4ci3-demo-meaning",
        courseVersionId,
        conceptIds: ["mathematical-modeling"],
        prompt: "Write one sentence explaining why a mathematical model needs clearly stated assumptions.",
        hints: ["Think about what limits the situation being modeled."],
        unlockPolicy: "after-meaningful-attempt",
        revision: 1,
      },
      private: createExercisePrivate(
        "s4ci3-demo-meaning",
        "A mathematical model needs clearly stated assumptions because they define the conditions under which its conclusions apply.",
        ["assumptions define conditions"],
        "Look for a concrete connection between assumptions and the scope of a model's conclusion.",
      ),
    },
    {
      public: {
        exerciseId: "s4ci3-demo-reasoning",
        courseVersionId,
        conceptIds: ["mathematical-reasoning"],
        prompt: "Give a short reason why checking units can catch an error in a calculation.",
        hints: ["Compare the units required by the quantity with the units produced by the expression."],
        unlockPolicy: "after-meaningful-attempt",
        revision: 1,
      },
      private: createExercisePrivate(
        "s4ci3-demo-reasoning",
        "Checking units can catch an error because a valid calculation must produce units consistent with the quantity being computed.",
        ["units must be consistent"],
        "Look for consistency between the result's units and the intended physical or mathematical quantity.",
      ),
    },
  ];
}
