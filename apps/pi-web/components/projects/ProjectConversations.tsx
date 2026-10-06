"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { projectAction, readProjects, type ProjectDirectoryState } from "@/lib/project-workspaces-client";
import styles from "./Projects.module.css";

/** The same project membership and default-setting controls work in every task. */
export function ProjectConversations({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [data, setData] = useState<ProjectDirectoryState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const reload = useCallback(async () => { setData(await readProjects()); }, []);
  useEffect(() => {
    const controller = new AbortController();
    readProjects(controller.signal).then(setData).catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [sessionId]);
  const projectId = data?.conversations.find((item) => item.id === sessionId)?.projectId;
  const project = data?.projects.find((item) => item.id === projectId);
  const conversations = data?.conversations.filter((item) => item.projectId === projectId) ?? [];
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  if (!project && !error) return <div className={styles.compact}><a href="/projects">项目与对话</a></div>;
  return <nav className={styles.compact} aria-label="项目内对话">
    {project && <>
      <div className={styles.row}><a href={`/projects?project=${encodeURIComponent(project.id)}`} title={project.title}>▸ {project.title}</a><span className={styles.muted}>{conversations.length} 个对话</span></div>
      <div className={styles.row}>
        <select aria-label="切换项目内对话" value={sessionId} onChange={(event) => { const target = conversations.find((item) => item.id === event.target.value); if (target) router.push(target.href); }}>
          {conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button disabled={busy} type="button" onClick={() => void perform(async () => {
          const result = await projectAction({ action: "new_from_session", sourceSessionId: sessionId, requestId: crypto.randomUUID() });
          if (!result.href) throw new Error("新对话已创建，但没有返回入口。");
          router.push(result.href);
        })}>新建对话</button>
      </div>
      <details><summary>项目默认设置</summary><p>资料与成果由项目共享。此处新对话沿用当前对话的模式与设置，聊天记录独立；从课程列表新建时使用项目默认设置。</p>
        <p>{project.defaults ? `${project.defaults.mode} · ${project.defaults.model ?? "默认模型"} · ${project.defaults.skills.length} 个 Skills` : "首次从课程列表新建时，采用现有备课对话的设置。"}</p>
        <button type="button" disabled={busy} onClick={() => void perform(async () => { await projectAction({ action: "save_defaults", projectId: project.id, sessionId, expectedRevision: project.revision }); await reload(); setNotice("已保存项目默认设置；后续新对话自动继承。"); })}>将当前对话设置保存为项目默认</button>
      </details>
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
  </nav>;
}
