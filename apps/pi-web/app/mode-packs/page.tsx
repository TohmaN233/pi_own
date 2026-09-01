"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  activateModePack,
  deleteModePack,
  getModePackLibrary,
  getModePackStatus,
  saveModePack,
  type ModePackLibraryItem,
  type ModePackStatusResponse,
} from "@/lib/mode-pack-client";
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

function forkDraft(item: ModePackLibraryItem): Record<string, unknown> {
  const draft = structuredClone(item.draft);
  const sourceId = String(draft.modePackId ?? "mode").replace(/^custom\./u, "");
  draft.modePackId = `custom.${sourceId}.copy`;
  draft.revision = 1;
  draft.title = `${String(draft.title ?? "Mode")} copy`;
  return draft;
}

export default function ModePacksPage() {
  const searchParams = useSearchParams();
  const initialSessionId = searchParams.get("sessionId") ?? "";
  return <ModePacksEditor key={initialSessionId} initialSessionId={initialSessionId} />;
}

function ModePacksEditor({ initialSessionId }: { initialSessionId: string }) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [status, setStatus] = useState<ModePackStatusResponse | null>(null);
  const [packs, setPacks] = useState<ModePackLibraryItem[]>([]);
  const [resources, setResources] = useState<Array<Record<string, unknown>>>([]);
  const [editor, setEditor] = useState(pretty(BLANK_DRAFT));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const loadedForSession = status?.sessionId === sessionId.trim();

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
      setNotice(null);
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      setStatus(null);
      setPacks([]);
      setResources([]);
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

  const save = async () => {
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
      });
      if (request.signal.aborted) return;
      setEditor(pretty({ ...saved.draft, revision: revision + 1 }));
      const refreshed = await refresh();
      if (!request.signal.aborted && refreshed) setNotice(`Saved immutable revision ${revision}.`);
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
    if (!current || current.builtin || !Number.isSafeInteger(revision)) {
      setNotice("Select a saved custom Mode Pack before deleting.");
      return;
    }
    const request = beginMutation();
    if (!request) return;
    try {
      await deleteModePack({ modePackId: parsedEditor.modePackId, expectedRevision: revision });
      if (request.signal.aborted) return;
      setEditor(pretty(BLANK_DRAFT));
      const refreshed = await refresh();
      if (!request.signal.aborted && refreshed) setNotice(`Deleted ${parsedEditor.modePackId}.`);
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

  const changeSession = (value: string) => {
    if (mutationRequest.current) return;
    refreshRequest.current?.abort();
    setStatus(null);
    setPacks([]);
    setResources([]);
    setNotice(null);
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
        {status && loadedForSession && <span className={status.verified ? styles.active : styles.warning}>{status.currentModePackId ?? "No active Mode Pack"} · {status.verified ? "verified" : status.diagnostic ?? "unverified"}</span>}
      </section>

      {notice && <p className={styles.warning}>{notice}</p>}

      <div className={styles.grid}>
        <section className={styles.panel}>
          <h2>Available Mode Packs</h2>
          {packs.map((item) => {
            const definition = item.definition;
            const id = String(definition.modePackId);
            const title = String(definition.title);
            const revision = Number(definition.revision);
            return (
              <article className={styles.card} key={id}>
                <div className={styles.cardHeader}>
                  <strong>{title}</strong>
                  <span className={styles.meta}>{item.builtin ? "built-in" : `custom r${revision}`}</span>
                </div>
                <span>{id}</span>
                <span className={styles.meta}>{String(definition.description)}</span>
                {!item.selectable && <span className={styles.warning}>{[...item.missingRequiredResources, ...item.identityMismatches].join(", ")}</span>}
                <div className={styles.actions}>
                  <button className={styles.button} type="button" disabled={busy || !loadedForSession} onClick={() => setEditor(pretty(item.builtin ? forkDraft(item) : { ...item.draft, revision: revision + 1 }))}>{item.builtin ? "Fork" : "Edit next revision"}</button>
                  <button className={styles.button} type="button" disabled={busy || !loadedForSession || !item.selectable || !status?.live || status.busy} onClick={() => void activate(id)}>Activate</button>
                </div>
              </article>
            );
          })}
          <h3>Discovered resources</h3>
          <pre className={styles.resources}>{pretty(resources)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.cardHeader}>
            <h2>Custom Mode Pack JSON</h2>
            <button className={styles.button} type="button" disabled={busy} onClick={() => setEditor(pretty(BLANK_DRAFT))}>New</button>
          </div>
          <textarea className={styles.textarea} value={editor} disabled={busy} onChange={(event) => setEditor(event.target.value)} spellCheck={false} aria-label="Custom Mode Pack JSON" />
          <div className={styles.actions}>
            <button className={styles.button} type="button" disabled={busy || !parsedEditor || !loadedForSession} onClick={() => void save()}>Save revision</button>
            <button className={styles.button} type="button" disabled={busy || !parsedEditor || !loadedForSession} onClick={() => void remove()}>Delete custom pack</button>
          </div>
        </section>
      </div>
    </main>
  );
}
