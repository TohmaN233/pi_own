"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { getSessionModeSettings } from "@/lib/mode-settings-service";
import { activateModePack } from "@/lib/mode-pack-client";
import { notifySessionConfiguration, subscribeSessionConfiguration } from "@/lib/session-configuration-events";
import styles from "./ModeSettingsPanel.module.css";

type Settings = Awaited<ReturnType<typeof getSessionModeSettings>>;
export function ModeSettingsPanel({ sessionId, section = "all" }: { sessionId: string; section?: "all" | "skills" | "prompt" | "tools" | "workflows" }) {
  const [data, setData] = useState<Settings | null>(null);
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [nativeTools, setNativeTools] = useState<Record<string, boolean>>({});
  const [selectedWorkflows, setSelectedWorkflows] = useState<Record<string, boolean>>({});
  const [workflowPending, setWorkflowPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [skillContent, setSkillContent] = useState<Record<string, string>>({});
  const [loadingSkill, setLoadingSkill] = useState<Record<string, boolean>>({});
  const dirty = useRef(false);
  const baseline = useRef<Settings | null>(null);
  const workflowDirty = useRef(false);
  const workflowBaseline = useRef<Settings | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(`/api/mode-packs/settings?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: "no-store" });
      const value = await response.json() as Settings & { error?: string };
      if (!response.ok) throw new Error(value.error ?? "无法读取模式设置");
      if (controller.signal.aborted) return;
      if (!dirty.current || baseline.current?.modePackId !== value.modePackId) {
          setPrompt(value.systemPrompt);
          setSelected(Object.fromEntries(value.skills.map((skill) => [skill.id, skill.enabled])));
          setNativeTools(Object.fromEntries(["codemode", "tool_search"].map((name) => [name, value.tools.includes(name)])));
          dirty.current = false;
          baseline.current = value;
      }
      const previousScope = workflowBaseline.current?.workflowScope;
      if (!workflowDirty.current || previousScope?.snapshotId !== value.workflowScope?.snapshotId || previousScope?.origin !== value.workflowScope?.origin) {
        setSelectedWorkflows(Object.fromEntries(value.workflows.map((workflow) => [workflow.id, workflow.enabled])));
        workflowDirty.current = false;
        workflowBaseline.current = value;
        setWorkflowPending(false);
      }
      setData(value);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [sessionId]);
  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeSessionConfiguration(sessionId, () => { void refresh(); });
    return () => { unsubscribe(); request.current?.abort(); };
  }, [refresh, sessionId]);
  const loadSkill = useCallback(async (skillId: string) => {
    if (skillContent[skillId] !== undefined || loadingSkill[skillId]) return;
    setLoadingSkill((current) => ({ ...current, [skillId]: true }));
    try {
      const response = await fetch(`/api/mode-packs/settings?sessionId=${encodeURIComponent(sessionId)}&skillId=${encodeURIComponent(skillId)}`, { cache: "no-store" });
      const value = await response.json() as { content?: string; error?: string };
      if (!response.ok || typeof value.content !== "string") throw new Error(value.error ?? "无法读取 Skill");
      setSkillContent((current) => ({ ...current, [skillId]: value.content! }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingSkill((current) => ({ ...current, [skillId]: false }));
    }
  }, [loadingSkill, sessionId, skillContent]);
  async function saveWorkflows() {
    const source = workflowBaseline.current;
    if (!source?.workflowScope || busy || !workflowDirty.current) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const workflows = source.workflows.filter((workflow) => (selectedWorkflows[workflow.id] ?? workflow.enabled) !== workflow.enabled)
        .map((workflow) => ({ id: workflow.id, enabled: selectedWorkflows[workflow.id] }));
      const response = await fetch("/api/mode-packs/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        sessionId, expectedSnapshotId: source.workflowScope.snapshotId, expectedWorkflowRevision: source.workflowScope.revision,
        idempotencyKey: crypto.randomUUID(), settingsPatch: { workflows },
      }) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "保存 Workflow 组合失败");
      workflowDirty.current = false;
      setWorkflowPending(false);
      await refresh();
      notifySessionConfiguration(sessionId);
      setNotice("Workflow 组合已保存到当前对话的此模式；正在运行的任务保持原设置。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!data || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (!data.snapshotId && section === "tools") {
        const source = baseline.current ?? data;
        const tools = [...source.tools.filter((name) => name !== "codemode" && name !== "tool_search"), ...["codemode", "tool_search"].filter((name) => nativeTools[name])];
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "set_tools", toolNames: tools }) });
        const value = await response.json() as { error?: string };
        if (!response.ok) throw new Error(value.error ?? "保存工具能力失败");
      } else if (!data.snapshotId) {
        await activateModePack({ sessionId, modePackId: "general", expectedSnapshotId: null, idempotencyKey: crypto.randomUUID() });
      } else {
        const source = baseline.current ?? data;
        // Keep the editing baseline for conflicts, but include skills installed
        // while this form had unsaved changes and its library tab was open.
        const available = [...source.skills, ...data.skills.filter((skill) => !source.skills.some((previous) => previous.id === skill.id))];
        const skills = available.filter((skill) => (selected[skill.id] ?? skill.enabled) !== skill.enabled).map((skill) => ({ id: skill.id, enabled: selected[skill.id] }));
        const tools = [...source.tools.filter((name) => name !== "codemode" && name !== "tool_search"), ...["codemode", "tool_search"].filter((name) => nativeTools[name])];
        const settingsPatch = {
          ...(section === "all" || section === "prompt" ? { systemPrompt: prompt } : {}),
          ...(section === "all" || section === "skills" ? { skills } : {}),
          ...(section === "all" || section === "tools" ? { tools } : {}),
        };
        const response = await fetch("/api/mode-packs/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, expectedSnapshotId: source.snapshotId, idempotencyKey: crypto.randomUUID(), settingsPatch }) });
        const value = await response.json() as { error?: string };
        if (!response.ok) throw new Error(value.error ?? "保存失败");
      }
      dirty.current = false;
      await refresh();
      notifySessionConfiguration(sessionId);
      setNotice(!data.snapshotId && section === "tools" ? "工具能力已生效并保存到当前对话。" : "已生效，当前会话的模式设置已保存。切换回来时会恢复。 ");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-label="模式设置">
    <div className={styles.heading}><strong>{data?.modePackId ?? (section === "tools" ? "当前对话" : "模式与 Skills")}</strong><span>{data?.verified ? "运行时已核验" : data?.live ? !data.snapshotId && section === "tools" ? "Agent 已启动" : "尚未核验" : "Agent 未启动"}</span></div>
    {error && <p role="alert" className={styles.error}>{error}<button type="button" onClick={() => void refresh()}>重新读取</button></p>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <p>正在读取当前会话…</p> : <>
      {(section === "all" || section === "skills" || section === "workflows") && <div className={styles.skills}>
        <strong>此模式的 Workflow 组合</strong>
        <p>所有已安装的 Workflow 都可自由选择，模式只提供默认开关。调整会保存到当前对话，切回此模式时恢复。启动需要定义已启用、已发布及所需工具可用；开关只影响新任务。</p>
        {data.workflowScope?.reason && <p role="status">{data.workflowScope.reason}</p>}
        {!data.workflows.length && <p>尚未安装 Workflow。可在 Workbench 中安装或创建。</p>}
        {[true, false].map((enabled) => <div key={String(enabled)}><strong>{enabled ? "已打开的 Workflow" : "已关闭的 Workflow"}</strong>
        {data.workflows.filter((workflow) => (selectedWorkflows[workflow.id] ?? workflow.enabled) === enabled).map((workflow) => <article key={workflow.id}><label>
          <input type="checkbox" checked={selectedWorkflows[workflow.id] ?? workflow.enabled} disabled={busy || !data.workflowScope}
            onChange={(event) => { workflowDirty.current = true; setWorkflowPending(true); setSelectedWorkflows((current) => ({ ...current, [workflow.id]: event.target.checked })); }}/>
          <strong>{workflow.name}</strong><span>加入此模式组合</span><span>{workflow.defaultEnabled ? "默认加入" : "默认不加入"}</span>
        </label><code className={styles.path}>{workflow.id}</code>
        {workflow.globalEnabled === false && <small>{(selectedWorkflows[workflow.id] ?? workflow.enabled) === workflow.enabled
          ? "共享定义已全局停用；此模式的选择已保存，暂不能启动。" : "共享定义已全局停用；保存此模式的组合选择后仍暂不能启动。"}</small>}
        </article>)}</div>)}
        {!!data.workflows.length && <button type="button" disabled={busy || !workflowPending || !data.workflowScope} onClick={() => void saveWorkflows()}>保存 Workflow 组合</button>}
      </div>}
      {(section === "all" || section === "tools") && <div className={styles.skills}>
        <p>当前对话的工具能力；随模式保存。MCP 使用 Pi 原生服务器配置，可在对话中用 /mcp 管理。</p>
        {[{ name: "codemode", label: "Codemode · 工具编排", description: "允许脚本批量调用已有工具，也保留直接工具调用。" }, { name: "tool_search", label: "独立工具搜索", description: "提供 tool_search；Codemode 内置的 searchTools() 不需要此开关。" }].map((tool) => <article key={tool.name}>
          <label><input type="checkbox" checked={nativeTools[tool.name] ?? false} disabled={busy || (!data.snapshotId && section !== "tools")} onChange={(event) => { dirty.current = true; setNativeTools((current) => ({ ...current, [tool.name]: event.target.checked })); }}/><strong>{tool.label}</strong></label><small>{tool.description}</small>
        </article>)}
      </div>}
      {(section === "all" || section === "prompt") && <label className={styles.field}>此模式的系统提示词<textarea aria-label="此模式的系统提示词" value={prompt} disabled={busy || !data.snapshotId} onChange={(event) => { dirty.current = true; setPrompt(event.target.value); }} rows={10}/><small>随模式自动切换；修改只保存到当前会话的此模式。工具权限、课程隔离和审批规则由 Host 执行。</small></label>}
      {(section === "all" || section === "skills") && <><p className={styles.path}>本地技能库：<code>{data.skillDirectory}</code></p><p>勾选决定当前模式的组合。“已加载”表示运行时已装入；必需技能由模式合同固定。要从模式包中彻底移除默认 Skill，请编辑包并启用新修订。</p>
      {data.kind === "generic" && data.modePackId && <a href={`/mode-packs?sessionId=${encodeURIComponent(sessionId)}&editModePackId=${encodeURIComponent(data.modePackId)}`}>编辑当前模式包默认 Skill（可移除）</a>}
      <div className={styles.skills}>{data.skills.map((skill) => <article key={skill.id}>
        <label><input type="checkbox" checked={selected[skill.id] ?? skill.enabled} disabled={busy || skill.required || !data.snapshotId} onChange={(event) => { dirty.current = true; setSelected((current) => ({ ...current, [skill.id]: event.target.checked })); }}/><strong>{skill.name}</strong><span>{skill.required ? "必需 · " : ""}{skill.loaded ? "已加载" : skill.enabled ? "已选，待加载" : "未启用"}</span></label>
        <details onToggle={(event) => { if (event.currentTarget.open) void loadSkill(skill.id); }}><summary>查看完整 Skill</summary><code className={styles.path}>{skill.filePath}</code><pre>{loadingSkill[skill.id] ? "正在读取…" : skillContent[skill.id] ?? ""}</pre></details>
      </article>)}</div></>}
      {section !== "workflows" && <div className={styles.footer}><button type="button" disabled={busy || data.busy || ((section === "all" || section === "prompt") && !!data.snapshotId && !prompt.trim())} onClick={() => void save()}>{busy ? "正在应用…" : data.snapshotId || section === "tools" ? "保存并应用" : "启用普通模式以配置能力"}</button>{data.busy && <span>请等待当前回复完成后修改</span>}</div>}
    </>}
  </section>;
}
