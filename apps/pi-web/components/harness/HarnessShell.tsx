"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  getHarnessStatus,
  getHarnessTimeline,
  importHarnessCourse,
  readHarnessSpan,
  searchHarnessCourse,
  selectHarnessCourse,
	switchHarnessProfile,
  type HarnessSpan,
  type HarnessStatus,
  type HarnessTimelineEvent,
} from "@/lib/harness-client";
import styles from "./HarnessShell.module.css";
import { PracticePanel } from "./PracticePanel";

export function HarnessShell({ children }: { children: ReactNode }) {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session") ?? undefined;
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [panel, setPanel] = useState<"import" | "sources" | "timeline" | "practice" | "snapshot" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [spans, setSpans] = useState<HarnessSpan[]>([]);
  const [source, setSource] = useState<HarnessSpan | null>(null);
  const [timeline, setTimeline] = useState<HarnessTimelineEvent[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
	const profileOperationKeys = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    try {
      setStatus(await getHarnessStatus(sessionId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectCourse = async (courseVersionId: string) => {
    try {
      await selectHarnessCourse(courseVersionId);
      await refresh();
      if (status?.session && status.session.courseVersionId !== courseVersionId) {
        setNotice("Course selection applies to the next new session; this session keeps its original course binding.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const importCourse = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const courseId = String(form.get("courseId") ?? "").trim();
    const files = Array.from(fileInput.current?.files ?? []);
    if (!courseId || files.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const imported = await importHarnessCourse(courseId, files);
      await selectHarnessCourse(imported.courseVersionId);
      await refresh();
      setPanel(null);
      setNotice(`Imported ${imported.materialCount} materials and ${imported.spanCount} source spans.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const searchSources = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionId || !query.trim()) return;
    setBusy(true);
    setSource(null);
    try {
      const result = await searchHarnessCourse(sessionId, query.trim());
      setSpans(result.spans);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const openSource = async (spanId: string) => {
    if (!sessionId) return;
    try {
      setSource(await readHarnessSpan(sessionId, spanId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const openTimelineSource = async (spanId: string) => {
    if (!sessionId) return;
    try {
      setSource(await readHarnessSpan(sessionId, spanId));
      setPanel("sources");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const openTimeline = async () => {
    if (!sessionId) return;
    try {
      const result = await getHarnessTimeline(sessionId);
      setTimeline(result.events);
      setPanel(panel === "timeline" ? null : "timeline");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

	const switchProfile = async (targetProfileId: string) => {
		if (!sessionId || !status?.session) return;
		const current = status.session;
		if (targetProfileId === current.profileId) return;
		const operation = `${current.resourceSnapshotId}\u0000${targetProfileId}`;
		const idempotencyKey = profileOperationKeys.current.get(operation) ?? crypto.randomUUID();
		profileOperationKeys.current.set(operation, idempotencyKey);
		setBusy(true);
		setNotice(null);
		try {
			await switchHarnessProfile(sessionId, targetProfileId, current.resourceSnapshotId, idempotencyKey);
			profileOperationKeys.current.delete(operation);
			await refresh();
		} catch (error) {
			setNotice(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

  const selected = status?.activeCourseVersionId ?? "";

  return (
    <div className={styles.frame}>
      <header className={styles.bar}>
        <span className={styles.brand}>Learning Harness</span>
        <select
          className={styles.select}
          aria-label="Course for new sessions"
          value={selected}
          onChange={(event) => void selectCourse(event.target.value)}
          disabled={!status || status.courses.length === 0}
        >
          <option value="">{status?.courses.length ? "Choose course" : "Import a course"}</option>
          {status?.courses.map((course) => (
            <option key={course.courseVersionId} value={course.courseVersionId}>
              {course.courseId} · v{course.revision} · {course.materialCount} files
            </option>
          ))}
        </select>
		<select
			className={styles.select}
			aria-label="Learning profile"
			aria-busy={busy || Boolean(status?.session?.pendingTransition)}
			value={status?.session?.profileId ?? ""}
			onChange={(event) => void switchProfile(event.target.value)}
			disabled={!status?.session || !status.session.runtime.verified || busy || Boolean(status?.session?.pendingTransition)}
		>
			<option value="">No bound learner profile</option>
			{status?.availableProfiles.map((profile) => (
				<option key={profile.profileId} value={profile.profileId} disabled={!profile.selectable} title={profile.disabledReason ?? undefined}>
					{profile.profileId}{profile.selectable ? "" : ` — ${profile.disabledReason}`}
				</option>
			))}
		</select>
        <span className={styles.snapshot} title={status?.session?.resourceSnapshotId}>
          {status?.session ? `snapshot ${status.session.resourceSnapshotId}` : "new sessions use the selected course"}
        </span>
        <span className={styles.spacer} />
        <button className={styles.button} type="button" onClick={() => setPanel(panel === "import" ? null : "import")} aria-expanded={panel === "import"}>
          Import
        </button>
		<button className={styles.button} type="button" onClick={() => setPanel(panel === "snapshot" ? null : "snapshot")} aria-expanded={panel === "snapshot"} disabled={!status?.session}>
			Snapshot
		</button>
        <button className={styles.button} type="button" onClick={() => setPanel(panel === "sources" ? null : "sources")} aria-expanded={panel === "sources"} disabled={!status?.session}>
          Sources
        </button>
        <button className={styles.button} type="button" onClick={() => setPanel(panel === "practice" ? null : "practice")} aria-expanded={panel === "practice"} disabled={!status?.session}>
          Practice
        </button>
        <button className={styles.button} type="button" onClick={() => void openTimeline()} aria-expanded={panel === "timeline"} disabled={!status?.session}>
          Timeline
        </button>
      </header>
      <main className={styles.content}>{children}</main>

      {notice && (
        <button type="button" className={styles.notice} onClick={() => setNotice(null)}>
          {notice}
        </button>
      )}

      {panel === "import" && (
        <section className={styles.panel} aria-label="Import course">
          <h2 className={styles.panelTitle}>Import course materials</h2>
          <form className={styles.form} onSubmit={importCourse}>
            <label>
              Course ID
              <input className={styles.input} name="courseId" required placeholder="s4ci3-f2022" />
            </label>
            <label>
              ZIP, PDF, Markdown, text, notebook, or code
              <input ref={fileInput} name="files" type="file" required multiple accept=".zip,.pdf,.md,.mdx,.txt,.ipynb,.c,.cc,.cpp,.cs,.go,.java,.js,.jsx,.py,.r,.rs,.ts,.tsx" />
            </label>
            <button className={styles.button} type="submit" disabled={busy}>{busy ? "Importing…" : "Create immutable version"}</button>
          </form>
        </section>
      )}

      {panel === "sources" && status?.session && sessionId && (
        <section className={styles.panel} aria-label="Course sources">
          <h2 className={styles.panelTitle}>Current-course sources</h2>
          <form className={styles.form} onSubmit={searchSources}>
            <input className={styles.input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this course" aria-label="Search this course" />
            <button className={styles.button} type="submit" disabled={busy || !query.trim()}>Search</button>
          </form>
          <div className={styles.results}>
            {spans.map((span) => (
              <button className={styles.result} type="button" key={span.spanId} onClick={() => void openSource(span.spanId)}>
                <span>{span.headingPath.at(-1) || span.text.slice(0, 90)}</span>
                <span className={styles.resultMeta}>lines {span.startLine}–{span.endLine} · {span.spanId}</span>
              </button>
            ))}
          </div>
          {source && <pre className={styles.sourceText}>{source.text}</pre>}
        </section>
      )}

      {panel === "practice" && status?.session && sessionId && <PracticePanel key={sessionId} sessionId={sessionId} onError={setNotice} />}

		{panel === "snapshot" && status?.session && (
			<section className={styles.panel} aria-label="Snapshot inspector">
				<h2 className={styles.panelTitle}>Snapshot inspector</h2>
				<div className={styles.inspector}>
					<dl>
						<dt>Profile</dt><dd>{status.session.snapshot.profileId} · {status.session.snapshot.mode}</dd>
						<dt>Binding revision</dt><dd>{status.session.bindingRevision}</dd>
						<dt>Snapshot</dt><dd>{status.session.snapshot.resourceSnapshotId}</dd>
						<dt>Course</dt><dd>{status.session.snapshot.courseVersionId}</dd>
						<dt>Runtime</dt><dd>{status.session.runtime.verified ? "verified" : status.session.runtime.diagnostic ?? "recovery required"}</dd>
						<dt>Active tools</dt><dd>{status.session.runtime.activeTools.join(", ") || "none"}</dd>
						<dt>Resources</dt><dd>{status.session.snapshot.resources.map((resource) => `${resource.kind}:${resource.id}@${resource.version}`).join(", ") || "none"}</dd>
					</dl>
					{status.session.pendingTransition && <p className={styles.empty}>Recovery required: a profile transition is pending for {status.session.pendingTransition.targetProfileId}.</p>}
					{!status.session.runtime.verified && <p className={styles.empty}>Profile switching stays disabled until this runtime is verified.</p>}
				</div>
			</section>
		)}

      {panel === "timeline" && status?.session && sessionId && (
        <section className={styles.panel} aria-label="Learning timeline">
          <h2 className={styles.panelTitle}>Learning timeline</h2>
          <div className={styles.results}>
            {timeline.length === 0 && <p className={styles.empty}>No published grounded answers yet.</p>}
            {timeline.map((event) => (
              <article className={styles.timelineEvent} key={event.eventId}>
                <span>{event.kind} · {new Date(event.createdAt).toLocaleString()}</span>
                {event.payload.receiptId && <span className={styles.resultMeta}>receipt {event.payload.receiptId}</span>}
                {event.payload.claimIds?.map((claimId) => <span className={styles.resultMeta} key={claimId}>claim {claimId}</span>)}
                {event.payload.citationSpanIds?.map((spanId) => (
                  <button className={styles.citation} type="button" key={spanId} onClick={() => void openTimelineSource(spanId)}>
                    {spanId}
                  </button>
                ))}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
