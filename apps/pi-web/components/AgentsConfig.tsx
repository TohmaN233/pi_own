"use client";

import { useEffect, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { ConfigButton, ConfigPanelShell, ConfigSwitch } from "./SettingsUi";

export function AgentsConfig({ cwd, sessionId = null, onClose, onReloaded, embedded = false }: {
  cwd: string; sessionId?: string | null; onClose: () => void; onReloaded?: () => void; embedded?: boolean;
}) {
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    fetch("/api/subagents/settings").then(async response => {
      const data = await response.json() as { enabled: boolean; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (current) setEnabled(data.enabled);
    }).catch(cause => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, []);
  const open = async (command: string) => {
    if (!sessionId) return;
    setBusy(true); setError(null);
    try {
      const pending = sendAgentCommand(sessionId, { type: "prompt", message: command });
      onClose();
      await pending;
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const toggle = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/subagents/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
      const data = await response.json() as { enabled: boolean; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setEnabled(data.enabled);
      if (sessionId) { await sendAgentCommand(sessionId, { type: "reload" }); onReloaded?.(); }
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <ConfigPanelShell embedded={embedded} title="Subagents" subtitle={cwd} closeLabel="关闭" onClose={onClose}>
    <div style={{ padding: 20, overflow: "auto", lineHeight: 1.7 }}>
      <h3>pi-subagents · 0.74.0</h3>
      <p>角色、模型、思考等级和提示词统一使用 pi-subagents 的配置。新运行、后台任务和运行看板使用同一个调度器。</p>
      <ConfigSwitch checked={enabled} loading={busy} onChange={() => void toggle()} label="启用 Subagents" />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
        <ConfigButton disabled={!sessionId || busy || !enabled} onClick={() => void open("/subagents")}>管理角色与模型</ConfigButton>
        <ConfigButton disabled={!sessionId || busy || !enabled} onClick={() => void open("/subagents-fleet")}>查看与控制运行</ConfigButton>
        <ConfigButton disabled={!sessionId || busy} onClick={() => void open("/context details")}>上下文用量</ConfigButton>
      </div>
      {!sessionId && <p>打开一个对话后可以管理角色和查看运行。</p>}
      {error && <p role="alert" style={{ color: "var(--error)" }}>{error}</p>}
    </div>
  </ConfigPanelShell>;
}
