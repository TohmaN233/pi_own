"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { identifyPermissionPreset, parsePermissionPolicy, permissionPreset, type PermissionPreset, type PermissionScope, type PermissionSettings } from "@/lib/permission-policy";
import { ConfigButton } from "./SettingsUi";

export function PermissionsConfig({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const [scope, setScope] = useState<PermissionScope>("global");
  const [settings, setSettings] = useState<PermissionSettings | null>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const dirty = !!settings && settings.source !== source;
  let preset: PermissionPreset | "custom" = "custom";
  let external = false;
  try {
    const policy = parsePermissionPolicy(source || "{}");
    preset = scope === "project" && Object.keys(policy).length === 0 ? "custom" : identifyPermissionPreset(policy);
    external = (policy.special?.external_directory ?? (scope === "project" ? settings?.globalPolicy.special?.external_directory : undefined)) === "allow";
  } catch { /* The editable draft can be incomplete; saving validates it. */ }

  useEffect(() => {
    const controller = new AbortController();
    setSettings(null); setError(null); setSaved(false);
    const query = new URLSearchParams({ scope, ...(sessionId ? { sessionId } : {}) });
    void fetch(`/api/permissions/settings?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted) { setSettings(data); setSource(data.source); }
      }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [scope, sessionId, refresh]);

  const update = (transform: (policy: ReturnType<typeof parsePermissionPolicy>) => ReturnType<typeof parsePermissionPolicy>) => {
    try { setSource(JSON.stringify(transform(parsePermissionPolicy(source)), null, 2) + "\n"); setError(null); setSaved(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const save = async () => {
    if (!settings) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      parsePermissionPolicy(source);
      const response = await fetch("/api/permissions/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, ...(sessionId ? { sessionId } : {}), source, expectedContentHash: settings.contentHash }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSettings(data); setSource(data.source); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  return <div className="settings-general permissions-config">
    <h2 className="settings-general-title">{t("permissions.title")}</h2>
    <p className="settings-general-description">{t("permissions.description")}</p>
    <label className="config-field">
      <span className="config-field-label">{t("permissions.scope")}</span>
      <select value={scope} disabled={dirty || saving} onChange={(event) => setScope(event.target.value as PermissionScope)} className="config-input">
        <option value="global">{t("permissions.global")}</option>
        <option value="project" disabled={!sessionId}>{t("permissions.project")}</option>
      </select>
    </label>
    {error && <p role="alert" className="settings-general-error">{error}</p>}
    {!settings ? <ConfigButton variant="secondary" onClick={() => setRefresh((value) => value + 1)}>{error ? t("permissions.reload") : t("common.loading")}</ConfigButton> : <>
      <p className="settings-general-description">{settings.active ? t("permissions.active") : t("permissions.inactive")}</p>
      <div role="radiogroup" aria-label={t("permissions.policy")} className="permissions-presets">
        {(["confirm", "read", "auto"] as const).map((id) => <label key={id} className="permissions-preset">
          <input type="radio" name="permission-preset" checked={preset === id} disabled={saving} onChange={() => update((policy) => permissionPreset(policy, id))}/>
          <span><strong>{t(`permissions.${id}`)}</strong><span>{t(`permissions.${id}Description`)}</span></span>
        </label>)}
      </div>
      {preset === "custom" && <p className="settings-general-description">{t("permissions.custom")}</p>}
      <label className="permissions-external">
        <input type="checkbox" checked={external} disabled={saving} onChange={(event) => update((policy) => ({ ...policy, special: { ...policy.special, external_directory: event.target.checked ? "allow" : "ask" } }))}/>
        <span>{t("permissions.external")}</span>
      </label>
      <p className="settings-general-description">{t("permissions.denyFloor")}</p>
      <details>
        <summary>{t("permissions.advanced")}</summary>
        <textarea aria-label={t("permissions.advanced")} className="permissions-source" spellCheck={false} value={source} disabled={saving} onChange={(event) => { setSource(event.target.value); setSaved(false); }}/>
        {scope === "project" && <details><summary>{t("permissions.inherited")}</summary><pre className="permissions-inherited">{JSON.stringify(settings.globalPolicy, null, 2)}</pre></details>}
        <p className="permissions-path">{settings.path}</p>
      </details>
      <div className="permissions-actions">
        <ConfigButton disabled={!dirty || saving} onClick={() => void save()}>{saving ? t("common.loading") : t("permissions.save")}</ConfigButton>
        <ConfigButton variant="secondary" disabled={saving} onClick={() => setRefresh((value) => value + 1)}>{t("permissions.reload")}</ConfigButton>
        {saved && <span role="status">{t("permissions.saved")}</span>}
      </div>
    </>}
  </div>;
}
