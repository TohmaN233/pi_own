import type { CourseBuilderAssignment, CourseBuilderProject } from "../../../packages/course-builder-host/src/types.ts";

function section(title: string, items: readonly string[], ordered = false): string {
	return `## ${title}\n\n${items.map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${item}`).join("\n")}`;
}

/** One canonical Assignment document for browser review and downloaded Markdown. */
export function assignmentMarkdown(
	assignment: CourseBuilderAssignment,
	teacherCopy: boolean,
	project?: Pick<CourseBuilderProject, "assignmentPreamble">,
): string {
	const draft = assignment.draft;
	if (!draft) throw new Error("Assignment draft is unavailable");
	return [
		`# ${assignment.title}`,
		project?.assignmentPreamble?.trim() ? `> ${project.assignmentPreamble.trim().replace(/\n/gu, "\n> ")}` : "",
		draft.overview,
		section("任务", draft.tasks, true),
		section("提交内容", draft.deliverables),
		section("评分标准", draft.rubric),
		...(teacherCopy ? [section("教师用解题提示", draft.solutionNotes)] : []),
		`---\nAssignment ID: ${assignment.assignmentId}  \nRevision: ${assignment.revision}  \nStatus: ${assignment.status}`,
	].filter(Boolean).join("\n\n") + "\n";
}
