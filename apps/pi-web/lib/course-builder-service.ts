import { getLearningHarness } from "./harness-server";
import { courseBuilderView, parseCourseBuilderProjectInput, runCourseBuilderCommand, type CourseBuilderCommand } from "../../../packages/course-builder-host/src/index.ts";
import { isDeepStrictEqual } from "node:util";
import { createPersistedGenericSession } from "./rpc-manager";
import { readLinkedCourseBuilderMaterial } from "./course-builder-local-materials";
import { readChatAttachment } from "./chat-attachments";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import { listAllSessions } from "./session-reader";
import { readCourseRevisionTasks, readCourseDeliveryTask } from "./course-builder-revisions";

export function getCourseBuilderHost() { return getLearningHarness().courseBuilder; }
export function assertCourseBuilderSession(sessionId: string): void {
 if (!sessionId || getLearningHarness().findCurrentSession(sessionId) || getLearningHarness().studyResearch.findProjectForSession(sessionId)) throw new Error("Course Builder requires a non-student Pi session");
}
export function courseBuilderState(sessionId: string) {
 assertCourseBuilderSession(sessionId);
 return {projects:getCourseBuilderHost().listProjects(),snapshot:courseBuilderView(getCourseBuilderHost(),sessionId),compilerEnabled:process.env.PI_COURSE_BUILDER_TRUSTED_TEX==="1"};
}
declare global {
 var __piCourseCreationLocks: Map<string, Promise<string>> | undefined;
}

/** Creation is explicit, requires no model, and retries use the same durable project. */
export async function createCourseBuilderWorkspace(value: unknown, createdAt: string): Promise<string> {
 const input = parseCourseBuilderProjectInput(value);
 if (!createdAt || new Date(createdAt).toISOString() !== createdAt) throw new Error("Invalid course creation timestamp");
 const key = `${input.courseId}:${createdAt}`;
 const locks = globalThis.__piCourseCreationLocks ??= new Map();
 const preceding = locks.get(key);
 const operation = (async () => {
  if (preceding) await preceding;
  const host = getCourseBuilderHost();
  const project = host.createProject(input, createdAt);
  const savedInput = Object.fromEntries(Object.keys(input).map((key) => [key, project[key as keyof typeof input]]));
  if (!isDeepStrictEqual(savedInput, input)) throw new Error("This creation request was already used for different course settings");
  const state = await courseBuilderWorkspaceState(null);
  const existing = state.projectSessions[project.projectId]?.[0];
  if (existing) return existing;
  const sessionId = createPersistedGenericSession(process.cwd(), `备课 · ${project.title}`);
  host.bindSession(sessionId, project.projectId);
  console.info("[course-builder] created course workspace", { sessionId, projectId: project.projectId });
  return sessionId;
 })();
 locks.set(key, operation);
 try { return await operation; }
 finally { if (locks.get(key) === operation) locks.delete(key); }
}
export async function courseBuilderWorkspaceState(sessionId: string | null) {
 const host = getCourseBuilderHost();
 const projectSessions: Record<string, string[]> = {};
 // Use the existing session inventory so deleted JSONL files are not offered as resumable workspaces.
 const sessions = [...await listAllSessions()].sort((left, right) => Number(right.messageCount > 0) - Number(left.messageCount > 0) || right.modified.localeCompare(left.modified));
 for (const session of sessions) {
  if (getLearningHarness().findCurrentSession(session.id)) continue;
  const project = host.getProjectForSession(session.id);
  if (project) (projectSessions[project.projectId] ??= []).push(session.id);
 }
 return { projects: host.listProjects(), snapshot: sessionId ? courseBuilderView(host, sessionId) : null, projectSessions, revisionTasks: sessionId ? await readCourseRevisionTasks(sessionId) : [], deliveryTask: sessionId ? await readCourseDeliveryTask(sessionId) : null, compilerEnabled: process.env.PI_COURSE_BUILDER_TRUSTED_TEX === "1" };
}
export async function courseBuilderCommand(sessionId: string, command: CourseBuilderCommand, assertActive?:()=>void|Promise<void>) {
 assertCourseBuilderSession(sessionId);
 const result = await runCourseBuilderCommand(getCourseBuilderHost(),sessionId,command,{trustedTex:process.env.PI_COURSE_BUILDER_TRUSTED_TEX==="1",assertActive,readLinkedMaterial:readLinkedCourseBuilderMaterial,readAttachment:async(id)=>{
  const path=await resolveSessionPath(sessionId), header=path ? readSessionHeader(path) : null;
  if(!header)throw new Error("Attachment conversation unavailable");
  return readChatAttachment(header.cwd,id,{sessionId,assignmentId:getCourseBuilderHost().getAgentAssignmentScope(sessionId)});
 }});
 return result;
}
