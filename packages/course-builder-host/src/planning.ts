import type { CourseBuilderProject, CourseBuilderProjectInput, SemesterPlan } from "./types.ts";

/** Inputs that change teaching arrangements, independently of sources and slide presentation. */
export function coursePlanningSettings(project: CourseBuilderProjectInput) {
	return {
		weeks: project.weeks,
		sessionsPerWeek: project.sessionsPerWeek,
		minutesPerSession: project.minutesPerSession,
		audience: project.audience,
		language: project.language,
		goals: [...project.goals].sort(),
	};
}

/** Shared by Host admission and UI controls. General project revisions only guard writes. */
export function semesterPlanningIssue(project: CourseBuilderProject, semester: SemesterPlan): string | null {
	const slots = new Set(semester.sessions.map((slot) => `${slot.week}:${slot.session}`));
	if (
		semester.sessions.length !== project.weeks * project.sessionsPerWeek ||
		slots.size !== semester.sessions.length ||
		semester.sessions.some(
			(slot) =>
				slot.week < 1 || slot.week > project.weeks || slot.session < 1 || slot.session > project.sessionsPerWeek,
		)
	)
		return "课次数量或安排已变化，请调整学期计划并确认。";
	const covered = new Set(semester.sessions.flatMap((slot) => slot.courseGoalsCovered));
	if (project.goals.some((goal) => !covered.has(goal))) return "学期计划尚未覆盖当前课程目标，请调整后确认。";
	// Legacy plans did not record planning-only revisions. Preserve their existing
	// review and validate their observable calendar/goals; do not invent past changes.
	if ((semester.projectPlanningRevision ?? 0) !== (project.planningRevision ?? 0))
		return "课程目标、课时或教学对象等规划条件已变化，请调整学期计划并确认。";
	return null;
}
