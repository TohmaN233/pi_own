import type { projectWorkspaceList } from "./project-workspaces-service";
export type ProjectDirectoryState = Awaited<ReturnType<typeof projectWorkspaceList>>;
export async function readProjects(signal?: AbortSignal): Promise<ProjectDirectoryState> {
  const response = await fetch("/api/projects", { cache: "no-store", signal });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "无法读取项目与对话");
  return value;
}
export async function projectAction(body: Record<string, unknown>): Promise<{ href?: string; id?: string }> {
  const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "项目操作未完成");
  return value;
}
