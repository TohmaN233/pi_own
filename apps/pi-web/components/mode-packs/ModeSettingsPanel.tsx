"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { getSessionModeSettings } from "@/lib/mode-settings-service";
import { activateModePack } from "@/lib/mode-pack-client";
import { notifySessionConfiguration, subscribeSessionConfiguration } from "@/lib/session-configuration-events";
import styles from "./ModeSettingsPanel.module.css";

type Settings = Awaited<ReturnType<typeof getSessionModeSettings>>;
export function ModeSettingsPanel({ sessionId, section = "all" }: { sessionId: string; section?: "all" | "skills" | "prompt" }) {
  const [data, setData] = useState<Settings | null>(null);
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  const baseline = useRef<Settings | null>(null);
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
          dirty.current = false;
          baseline.current = value;
      }
      setData(value);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [sessionId]);
  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeSessionConfiguration(sessionId, () => { void refresh(); });
    return () => { unsubscribe(); request.current?.abort(); };
  }, [refresh, sessionId]);
  async function save() {
    if (!data || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (!data.snapshotId) {
        await activateModePack({ sessionId, modePackId: "general", expectedSnapshotId: null, idempotencyKey: crypto.randomUUID() });
      } else {
        const source = baseline.current ?? data;
        // Keep the editing baseline for conflicts, but include skills installed
        // while this form had unsaved changes and its library tab was open.
        const available = [...source.skills, ...data.skills.filter((skill) => !source.skills.some((previous) => previous.id === skill.id))];
        const skills = available.filter((skill) => (selected[skill.id] ?? skill.enabled) !== skill.enabled).map((skill) => ({ id: skill.id, enabled: selected[skill.id] }));
        const settingsPatch = { ...(section !== "skills" ? { systemPrompt: prompt } : {}), ...(section !== "prompt" ? { skills } : {}) };
        const response = await fetch("/api/mode-packs/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, expectedSnapshotId: source.snapshotId, idempotencyKey: crypto.randomUUID(), settingsPatch }) });
        const value = await response.json() as { error?: string };
        if (!response.ok) throw new Error(value.error ?? "保存失败");
      }
      dirty.current = false;
      await refresh();
      notifySessionConfiguration(sessionId);
      setNotice("已生效，当前会话的模式设置已保存。切换回来时会恢复。 ");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className={styles.panel} aria-label="模式设置">
    <div className={styles.heading}><strong>{data?.modePackId ?? "模式与 Skills"}</strong><span>{data?.verified ? "运行时已核验" : data?.live ? "尚未核验" : "Agent 未启动"}</span></div>
    {error && <p role="alert" className={styles.error}>{error}<button type="button" onClick={() => void refresh()}>重新读取</button></p>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <p>正在读取当前会话…</p> : <>
      {section !== "skills" && <label className={styles.field}>此模式的系统提示词<textarea aria-label="此模式的系统提示词" value={prompt} disabled={busy || !data.snapshotId} onChange={(event) => { dirty.current = true; setPrompt(event.target.value); }} rows={10}/><small>随模式自动切换；修改只保存到当前会话的此模式。工具权限、课程隔离和审批规则由 Host 执行。</small></label>}
      {section !== "prompt" && <><p className={styles.path}>本地技能库：<code>{data.skillDirectory}</code></p><p>勾选决定当前模式的组合。“已加载”表示运行时已装入；必需技能由模式合同固定。</p><div className={styles.skills}>{data.skills.map((skill) => <article key={skill.id}>
        <label><input type="checkbox" checked={selected[skill.id] ?? skill.enabled} disabled={busy || skill.required || !data.snapshotId} onChange={(event) => { dirty.current = true; setSelected((current) => ({ ...current, [skill.id]: event.target.checked })); }}/><strong>{skill.name}</strong><span>{skill.required ? "必需 · " : ""}{skill.loaded ? "已加载" : skill.enabled ? "已选，待加载" : "未启用"}</span></label>
        <details><summary>查看完整 Skill</summary><code className={styles.path}>{skill.filePath}</code><pre>{skill.content}</pre></details>
      </article>)}</div></>}
      <div className={styles.footer}><button type="button" disabled={busy || data.busy || (section !== "skills" && !!data.snapshotId && !prompt.trim())} onClick={() => void save()}>{busy ? "正在应用…" : data.snapshotId ? "保存并应用" : "启用普通模式以配置 Skills"}</button>{data.busy && <span>请等待当前回复完成后修改</span>}</div>
    </>}
  </section>;
}
