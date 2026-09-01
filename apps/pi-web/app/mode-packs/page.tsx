"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [status, setStatus] = useState<ModePackStatusResponse | null>(null);
  const [packs, setPacks] = useState<ModePackLibraryItem[]>([]);
  const [resources, setResources] = useState<Array<Record<string, unknown>>>([]);
  const [editor, setEditor] = useState(pretty(BLANK_DRAFT));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId.trim()) return;
    const [nextStatus, library] = await Promise.all([
      getModePackStatus(sessionId.trim()),
      getModePackLibrary(sessionId.trim()),
    ]);
    if (nextStatus.kind !== "generic") {
      throw new Error("The full Mode Pack editor is for ordinary Pi sessions; course-bound learner packs stay in the Learning Harness panel.");
    }
    setStatus(nextStatus);
    setPacks(library.packs);
    setResources(library.resources);
  }, [sessionId]);

  useEffect(() => {
    if (!initialSessionId) return;
    void refresh().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [initialSessionId, refresh]);

  const parsedEditor = useMemo(() => {
    try {
      return JSON.parse(editor) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [editor]);

  const save = async () => {
    if (!parsedEditor || !sessionId.trim()) {
      setNotice("The editor must contain valid JSON and a session id is required.");
      return;
    }
    const revision = Number(parsedEditor.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      setNotice("draft.revision must be a positive integer.");
      return;
    }
    setBusy(true);
    try {
      const saved = await saveModePack({
        sessionId: sessionId.trim(),
        draft: parsedEditor,
        expectedRevision: revision - 1,
      });
      setEditor(pretty({ ...saved.draft, revision: revision + 1 }));
      await refresh();
      setNotice(`Saved immutable revision ${revision}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!parsedEditor || typeof parsedEditor.modePackId !== "string") return;
    const current = packs.find((item) => item.definition.modePackId === parsedEditor.modePackId);
    const revision = Number(current?.definition.revision ?? 0);
    if (!current || current.builtin || !Number.isSafeInteger(revision)) {
      setNotice("Select a saved custom Mode Pack before deleting.");
      return;
    }
    setBusy(true);
    try {
      await deleteModePack({ modePackId: parsedEditor.modePackId, expectedRevision: revision });
      setEditor(pretty(BLANK_DRAFT));
      await refresh();
      setNotice(`Deleted ${parsedEditor.modePackId}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (modePackId: string) => {
    if (!status) return;
    setBusy(true);
    try {
      await activateModePack({
        sessionId: status.sessionId,
        modePackId,
        expectedSnapshotId: status.currentSnapshotId,
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
      setNotice(`Activated ${modePackId}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
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
        <input className={styles.input} value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Pi session id" aria-label="Pi session id" />
        <button className={styles.button} type="button" disabled={busy || !sessionId.trim()} onClick={() => void refresh().catch((error) => setNotice(error instanceof Error ? error.message : String(error)))}>Load</button>
        {status && <span className={status.verified ? styles.active : styles.warning}>{status.currentModePackId ?? "No active Mode Pack"} · {status.verified ? "verified" : status.diagnostic ?? "unverified"}</span>}
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
                  <button className={styles.button} type="button" onClick={() => setEditor(pretty(item.builtin ? forkDraft(item) : { ...item.draft, revision: revision + 1 }))}>{item.builtin ? "Fork" : "Edit next revision"}</button>
                  <button className={styles.button} type="button" disabled={busy || !item.selectable || !status?.live || status.busy} onClick={() => void activate(id)}>Activate</button>
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
            <button className={styles.button} type="button" onClick={() => setEditor(pretty(BLANK_DRAFT))}>New</button>
          </div>
          <textarea className={styles.textarea} value={editor} onChange={(event) => setEditor(event.target.value)} spellCheck={false} aria-label="Custom Mode Pack JSON" />
          <div className={styles.actions}>
            <button className={styles.button} type="button" disabled={busy || !parsedEditor || !sessionId.trim()} onClick={() => void save()}>Save revision</button>
            <button className={styles.button} type="button" disabled={busy || !parsedEditor} onClick={() => void remove()}>Delete custom pack</button>
          </div>
        </section>
      </div>
    </main>
  );
}
