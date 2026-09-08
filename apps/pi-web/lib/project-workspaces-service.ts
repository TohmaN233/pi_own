import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { modeSystemPrompt, reviseModePackSettings } from "../../../packages/profile-resource-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { createPersistedGenericSession, getGenericModePackStatus, getRpcSession, resolveSavedModeSettings } from "./rpc-manager";
import { listAllSessions, resolveSessionPath, invalidateSessionListCache } from "./session-reader";
import { ModePackStore } from "./mode-pack-store";
import { buildModePackRuntimePlanFromInventory } from "./mode-pack-inventory";

export function projectConversationHref(sessionId: string, course: boolean): string {
  return course ? `/course-builder?sessionId=${encodeURIComponent(sessionId)}` : `/?session=${encodeURIComponent(sessionId)}`;
}

export async function projectWorkspaceList() {
  const harness = getLearningHarness();
  const sessions = await listAllSessions();
  const saved = harness.projectWorkspaces.list();
  const courses = harness.courseBuilder.listProjects();
  const members = new Map(harness.projectWorkspaces.members().map((item) => [item.sessionId, item.projectId]));
  const conversations = sessions.map((session) => {
    const course = harness.courseBuilder.getProjectForSession(session.id);
    return { id: session.id, title: session.name || session.firstMessage || "未命名对话", modified: session.modified, messageCount: session.messageCount, cwd: session.cwd,
      projectId: course?.projectId ?? members.get(session.id) ?? null,
      href: projectConversationHref(session.id, !!course), student: !!harness.findCurrentSession(session.id) };
  }).sort((a, b) => b.modified.localeCompare(a.modified));
  const summaries = saved.filter((item) => !item.courseProjectId).map((item) => ({ ...item }));
  for (const course of courses) {
    const existing = saved.find((item) => item.id === course.projectId);
    summaries.push({ id: course.projectId, title: course.title, cwd: existing?.cwd ?? conversations.find((item) => item.projectId === course.projectId)?.cwd ?? process.cwd(),
      courseProjectId: course.projectId, defaults: existing?.defaults ?? null, revision: existing?.revision ?? 0 });
  }
  return { projects: summaries.map(({ defaults, ...item }) => ({ ...item,
    defaults: defaults ? { mode: defaults.profileId, model: defaults.model, provider: defaults.provider, systemPrompt: modeSystemPrompt(defaults),
      skills: defaults.resources.filter((resource) => resource.kind === "skill" && resource.enabled).map((resource) => resource.id) } : null })), conversations };
}

async function sessionSource(sessionId: string) {
  if (getLearningHarness().findCurrentSession(sessionId)) throw new Error("学生会话的活动边界不能作为通用项目默认设置。");
  const path = await resolveSessionPath(sessionId);
  if (!path) throw new Error("Session not found");
  const status = await getGenericModePackStatus(sessionId);
  const manager = SessionManager.open(path);
  let snapshot = status.runtime.binding?.snapshot;
  const context = manager.buildSessionContext();
  const live = getRpcSession(sessionId);
  const model = live?.inner.model ? { provider: live.inner.model.provider, modelId: live.inner.model.id } : context.model;
  if (!snapshot) snapshot = (await new ModePackStore().resolve("general", manager.getCwd())).snapshot;
  const fresh = await resolveSavedModeSettings(snapshot, undefined, manager.getCwd());
  if (model) snapshot = reviseModePackSettings(fresh.snapshot, { provider: model.provider, model: model.modelId }, fresh.inventory.catalog);
  else snapshot = fresh.snapshot;
  return { cwd: manager.getCwd(), snapshot };
}

async function ensureProject(projectId: string) {
  const harness = getLearningHarness();
  const existing = harness.projectWorkspaces.list().find((item) => item.id === projectId);
  if (existing) return existing;
  const course = harness.courseBuilder.listProjects().find((item) => item.projectId === projectId);
  if (!course) throw new Error("Project not found");
  const state = await projectWorkspaceList();
  const source = state.conversations.find((item) => item.projectId === projectId);
  const settings = source ? await sessionSource(source.id) : null;
  // Existing courses become folders without moving or rewriting their transcripts.
  const cwd = settings?.cwd ?? process.cwd();
  const defaults = settings?.snapshot.profileId === "course-builder" ? settings.snapshot : (await new ModePackStore().resolve("course-builder", cwd)).snapshot;
  return harness.projectWorkspaces.create({ id: projectId, courseProjectId: projectId, title: course.title, cwd, defaults });
}

export async function createProjectFolder(input: { id: string; title: string; cwd: string; sourceSessionId?: string }) {
  const source = input.sourceSessionId ? await sessionSource(input.sourceSessionId) : null;
  if (source?.snapshot.profileId === "course-builder") throw new Error("备课对话请在其课程内新建对话。");
  const cwd = resolve(source?.cwd ?? input.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("项目工作目录不存在。");
  const defaults = source?.snapshot ?? (await new ModePackStore().resolve("general", cwd)).snapshot;
  return getLearningHarness().projectWorkspaces.create({ id: input.id, title: input.title, cwd, defaults, courseProjectId: null });
}

export async function createProjectConversation(input: { projectId: string; title: string; requestId: string }) {
  const project = await ensureProject(input.projectId);
  const base = project.defaults ?? (await new ModePackStore().resolve(project.courseProjectId ? "course-builder" : "general", project.cwd)).snapshot;
  if (project.courseProjectId && base.profileId !== "course-builder") throw new Error("课程默认设置必须使用备课模式。");
  const resolved = await resolveSavedModeSettings(base, undefined, project.cwd);
  buildModePackRuntimePlanFromInventory({ snapshot: resolved.snapshot, inventory: resolved.inventory });
  const host = getLearningHarness().projectWorkspaces;
  const sessionId = host.createSession(project.id, input.requestId, contentHash(input), () => createPersistedGenericSession(project.cwd, input.title, resolved.snapshot));
  if (!await resolveSessionPath(sessionId)) throw new Error("The previously created conversation was deleted; start a new creation request.");
  if (project.courseProjectId) getLearningHarness().courseBuilder.bindSession(sessionId, project.courseProjectId);
  invalidateSessionListCache();
  console.info("[projects] created conversation", { projectId: project.id, sessionId, defaultRevision: project.revision });
  return { sessionId, href: projectConversationHref(sessionId, !!project.courseProjectId) };
}

export async function saveProjectDefaults(projectId: string, sourceSessionId: string, expectedRevision: number) {
  const state = await projectWorkspaceList();
  if (!state.conversations.some((item) => item.id === sourceSessionId && item.projectId === projectId)) throw new Error("默认设置来源必须是这个项目中的对话。");
  const prior = state.projects.find((item) => item.id === projectId);
  if (!prior || prior.revision !== expectedRevision) throw new Error("Project settings revision conflict; reload before saving");
  const source = await sessionSource(sourceSessionId);
  const project = await ensureProject(projectId);
  if (project.courseProjectId && source.snapshot.profileId !== "course-builder") throw new Error("课程默认设置必须使用备课模式。");
  const result = getLearningHarness().projectWorkspaces.update(projectId, { title: prior.title, defaults: source.snapshot }, expectedRevision === 0 ? 1 : expectedRevision);
  console.info("[projects] saved shared defaults", { projectId, sourceSessionId, revision: result.revision });
  return { revision: result.revision };
}

export async function moveProjectConversation(sessionId: string, projectId: string | null) {
  const harness = getLearningHarness();
  if (!await resolveSessionPath(sessionId)) throw new Error("Session not found");
  if (harness.courseBuilder.getProjectForSession(sessionId) || harness.findCurrentSession(sessionId)) throw new Error("课程对话包含课程绑定，请保留在原课程中；可在外面新建独立对话。");
  if (projectId && (await ensureProject(projectId)).courseProjectId) throw new Error("请使用课程内的新建对话，避免把其他任务的历史混入课程。");
  harness.projectWorkspaces.move(sessionId, projectId);
  console.info("[projects] moved conversation", { sessionId, projectId });
}
