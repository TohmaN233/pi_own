"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  activateModePack,
  deleteModePack,
  getModePackLibrary,
  getModePackStatus,
  importModePackArchive,
  importModePackBundle,
  modePackDefinitionToDraft,
  PortableModePackImportError,
  sendPortableImportPrompt,
  saveModePack,
  type ModePackLibraryItem,
  type ModePackStatusResponse,
} from "@/lib/mode-pack-client";
import { RESEARCH_MODE_ID, STUDY_MODE_ID } from "@/lib/study-mode-phase";
import styles from "./page.module.css";

const BLANK_DRAFT = {
  version: 1,
  modePackId: "custom.my-mode",
  revision: 1,
  title: "My Mode",
  description: "A user-defined Pi Mode Pack.",
  category: "general",
  role: "general",
  runtimeMode: "general",
  provider: null,
  model: null,
  thinkingLevel: "high",
  externalKnowledgePolicy: "allow",
  courseRequired: false,
  tools: ["find", "grep", "ls", "read"],
  components: [],
  systemPrompt: "Follow the user's task with the resources and workflow selected by this Mode Pack.",
  instructions: [],
};

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function ModePacksPage() {
  const searchParams = useSearchParams();
  const initialSessionId = searchParams.get("sessionId") ?? "";
  const initialEditModePackId = searchParams.get("editModePackId") ?? "";
  return <ModePacksEditor key={`${initialSessionId}:${initialEditModePackId}`} initialSessionId={initialSessionId} initialEditModePackId={initialEditModePackId} />;
}

function ModePacksEditor({ initialSessionId, initialEditModePackId }: { initialSessionId: string; initialEditModePackId: string }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [status, setStatus] = useState<ModePackStatusResponse | null>(null);
  const [packs, setPacks] = useState<ModePackLibraryItem[]>([]);
  const [resources, setResources] = useState<Array<Record<string, unknown>>>([]);
  const [packageResources, setPackageResources] = useState<Array<{ kind: "skill" | "extension"; id: string; title: string; packageContentHash: string; packageTitle: string; contentHash: string; delivery: string }>>([]);
  const [resourceSources, setResourceSources] = useState<Array<{ kind: "skill" | "extension"; id: string; packageContentHash: string }>>([]);
  const [sourceModePackId, setSourceModePackId] = useState<string | undefined>();
  const [editor, setEditor] = useState(pretty(BLANK_DRAFT));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAgentPrompt, setPendingAgentPrompt] = useState<string | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);
  const initialEditApplied = useRef(false);
  const loadedForSession = status?.sessionId === sessionId.trim();

  useEffect(() => {
    if (!initialEditModePackId || initialEditApplied.current || !loadedForSession) return;
    const item = packs.find((candidate) => candidate.definition.modePackId === initialEditModePackId);
    if (!item) return;
    initialEditApplied.current = true;
    if (item.definition.role !== "general" || item.definition.runtimeMode !== "general" || item.definition.courseRequired !== false) {
      setNotice(`模式 ${initialEditModePackId} 不支持通用模式包编辑。`);
      return;
    }
    setEditor(pretty({ ...item.draft, revision: Number(item.definition.revision) + 1 }));
    setResourceSources([]);
    setSourceModePackId(initialEditModePackId);
  }, [initialEditModePackId, loadedForSession, packs]);

  const refresh = useCallback(async (): Promise<boolean> => {
    refreshRequest.current?.abort();
    const request = new AbortController();
    refreshRequest.current = request;
    const requestedSessionId = sessionId.trim();
    if (!requestedSessionId) return false;
    try {
      const [nextStatus, library] = await Promise.all([
        getModePackStatus(requestedSessionId),
        getModePackLibrary(requestedSessionId),
      ]);
      if (request.signal.aborted) return false;
      if (nextStatus.sessionId !== requestedSessionId) throw new Error("Mode Pack status belongs to another session.");
      if (nextStatus.kind !== "generic") {
        throw new Error("The full Mode Pack editor is for ordinary Pi sessions; course-bound learner packs stay in the Learning Harness panel.");
      }
      setStatus(nextStatus);
      setPacks(library.packs);
      setResources(library.resources);
      setPackageResources(library.packageResources);
      setNotice(null);
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      setStatus(null);
      setPacks([]);
      setResources([]);
      setPackageResources([]);
      setNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    return () => { refreshRequest.current?.abort(); };
  }, [refresh]);

  useEffect(() => () => { mutationRequest.current?.abort(); }, []);

  const parsedEditor = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(editor);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }, [editor]);

  const editComponent = (id: string, type: string, action: "enable" | "disable" | "unlink") => {
    if (!parsedEditor || !Array.isArray(parsedEditor.components)) return;
    const components = (parsedEditor.components as Array<Record<string, unknown>>)
      .filter((component) => !(action === "unlink" && component.id === id && component.type === type))
      .map((component) => component.id === id && component.type === type
        ? { ...component, enabled: action === "enable", required: action === "enable" ? component.required : false }
        : component);
    setEditor(pretty({ ...parsedEditor, components }));
    if (action === "unlink") setResourceSources((sources) => sources.filter((source) => !(source.id === id && (source.kind === "extension" ? "plugin" : source.kind) === type)));
  };

  const addPackagedResource = (resource: (typeof packageResources)[number]) => {
    if (!parsedEditor || !Array.isArray(parsedEditor.components)) return;
    const type = resource.kind === "extension" ? "plugin" : "skill";
    if ((parsedEditor.components as Array<Record<string, unknown>>).some((component) => component.id === resource.id && component.type === type)) return;
    setEditor(pretty({ ...parsedEditor, components: [...parsedEditor.components, {
      type, id: resource.id, required: false, enabled: true,
      ...(resource.kind === "skill" ? { delivery: "native-skill" } : {}),
    }] }));
    setResourceSources((sources) => [...sources.filter((source) => !(source.kind === resource.kind && source.id === resource.id)), {
      kind: resource.kind, id: resource.id, packageContentHash: resource.packageContentHash,
    }]);
  };

  const beginMutation = (): AbortController | null => {
    if (busy || !loadedForSession || mutationRequest.current) return null;
    refreshRequest.current?.abort();
    const request = new AbortController();
    mutationRequest.current = request;
    setBusy(true);
    setNotice(null);
    return request;
  };

  const finishMutation = (request: AbortController) => {
    if (!request.signal.aborted) setBusy(false);
    if (mutationRequest.current === request) mutationRequest.current = null;
  };

  const save = async (activateAfterSave = false) => {
    if (!parsedEditor || !sessionId.trim() || !loadedForSession) {
      setNotice("Load the session first; the editor must contain a valid JSON object.");
      return;
    }
    const revision = Number(parsedEditor.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      setNotice("draft.revision must be a positive integer.");
      return;
    }
    const request = beginMutation();
    if (!request) return;
    try {
      const saved = await saveModePack({
        sessionId: sessionId.trim(),
        draft: parsedEditor,
        expectedRevision: revision - 1,
        ...(sourceModePackId ? { sourceModePackId } : {}),
        ...(resourceSources.length ? { resourceSources } : {}),
      });
      if (request.signal.aborted) return;
      setEditor(pretty({ ...saved.draft, revision: revision + 1 }));
      setResourceSources([]);
      setSourceModePackId(String(saved.definition.modePackId));
      if (activateAfterSave) {
        if (!status?.live || status.busy) throw new Error("修订已保存；当前会话不可切换，请稍后在模式列表中启用它。");
        try {
          await activateModePack({
            sessionId: status.sessionId,
            modePackId: String(saved.definition.modePackId),
            expectedSnapshotId: status.currentSnapshotId,
            idempotencyKey: crypto.randomUUID(),
          });
        } catch (error) {
          await refresh();
          setNotice(`修订已保存，但启用失败：${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      const refreshed = await refresh();
      if (!request.signal.aborted && refreshed) setNotice(activateAfterSave ? `已保存并启用修订 ${revision}。` : `已保存修订 ${revision}；点击“启用”后才会应用到当前会话。`);
    } catch (error) {
      if (!request.signal.aborted) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      finishMutation(request);
    }
  };

  const remove = async () => {
    if (!parsedEditor || typeof parsedEditor.modePackId !== "string" || !loadedForSession) return;
    const current = packs.find((item) => item.definition.modePackId === parsedEditor.modePackId);
    const revision = Number(current?.definition.revision ?? 0);
    if (!current || !parsedEditor.modePackId.startsWith("custom.") || !Number.isSafeInteger(revision)) {
      setNotice("Select a saved custom Mode Pack before deleting.");
      return;
    }
    const request = beginMutation();
    if (!request) return;
    try {
      const profileIds = current.moduleProfileIds?.length && current.moduleProfileIds.length > 1 ? current.moduleProfileIds : null;
      const expectedRevisions = profileIds ? Object.fromEntries(profileIds.map((id) => {
        const phase = packs.find((item) => item.definition.modePackId === id);
        if (!phase) throw new Error(`Portable module is missing phase ${id}`);
        return [id, Number(phase.definition.revision)];
      })) : null;
      await deleteModePack(expectedRevisions
        ? { modePackId: parsedEditor.modePackId, expectedRevisions }
        : { modePackId: parsedEditor.modePackId, expectedRevision: revision });
      if (request.signal.aborted) return;
      setEditor(pretty(BLANK_DRAFT));
      const refreshed = await refresh();
      if (!request.signal.aborted && refreshed) setNotice(`Deleted ${current.moduleId ?? parsedEditor.modePackId}.`);
    } catch (error) {
      if (!request.signal.aborted) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      finishMutation(request);
    }
  };

  const activate = async (modePackId: string) => {
    if (!status || status.sessionId !== sessionId.trim() || !status.live || status.busy) return;
    const request = beginMutation();
    if (!request) return;
    try {
      await activateModePack({
        sessionId: status.sessionId,
        modePackId,
        expectedSnapshotId: status.currentSnapshotId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (request.signal.aborted) return;
      const refreshed = await refresh();
      if (!request.signal.aborted && refreshed) setNotice(`Activated ${modePackId}.`);
    } catch (error) {
      if (!request.signal.aborted) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      finishMutation(request);
    }
  };

  const exportPackage = async (modePackId: string) => {
    if (!loadedForSession) return;
    const request = beginMutation(); if (!request) return;
    try {
      const response = await fetch(`/api/mode-packs/portable?sessionId=${encodeURIComponent(sessionId.trim())}&modePackId=${encodeURIComponent(modePackId)}&format=bundle`);
      if (!response.ok) { const failure = await response.json() as { error?: string }; throw new Error(failure.error ?? "Export failed"); }
      const filename = response.headers.get("content-disposition")?.match(/filename="([^"\\/]+)"/iu)?.[1] ?? `${modePackId}.mode-pack.tar`;
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(`Exported ${modePackId}.`);
    } catch (error) { if (!request.signal.aborted) setNotice(error instanceof Error ? error.message : String(error)); } finally { finishMutation(request); }
  };

  const importPackage = async (file: File) => {
    if (!loadedForSession) return;
    const sourceName = file.name.replace(/(?:\.mode-pack)?\.(?:tar|json)$/iu, "").replace(/^custom\./u, "");
    const suggestedId = `custom.${sourceName.replace(/[^a-z0-9.-]+/giu, "-").replace(/^-+|-+$/gu, "").toLocaleLowerCase("en-US") || "imported-mode"}`;
    const newModePackId = window.prompt("Imported module id", suggestedId)?.trim(); if (!newModePackId) return;
    const request = beginMutation(); if (!request) return;
    setPendingAgentPrompt(null);
    try {
      const body = file.name.endsWith(".json")
        ? await importModePackArchive({ sessionId: sessionId.trim(), archive: JSON.parse(await file.text()) as unknown, newModePackId })
        : await importModePackBundle({ sessionId: sessionId.trim(), file, newModePackId });
      setEditor(pretty({ ...modePackDefinitionToDraft(body.definition), revision: Number(body.definition.revision) + 1 })); await refresh(); setNotice(`Imported ${newModePackId}.`);
    } catch (error) {
      if (!request.signal.aborted) {
        setNotice(error instanceof PortableModePackImportError && error.details.agentDelivery === "accepted" ? `${error.message}\n诊断已发送给 Pi agent。` : error instanceof Error ? error.message : String(error));
        if (error instanceof PortableModePackImportError && error.details.agentDelivery !== "accepted") {
          setPendingAgentPrompt(error.details.agentPrompt ?? null);
        }
      }
    } finally { finishMutation(request); }
  };

  const sendConflictToPi = async () => {
    if (!pendingAgentPrompt || busy || !loadedForSession) return;
    const request = beginMutation(); if (!request) return;
    try {
      await sendPortableImportPrompt(sessionId.trim(), pendingAgentPrompt);
      if (!request.signal.aborted) {
        setPendingAgentPrompt(null);
        setNotice("导入预检诊断已发送给 Pi agent；工作模块仍未安装。");
      }
    } catch (error) {
      if (!request.signal.aborted) setNotice(`Pi agent 未收到诊断：${error instanceof Error ? error.message : String(error)}`);
    } finally { finishMutation(request); }
  };

  const changeSession = (value: string) => {
    if (mutationRequest.current) return;
    refreshRequest.current?.abort();
    setStatus(null);
    setPacks([]);
    setResources([]);
    setPackageResources([]);
    setResourceSources([]);
    setSourceModePackId(undefined);
    setNotice(null);
    setPendingAgentPrompt(null);
    setSessionId(value);
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Pi Own Mode Packs</h1>
          <p className={styles.meta}>Versioned prompts, Skills, plugins, tools and workflows with verified Pi runtime activation.</p>
        </div>
        <a href={sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/"}>Back to Pi Web</a>
      </header>

      <section className={styles.toolbar}>
        <input className={styles.input} value={sessionId} disabled={busy} onChange={(event) => changeSession(event.target.value)} placeholder="Pi session id" aria-label="Pi session id" />
        <button className={styles.button} type="button" disabled={busy || !sessionId.trim()} onClick={() => void refresh()}>Load</button>
        <input ref={importInput} type="file" accept=".tar,.json,application/json,application/vnd.pi-own.mode-pack+tar" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importPackage(file); }} />
        <button className={styles.button} type="button" disabled={busy || !loadedForSession} onClick={() => importInput.current?.click()}>导入工作模块</button>
        {status && loadedForSession && <span className={status.verified ? styles.active : styles.warning}>{status.currentModePackId ?? "No active Mode Pack"} · {status.verified ? "verified" : status.diagnostic ?? "unverified"}</span>}
      </section>

      {notice && <p className={styles.warning}>{notice}</p>}
      {pendingAgentPrompt && <button className={styles.button} type="button" disabled={busy || !loadedForSession} onClick={() => void sendConflictToPi()}>交给 Pi agent 处理</button>}

      <div className={styles.grid}>
        <section className={styles.panel}>
          <h2>Available Mode Packs</h2>
          {packs.filter((item, index) => ![STUDY_MODE_ID, RESEARCH_MODE_ID].includes(String(item.definition.modePackId))
            && (!item.moduleId || packs.findIndex((candidate) => candidate.moduleId === item.moduleId) === index)).map((item) => {
            const definition = item.definition;
            const id = String(definition.modePackId);
            const title = String(definition.title);
            const revision = Number(definition.revision);
            const phases = item.moduleProfileIds?.length && item.moduleProfileIds.length > 1
              ? item.moduleProfileIds.map((phaseId) => packs.find((candidate) => candidate.definition.modePackId === phaseId)).filter((phase): phase is ModePackLibraryItem => Boolean(phase))
              : [item];
            const exportable = !item.packageError && !item.packageMetadataError && phases.every((phase) => !phase.packageError);
            const editable = definition.role === "general" && definition.runtimeMode === "general" && definition.courseRequired === false;
            return (
              <article className={styles.card} key={item.moduleId ?? id}>
                <div className={styles.cardHeader}>
                  <strong>{item.moduleId && phases.length > 1 ? item.moduleId : title}</strong>
                  <span className={styles.meta}>{item.builtin ? "built-in" : `r${revision}`}{phases.length > 1 ? ` · ${phases.length} phases` : ""}</span>
                </div>
                <span>{item.moduleId ?? id}</span>
                <span className={styles.meta}>{String(definition.description)}</span>
                {phases.length > 1 && <span className={styles.meta}>{phases.map((phase) => String(phase.definition.title)).join(" · ")}</span>}
                {item.packageMetadataError && <span className={styles.warning}>{item.packageMetadataError}</span>}
                {!item.selectable && <span className={styles.warning}>{[...item.missingRequiredResources, ...item.identityMismatches, ...(item.packageError ? [item.packageError] : [])].join(", ")}</span>}
                <div className={styles.actions}>
                  {phases.map((phase) => (
                    <span key={String(phase.definition.modePackId)} className={styles.actions}>
                      <button className={styles.button} type="button" disabled={busy || !loadedForSession || !editable} onClick={() => { setEditor(pretty({ ...phase.draft, revision: Number(phase.definition.revision) + 1 })); setResourceSources([]); setSourceModePackId(String(phase.definition.modePackId)); }}>{phases.length > 1 ? `Edit ${String(phase.definition.title)}` : "编辑当前模式"}</button>
                      <button className={styles.button} type="button" disabled={busy || !loadedForSession || !phase.selectable || !status?.live || status.busy} onClick={() => void activate(String(phase.definition.modePackId))}>{phases.length > 1 ? `Activate ${String(phase.definition.title)}` : "Activate"}</button>
                    </span>
                  ))}
                  {exportable && <button className={styles.button} type="button" disabled={busy || !loadedForSession} onClick={() => void exportPackage(id)}>Export</button>}
                </div>
              </article>
            );
          })}
          {packs.some((item) => [STUDY_MODE_ID, RESEARCH_MODE_ID].includes(String(item.definition.modePackId))) && (
            <article className={styles.card}>
              <div className={styles.cardHeader}><strong>Study & Research / 学习与研究</strong><span className={styles.meta}>{packs.filter((item) => [STUDY_MODE_ID, RESEARCH_MODE_ID].includes(String(item.definition.modePackId))).every((item) => item.builtin) ? "built-in module" : "当前模块"}</span></div>
              <span className={styles.meta}>Study 和 Research 是同一模块的两个阶段。</span>
              <div className={styles.actions}>
                {packs.filter((item) => [STUDY_MODE_ID, RESEARCH_MODE_ID].includes(String(item.definition.modePackId))).map((item) => (
                  <span key={String(item.definition.modePackId)} className={styles.actions}>
                    <button className={styles.button} type="button" disabled={busy || !loadedForSession} onClick={() => { setEditor(pretty({ ...item.draft, revision: Number(item.definition.revision) + 1 })); setResourceSources([]); setSourceModePackId(String(item.definition.modePackId)); }}>编辑 {String(item.definition.modePackId) === STUDY_MODE_ID ? "Study" : "Research"}</button>
                    <button className={styles.button} type="button" disabled={busy || !loadedForSession || !item.selectable || !status?.live || status.busy} onClick={() => void activate(String(item.definition.modePackId))}>
                      Activate {String(item.definition.modePackId) === STUDY_MODE_ID ? "Study" : "Research"}
                    </button>
                  </span>
                ))}
                <button className={styles.button} type="button" disabled={busy || !loadedForSession} onClick={() => void exportPackage(STUDY_MODE_ID)}>Export</button>
              </div>
            </article>
          )}
          <h3>Discovered resources</h3>
          <pre className={styles.resources}>{pretty(resources)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.cardHeader}>
            <h2>Mode Pack JSON</h2>
            <button className={styles.button} type="button" disabled={busy} onClick={() => { setEditor(pretty(BLANK_DRAFT)); setResourceSources([]); setSourceModePackId(undefined); }}>New</button>
          </div>
          <textarea className={styles.textarea} value={editor} disabled={busy} onChange={(event) => setEditor(event.target.value)} spellCheck={false} aria-label="Custom Mode Pack JSON" />
          {parsedEditor && Array.isArray(parsedEditor.components) && (
            <div>
              <h3>包内默认资源</h3>
              {(parsedEditor.components as Array<Record<string, unknown>>)
                .filter((component) => component.type === "skill" || component.type === "plugin")
                .map((component) => {
                  const id = String(component.id);
                  const type = String(component.type);
                  return <div className={styles.actions} key={`${type}:${id}`}>
                    <span>{type === "skill" ? "Skill" : "插件"} · {id}</span>
                    <label><input type="checkbox" checked={component.enabled === true} disabled={busy} onChange={(event) => editComponent(id, type, event.target.checked ? "enable" : "disable")} /> 默认启用</label>
                    <button className={styles.button} type="button" disabled={busy} onClick={() => editComponent(id, type, "unlink")}>从此模式包移除</button>
                  </div>;
                })}
            </div>
          )}
          {parsedEditor && Array.isArray(parsedEditor.components) && (
            <div>
              <h3>已安装包的 Skill 与插件</h3>
              {packageResources.filter((resource) => !(parsedEditor.components as Array<Record<string, unknown>>)
                .some((component) => component.id === resource.id && component.type === (resource.kind === "extension" ? "plugin" : "skill")))
                .map((resource) => <div className={styles.actions} key={`${resource.packageContentHash}:${resource.kind}:${resource.id}`}>
                  <span>{resource.kind === "skill" ? resource.title : resource.title} · {resource.packageTitle}</span>
                  <button className={styles.button} type="button" disabled={busy} onClick={() => addPackagedResource(resource)}>加入并默认启用</button>
                </div>)}
            </div>
          )}
          <div className={styles.actions}>
            <button className={styles.button} type="button" disabled={busy || !parsedEditor || !loadedForSession} onClick={() => void save()}>保存修订</button>
            <button className={styles.button} type="button" disabled={busy || !parsedEditor || !loadedForSession || !status?.live || status.busy} onClick={() => void save(true)}>保存并启用</button>
            <button className={styles.button} type="button" disabled={busy || !parsedEditor || !loadedForSession || typeof parsedEditor.modePackId !== "string" || !parsedEditor.modePackId.startsWith("custom.")} onClick={() => void remove()}>删除自定义模式包</button>
          </div>
        </section>
      </div>
    </main>
  );
}
