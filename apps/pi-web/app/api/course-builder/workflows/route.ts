import { isApiRequestAllowed } from "@/lib/request-security";
import { builderError, builderString, readCourseBuilderJson, requireCourseBuilderRuntime } from "@/lib/course-builder-request";
import { prepareCourseWorkflowTask, preflightCourseWorkflowTask, listCourseWorkflowTasks, startCourseWorkflowTask, statusCourseWorkflowTask, cancelCourseWorkflowTask, cleanupCourseWorkflowTasks, courseWorkflowTaskDefinition, type CourseWorkflowPrepareInput } from "@/lib/course-workflow-tasks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function guard(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  if (request.headers.get("x-course-builder-teacher") !== "1") return Response.json({ error: "Teacher task selection required" }, { status: 403 });
}
export async function GET(request: Request) {
  const refused = guard(request); if (refused) return refused;
  try {
    const query = new URL(request.url).searchParams, sessionId = builderString(query.get("sessionId"));
    await requireCourseBuilderRuntime(sessionId);
    return Response.json(query.has("taskId") ? await statusCourseWorkflowTask(sessionId,builderString(query.get("taskId"))) : await listCourseWorkflowTasks(sessionId));
  } catch (error) { return builderError(error); }
}

export async function POST(request: Request) {
  const refused = guard(request); if (refused) return refused;
  try {
    const input = await readCourseBuilderJson(request), sessionId = builderString(input.sessionId);
    await requireCourseBuilderRuntime(sessionId, input.action !== "status" && input.action !== "cancel");
    if(input.action === "cleanup")return Response.json(await cleanupCourseWorkflowTasks(sessionId));
    if (input.action === "status") return Response.json(await statusCourseWorkflowTask(sessionId,builderString(input.taskId)));
    if (input.action === "cancel") return Response.json(await cancelCourseWorkflowTask(sessionId,builderString(input.taskId)));
    if (input.action === "run") return Response.json(await startCourseWorkflowTask(sessionId,builderString(input.taskId)));
    if(input.action==="preflight") return Response.json(await preflightCourseWorkflowTask(sessionId,builderString(input.taskId)));
    if (input.action !== undefined && input.action !== "prepare") throw new Error("Unknown course Workflow action");
    if (input.productAction !== undefined && input.workflowId !== undefined && input.productAction !== input.workflowId) throw new Error("Conflicting Course product selections");
    const definition = courseWorkflowTaskDefinition(input.productAction ?? input.workflowId);
    const selectors = [input.course !== undefined, input.assignmentId !== undefined, input.lessonId !== undefined, input.week !== undefined || input.session !== undefined].filter(Boolean).length;
    if (selectors !== 1) throw new Error("Select exactly one course, Assignment, lesson or semester slot");
    const target: CourseWorkflowPrepareInput["target"] = input.course !== undefined ? { course: input.course as true }
      : input.assignmentId !== undefined ? { assignmentId: builderString(input.assignmentId) }
      : input.lessonId !== undefined ? { lessonId: builderString(input.lessonId) }
      : { week: Number(input.week), session: Number(input.session) };
    if ("course" in target && target.course !== true) throw new Error("Invalid course target");
    if ("week" in target && (!Number.isSafeInteger(target.week) || target.week < 1 || !Number.isSafeInteger(target.session) || target.session < 1)) throw new Error("Invalid semester slot");
    if (typeof input.task !== "string") throw new Error("Teacher task is required");
    const materialIds = input.materialIds === undefined ? undefined : Array.isArray(input.materialIds) ? input.materialIds.map(builderString) : (() => { throw new Error("Invalid material selection"); })();
    const attachmentIds = input.attachmentIds === undefined ? undefined : Array.isArray(input.attachmentIds) ? input.attachmentIds.map(builderString) : (() => { throw new Error("Invalid attachment selection"); })();
    if (input.discardBaseline !== undefined && typeof input.discardBaseline !== "boolean") throw new Error("discardBaseline must be boolean");
    return Response.json(await prepareCourseWorkflowTask(sessionId, { productAction: definition.workflowId, target, materialIds, attachmentIds,
      ...(input.baselineTaskId !== undefined ? {baselineTaskId:builderString(input.baselineTaskId)} : {}),
      ...(input.discardBaseline !== undefined ? {discardBaseline:input.discardBaseline} : {}), task: input.task }));
  } catch (error) { return builderError(error); }
}
