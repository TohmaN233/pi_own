import type { LessonPlanDraft } from "../../../packages/course-builder-host/src/types";

export const LESSON_TEXT_SECTIONS = [
  ["objectives", "学习目标"], ["prerequisites", "前置知识"], ["misconceptions", "常见误解"],
  ["examples", "讲解与示例"], ["exercises", "练习与理解检查"], ["visualRequests", "可视化安排"], ["notes", "教师备注"],
] as const;

/** Copy editable content only; neither browser drafts nor teacher edits carry approval fields. */
export function lessonReviewDraft(value: unknown): LessonPlanDraft {
  if (!value || typeof value !== "object") throw new Error("无法读取暂存的教案内容");
  const item = value as Record<string, unknown>;
  for (const key of ["week", "session"]) if (!Number.isInteger(item[key])) throw new Error(`教案 ${key} 无效`);
  if (typeof item.title !== "string") throw new Error("教案标题无效");
  for (const key of [...LESSON_TEXT_SECTIONS.map(([key]) => key), "materialIds"]) {
    if (!Array.isArray(item[key]) || !(item[key] as unknown[]).every((text) => typeof text === "string")) throw new Error(`教案 ${key} 无效`);
  }
  if (!Array.isArray(item.segments) || !item.segments.every((segment) => segment && typeof segment === "object" && typeof segment.minutes === "number" && Number.isFinite(segment.minutes) && ["title", "teacherAction", "learnerAction"].every((key) => typeof segment[key] === "string") && (segment.checkForUnderstanding === null || typeof segment.checkForUnderstanding === "string"))) throw new Error("教学环节无效");
  const { week, session, title, objectives, prerequisites, misconceptions, segments, examples, exercises, materialIds, visualRequests, notes } = item as unknown as LessonPlanDraft;
  return structuredClone({ week, session, title, objectives, prerequisites, misconceptions, segments, examples, exercises, materialIds, visualRequests, notes });
}
