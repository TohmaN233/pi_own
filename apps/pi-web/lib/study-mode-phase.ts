export const STUDY_MODE_ID = "study-research.study";
export const RESEARCH_MODE_ID = "study-research.research";

export function studyModePhase(profileId: string): "study" | "research" | null {
  if (profileId === STUDY_MODE_ID) return "study";
  if (profileId === RESEARCH_MODE_ID) return "research";
  return null;
}
