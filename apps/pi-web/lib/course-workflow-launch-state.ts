export type CourseWorkflowStartState = "intent" | "confirmed" | "unconfirmed" | "refused";
export type CourseWorkflowStartError = { code: string | null; message: string; details?: unknown; legacy?: true };
export type CourseWorkflowLaunchRecord = {
  runId?: string; startState?: CourseWorkflowStartState; startIntentAt?: string; startConfirmedAt?: string; startCheckedAt?: string;
  startError?: CourseWorkflowStartError | string; startLookupError?: CourseWorkflowStartError; legacyStartRecord?: true;
  previousLaunches?: Omit<CourseWorkflowLaunchRecord, "previousLaunches">[];
};
declare global { var __piWorkflowPendingLaunches: Set<string> | undefined; }
// Next routes and dynamically loaded extensions can have different module instances.
// Pending dispatch ownership belongs to the shared Host process, not a status reader.
const pendingLaunches = () => globalThis.__piWorkflowPendingLaunches ??= new Set<string>();
export function courseWorkflowStartState(record: CourseWorkflowLaunchRecord): CourseWorkflowStartState | "prepared" {
  if (record.startState !== undefined && !["intent", "confirmed", "unconfirmed", "refused"].includes(record.startState)) throw new Error("Course Workflow start state is corrupt");
  if (record.startState && !record.runId) throw new Error("Course Workflow start state has no intended Run identity");
  return record.startState ?? (record.runId ? "unconfirmed" : "prepared");
}
export function courseWorkflowStartLabel(record: CourseWorkflowLaunchRecord) {
  const state = courseWorkflowStartState(record);
  return state === "prepared" ? "待启动" : state === "confirmed" ? "已启动"
    : state === "refused" ? "未启动 · 可重试"
    : state === "intent" ? "启动核验中" : (record.legacyStartRecord || record.runId && !record.startState) ? "启动待核验（旧版记录）" : "启动未确认";
}
export function courseWorkflowStartError(error: unknown): CourseWorkflowStartError {
  if (typeof error === "string") return { code: null, message: error, legacy: true };
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    return { code: typeof value.code === "string" ? value.code : null, message: typeof value.message === "string" ? value.message : String(error),
      ...(value.details !== undefined ? { details: value.details } : {}) };
  }
  return { code: null, message: String(error) };
}
function exactMissingRun(error: unknown, runId: string) {
  const value = error as { code?: unknown; details?: { run_id?: unknown; observation?: unknown } } | null;
  return value?.code === "RUN_NOT_FOUND" && value.details?.run_id === runId && value.details?.observation === "run_directory_absent";
}
function preRunRefusal(error: CourseWorkflowLaunchRecord["startError"], runId: string) {
  if (!error || typeof error !== "object") return false;
  const admission = (error.details as { admission?: { run_id?: string; phase?: string; execution_started?: boolean } } | undefined)?.admission;
  if (admission) return admission.run_id === runId && admission.phase === "before_run_creation" && admission.execution_started === false;
  // These historical Host errors were raised exclusively before Run creation.
  return error.code === "HOST_TOOL_BINDING_STALE" && error.message === "Workflow host-tool bindings do not match the registered qualified implementations"
    || error.code === "COURSE_WORKFLOW_ADMISSION_STATE" && error.message === "Course production task is not admitting a new Run intent"
    || error.code === "PI_MAIN_STRICT_CONTEXT";
}
export function courseWorkflowLaunchCanRetry(record: CourseWorkflowLaunchRecord) {
  return Boolean(record.runId && record.startState === "refused" && preRunRefusal(record.startError, record.runId)
    && exactMissingRun(record.startLookupError, record.runId) && !pendingLaunches().has(record.runId));
}
/** Preserve the refusal evidence; retry prepares a fresh intent for the same teacher request. */
export function resetRefusedCourseWorkflowLaunch<R extends CourseWorkflowLaunchRecord>(record: R): R {
  if (!courseWorkflowLaunchCanRetry(record)) throw new Error("Only a confirmed pre-Run refusal can be retried");
  const { previousLaunches = [], runId, startState, startIntentAt, startConfirmedAt, startCheckedAt, startError, startLookupError, legacyStartRecord, ...task } = record;
  const prior = {runId, startState, startIntentAt, startConfirmedAt, startCheckedAt, startError, startLookupError, legacyStartRecord};
  return {...task, previousLaunches:[...previousLaunches, prior]} as R;
}
const observedFields = (record: CourseWorkflowLaunchRecord) => JSON.stringify([record.startState, record.startError, record.startLookupError, record.legacyStartRecord]);
async function persistObservation<R extends CourseWorkflowLaunchRecord>(record: R, before: string, persist: (record: R) => Promise<void>) {
  if (before !== observedFields(record)) { record.startCheckedAt = new Date().toISOString(); await persist(record); }
}
/** readRun must verify the exact actor/workflow/task/workspace binding before resolving. */
export async function observeCourseWorkflowLaunch<R extends CourseWorkflowLaunchRecord, S>(record: R, readRun: () => Promise<S>, persist: (record: R) => Promise<void>): Promise<S | null> {
  if (!record.runId) return null;
  courseWorkflowStartState(record);
  if (pendingLaunches().has(record.runId)) return null;
  const before = observedFields(record), legacy = record.startState === undefined;
  let state: S;
  try { state = await readRun(); }
  catch (error) {
    if (!exactMissingRun(error, record.runId) || record.startState === "confirmed") throw error;
    record.startState = preRunRefusal(record.startError, record.runId) ? "refused" : "unconfirmed"; if (legacy) record.legacyStartRecord = true;
    record.startLookupError = courseWorkflowStartError(error); record.startError ??= record.startLookupError;
    await persistObservation(record, before, persist);
    return null; // Present absence does not prove no previous Run or effects.
  }
  record.startState = "confirmed"; record.startConfirmedAt ??= new Date().toISOString();
  if (legacy) record.legacyStartRecord = true;
  await persistObservation(record, before, persist);
  return state;
}
/** Persist the exact intent once; any ambiguous dispatch keeps its Run and request identities. */
export async function dispatchCourseWorkflowLaunch<R extends CourseWorkflowLaunchRecord, S>(record: R, dispatch: () => Promise<unknown>, readRun: () => Promise<S>, persist: (record: R) => Promise<void>): Promise<S> {
  if (!record.runId) throw new Error("Course Workflow start intent requires a Run identity");
  if (record.startState !== undefined || record.startIntentAt !== undefined) throw new Error("Course Workflow start intent is already recorded; reconcile its exact Run");
  if (pendingLaunches().has(record.runId)) throw new Error("This exact Run is already being dispatched");
  pendingLaunches().add(record.runId);
  try {
    record.startState = "intent"; record.startIntentAt = new Date().toISOString();
    await persist(record);
    let startFailure: unknown, dispatchFailed = false;
    try {
      const acknowledged = await dispatch();
      if (!acknowledged || typeof acknowledged !== "object" || (acknowledged as {run_id?: string}).run_id !== record.runId)
        throw Object.assign(new Error("pi-CAW acknowledged a different Run identity"), {code:"COURSE_WORKFLOW_ACK_MISMATCH"});
    } catch (error) {
      dispatchFailed = true; startFailure = error;
      const absent = exactMissingRun(error, record.runId) || (error as { code?: string })?.code === "EPERM";
      if (absent) {
        // The Run directory was never published. Do not freeze this task.
        const { previousLaunches = [], runId, startState, startIntentAt, startConfirmedAt, startCheckedAt, startError, startLookupError, legacyStartRecord, ...task } = record;
        const prior = { runId, startState: "intent" as const, startIntentAt, startError: courseWorkflowStartError(error) };
        Object.assign(record, task, { previousLaunches: [...previousLaunches, prior] });
        delete record.runId; delete record.startState; delete record.startIntentAt; delete record.startConfirmedAt;
        delete record.startCheckedAt; delete record.startError; delete record.startLookupError; delete record.legacyStartRecord;
        await persist(record);
        throw error;
      }
      record.startState = "unconfirmed"; record.startError = courseWorkflowStartError(error);
      await persist(record);
    }
    pendingLaunches().delete(record.runId);
    let state: S | null;
    try { state = await observeCourseWorkflowLaunch(record, readRun, persist); }
    catch (error) {
      record.startState = "unconfirmed"; record.startError ??= courseWorkflowStartError(error); record.startLookupError = courseWorkflowStartError(error);
      record.startCheckedAt = new Date().toISOString(); await persist(record);
      throw error;
    }
    if (state !== null) return state;
    if (dispatchFailed) throw startFailure;
    const diagnostic = record.startLookupError!;
    throw Object.assign(new Error(diagnostic.message), {code:diagnostic.code, details:diagnostic.details});
  } finally { pendingLaunches().delete(record.runId); }
}
