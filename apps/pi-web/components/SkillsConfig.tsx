"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModeSettingsPanel } from "./mode-packs/ModeSettingsPanel";
import { orderSkillsByDormancy } from "@/lib/skill-display";
import { notifySessionConfiguration } from "@/lib/session-configuration-events";
import type {
  SkillInfo as Skill,
  SkillInstallScope,
  SkillSearchResult,
  SkillsResponse,
  SkillUpdateResult,
} from "@/lib/api-types";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

function shortenPath(p: string): string {
  // Match common home dir patterns: /Users/xxx, /home/xxx
  return p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function sourceLabel(skill: Skill): string {
  if (skill.sourceInfo?.source === "pi-own-local-skills") return "project";
  const src = skill.sourceInfo?.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user" || src === "user") return "global";
  if (scope === "project" || src === "project") return "project";
  return "path";
}

function updateKey(skill: Skill): string | null {
  return skill.install
    ? `${skill.install.scope}\0${skill.install.package}`
    : null;
}

function shortVersion(version?: string): string {
  return version ? version.slice(0, 8) : "unknown";
}

function SkillDetail({
  skill,
  cwd,
  onToggle,
  toggling,
  saveError,
  updateStatus,
  checkingUpdate,
  updating,
  updateError,
  onCheckUpdate,
  onUpdate,
}: {
  skill: Skill;
  cwd: string;
  onToggle: (skill: Skill) => void;
  toggling: boolean;
  saveError: string | null;
  updateStatus?: SkillUpdateResult;
  checkingUpdate: boolean;
  updating: boolean;
  updateError: string | null;
  onCheckUpdate: () => void;
  onUpdate: () => void;
}) {
  const { t } = useI18n();
  const label = sourceLabel(skill);
  const enabled = !skill.disableModelInvocation;

  function displayPath(p: string): string {
    if (label === "project" && p.startsWith(cwd)) {
      const rel = p.slice(cwd.length).replace(/^[/\\]/, "");
      return `./${rel}`;
    }
    return shortenPath(p);
  }

  return (
    <ConfigDetailStack>
      {/* Path + tag + toggle, with a stable status row below. */}
      <div className="skill-detail-heading">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <span className={`config-scope-tag${label === "project" ? " is-project" : ""}`}>
              {label}
            </span>
            <span className="config-detail-path">
              {displayPath(skill.filePath)}
            </span>
          </ConfigDetailHeaderInfo>
          <ConfigDetailActions>
            <ConfigSwitch
              checked={enabled}
              disabled={skill.sourceInfo?.source === "pi-own-local-skills"}
              loading={toggling}
              label={enabled ? t("i18n.visibleInPrompt") : t("i18n.hiddenFromPrompt")}
              onChange={() => onToggle(skill)}
            />
          </ConfigDetailActions>
        </ConfigDetailHeader>
        <div className="skill-detail-status-row">
          {skill.sourceInfo?.source === "pi-own-local-skills" && <span>项目技能库。打开会话后，在「当前模式组合」中选择启用；这里的安装状态不代表模型已加载。</span>}
          {!enabled && (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("i18n.hiddenButInvocable")}
            </span>
          )}
          {saveError && (
            <span style={{ fontSize: 12, color: "#f87171", overflowWrap: "anywhere" }}>
              {saveError}
            </span>
          )}
        </div>
      </div>

      {skill.install?.skillsShUrl && (
        <ConfigField label="Source">
          <a
            href={skill.install.skillsShUrl}
            target="_blank"
            rel="noreferrer"
            title={skill.install.skillsShUrl}
            className="skill-source-link"
          >
            <span className="skill-source-link-text">
              {skill.install.skillsShUrl.replace(/^https?:\/\//, "")} ↗
            </span>
          </a>
        </ConfigField>
      )}

      {skill.install && (
        <ConfigField label="Version">
          <div className="skill-version-row">
            <span className="skill-version-value">
              {shortVersion(updateStatus?.currentVersion ?? skill.install.versionHash)}
            </span>
            {skill.install.canCheckForUpdates && (
              <ConfigButton
                size="small"
                onClick={onCheckUpdate}
                disabled={checkingUpdate || updating}
              >
                 {t("i18n.check")}
              </ConfigButton>
            )}
            {updateStatus?.state === "update-available" && (
              <span className="skill-version-value is-update">
                {shortVersion(updateStatus.latestVersion)}
              </span>
            )}
            {(checkingUpdate ||
              (updateStatus && updateStatus.state !== "update-available")) && (
              <span
                className={`skill-update-status ${checkingUpdate
                  ? "is-checking"
                  : updateStatus?.state === "up-to-date"
                    ? "is-success"
                    : updateStatus?.state === "error"
                      ? "is-error"
                      : "is-muted"}`}
              >
                {checkingUpdate
                   ? t("i18n.checking")
                  : updateStatus?.state === "up-to-date"
                     ? t("i18n.upToDate")
                    : updateStatus?.state === "unsupported"
                         ? t("i18n.automaticChecksUnavailable")
                         : updateStatus?.message || t("i18n.checkFailed")}
              </span>
            )}
            {updateStatus?.state === "update-available" && (
              <ConfigButton
                variant="primary"
                size="small"
                onClick={onUpdate}
                disabled={updating || checkingUpdate}
              >
                 {updating ? t("i18n.updating") : t("i18n.update")}
              </ConfigButton>
            )}
          </div>
          {updateError && (
            <span style={{ fontSize: 12, color: "#ef4444" }}>{updateError}</span>
          )}
        </ConfigField>
      )}

      <ConfigField label="Name">
        <span className="skill-name-value">
          {skill.name}
        </span>
      </ConfigField>

      <ConfigField label="Description">
        <span className="skill-description">
          {skill.description}
        </span>
      </ConfigField>
    </ConfigDetailStack>
  );
}

function AddSkillPanel({
  cwd,
  installedPackages,
  installDirectory,
  onInstalled,
}: {
  cwd: string;
  installedPackages: Record<SkillInstallScope, ReadonlySet<string>>;
  installDirectory: string;
  onInstalled: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  const [newlyInstalledPkgs, setNewlyInstalledPkgs] = useState<Set<string>>(
    new Set(),
  );
  const scope = "project" as const;
  const [source, setSource] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const res = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.trim() }),
      });
      const d = (await res.json()) as {
        results?: SkillSearchResult[];
        error?: string;
      };
      if (d.error) {
        setSearchError(d.error);
        return;
      }
      setResults(d.results ?? []);
      if ((d.results ?? []).length === 0) setSearchError("No skills found");
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }, []);

  const install = useCallback(
    async (pkg: string) => {
      setInstalling(pkg);
      setInstallError(null);
      setInstallNotice(null);
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ package: pkg, scope, cwd }),
        });
        const d = (await res.json()) as { success?: boolean; directory?: string; skills?: string[]; error?: string };
        if (!res.ok || d.error || !d.success) {
          setInstallError(d.error ?? `HTTP ${res.status}`);
          return;
        }
        setNewlyInstalledPkgs((prev) =>
          new Set(prev).add(`${scope}:${pkg}`),
        );
        setInstallNotice(`已安装：${d.skills?.join("、") || pkg}。保存于 ${d.directory || installDirectory}；可在「当前模式组合」中启用。`);
        onInstalled();
      } catch (e) {
        setInstallError(String(e));
      } finally {
        setInstalling(null);
      }
    },
    [onInstalled, scope, cwd, installDirectory],
  );

  return (
    <ConfigDetailStack className="is-full-height">
      {/* ── Header area ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <ConfigDetailTitle>{t("i18n.addSkill")}</ConfigDetailTitle>

        {/* Search row */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            aria-label="搜索技能市场"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search(query);
            }}
             placeholder={t("i18n.skillSearchPlaceholder")}
            style={{
              flex: 1,
              padding: "7px 10px",
              fontSize: 12,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />
          <ConfigButton
            variant="primary"
            onClick={() => search(query)}
            disabled={searching || !query.trim()}
          >
             {searching ? t("i18n.searching") : t("i18n.search")}
          </ConfigButton>
        </div>

        <p style={{ fontSize: 12, overflowWrap: "anywhere", color: "var(--text-muted)" }}>安装目录：<code>{installDirectory || "正在读取项目技能目录…"}</code></p>
        <label style={{ fontSize: 12 }}>仓库地址或技能标识
          <input aria-label="仓库地址或技能标识" value={source} onChange={(event) => setSource(event.target.value)} placeholder="owner/repo@skill 或仓库 URL" style={{ display: "block", width: "100%", marginTop: 6, padding: 8, background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6 }}/>
        </label>
        <ConfigButton onClick={() => void install(source.trim())} disabled={!source.trim() || !installDirectory || installing !== null}>从地址添加</ConfigButton>
        {/* Errors */}
        {installNotice && <div role="status" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{installNotice}</div>}
        {searchError && (
          <div style={{ fontSize: 12, color: "#f87171" }}>{searchError}</div>
        )}
        {installError && (
          <div
            style={{ fontSize: 12, color: "#f87171", wordBreak: "break-word" }}
          >
            {installError}
          </div>
        )}
      </div>

      {/* ── Results list ── */}
      {results.length > 0 ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {results.map((r) => {
            const isInstalled =
              installedPackages[scope].has(r.package) ||
              newlyInstalledPkgs.has(`${scope}:${r.package}`);
            const isInstalling = installing === r.package;
            // split "owner/repo@skill" for cleaner display
            const atIdx = r.package.indexOf("@");
            const repopart = atIdx > -1 ? r.package.slice(0, atIdx) : r.package;
            const skillpart = atIdx > -1 ? r.package.slice(atIdx + 1) : null;
            return (
              <div
                key={r.package}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "12px 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* skill name prominent */}
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text)",
                      marginBottom: 3,
                    }}
                  >
                    {skillpart ?? repopart}
                  </div>
                  {/* repo + installs + link row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-dim)",
                      }}
                    >
                      {repopart}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        fontWeight: 500,
                      }}
                    >
                      {r.installs}
                    </span>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          fontSize: 12,
                          color: "var(--accent)",
                          textDecoration: "none",
                        }}
                      >
                        skills.sh ↗
                      </a>
                    )}
                  </div>
                </div>
                <ConfigButton
                  size="small"
                  onClick={() =>
                    !isInstalled && !isInstalling && install(r.package)
                  }
                  disabled={isInstalled || isInstalling || installing !== null || !installDirectory}
                  style={{
                    flexShrink: 0,
                    background: isInstalled ? "rgba(34,197,94,0.1)" : "none",
                    color: isInstalled
                      ? "#16a34a"
                      : isInstalling
                        ? "var(--accent)"
                        : "var(--text-muted)",
                  }}
                >
                  {isInstalled
                     ? `✓ ${t("i18n.installed")}`
                    : isInstalling
                       ? t("i18n.installing")
                       : t("i18n.install")}
                </ConfigButton>
              </div>
            );
          })}
        </div>
      ) : (
        !searchError &&
        !searching && (
          <div
            style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}
          >
            Search{" "}
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
            >
              skills.sh
            </a>{" "}
            to discover and install skills for your agent.
          </div>
        )
      )}
    </ConfigDetailStack>
  );
}

export function SkillsConfig({
  sessionId,
  section = "skills",
  ...props
}: { sessionId?: string | null; cwd: string; onClose: () => void; embedded?: boolean; section?: "skills" | "all" }) {
  const [tab, setTab] = useState<"mode" | "library">("mode");
  if (!sessionId) return <SkillLibraryConfig {...props}/>;
  return <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
    <div role="tablist" aria-label="技能管理" style={{ display: "flex", gap: 8, padding: 12, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      {(["mode", "library"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} style={{ padding: "7px 10px", border: "1px solid var(--border)", borderRadius: 6, background: tab === value ? "var(--bg-selected)" : "var(--bg-panel)", color: "var(--text)", cursor: "pointer" }}>{value === "mode" ? "当前模式组合" : "技能库 · 添加与市场"}</button>)}
    </div>
    <div style={{ display: tab === "mode" ? "block" : "none", flex: 1, minHeight: 0, overflow: "hidden" }}><ModeSettingsPanel key={sessionId} sessionId={sessionId} section={section}/></div>
    {tab === "library" && <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}><SkillLibraryConfig {...props} onInstalled={() => notifySessionConfiguration(sessionId)}/></div>}
  </div>;
}

function SkillLibraryConfig({
  cwd,
  onClose,
  embedded = false,
  onInstalled,
}: {
  cwd: string;
  onClose: () => void;
  embedded?: boolean;
  onInstalled?: () => void;
}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => getLastSettingsSelection("skills", cwd));
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, SkillUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [projectResourcesLoaded, setProjectResourcesLoaded] = useState(true);
  const [installDirectory, setInstallDirectory] = useState("");

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      const d = (await res.json()) as Partial<SkillsResponse> & { error?: string };
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      const list = d.skills ?? [];
      setSkills(list);
      setProjectResourcesLoaded(d.projectResourcesLoaded ?? true);
      setInstallDirectory(d.installDirectory ?? "");
      setSelected((current) => {
        if (current && list.some((skill) => skill.filePath === current)) return current;
        const initialSkill = list.find((skill) => !skill.disableModelInvocation) ?? list[0];
        return initialSkill?.filePath ?? null;
      });
      return list;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setUpdateStatuses({});
    setUpdateError(null);
    void loadSkills();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected) setLastSettingsSelection("skills", selected, cwd);
  }, [cwd, selected]);

  const checkForUpdates = useCallback(async (skill?: Skill) => {
    const targets = skill
      ? [skill]
      : skills.filter((item) => Boolean(item.install));
    const keys = targets
      .map(updateKey)
      .filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!skill) setCheckingAll(true);
    try {
      const res = await fetch("/api/skills/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill?.install?.package,
          scope: skill?.install?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: SkillUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[`${update.scope}\0${update.package}`] = update;
        }
        return next;
      });
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!skill) setCheckingAll(false);
    }
  }, [cwd, skills]);

  const updateInstalledSkill = useCallback(async (skill: Skill) => {
    if (!skill.install) return;
    const key = updateKey(skill)!;
    setUpdatingSkill(key);
    setUpdateError(null);
    try {
      const res = await fetch("/api/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          package: skill.install.package,
          scope: skill.install.scope,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        skill?: Skill;
        error?: string;
      };
      if (!res.ok || data.error || !data.success) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadSkills();
      onInstalled?.();
      const versionHash = data.skill?.install?.versionHash;
      setUpdateStatuses((current) => ({
        ...current,
        [key]: {
          package: skill.install!.package,
          scope: skill.install!.scope,
          state: "up-to-date",
          currentVersion: versionHash,
          latestVersion: versionHash,
        },
      }));
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdatingSkill(null);
    }
  }, [cwd, loadSkills, onInstalled]);

  const toggle = useCallback(async (skill: Skill) => {
    const next = !skill.disableModelInvocation;
    setToggling((s) => new Set(s).add(skill.filePath));
    setSaveError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: skill.filePath,
          disableModelInvocation: next,
        }),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setSaveError(d.error ?? `HTTP ${res.status}`);
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.filePath === skill.filePath
            ? { ...s, disableModelInvocation: next }
            : s,
        ),
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(skill.filePath);
        return n;
      });
    }
  }, []);

  const selectedSkill = skills.find((s) => s.filePath === selected) ?? null;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.skills")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={onClose}>

        {!projectResourcesLoaded && (
          <div role="status" className="config-trust-notice">
            {t("trust.skillsNotLoaded")}
          </div>
        )}

        {/* Body */}
        <ConfigSplitView>
          {/* Left: skill list */}
          <ConfigSidebar>
            <ConfigSidebarList>
              {loading ? (
                <div className="config-sidebar-message">
                   {t("i18n.loading")}
                </div>
              ) : error ? (
                <div className="config-sidebar-message is-error">
                  {error}
                </div>
              ) : skills.length === 0 ? (
                <div className="config-sidebar-message is-empty">
                   {t("i18n.noSkills")}
                </div>
              ) : (
                (() => {
                  const groups: { label: string; skills: typeof skills }[] = [];
                  const scopeLabels = {
                    project: t("skills.scope.project"),
                    global: t("skills.scope.global"),
                    path: t("skills.scope.path"),
                  };
                  const groupDefinitions = [
                    {
                      label: `${scopeLabels.project} / skills.sh`,
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "project" &&
                        Boolean(skill.install?.skillsShUrl),
                    },
                    {
                      label: scopeLabels.project,
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "project" &&
                        !skill.install?.skillsShUrl,
                    },
                    {
                      label: `${scopeLabels.global} / skills.sh`,
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "global" &&
                        Boolean(skill.install?.skillsShUrl),
                    },
                    {
                      label: scopeLabels.global,
                      matches: (skill: Skill) =>
                        sourceLabel(skill) === "global" &&
                        !skill.install?.skillsShUrl,
                    },
                    {
                      label: scopeLabels.path,
                      matches: (skill: Skill) => sourceLabel(skill) === "path",
                    },
                  ];
                  for (const { label, matches } of groupDefinitions) {
                    const grpSkills = skills.filter(matches);
                    if (grpSkills.length > 0)
                      groups.push({ label, skills: grpSkills });
                  }
                  const renderSkillRow = (skill: Skill) => {
                    const isSelected =
                      !addMode && selected === skill.filePath;
                    const disabled = skill.disableModelInvocation;
                    return (
                      <ConfigSidebarItem
                        key={skill.filePath}
                        active={isSelected}
                        onClick={() => {
                          setSelected(skill.filePath);
                          setAddMode(false);
                        }}
                      >
                        <ConfigStatusDot active={!disabled} />
                        <ConfigSidebarText className={`is-grow${disabled ? " is-muted" : ""}`}>
                          {skill.name}
                        </ConfigSidebarText>
                        {(() => {
                          const key = updateKey(skill);
                          const status = key ? updateStatuses[key] : undefined;
                          if (status?.state !== "update-available") return null;
                          return (
                            <span title={t("i18n.updateAvailable")} className="skill-update-indicator">
                              ↑
                            </span>
                          );
                        })()}
                      </ConfigSidebarItem>
                    );
                  };
                  return groups.map(
                    ({ label: grpLabel, skills: grpSkills }) => {
                      return (
                        <div key={grpLabel} className="config-sidebar-group">
                          <ConfigSidebarGroupLabel>
                            {grpLabel}
                          </ConfigSidebarGroupLabel>
                          {orderSkillsByDormancy(grpSkills).map(renderSkillRow)}
                        </div>
                      );
                    },
                  );
                })()
              )}
            </ConfigSidebarList>
            {/* Add skill button */}
            <ConfigListAction
                onClick={() => setAddMode(true)}
                active={addMode}
              >
                 {t("i18n.addSkill")}
            </ConfigListAction>
          </ConfigSidebar>

          {/* Right: detail or add panel */}
          <ConfigDetail>
            <ConfigDetailStack className="is-fill">
              {addMode ? (
              <AddSkillPanel
                cwd={cwd}
                installDirectory={installDirectory}
                installedPackages={{
                  global: new Set(
                    skills
                      .filter((skill) => skill.install?.scope === "global")
                      .map((skill) => skill.install!.package),
                  ),
                  project: new Set(
                    skills
                      .filter((skill) => skill.install?.scope === "project" && skill.install.directory === installDirectory)
                      .map((skill) => skill.install!.package),
                  ),
                }}
                onInstalled={() => {
                  void loadSkills();
                  onInstalled?.();
                }}
              />
            ) : loading ? null : selectedSkill ? (
              <SkillDetail
                key={selectedSkill.filePath}
                skill={selectedSkill}
                cwd={cwd}
                onToggle={toggle}
                toggling={toggling.has(selectedSkill.filePath)}
                saveError={saveError}
                updateStatus={
                  updateKey(selectedSkill)
                    ? updateStatuses[updateKey(selectedSkill)!]
                    : undefined
                }
                checkingUpdate={
                  updateKey(selectedSkill)
                    ? checkingUpdates.has(updateKey(selectedSkill)!)
                    : false
                }
                updating={updatingSkill === updateKey(selectedSkill)}
                updateError={updateError}
                onCheckUpdate={() => void checkForUpdates(selectedSkill)}
                onUpdate={() => void updateInstalledSkill(selectedSkill)}
              />
              ) : (
                <ConfigEmptyState>{t("i18n.selectSkill")}</ConfigEmptyState>
              )}
            </ConfigDetailStack>
          </ConfigDetail>
        </ConfigSplitView>

        {/* Footer */}
        <ConfigFooter status={
            Object.values(updateStatuses).filter(
              (status) => status.state === "update-available",
            ).length > 0 && (
              <span style={{ fontSize: 12, color: "#d97706" }}>
                {
                  Object.values(updateStatuses).filter(
                    (status) => status.state === "update-available",
                  ).length
                }{" "}
                {Object.values(updateStatuses).filter(
                  (status) => status.state === "update-available",
                ).length === 1
                   ? t("i18n.update")
                   : t("i18n.updates")}
              </span>
            )}
        >
          {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
          {skills.some((skill) => Boolean(skill.install)) && (
            <ConfigButton variant="secondary" onClick={() => void checkForUpdates()} disabled={checkingAll || updatingSkill !== null}>
              {checkingAll ? t("i18n.checking") : t("i18n.checkUpdates")}
            </ConfigButton>
          )}
        </ConfigFooter>
    </ConfigPanelShell>
  );
}
