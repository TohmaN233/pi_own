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
  type HarnessModePackDraft,
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
  const [panel, setPanel] = useState<"import" | "sources" | "timeline" | "practice" | "snapshot" | "modes" | null>(null);
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

	const createCustomModePack = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!sessionId || !status?.session) return;
		const form = new FormData(event.currentTarget);
		const modePackId = String(form.get("modePackId") ?? "").trim();
		const title = String(form.get("title") ?? "").trim();
		const description = String(form.get("description") ?? "").trim() || "Custom course-bound learner Mode Pack.";
		const systemPrompt = String(form.get("systemPrompt") ?? "").trim();
		const rawWorkflow = String(form.get("baseWorkflow") ?? "tutor");
		const workflow = rawWorkflow === "practice" || rawWorkflow === "teach-back" ? rawWorkflow : "tutor";
		if (!modePackId.startsWith("custom.") || !title || !systemPrompt) {
			setNotice("Custom Mode Pack id, title, and prompt are required; the id must start with custom.");
			return;
		}
		const selectedSkills = new Set(form.getAll("components").map((value) => String(value)));
		if (workflow === "teach-back") selectedSkills.add("education.feynman-teach-back");
		const runtimeMode = workflow === "practice" ? "practice" as const : "student-learn" as const;
		const draft: HarnessModePackDraft = {
			version: 1,
			modePackId,
			revision: 1,
			title,
			description,
			category: "education",
			role: "student",
			runtimeMode,
			provider: null,
			model: null,
			thinkingLevel: "high",
			externalKnowledgePolicy: runtimeMode === "practice" ? "deny" : "explain-and-label",
			courseRequired: true,
			tools: [],
			components: [
				{ type: "plugin", id: "learning-harness", required: true, enabled: true },
				{ type: "workflow", id: workflow, required: true, enabled: true },
				...[...selectedSkills].sort().map((id) => ({
					type: "skill" as const,
					id,
					required: false,
					enabled: true,
				})),
			],
			systemPrompt,
			instructions: [],
		};
		const current = status.session;
		const operation = `${current.resourceSnapshotId}\u0000${modePackId}\u0000${JSON.stringify(draft)}`;
		const idempotencyKey = profileOperationKeys.current.get(operation) ?? crypto.randomUUID();
		profileOperationKeys.current.set(operation, idempotencyKey);
		setBusy(true);
		setNotice(null);
		try {
			await switchHarnessProfile(
				sessionId,
				modePackId,
				current.resourceSnapshotId,
				idempotencyKey,
				draft,
			);
			profileOperationKeys.current.delete(operation);
			await refresh();
			setPanel(null);
			setNotice(`Activated ${title} as immutable Mode Pack ${modePackId}.`);
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
			aria-label="Mode Pack"
			aria-busy={busy || Boolean(status?.session?.pendingTransition)}
			value={status?.session?.profileId ?? ""}
			onChange={(event) => void switchProfile(event.target.value)}
			disabled={!status?.session || !status.session.runtime.verified || busy || Boolean(status?.session?.pendingTransition)}
		>
			<option value="">No bound learner profile</option>
			{status?.availableProfiles.map((profile) => (
				<option key={profile.profileId} value={profile.profileId} disabled={!profile.selectable} title={profile.disabledReason ?? undefined}>
					{profile.title} · {profile.profileId}{profile.selectable ? "" : ` — ${profile.disabledReason}`}
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
		<button className={styles.button} type="button" onClick={() => setPanel(panel === "modes" ? null : "modes")} aria-expanded={panel === "modes"} disabled={!status?.session}>
			Modes
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

      {panel === "modes" && status?.session && sessionId && (
        <section className={styles.panel} aria-label="Mode Pack editor">
          <h2 className={styles.panelTitle}>Mode Packs</h2>
          <p className={styles.empty}>
            Active: {status.availableProfiles.find((item) => item.profileId === status.session?.profileId)?.title ?? status.session.profileId}
            {" · "}{status.session.profileId}
          </p>
          <form className={styles.form} onSubmit={createCustomModePack}>
            <label>
              Custom Mode Pack ID
              <input
                className={styles.input}
                name="modePackId"
                required
                pattern="custom\.[a-z0-9]+(?:[.-][a-z0-9]+)*"
                placeholder="custom.statistics"
              />
            </label>
            <label>
              Display title
              <input className={styles.input} name="title" required placeholder="Statistics coach" />
            </label>
            <label>
              Description
              <input className={styles.input} name="description" placeholder="How this mode should be used" />
            </label>
            <label>
              Base workflow
              <select className={styles.select} name="baseWorkflow" defaultValue="tutor">
                <option value="tutor">Tutor</option>
                <option value="practice">Practice</option>
                <option value="teach-back">Teach-back</option>
              </select>
            </label>
            <label>
              Fixed Mode Pack prompt
              <textarea
                className={styles.textarea}
                name="systemPrompt"
                required
                rows={6}
                placeholder="State the teaching style, workflow emphasis, terminology, and quality bar for this mode."
              />
            </label>
            <fieldset className={styles.modeFieldset}>
              <legend>Installed optional Skills</legend>
              {status.modePackComponents.filter((option) => option.type === "skill").map((option) => (
                <label className={styles.componentOption} key={option.id}>
                  <input
                    type="checkbox"
                    name="components"
                    value={option.id}
                    defaultChecked={option.recommended}
                  />
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <button className={styles.button} type="submit" disabled={busy || !status.session.runtime.verified}>
              {busy ? "Activating…" : "Compile and activate"}
            </button>
          </form>
          <div className={styles.modeList}>
            {status.availableProfiles.map((profile) => (
              <article className={styles.modeCard} key={profile.profileId}>
                <strong>{profile.title}</strong>
                <span className={styles.resultMeta}>{profile.profileId} · {profile.runtimeMode} · {profile.source}</span>
                <span>{profile.description}</span>
                {!profile.selectable && <span className={styles.resultMeta}>{profile.disabledReason}</span>}
              </article>
            ))}
          </div>
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
						<dt>Mode Pack</dt><dd>{status.availableProfiles.find((item) => item.profileId === status.session?.profileId)?.title ?? status.session.snapshot.profileId} · {status.session.snapshot.profileId}</dd>
						<dt>Runtime envelope</dt><dd>{status.session.snapshot.mode} · {status.session.snapshot.role}</dd>
						<dt>Binding revision</dt><dd>{status.session.bindingRevision}</dd>
						<dt>Snapshot</dt><dd>{status.session.snapshot.resourceSnapshotId}</dd>
						<dt>Snapshot hash</dt><dd>{status.session.snapshot.contentHash}</dd>
						<dt>Course</dt><dd>{status.session.snapshot.courseVersionId}</dd>
						<dt>Runtime</dt><dd>{status.session.runtime.verified ? "verified" : status.session.runtime.diagnostic ?? "recovery required"}</dd>
						<dt>Active tools</dt><dd>{status.session.runtime.activeTools.join(", ") || "none"}</dd>
						<dt>Resources</dt><dd>{status.session.snapshot.resources.map((resource) => `${resource.kind}:${resource.id}@${resource.version}#${resource.contentHash.slice(0, 18)}`).join(", ") || "none"}</dd>
						<dt>Compiled instructions</dt><dd>{status.session.snapshot.instructions.length}</dd>
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
