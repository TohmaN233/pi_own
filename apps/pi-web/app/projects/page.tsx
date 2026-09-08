"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { projectAction, readProjects, type ProjectDirectoryState } from "@/lib/project-workspaces-client";
import styles from "@/components/projects/Projects.module.css";

function ProjectDirectory() {
  const router = useRouter();
  const query = useSearchParams();
  const selected = query.get("project") ?? "";
  const [data, setData] = useState<ProjectDirectoryState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<"project" | "conversation" | null>(null);
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState("");
  const [source, setSource] = useState("");
  const [requestId, setRequestId] = useState("");
  const refresh = useCallback(async () => { setData(await readProjects()); }, []);
  useEffect(() => { const controller = new AbortController(); readProjects(controller.signal).then(setData).catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); }); return () => controller.abort(); }, []);
  const project = data?.projects.find((item) => item.id === selected);
  const conversations = data?.conversations.filter((item) => item.projectId === (project?.id ?? null)) ?? [];
  const independentCwd = project?.cwd ?? data?.conversations[0]?.cwd;
  const independentHref = independentCwd ? `/?cwd=${encodeURIComponent(independentCwd)}` : "/";
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function showForm(next: "project" | "conversation") { setForm(next); setTitle(""); setSource(""); setCwd(project?.cwd ?? data?.conversations[0]?.cwd ?? ""); setRequestId(crypto.randomUUID()); }
  function selectProject(id: string) { setForm(null); setSource(""); router.push(id ? `/projects?project=${encodeURIComponent(id)}` : "/projects"); }
  return <main className={styles.page}>
    <header className={styles.header}><Link href="/">← 返回 Pi</Link><h1>项目与对话</h1><Link href={independentHref}>新建独立对话</Link><button onClick={() => showForm("project")}>新建项目</button><a href="/course-builder">新建课程</a></header>
    <div className={styles.layout}>
      <nav className={styles.folders} aria-label="项目文件夹"><button className={styles.folder} aria-current={!selected} onClick={() => selectProject("")}>独立对话 <small>({data?.conversations.filter((item) => !item.projectId).length ?? 0})</small></button>
        {data?.projects.map((item) => <button className={styles.folder} key={item.id} aria-current={selected === item.id} onClick={() => selectProject(item.id)}>▸ {item.title}<div className={styles.muted}>{item.courseProjectId ? "课程" : "项目"} · {data.conversations.filter((session) => session.projectId === item.id).length} 个对话</div></button>)}
      </nav>
      <section className={styles.content}>
        {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
        {!data ? <p>正在读取项目…</p> : <>
          <h2>{project?.title ?? "独立对话"}</h2><p className={styles.muted}>{project ? "同一项目下的对话共享资料与成果，各自保留独立聊天记录。" : "这些对话放在项目外。可以独立使用，也可以整理到普通项目中。"}</p>
          {selected && !project && <p role="alert">项目不存在，请从左侧重新选择。</p>}
          {project && <div className={styles.row}><button onClick={() => showForm("conversation")}>新建项目内对话</button><span className={styles.muted}>{project.cwd}</span></div>}
          {form && <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void perform(async () => {
            const result = await projectAction(form === "conversation" ? { action: "new_conversation", projectId: project!.id, title, requestId } : { action: "create", title, cwd, requestId, ...(source ? { sourceSessionId: source } : {}) });
            if (form === "conversation") { if (!result.href) throw new Error("没有返回新对话入口"); router.push(result.href); }
            else { await refresh(); setForm(null); router.push(`/projects?project=${encodeURIComponent(result.id!)}`); }
          }); }}>
            <label>{form === "project" ? "项目名称" : "对话名称"}<input required maxLength={200} value={title} onChange={(event) => { setTitle(event.target.value); setRequestId(crypto.randomUUID()); }} placeholder={form === "project" ? "例如：论文写作 / 数据分析" : "例如：第二课课件 / Assignment 1"}/></label>
            {form === "project" && <><label>共享工作目录<input required value={cwd} onChange={(event) => { setCwd(event.target.value); setRequestId(crypto.randomUUID()); }}/></label><label>初始设置来源<select value={source} onChange={(event) => { setSource(event.target.value); setRequestId(crypto.randomUUID()); const session = data.conversations.find((item) => item.id === event.target.value); if (session) setCwd(session.cwd); }}><option value="">通用模式默认设置</option>{data.conversations.filter((item) => !item.projectId && !item.student).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><p className={styles.muted}>复用模型、提示词和 Skills，不复制聊天内容。不会移动或修改此目录中的文件。</p></>}
            <div className={styles.row}><button disabled={busy || !title.trim()}>创建</button><button type="button" onClick={() => setForm(null)}>取消</button></div>
          </form>}
          {project && <details className={styles.defaults}><summary>项目默认设置 · {project.defaults?.model ?? "尚未单独保存"}</summary>
            <p>新对话继承默认模型、提示词和 Skills。先在某条对话中调整，再将它保存为项目默认；已有对话保留各自设置。</p>
            {project.defaults && <><p>模式：{project.defaults.mode} · Skills：{project.defaults.skills.length}</p><pre>{project.defaults.systemPrompt}</pre><p className={styles.muted}>{project.defaults.skills.join(" · ")}</p></>}
            <div className={styles.row}><select aria-label="项目默认设置来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="">选择项目中的对话…</option>{conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button disabled={busy || !source} onClick={() => void perform(async () => { await projectAction({ action: "save_defaults", projectId: project.id, sessionId: source, expectedRevision: project.revision }); await refresh(); setNotice("已保存项目默认设置，后续新对话将继承。"); })}>保存为项目默认</button></div>
          </details>}
          <ul className={styles.list}>{conversations.map((item) => <li className={styles.conversation} key={item.id}><div><a href={item.href}>{item.title}</a><span className={styles.muted}>{item.messageCount === 0 ? "尚未开始" : `${item.messageCount} 条消息`} · {new Date(item.modified).toLocaleString()}</span></div>
            {!item.student && !project?.courseProjectId && <select aria-label={`整理对话：${item.title}`} value={item.projectId ?? ""} disabled={busy} onChange={(event) => { const projectId = event.target.value || null; void perform(async () => { await projectAction({ action: "move", sessionId: item.id, projectId }); await refresh(); }); }}><option value="">项目外 · 独立对话</option>{data.projects.filter((folder) => !folder.courseProjectId).map((folder) => <option value={folder.id} key={folder.id}>{folder.title}</option>)}</select>}
          </li>)}</ul>
          {!conversations.length && <p className={styles.muted}>{project ? "项目里还没有对话。点击上方按钮开始，项目资料和设置会继续保留。" : "没有独立对话。"}</p>}
        </>}
      </section>
    </div>
  </main>;
}
export default function ProjectsPage() { return <Suspense fallback={<p>正在打开项目…</p>}><ProjectDirectory/></Suspense>; }
