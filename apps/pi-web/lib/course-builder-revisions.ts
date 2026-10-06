import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CourseBuilderHost, CourseBuilderCommand } from "../../../packages/course-builder-host/src/index.ts";
import { getRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { CourseDeliveryLoop, DELIVERY_ENTRY, type DeliveryTask } from "./course-builder-delivery";
import { prepareCourseWorkflowTask, startCourseWorkflowTask } from "./course-workflow-tasks";
import { recoverFailedVisualBinding } from "./course-builder-delivery-target";

export type ReviewAction = "review_semester" | "review_lesson" | "review_assignment";
export interface CourseRevisionTask {
  sessionId: string;
  requestId: string;
  action: ReviewAction;
  targetId: string;
  baseRevision: number;
  note: string;
  createdAt: string;
  status: "sending" | "sent" | "failed" | "completed";
  error?: string;
  completedRevision?: number;
  workflowTaskId?: string;
  runId?: string;
}
const ENTRY = "pi-web:course-revision";
const locks = new Set<string>();

function tasksFrom(manager: SessionManager): CourseRevisionTask[] {
  const tasks = new Map<string, CourseRevisionTask>();
  for (const entry of manager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
    const task = entry.data as CourseRevisionTask;
    if (!task || typeof task.requestId !== "string" || typeof task.targetId !== "string" || typeof task.note !== "string" || !Number.isSafeInteger(task.baseRevision) || !["sending", "sent", "failed", "completed"].includes(task.status)) throw new Error("Invalid saved course revision task");
    if (task.sessionId === manager.getSessionId()) tasks.set(task.requestId, task);
  }
  return [...tasks.values()];
}

function persist(manager: SessionManager, task: CourseRevisionTask): void {
  manager.appendCustomEntry(ENTRY, task);
  const file = manager.getSessionFile();
  if (!file || tasksFrom(SessionManager.open(file)).find((item) => item.requestId === task.requestId)?.status !== task.status) throw new Error("Course revision task was not persisted in the Pi transcript");
  console.info("[course-builder] revision task", { sessionId: manager.getSessionId(), requestId: task.requestId, targetId: task.targetId, status: task.status, baseRevision: task.baseRevision, completedRevision: task.completedRevision });
}

export async function readCourseRevisionTasks(sessionId: string) {
  const wrapper = getRpcSession(sessionId);
  const path = wrapper?.isAlive() ? null : await resolveSessionPath(sessionId);
  const manager = wrapper?.isAlive() ? wrapper.inner.sessionManager : path ? SessionManager.open(path) : null;
  return manager ? tasksFrom(manager).map((task) => ({ ...task, running: (task.status === "sent" || task.status === "sending") && !!wrapper?.isRunning() })) : [];
}

export async function readCourseDeliveryTask(sessionId: string, host: CourseBuilderHost): Promise<DeliveryTask | null> {
  const wrapper = getRpcSession(sessionId);
  const path = wrapper?.isAlive() ? null : await resolveSessionPath(sessionId);
  const manager = wrapper?.isAlive() ? wrapper.inner.sessionManager : path ? SessionManager.open(path) : null;
  if(!manager)return null;
  return new CourseDeliveryLoop({
    snapshot:()=>{const snapshot=host.getSnapshotForSession(sessionId);if(!snapshot)throw new Error("Delivery course is unavailable");return snapshot;},
    visualBindingRecovery:(task)=>{const snapshot=host.getSnapshotForSession(sessionId);return snapshot && task.target ? recoverFailedVisualBinding(snapshot,task.id,task.target,manager.getBranch()) : undefined;},
    load:()=>{const entry=manager.getBranch().reverse().find((item)=>item.type==="custom"&&item.customType===DELIVERY_ENTRY);return entry?.type==="custom" ? entry.data as DeliveryTask : undefined;},
    save:(task)=>{manager.appendCustomEntry(DELIVERY_ENTRY,task);console.info("[course-delivery] binding restored",{sessionId,taskId:task.id,target:task.target,repair:task.bindingRepair});},
  }).restore() ?? null;
}

/** Review and dispatch share one admission boundary. Retries replay the receipt. */
export async function requestCourseRevision(host: CourseBuilderHost, wrapper: AgentSessionWrapper, input: { sessionId: string; action: ReviewAction; id: string; revision: number; note: string; requestId: string }) {
  const manager = wrapper.inner.sessionManager;
  if (locks.has(input.sessionId)) throw new Error("A teacher revision request is being submitted; wait before retrying");
  locks.add(input.sessionId);
  try {
    const prior = tasksFrom(manager).find((task) => task.requestId === input.requestId);
    if (prior) {
      if (prior.action !== input.action || prior.targetId !== input.id || prior.baseRevision !== input.revision || prior.note !== input.note) throw new Error("Revision request ID was reused with different review instructions");
      if (prior.status === "failed") throw new Error(prior.error ?? "Revision prompt failed; submit a new retry request");
      return prior;
    }
    if (wrapper.isRunning()) throw new Error("Session is busy; wait before requesting revisions");
    const snapshot = host.getSnapshotForSession(input.sessionId);
    const target = input.action === "review_semester" ? (snapshot?.semesterPlan?.semesterPlanId === input.id ? snapshot.semesterPlan : null) : input.action === "review_lesson" ? snapshot?.lessonPlans.find((plan) => plan.lessonPlanId === input.id) : snapshot?.assignments.find((assignment) => assignment.assignmentId === input.id);
    // Assignment review itself advances its version. Resending that exact saved
    // review must not apply it a second time or fail against its pre-review version.
    const reviewed = target?.status === "changes-requested" && target.review?.targetRevision === input.revision && target.review.note === input.note.trim();
    if (!reviewed) {
      if (input.action === "review_semester") host.reviewSemesterPlan(input.sessionId, input.id, input.revision, "request-changes", input.note);
      else if (input.action === "review_lesson") host.reviewLessonPlan(input.sessionId, input.id, input.revision, "request-changes", input.note);
      else host.reviewAssignment(input.sessionId, input.id, input.revision, "request-changes", input.note);
    }
    const task: CourseRevisionTask = { sessionId: input.sessionId, requestId: input.requestId, action: input.action, targetId: input.id, baseRevision: input.revision, note: input.note, createdAt: new Date().toISOString(), status: "sending" };
    persist(manager, task);
    const assignment = input.action === "review_assignment";
    try {
      const prepared=await prepareCourseWorkflowTask(input.sessionId,{
        workflowId:assignment ? "course-assignment-plan" : input.action==="review_semester" ? "course-semester-plan" : "course-lesson-plan",
        target:assignment ? {assignmentId:input.id} : input.action==="review_semester" ? {course:true} : {lessonId:input.id},
        task:`Apply the teacher's requested changes to the existing target. Preserve unaffected content, visuals and styling; replacement requires explicit abandonment. Save a new draft for teacher review.\nTeacher changes:\n${input.note}`,
      });
      task.workflowTaskId=prepared.taskId;
      persist(manager,task);
      const started=await startCourseWorkflowTask(input.sessionId,prepared.taskId);
      task.runId=started.runId;
      const latest = tasksFrom(manager).find((item) => item.requestId === task.requestId);
      if (latest?.status === "completed") return latest;
      const sent = { ...task, status: "sent" as const };
      persist(manager, sent);
      return sent;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      persist(manager, { ...task, status: "failed", error });
      throw new Error(`审查意见已保存，但 Workflow 修改未确认启动：${error}`);
    }
  } finally { locks.delete(input.sessionId); }
}

/** Called only after the delivery gate verifies every requirement for the saved target. */
export function completeCourseRevisionTasks(sessionId: string, command: CourseBuilderCommand, result: unknown, workflowTaskId?: string): void {
  const action = command.action === "save_semester" ? "review_semester" : command.action === "save_lesson" ? "review_lesson" : command.action === "save_assignment" ? "review_assignment" : null;
  if (!action) return;
  const manager = getRpcSession(sessionId)?.inner.sessionManager;
  if (!manager) return;
  const saved = result as { semesterPlanId?: string; lessonPlanId?: string; assignmentId?: string; revision: number };
  const targetId = saved.semesterPlanId ?? saved.lessonPlanId ?? saved.assignmentId;
  for (const task of tasksFrom(manager)) {
    if ((task.status === "sending" || task.status === "sent" || task.status === "failed" && task.workflowTaskId === workflowTaskId && Boolean(workflowTaskId)) && (workflowTaskId ? task.workflowTaskId === workflowTaskId : !task.workflowTaskId) && task.action === action && task.targetId === targetId && saved.revision > task.baseRevision) persist(manager, { ...task, status: "completed", completedRevision: saved.revision });
  }
}
