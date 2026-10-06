import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, realpath, lstat, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createCourseWorkflowDomain, courseWorkflowToolContracts, COURSE_WORKFLOW_TOOL_IDENTITIES, type CourseWorkflowDomainOptions, type CourseWorkflowBroker } from "./course-workflow-domain";
import { getCourseBuilderHost, courseBuilderSessionCwd } from "./course-builder-service";
import type { CourseBuilderSnapshot } from "../../../packages/course-builder-host/src/index.ts";
import { completeCourseRevisionTasks } from "./course-builder-revisions";
import { readChatAttachmentSource } from "./chat-attachments";
import { assignmentOutputDirectory, listAssignmentAssets } from "./course-builder-assignment-assets";
import { courseMaterialRoots } from "./course-builder-material-library";
import { courseWorkflowStartState, courseWorkflowStartError, courseWorkflowLaunchCanRetry, resetRefusedCourseWorkflowLaunch, dispatchCourseWorkflowLaunch, observeCourseWorkflowLaunch, type CourseWorkflowLaunchRecord } from "./course-workflow-launch-state";
import { COURSE_PRODUCTION_WORKFLOW_ID, COURSE_PRODUCT_DEFINITIONS, type CourseWorkflowProductAction } from "./course-production-policy";
export type { CourseWorkflowProductAction } from "./course-production-policy";

export const COURSE_WORKFLOW_DEFINITIONS = COURSE_PRODUCT_DEFINITIONS;
export type CourseWorkflowId = keyof typeof COURSE_WORKFLOW_DEFINITIONS;
export function courseWorkflowTaskDefinition(workflowId: unknown = "course-lesson-artifacts") {
  if (typeof workflowId !== "string" || !Object.hasOwn(COURSE_WORKFLOW_DEFINITIONS, workflowId)) throw new Error("Unsupported course Workflow");
  const id = workflowId as CourseWorkflowId;
  return { workflowId: id, kind: COURSE_WORKFLOW_DEFINITIONS[id].kind };
}
export type CourseWorkflowPrepareInput = { productAction?: CourseWorkflowProductAction; workflowId?: CourseWorkflowId; target: CourseWorkflowDomainOptions["target"]; materialIds?: string[]; attachmentIds?: string[]; baselineTaskId?: string; discardBaseline?: boolean; task: string };
/** The Host binds exactly one course, Assignment, existing lesson or semester slot. */
export function selectCourseWorkflowTask(snapshot: CourseBuilderSnapshot, input: CourseWorkflowPrepareInput) {
  if (input.productAction && input.workflowId && input.productAction !== input.workflowId) throw new Error("Conflicting Course production selections");
  const definition = courseWorkflowTaskDefinition(input.productAction ?? input.workflowId), target = input.target;
  const attachmentIds = input.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 16 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some(id => typeof id !== "string" || !/^[0-9a-f-]{36}$/u.test(id))) throw new Error("Select at most 16 distinct attachment IDs from this conversation");
  const scope = COURSE_WORKFLOW_DEFINITIONS[definition.workflowId].scope;
  if ("course" in target) {
    if (target.course !== true || !["course", "course-or-lesson"].includes(scope)) throw new Error("Workflow requires an exact lesson or Assignment target");
    return { ...definition, target, attachmentIds, week: undefined, session: undefined, materialIds: input.materialIds ?? snapshot.materials.filter(item => item.metadata.storage === "local-link" && item.metadata.materialScope !== "assignment").map(item => item.materialId) };
  }
  if ("assignmentId" in target) {
    if (scope !== "assignment") throw new Error("Workflow does not accept an Assignment target");
    const assignment = snapshot.assignments.find(item => item.assignmentId === target.assignmentId);
    if (!assignment) throw new Error("Select an existing Assignment in this course");
    return { ...definition, target, attachmentIds, week: undefined, session: undefined, materialIds: input.materialIds ?? assignment.materialIds };
  }
  if (["course", "assignment"].includes(scope)) throw new Error("Workflow requires its exact course or Assignment target");
  const slot = "lessonId" in target ? snapshot.lessonPlans.find(item => item.lessonPlanId === target.lessonId)
    : snapshot.semesterPlan?.sessions.find(item => item.week === target.week && item.session === target.session);
  if (!slot) throw new Error("Select an existing semester slot or lesson in this course");
  if (["existing-lesson", "existing-deck"].includes(scope) && !("lessonId" in target)) throw new Error("课件与相关产物必须选择已有单课计划。");
  if (scope === "existing-deck" && !("lessonId" in target && snapshot.decks.some(item => item.lessonPlanId === target.lessonId))) throw new Error("所选课次尚无课件，无法启动此 Workflow。");
  return { ...definition, target, attachmentIds, week: slot.week, session: slot.session, materialIds: input.materialIds ?? (definition.workflowId === "course-slide-revision" ? [] : slot.materialIds) };
}

type TaskRecord = Pick<CourseWorkflowDomainOptions, "sessionId" | "cwd" | "taskId" | "target" | "materialIds" | "taskDirectory" | "kind" | "production" | "outputDirectory" | "materialRoot" | "baselineFiles" | "repairBaselineFiles" | "attachmentIds" | "attachmentSources"> & CourseWorkflowLaunchRecord & {
  version: 1; projectId: string; task: string; createdAt: string;
  workflowId?: CourseWorkflowId | typeof COURSE_PRODUCTION_WORKFLOW_ID;
  productAction?: CourseWorkflowProductAction; baselineTaskId?: string;
  commitRequestId?: string; compileRequestId?: string; workflowRevision?: string; processCleanedAt?: string;
  refusalDiscardedAt?: string; previousRefusalCleanupAt?: string; workspaceCleanedAt?: string;
};
function recordDefinition(record: Pick<TaskRecord,"workflowId"|"productAction">) {
  if (record.workflowId === COURSE_PRODUCTION_WORKFLOW_ID && !record.productAction) throw new Error("Course production task has no private product action");
  return courseWorkflowTaskDefinition(record.workflowId === COURSE_PRODUCTION_WORKFLOW_ID ? record.productAction : record.workflowId);
}
/** Preserve the recorded teacher request under the converted Workflow's semantic Root input name. */
export function courseWorkflowTaskInputs(record: Pick<TaskRecord, "workflowId" | "productAction" | "taskId" | "task" | "commitRequestId" | "compileRequestId">) {
  if (record.workflowId === COURSE_PRODUCTION_WORKFLOW_ID) { recordDefinition(record);
    return { taskId: record.taskId, task: record.task, commitRequestId: record.commitRequestId, compileRequestId: record.compileRequestId }; }
  const definition = recordDefinition(record);
  return { taskId: record.taskId, kind: definition.kind.startsWith("assignment") ? "assignment" : definition.kind, commitRequestId: record.commitRequestId, compileRequestId: record.compileRequestId,
    ...(definition.workflowId === "course-slide-revision" ? { changeRequest: record.task, format: "tex", documentKind: "beamer" } : { task: record.task }) };
}
type Domain = ReturnType<typeof createCourseWorkflowDomain>;
export type CourseWorkflowControl = (operation: "list" | "run" | "get" | "cancel" | "cleanup_run_history" | "run_retention", args: Record<string, unknown>) => Promise<unknown>;
declare global {
  var __piCourseWorkflowTasks: Map<string, { record: TaskRecord; domain: Domain }> | undefined;
  var __piCourseWorkflowControls: Map<string, CourseWorkflowControl> | undefined;
  var __piCourseWorkflowStarting: Set<string> | undefined;
  var __piCourseWorkflowScopes: Map<string, RegistryScope> | undefined;
}
const tasks = (): Map<string,{record:TaskRecord;domain:Domain}> => globalThis.__piCourseWorkflowTasks ??= new Map<string,{record:TaskRecord;domain:Domain}>();
const controls = () => globalThis.__piCourseWorkflowControls ??= new Map<string, CourseWorkflowControl>();
export function registerCourseWorkflowControl(sessionId: string, control: CourseWorkflowControl) {
  controls().set(sessionId, control);
  return () => { if (controls().get(sessionId) === control) controls().delete(sessionId); };
}
function controlFor(sessionId: string) {
  const control = controls().get(sessionId);
  if (!control) throw new Error("当前会话的 pi-CAW 尚未连接；请重新连接课程会话。");
  return control;
}
function taskFor(sessionId: string, taskId: string) {
  const task = tasks().get(taskId);
  if (!task || task.record.sessionId !== sessionId) throw new Error("Course workflow task unavailable in this conversation");
  return task;
}
function taskView(record: TaskRecord) {
  const definition = recordDefinition(record), binding = tasks().get(record.taskId)?.domain.binding;
  return { taskId: record.taskId, workflowId: record.workflowId ?? definition.workflowId, productAction: record.productAction ?? definition.workflowId,
    product: definition.kind, operation: record.production?.operation, baselineTaskId: record.baselineTaskId, kind: definition.kind, target: record.target,
    week: binding?.week, session: binding?.session, attachmentIds: record.attachmentIds ?? [], materialIds: record.materialIds, task: record.task,
    workspace: record.taskDirectory, createdAt: record.createdAt, runId: record.runId, startState: record.startState ?? (record.runId ? "unconfirmed" : undefined),
    started: courseWorkflowStartState(record) === "confirmed", startIntentAt: record.startIntentAt, startConfirmedAt: record.startConfirmedAt,
    legacyStartRecord: record.legacyStartRecord || Boolean(record.runId && record.startState === undefined),
    startError: record.startError === undefined ? undefined : courseWorkflowStartError(record.startError), startLookupError: record.startLookupError,
    workspaceCleanedAt: record.workspaceCleanedAt };
}
/** Working copies under the private task directory are not the official course record. */
export async function removeRecordedCourseWorkspace(record: TaskRecord) {
  const expected = resolve(record.cwd, ".pi", "course-builder", record.projectId, "workflow-tasks", record.taskId);
  if (resolve(record.taskDirectory) !== expected) throw new Error("Task workspace cleanup path differs from its exact private binding");
  const inspect = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Task workspace cleanup refuses symbolic links");
    if (stat.isDirectory()) for (const entry of await readdir(path)) await inspect(join(path, entry));
  };
  try {
    if ((await realpath(expected)).toLowerCase() !== expected.toLowerCase()) throw new Error("Task workspace cleanup target resolves outside its exact private directory");
    await inspect(expected);
    await rm(expected, { recursive: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  record.workspaceCleanedAt = new Date().toISOString();
  await saveTask(record);
}
async function saveTask(record: TaskRecord) {
  const path = join(root(record.cwd, record.projectId), record.taskId, "host-task.json"), temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

type WorkflowRow = { id: string; status: string; enabled: boolean; revision_hash: string; validation: { valid: boolean; errors?: unknown[] } };
export async function listCourseWorkflowTasks(sessionId: string) {
  await restoreCourseWorkflowTasks(sessionId, await courseBuilderSessionCwd(sessionId));
  if([...tasks().values()].some(item=>item.record.sessionId===sessionId && item.record.runId && !item.record.processCleanedAt))await cleanupCourseWorkflowTasks(sessionId,false);
  const rows = await controlFor(sessionId)("list", {});
  if (!Array.isArray(rows)) throw new Error("pi-CAW returned an invalid Workflow catalog");
  const workflow = rows.find((item: WorkflowRow) => item.id === COURSE_PRODUCTION_WORKFLOW_ID) as WorkflowRow | undefined;
  if (workflow && (!workflow.validation || typeof workflow.validation.valid !== "boolean")) throw new Error("pi-CAW returned an invalid Course production readiness result");
  const disabledReason = !workflow ? `尚未安装 ${COURSE_PRODUCTION_WORKFLOW_ID} Workflow。`
    : workflow.status !== "ready" ? `Workflow 状态为 ${workflow.status}；请在 Workbench 发布为 Ready。`
    : !workflow.enabled ? "Workflow 已停用；请在 Workbench 启用。"
    : !workflow.validation.valid ? `Workflow 验证失败：${JSON.stringify(workflow.validation.errors ?? workflow.validation)}` : null;
  const master = { id: COURSE_PRODUCTION_WORKFLOW_ID, title: "课程生产", ready: !disabledReason, revision: workflow?.revision_hash, disabledReason };
  const products = (Object.keys(COURSE_WORKFLOW_DEFINITIONS) as CourseWorkflowId[]).map(id => ({ id, ...COURSE_WORKFLOW_DEFINITIONS[id], ready: master.ready, revision: master.revision, disabledReason: master.disabledReason }));
  const snapshot = getCourseBuilderHost().getSnapshotForSession(sessionId);
  const slides = (snapshot?.lessonPlans ?? []).map(lesson => {
    const deck = snapshot?.decks.find(item => item.lessonPlanId === lesson.lessonPlanId);
    return { lessonId: lesson.lessonPlanId, week: lesson.week, session: lesson.session, deckId: deck?.deckId,
      title: deck?.title, disabledReason: !deck ? "所选课次尚无课件。" : null };
  });
  return { workflow: master, products, workflows: products, slides,
    tasks: [...tasks().values()].filter(item => item.record.sessionId === sessionId && !item.record.processCleanedAt).map(item => taskView(item.record)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) };
}

/** Only exact pre-Run refusals are disposable. Absence alone never permits replay or deletion. */
export function courseLaunchWasRefused(record: CourseWorkflowLaunchRecord) {
  if (courseWorkflowLaunchCanRetry(record)) return true;
  const error=record.startError;
  return record.startState === "unconfirmed" && record.startLookupError?.code === "RUN_NOT_FOUND"
    && Boolean(record.runId && (record.startLookupError.details as {run_id?:string;observation?:string})?.run_id === record.runId
      && (record.startLookupError.details as {observation?:string})?.observation === "run_directory_absent")
    && typeof error === "object" && error !== null && (error.code === "PI_MAIN_STRICT_CONTEXT" || error.code === "COURSE_WORKFLOW_ADMISSION_STATE"
      || error.message === "Course production task is not admitting a new Run intent");
}
/** Recover only pre-execution refusals hidden by the old automatic cleanup policy. */
export function restoreCleanedCourseRefusal(record: CourseWorkflowLaunchRecord & Pick<TaskRecord,"processCleanedAt"|"refusalDiscardedAt"|"previousRefusalCleanupAt">) {
  if(!record.processCleanedAt || record.refusalDiscardedAt || !courseLaunchWasRefused(record))return false;
  record.previousRefusalCleanupAt=record.processCleanedAt;
  delete record.processCleanedAt;
  return true;
}
export async function cleanupCourseWorkflowTasks(sessionId:string, completedNow=true) {
  await restoreCourseWorkflowTasks(sessionId,await courseBuilderSessionCwd(sessionId));
  const result=await controlFor(sessionId)("cleanup_run_history",{completed_now:completedNow}) as {deleted:{run_id:string}[];bytes:number;protected:unknown[]};
  let refused=0;
  for(const {record} of tasks().values()) {
    if(record.sessionId !== sessionId || record.processCleanedAt || !record.runId)continue;
    let cleaned=result.deleted.some(item=>item.run_id===record.runId);
    if(!cleaned && !courseLaunchWasRefused(record)) {
      const state=await observeCourseWorkflowLaunch(record,()=>exactRun(sessionId,record),saveTask) as (RunState & {process_cleaned?:boolean})|null;
      cleaned=state?.process_cleaned===true;
    }
    if(courseLaunchWasRefused(record)) {
      // Automatic history retention must not discard a task the teacher can retry.
      if(!completedNow)continue;
      const expected=resolve(record.cwd,".pi","course-builder",record.projectId,"workflow-tasks",record.taskId);
      if(resolve(record.taskDirectory)!==expected)throw new Error("Refused task cleanup path differs from its exact private binding");
      const inspect=async(path:string):Promise<void>=>{const stat=await lstat(path);if(stat.isSymbolicLink())throw new Error("Task cleanup refuses symbolic links");if(stat.isDirectory())for(const entry of await readdir(path))await inspect(join(path,entry));};
      try{if((await realpath(expected)).toLowerCase()!==expected.toLowerCase())throw new Error("Task cleanup target resolves outside its exact private directory");await inspect(expected);await rm(expected,{recursive:true});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      record.refusalDiscardedAt=new Date().toISOString();cleaned=true;refused++;
    }
    if(cleaned){record.processCleanedAt=new Date().toISOString();await saveTask(record);}
  }
  console.info("[course-workflow] record cleanup",{sessionId,refused,runs:result.deleted.length,bytes:result.bytes});
  return {...result,refused};
}

/** Persist the exact start intent before dispatch. An ambiguous failure cannot authorize a second Run. */
export async function startCourseWorkflowTask(sessionId: string, taskId: string) {
  const starting = globalThis.__piCourseWorkflowStarting ??= new Set<string>();
  if (starting.has(taskId)) throw new Error("This course Workflow is already starting");
  starting.add(taskId);
  try {
    const selected = taskFor(sessionId, taskId); let record = selected.record;
    const definition = recordDefinition(record);
    if (record.runId) {
      await observeCourseWorkflowLaunch(record, () => exactRun(sessionId, record), saveTask);
      if (!courseWorkflowLaunchCanRetry(record)) throw new Error(`任务已绑定 Run ${record.runId}；请查看状态，不要重复启动。`);
      record = resetRefusedCourseWorkflowLaunch(record);
      selected.record = record; await saveTask(record);
    }
    if (record.workflowId !== COURSE_PRODUCTION_WORKFLOW_ID) {
      const snapshot = getCourseBuilderHost().getSnapshotForSession(sessionId);
      if (!snapshot) throw new Error("Course project unavailable");
      record = { ...record, workflowId: COURSE_PRODUCTION_WORKFLOW_ID, productAction: definition.workflowId, kind: definition.kind,
        production: { action: definition.workflowId, operation: selectCourseProductionOperation(snapshot,definition.kind,record.target,record.baselineFiles) } };
      const domain = domainFor(record); record.production!.bindingSha256 = domain.contextBinding().sha256;
      selected.record = record; selected.domain = domain; await saveTask(record);
    }
    const catalog = await listCourseWorkflowTasks(sessionId);
    const workflow = catalog.workflow;
    if (!workflow.ready || !workflow.revision) throw new Error(workflow.disabledReason ?? "Workflow is not Ready");
    if (definition.workflowId === "course-slide-revision") {
      const snapshot = getCourseBuilderHost().getSnapshotForSession(sessionId);
      if (!snapshot) throw new Error("Course project unavailable");
      selectCourseWorkflowTask(snapshot, { workflowId: definition.workflowId, target: record.target, task: record.task, materialIds: record.materialIds });
    }
    const preflight = await preflightCourseWorkflowTask(sessionId, taskId);
    if (definition.workflowId === "course-slide-revision" && (!preflight?.context?.currentArtifact?.deckId)) throw new Error("课件修改需要已有课件；尚未调用模型。");
    const routed = await selected.domain.registry.course_task_route.execute({ input: {taskId}, context: {run_id:`preflight-${taskId}`,node_id:"route",attempt_id:randomUUID(),workspace:record.taskDirectory} });
    if (routed.exit_code !== 0) throw new Error(routed.diagnostic || "Private Course production routing failed");
    const next: TaskRecord = { ...record, runId: `run-${randomUUID()}`, commitRequestId: randomUUID(), compileRequestId: randomUUID(), workflowRevision: workflow.revision };
    try {
      await dispatchCourseWorkflowLaunch(next, () => controlFor(sessionId)("run", { workflow_id: COURSE_PRODUCTION_WORKFLOW_ID, revision_hash: next.workflowRevision,
        run_id: next.runId, workspace: next.taskDirectory, access: "bounded_write", allowed_paths: ["."], constraints: { allowed_paths: ["."] },
        inputs: courseWorkflowTaskInputs(next) }), () => exactRun(sessionId, next), async updated => {
          await saveTask(updated); selected.record = updated; registryScope(sessionId).knownRuns.add(updated.runId!);
          console.info("[course-workflow] start observation", { sessionId, taskId, runId: updated.runId, state: updated.startState,
            revision: updated.workflowRevision, startError: updated.startError, lookupError: updated.startLookupError });
        });
      return { ...taskView(next), started: true };
    } catch (error) {
      console.error("[course-workflow] start unconfirmed", { sessionId, taskId, runId: next.runId, error: next.startError, lookupError: next.startLookupError });
      throw error;
    }
  } finally { starting.delete(taskId); }
}

type RunState = { run_id: string; main_actor: string; workflow_id: string; inputs: { taskId?: string }; permissions: { workspace: string };
  status: string; updated_at: string; error?: unknown; nodes: Record<string, { status: string; error?: unknown; output?: Record<string, unknown> }> };
async function exactRun(sessionId: string, record: TaskRecord) {
  if (!record.runId) throw new Error("This task has not started a Run");
  const state = await controlFor(sessionId)("get", { run_id: record.runId }) as RunState;
  if (!state || state.run_id !== record.runId || state.main_actor !== sessionId || state.workflow_id !== (record.workflowId ?? recordDefinition(record).workflowId)
    || state.inputs?.taskId !== record.taskId || resolve(state.permissions?.workspace ?? "") !== resolve(record.taskDirectory)) throw new Error("Course Workflow Run binding differs from its private Host task");
  return state;
}
/** Projection runs only after exact Run reconciliation, outside the domain broker's mutation/effect boundary. */
export function courseWorkflowRevisionEvidence(record: Pick<TaskRecord,"taskId"|"workflowId"|"productAction"|"target"|"projectId">, state: Pick<RunState,"status"|"nodes">, snapshot: CourseBuilderSnapshot | null) {
  const kind = recordDefinition(record).kind;
  if (!["semester","lesson","assignment-plan","assignment-artifacts"].includes(kind)) return {status:"not-applicable" as const};
  if (state.status !== "succeeded") return {status:"pending" as const};
  const matches = Object.values(state.nodes).filter(node => node.status === "succeeded" && node.output?.taskId === record.taskId
    && node.output.succeeded === true && node.output.kind === (kind.startsWith("assignment") ? "assignment" : kind) && (node.output.lesson || node.output.product));
  const commit = matches.length === 1 ? matches[0] : undefined;
  const output = commit?.output;
  if (commit?.status !== "succeeded" || output?.taskId !== record.taskId || output.succeeded !== true) return {status:"missing" as const,diagnostic:"已完成 Run 缺少准确任务的成功 Host 保存凭据；修改记录尚未完成。"};
  const saved = (kind === "lesson" ? output.lesson : output.product) as Record<string,unknown> | undefined;
  const expectedKind = kind.startsWith("assignment") ? "assignment" : kind;
  if (output.kind !== expectedKind || !saved || typeof saved.contentHash !== "string" || !Number.isSafeInteger(saved.revision)) return {status:"missing" as const,diagnostic:"Host 保存凭据缺少当前产品身份、修订或内容 Hash；修改记录尚未完成。"};
  const target = record.target;
  const current = kind === "semester" ? snapshot?.semesterPlan
    : kind === "lesson" && "lessonId" in target ? snapshot?.lessonPlans.find(item=>item.lessonPlanId === target.lessonId)
    : kind === "lesson" && "week" in target ? snapshot?.lessonPlans.find(item=>item.week === target.week && item.session === target.session)
    : kind.startsWith("assignment") && "assignmentId" in target ? snapshot?.assignments.find(item=>item.assignmentId === target.assignmentId) : undefined;
  const identity = kind === "semester" ? "semesterPlanId" : kind === "lesson" ? "lessonPlanId" : "assignmentId";
  if (snapshot?.project.projectId !== record.projectId || !current || saved[identity] !== (current as unknown as Record<string,unknown>)[identity] || saved.revision !== current.revision || saved.contentHash !== current.contentHash) return {status:"stale" as const,diagnostic:"当前 Host 产品已与此 Run 的保存凭据不同；修改记录尚未完成。"};
  return {status:"verified" as const,action:kind === "semester" ? "save_semester" as const : kind === "lesson" ? "save_lesson" as const : "save_assignment" as const,saved};
}

export async function statusCourseWorkflowTask(sessionId: string, taskId: string) {
  await restoreCourseWorkflowTasks(sessionId, await courseBuilderSessionCwd(sessionId));
  const record = taskFor(sessionId, taskId).record;
  if (!record.runId) return { ...taskView(record), run: null, files: [], teacherReviewPending: true };
  const state = await observeCourseWorkflowLaunch(record, () => exactRun(sessionId, record), saveTask);
  if (!state) return { ...taskView(record), run: null, files: [], teacherReviewPending: true };
  const revisionReconciliation = courseWorkflowRevisionEvidence(record,state,getCourseBuilderHost().getSnapshotForSession(sessionId));
  if (revisionReconciliation.status === "verified") completeCourseRevisionTasks(sessionId,{action:revisionReconciliation.action},revisionReconciliation.saved,record.taskId);
  if (record.workspaceCleanedAt) return { ...taskView(record), teacherReviewPending: true, workspaceCleaned: true, files: [],
    run: { runId: state.run_id, status: state.status, updatedAt: state.updated_at, error: state.error,
      nodes: Object.entries(state.nodes).map(([id,node]) => ({ id, status: node.status, error: node.error })) } };
  const kind = recordDefinition(record).kind;
  const recorded = state.status === "succeeded" && (["semester","lesson","assignment-plan","assignment-artifacts"].includes(kind)
    ? revisionReconciliation.status === "verified"
    : Object.values(state.nodes).some(node => node.status === "succeeded" && node.output?.taskId === record.taskId && node.output.succeeded === true));
  if (recorded) {
    await removeRecordedCourseWorkspace(record);
    return { ...taskView(record), teacherReviewPending: true, revisionReconciliation, workspaceCleaned: true, files: [],
      run: { runId: state.run_id, status: state.status, updatedAt: state.updated_at, error: state.error,
        nodes: Object.entries(state.nodes).map(([id,node]) => ({ id, status: node.status, error: node.error })) } };
  }
  const files = new Map<string, { path: string; name: string; sha256: string; currentSha256?: string; bytes: number; verification: "verified" | "modified" | "missing"; diagnostic?: string }>();
  // Only accepted domain mutation/compile outputs carry file evidence; context/material paths are never preview candidates.
  const collect = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) await collect(item); return; }
    const item = value as Record<string, unknown>;
    if (typeof item.path === "string" && typeof item.sha256 === "string") {
      const path = resolve(item.path), lexicalScope = relative(resolve(record.taskDirectory), path);
      if (!lexicalScope || lexicalScope === ".." || lexicalScope.startsWith(`..${sep}`) || isAbsolute(lexicalScope)) throw new Error("Run artifact is outside the exact course task workspace");
      let physicalPath: string;
      try { physicalPath = await realpath(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        files.set(path, { path, name: basename(path), sha256: item.sha256, bytes: typeof item.bytes === "number" ? item.bytes : 0, verification: "missing", diagnostic: "已记录的产物文件不存在。" }); return;
      }
      const scope = relative(await realpath(record.taskDirectory), physicalPath);
      if (!scope || scope === ".." || scope.startsWith(`..${sep}`) || isAbsolute(scope)) throw new Error("Run artifact is outside the exact course task workspace");
      const data = await readFile(path), sha256 = createHash("sha256").update(data).digest("hex");
      const modified = sha256 !== item.sha256 || typeof item.bytes === "number" && item.bytes !== data.length;
      files.set(path, { path, name: basename(path), sha256: item.sha256, currentSha256: sha256, bytes: data.length, verification: modified ? "modified" : "verified",
        ...(modified ? { diagnostic: "文件已修改；当前内容与此 Run 的编译/保存凭据不匹配。PDF 只证明原编译版本。" } : {}) });
      return;
    }
    for (const [key, child] of Object.entries(item)) if (["files", "artifacts", "source", "output", "preflight", "log"].includes(key)) await collect(child);
  };
  for (const node of Object.values(state.nodes ?? {})) if (node.output?.taskId === record.taskId) await collect(node.output);
  return { ...taskView(record), teacherReviewPending: true, revisionReconciliation, files: [...files.values()],
    run: { runId: state.run_id, status: state.status, updatedAt: state.updated_at, error: state.error,
      nodes: Object.entries(state.nodes).map(([id,node]) => ({ id, status: node.status, error: node.error })) } };
}
export async function cancelCourseWorkflowTask(sessionId: string, taskId: string) {
  const record = taskFor(sessionId, taskId).record;
  await exactRun(sessionId, record);
  console.info("[course-workflow] cancellation requested", { sessionId, taskId, runId: record.runId });
  return controlFor(sessionId)("cancel", { run_id: record.runId });
}

function courseWorkflowStoragePaths() {
  const database = resolve(process.env.PI_LEARNING_HARNESS_DIR || join(getAgentDir(), "learning-harness"), "learning-harness.sqlite");
  return [database, `${database}-wal`, `${database}-shm`];
}
function courseWorkflowStorageCapabilities(sessionId: string, id: string) {
  const records = [...tasks().values()].filter(item => item.record.sessionId === sessionId).map(item => item.record);
  return { write_files: ["course_task_context","course_task_route"].includes(id) ? [] : courseWorkflowStoragePaths(),
    write_directories: [...new Set(records.flatMap(record => [resolve(record.cwd, ".pi", "course-workflow-host"), ...(record.outputDirectory ? [record.outputDirectory] : []), ...(record.materialRoot ? [record.materialRoot] : [])]))] };
}
function domainFor(record: TaskRecord): Domain {
  return createCourseWorkflowDomain({ ...record, getHost: getCourseBuilderHost,
    readAttachment: id => readChatAttachmentSource(record.cwd,id,{sessionId:record.sessionId,assignmentId:"assignmentId" in record.target ? record.target.assignmentId : null}),
    kind: record.kind ?? recordDefinition(record).kind, storagePaths: courseWorkflowStoragePaths(),
    rscript: process.env.PI_COURSE_BUILDER_RSCRIPT,
    trustedExecution: process.env.PI_COURSE_BUILDER_TRUSTED_TEX === "1" });
}
function root(cwd: string, projectId: string) { return join(cwd, ".pi", "course-workflow-host", projectId); }

/** Existing dependency products do not turn a new requested product into a revision. */
export function selectCourseProductionOperation(snapshot: CourseBuilderSnapshot, kind: CourseWorkflowDomainOptions["kind"], target: CourseWorkflowDomainOptions["target"], baselineFiles: CourseWorkflowDomainOptions["baselineFiles"] = [], checkpoints: {lessonPlanId:string}[] = []) {
  const lesson = "lessonId" in target ? snapshot.lessonPlans.find(item => item.lessonPlanId === target.lessonId)
    : "week" in target ? snapshot.lessonPlans.find(item => item.week === target.week && item.session === target.session) : undefined;
  const deck = lesson ? snapshot.decks.find(item => item.lessonPlanId === lesson.lessonPlanId) : undefined;
  const existing = kind === "semester" ? snapshot.semesterPlan : kind === "analysis" ? snapshot.materialAnalysis
    : kind === "lesson" || kind === "bundle" ? lesson : kind === "deck" ? deck
    : kind === "teacher-notes" ? snapshot.teacherNotes.find(item => item.deckId === deck?.deckId)
    : kind === "assignment-plan" && "assignmentId" in target ? snapshot.assignments.find(item => item.assignmentId === target.assignmentId)?.draft
    : kind === "checkpoint" ? checkpoints.find(item => item.lessonPlanId === lesson?.lessonPlanId)
    : baselineFiles.length ? baselineFiles : undefined;
  return existing ? "revise" as const : "new" as const;
}
async function selectedTaskBaseline(sessionId: string, snapshot: CourseBuilderSnapshot, selection: ReturnType<typeof selectCourseWorkflowTask>, baselineTaskId: string) {
  await restoreCourseWorkflowTasks(sessionId, await courseBuilderSessionCwd(sessionId));
  const previous = taskFor(sessionId,baselineTaskId), record = previous.record;
  const targetKey = (value: CourseWorkflowPrepareInput["target"]) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b))));
  if (record.projectId !== snapshot.project.projectId || recordDefinition(record).kind !== selection.kind || targetKey(record.target) !== targetKey(selection.target)) throw new Error("Repair baseline must belong to this exact course, product and target");
  if (!record.commitRequestId) throw new Error("Repair baseline has no original Host commit request");
  const receipt = await previous.domain.committedReceipt(record.commitRequestId);
  if (!receipt.files.length) {
    const target = selection.target;
    const saved = receipt.lesson ?? receipt.product;
    const current = selection.kind === "semester" ? snapshot.semesterPlan : selection.kind === "analysis" ? snapshot.materialAnalysis
      : selection.kind === "lesson" && "lessonId" in target ? snapshot.lessonPlans.find(item=>item.lessonPlanId === target.lessonId)
      : selection.kind === "lesson" && "week" in target ? snapshot.lessonPlans.find(item=>item.week === target.week && item.session === target.session)
      : selection.kind === "assignment-plan" && "assignmentId" in target ? snapshot.assignments.find(item=>item.assignmentId === target.assignmentId) : undefined;
    if (!saved || !current || saved.contentHash !== current.contentHash || ("revision" in current && saved.revision !== current.revision)) throw new Error("Selected repair baseline has no exact current saved product or artifact sources");
  }
  const files = await Promise.all(receipt.files.map(async (file: {format:"tex"|"rmd"|"html";role?:"student"|"solution";source:{path:string;sha256:string;bytes:number}}) => {
    const source = await realpath(file.source.path), directory = await realpath(record.taskDirectory), scoped = relative(directory,source);
    if (!scoped || scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) throw new Error("Repair baseline source escaped its exact previous task workspace");
    const bytes = await readFile(source);
    if (bytes.length > 2097152 || bytes.length !== file.source.bytes || createHash("sha256").update(bytes).digest("hex") !== file.source.sha256) throw new Error("Saved repair baseline source bytes changed after its Host receipt");
    return {path:source,format:file.format,...(file.role ? {role:file.role} : {})};
  }));
  return {files,htmlMaterialId:selection.kind === "html" ? receipt.product?.materialId as string | undefined : undefined};
}

/** Validate selected references through the existing session/Assignment-scoped reader before task persistence. */
export async function validateCourseWorkflowAttachments(cwd: string, sessionId: string, target: CourseWorkflowPrepareInput["target"], attachmentIds: string[] = []) {
  if (attachmentIds.length > 16 || new Set(attachmentIds).size !== attachmentIds.length || attachmentIds.some(id=>typeof id !== "string" || !/^[0-9a-f-]{36}$/u.test(id))) throw new Error("Select at most 16 distinct attachment IDs from this conversation");
  return Promise.all(attachmentIds.map(async id => {
    const source = await readChatAttachmentSource(cwd,id,{sessionId,assignmentId:"assignmentId" in target ? target.assignmentId : null});
    return {id:source.id,name:source.name,sourceHash:source.sourceHash,textSha256:createHash("sha256").update(source.text).digest("hex")};
  }));
}

/** Human/API selection creates the private binding; model parameters cannot select a course. */
export async function prepareCourseWorkflowTask(sessionId: string, input: CourseWorkflowPrepareInput) {
  if (!input.task.trim() || input.task.length > 30000) throw new Error("Provide a bounded teacher request");
  const snapshot = getCourseBuilderHost().getSnapshotForSession(sessionId);
  if (!snapshot) throw new Error("Course project unavailable");
  const selection = selectCourseWorkflowTask(snapshot, input);
  if (input.discardBaseline !== undefined && typeof input.discardBaseline !== "boolean") throw new Error("discardBaseline must be an explicit boolean");
  if (input.baselineTaskId && input.discardBaseline) throw new Error("Cannot discard and repair the same selected baseline");
  const cwd = resolve(await courseBuilderSessionCwd(sessionId));
  const attachmentSources = await validateCourseWorkflowAttachments(cwd,sessionId,selection.target,selection.attachmentIds);
  const taskId = randomUUID(), taskDirectory = join(cwd,".pi","course-builder",snapshot.project.projectId,"workflow-tasks",taskId);
  let outputDirectory: string | undefined, materialRoot: string | undefined;
  let baselineFiles: CourseWorkflowDomainOptions["baselineFiles"];
  let repairBaselineFiles: CourseWorkflowDomainOptions["baselineFiles"], htmlBaselineMaterialId: string | undefined;
  if ("assignmentId" in selection.target) {
    outputDirectory = await assignmentOutputDirectory(sessionId,selection.target.assignmentId);
    const existing = await listAssignmentAssets(sessionId,selection.target.assignmentId);
    baselineFiles = existing.assets.filter(file => [".tex", ".rmd"].includes(file.extension)).map(file => ({path:resolve(existing.root,file.relativePath),format:file.extension === ".tex" ? "tex" as const : "rmd" as const,...(existing.assets.filter(item=>item.extension === file.extension).length === 1 ? {role:file.extension === ".tex" ? "student" as const : "solution" as const} : {})}));
  }
  if (input.baselineTaskId) {
    if (typeof input.baselineTaskId !== "string" || !/^[0-9a-f-]{36}$/u.test(input.baselineTaskId)) throw new Error("Select an exact previous task ID for repair");
    const selected = await selectedTaskBaseline(sessionId,snapshot,selection,input.baselineTaskId);
    repairBaselineFiles = selected.files; htmlBaselineMaterialId = selected.htmlMaterialId;
  }
  if (selection.kind === "html") {
    const roots = courseMaterialRoots(getCourseBuilderHost(),sessionId);
    const selectedRoots = [...new Set(selection.materialIds.map(id => snapshot.materials.find(item=>item.materialId === id)?.metadata.sourceRoot).filter((path): path is string=>typeof path === "string"))];
    const candidates = selectedRoots.length ? selectedRoots : roots;
    if (candidates.length !== 1) throw new Error("交互 HTML 需要所选课次材料绑定一个课程素材文件夹；请先明确材料文件夹。");
    materialRoot = await realpath(candidates[0]);
    if (!input.discardBaseline && "lessonId" in selection.target) {
      const lessonId = selection.target.lessonId;
      const current = snapshot.visuals.filter(item => item.lessonPlanId === lessonId && item.format === "interactive-html" && (!htmlBaselineMaterialId || item.materialId === htmlBaselineMaterialId));
      if (current.length > 1) throw new Error("Select an exact previous HTML task as the repair baseline");
      if (current[0]) {
        const material = snapshot.materials.find(item => item.materialId === current[0].materialId);
        if (!material || typeof material.metadata.sourcePath !== "string" || material.metadata.sourceRoot !== materialRoot) throw new Error("Current HTML source is unavailable in the selected material folder");
        baselineFiles = [{path:await realpath(material.metadata.sourcePath),format:"html"}];
      }
    }
  }
  const operation = input.discardBaseline ? "new" : input.baselineTaskId ? "revise"
    : selectCourseProductionOperation(snapshot,selection.kind,selection.target,baselineFiles,getCourseBuilderHost().listCoverageCheckpoints(sessionId));
  if (selection.workflowId === "course-slide-revision" && operation !== "revise") throw new Error("Slide revision requires its existing deck baseline");
  const record: TaskRecord = { version: 1, sessionId, cwd, taskId, taskDirectory,
    projectId: snapshot.project.projectId, kind: selection.kind, workflowId: COURSE_PRODUCTION_WORKFLOW_ID, productAction: selection.workflowId,
    production: {action:selection.workflowId,operation,discardBaseline:input.discardBaseline === true}, baselineTaskId:input.baselineTaskId, target: selection.target, materialIds: selection.materialIds,
    outputDirectory, materialRoot, baselineFiles, repairBaselineFiles, attachmentIds:selection.attachmentIds, attachmentSources, task: input.task, createdAt: new Date().toISOString() };
  const domain = domainFor(record);
  record.production!.bindingSha256 = domain.contextBinding().sha256;
  await mkdir(join(taskDirectory,"sources"), { recursive: true });
  const privateDirectory=join(root(cwd,snapshot.project.projectId),taskId);
  await mkdir(privateDirectory,{recursive:true});
  const handle = await open(join(privateDirectory, "host-task.json"), "wx");
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  tasks().set(taskId, { record, domain });
  console.info("[course-workflow] prepared", { sessionId, taskId, projectId: record.projectId, target: record.target, materials: record.materialIds.length });
  return { ...taskView(record), contracts: domain.contracts, binding: domain.binding };
}

export async function restoreCourseWorkflowTasks(sessionId: string, cwd: string) {
  const project = getCourseBuilderHost().getProjectForSession(sessionId);
  if (!project) return;
  const directory = root(resolve(cwd), project.projectId);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const record: TaskRecord = JSON.parse(await readFile(join(directory, entry.name, "host-task.json"), "utf8"));
    if (record.sessionId !== sessionId) continue;
    const definition = recordDefinition(record);
    if (record.workflowId === COURSE_PRODUCTION_WORKFLOW_ID && (record.production?.action !== record.productAction || record.production?.bindingSha256?.length !== 64)) throw new Error("Private Course production route binding is corrupt");
    if (definition.workflowId === "course-slide-revision" && !("lessonId" in record.target)) throw new Error("Course slide revision task binding requires an exact existing lesson");
    if (record.kind !== undefined && record.kind !== definition.kind) throw new Error("Course Workflow kind differs from its private selection");
    if (record.version !== 1 || record.projectId !== project.projectId || record.taskId !== entry.name
      || resolve(record.cwd) !== resolve(cwd) || resolve(record.taskDirectory) !== resolve(cwd,".pi","course-builder",project.projectId,"workflow-tasks",entry.name)) throw new Error("Course workflow task binding is corrupt");
    courseWorkflowStartState(record);
    if(restoreCleanedCourseRefusal(record)) {
      await saveTask(record);
      const loaded=tasks().get(record.taskId);if(loaded)loaded.record=record;
      console.info("[course-workflow] restored retryable refusal",{sessionId,taskId:record.taskId,runId:record.runId,previousCleanupAt:record.previousRefusalCleanupAt});
    }
    if (!tasks().has(record.taskId)) tasks().set(record.taskId, { record, domain: domainFor(record) });
  }
}

export async function preflightCourseWorkflowTask(sessionId: string, taskId: string) {
  const task=tasks().get(taskId);
  if(!task || task.record.sessionId!==sessionId)throw new Error("Course workflow task unavailable in this conversation");
  const result=await task.domain.registry.course_task_context.execute({input:{taskId},context:{run_id:`preflight-${taskId}`,node_id:"context",attempt_id:randomUUID(),workspace:task.record.taskDirectory}});
  if(result.exit_code!==0)throw new Error(result.diagnostic || "Course task context preflight failed");
  return result.output;
}

/** Master execution can be dispatched only through its durable private Host intent. */
export async function assertCourseProductionRunScope(sessionId: string, args: Record<string, unknown>) {
  const inputs = args.inputs as Record<string, unknown> | undefined;
  if (!inputs || typeof inputs.taskId !== "string") throw new Error("Course production requires a prepared private task");
  const {record} = taskFor(sessionId,inputs.taskId);
  if (record.workflowId !== COURSE_PRODUCTION_WORKFLOW_ID || args.workflow_id !== COURSE_PRODUCTION_WORKFLOW_ID
    || args.run_id !== record.runId || args.revision_hash !== record.workflowRevision || args.access !== "bounded_write"
    || typeof args.workspace !== "string" || resolve(args.workspace) !== resolve(record.taskDirectory)
    || JSON.stringify(args.allowed_paths) !== JSON.stringify(["."])
    || JSON.stringify(Object.keys(inputs).sort()) !== JSON.stringify(["commitRequestId","compileRequestId","task","taskId"])
    || Object.entries(courseWorkflowTaskInputs(record)).some(([key,value])=>inputs[key] !== value)) throw new Error("Course production Run differs from its exact private Host intent");
  if (courseWorkflowStartState(record) !== "intent") throw Object.assign(new Error("Course production task is not admitting a new Run intent"), {
    code: "COURSE_WORKFLOW_ADMISSION_STATE", details: { task_id: record.taskId, run_id: record.runId, start_state: courseWorkflowStartState(record), phase: "before_run_intent" },
  });
}

/** Private trusted Extension bus registration; every call resolves the exact prebound task. */
type RegistryScope = { registry: Record<string, CourseWorkflowBroker & { contract: ReturnType<typeof courseWorkflowToolContracts>[number] }>; admitted: Map<string, Domain>; knownRuns: Set<string> };
function registryScope(sessionId: string): RegistryScope {
  const scopes = globalThis.__piCourseWorkflowScopes ??= new Map<string, RegistryScope>();
  const existing = scopes.get(sessionId);
  if (existing) return existing;
  const admitted = new Map<string, Domain>(), knownRuns = new Set<string>();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const attemptKey = (id: string, context: { run_id: string; node_id: string; attempt_id: string }) => JSON.stringify([id, context.run_id, context.node_id, context.attempt_id]);
  const registry = Object.fromEntries(courseWorkflowToolContracts().map(contract => {
    const id = contract.id, identity = COURSE_WORKFLOW_TOOL_IDENTITIES[id];
    return [id, {
    identity, contract,
    attestation: { qualified: true as const, cancellable: true as const, effect_observation: true as const, tool_identity: identity,
      broker_id: "pi-own-course-workflow-v1", evidence_sha256: hash({ identity, protocol: "session-scoped-static-capability-exact-private-task-admission-observed-domain-effects" }),
      // Read at each Host handshake: a task may be prepared after the static registry was created.
      get storage_capabilities() { return courseWorkflowStorageCapabilities(sessionId, id); } },
    execute: (invocation: Parameters<CourseWorkflowBroker["execute"]>[0]) => {
      const task = tasks().get(invocation.input.taskId);
      if (!task || task.record.sessionId !== sessionId) throw new Error("This course workflow task does not belong to the original Pi conversation");
      if (task.record.workflowId === COURSE_PRODUCTION_WORKFLOW_ID && invocation.context.run_id !== task.record.runId
        && !(["course_task_context","course_task_route"].includes(id) && invocation.context.run_id === `preflight-${task.record.taskId}`)) throw new Error("Course production broker invocation differs from its recorded Run");
      const previous = admitted.get(attemptKey(id, invocation.context));
      if (previous && previous !== task.domain) throw new Error("Course operation attempt was already admitted to a different task");
      admitted.set(attemptKey(id, invocation.context), task.domain);
      knownRuns.add(invocation.context.run_id);
      return task.domain.registry[id].execute(invocation);
    },
    cancel: async (invocation: Parameters<CourseWorkflowBroker["cancel"]>[0]) => {
      const domain = admitted.get(attemptKey(id, invocation.context));
      if (domain) return domain.registry[id].cancel(invocation);
      if (!knownRuns.has(invocation.context.run_id)) throw Object.assign(new Error("Course operation admission history is unavailable; reconcile the original Host owner before claiming termination"), { code: "COURSE_ADMISSION_RECONCILE_REQUIRED" });
      return { termination_confirmed: true as const, evidence: [{ kind: "course-operation-not-admitted", sha256: hash([identity, sessionId, invocation.context.run_id, invocation.context.node_id, invocation.context.attempt_id]) }],
        effects: { observed: true as const, changed_paths: [], outside_paths: [], artifacts: [] } };
    },
  }];
  }));
  const scope = { registry, admitted, knownRuns }; scopes.set(sessionId, scope); return scope;
}
export function courseWorkflowRegistry(sessionId: string) { return registryScope(sessionId).registry; }
