"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
	getHarnessStatus,
	getHarnessTimeline,
	importHarnessCourse,
	readHarnessSpan,
	searchHarnessCourse,
	selectHarnessCourse,
	type HarnessSpan,
	type HarnessStatus,
	type HarnessTimelineEvent,
} from "@/lib/harness-client";
import {
	activateModePackForSession,
	getModePackSessionStatus,
	type ModePackSessionStatus,
} from "@/lib/mode-pack-client";
import styles from "./HarnessShell.module.css";
import { PracticePanel } from "./PracticePanel";

export function HarnessShell({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	const searchParams = useSearchParams();
	const sessionId = searchParams.get("session") ?? undefined;
	const [status, setStatus] = useState<HarnessStatus | null>(null);
	const [modeStatus, setModeStatus] = useState<ModePackSessionStatus | null>(null);
	const [panel, setPanel] = useState<"import" | "sources" | "timeline" | "practice" | "runtime" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	const [spans, setSpans] = useState<HarnessSpan[]>([]);
	const [source, setSource] = useState<HarnessSpan | null>(null);
	const [timeline, setTimeline] = useState<HarnessTimelineEvent[]>([]);
	const fileInput = useRef<HTMLInputElement>(null);
	const refreshRevision = useRef(0);
	const switchRevision = useRef(0);

	const refresh = useCallback(async () => {
		const revision = ++refreshRevision.current;
		try {
			const [nextStatus, nextModeStatus] = await Promise.all([
				getHarnessStatus(sessionId),
				sessionId ? getModePackSessionStatus(sessionId) : Promise.resolve(null),
			]);
			if (revision !== refreshRevision.current) return;
			setStatus(nextStatus);
			setModeStatus(nextModeStatus);
		} catch (error) {
			if (revision !== refreshRevision.current) return;
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

	const switchModePack = async (modePackId: string) => {
		if (!sessionId || !modeStatus) return;
		const target = modeStatus.modePacks.find((entry) => entry.id === modePackId);
		if (!target) return;
		if (
			modeStatus.active?.modePackId === target.id &&
			modeStatus.active.modePackRevision === target.revision &&
			modeStatus.active.modePackContentHash === target.contentHash
		) return;
		const revision = ++switchRevision.current;
		setBusy(true);
		setNotice(null);
		try {
			const result = await activateModePackForSession({
				sessionId,
				modePackId: target.id,
				revision: target.revision,
				...(modeStatus.active
					? { expectedCurrentModeHash: modeStatus.active.modePackContentHash }
					: {}),
			});
			if (revision !== switchRevision.current) return;
			if (result.transition === "hard" && result.targetSessionId !== sessionId) {
				const next = new URLSearchParams(searchParams.toString());
				next.set("session", result.targetSessionId);
				router.push(`${pathname}?${next.toString()}`);
				setNotice(`Mode Pack activated in a new isolated Pi session: ${result.targetSessionId}`);
				return;
			}
			await refresh();
			setNotice(`Mode Pack ${result.modePackId} r${result.modePackRevision} is active and runtime-verified.`);
		} catch (error) {
			if (revision !== switchRevision.current) return;
			setNotice(error instanceof Error ? error.message : String(error));
		} finally {
			if (revision === switchRevision.current) setBusy(false);
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

	const selectedCourse = status?.activeCourseVersionId ?? "";
	const activeModePackId = modeStatus?.active?.modePackId ?? modeStatus?.inferredModePackId ?? "";

	return (
		<div className={styles.frame}>
			<header className={styles.bar}>
				<span className={styles.brand}>Pi Own</span>
				<select
					className={styles.select}
					aria-label="Course for new sessions"
					value={selectedCourse}
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
					aria-busy={busy}
					value={activeModePackId}
					onChange={(event) => void switchModePack(event.target.value)}
					disabled={!sessionId || !modeStatus || busy}
				>
					<option value="">Choose Mode Pack</option>
					{modeStatus?.modePacks.map((modePack) => {
						const unavailable = modePack.contextKind === "course" && !status?.session;
						return (
							<option
								key={`${modePack.id}:${modePack.revision}`}
								value={modePack.id}
								disabled={unavailable}
							>
								{modePack.title} · r{modePack.revision}{modePack.builtin ? "" : " · custom"}
								{unavailable ? " · course required" : ""}
							</option>
						);
					})}
				</select>
				<span className={styles.snapshot} title={modeStatus?.active?.receipt.effectivePromptHash ?? undefined}>
					{modeStatus?.active
						? `${modeStatus.active.modePackId} · binding r${modeStatus.active.revision}`
						: modeStatus?.inferredModePackId
							? `${modeStatus.inferredModePackId} · legacy profile`
							: sessionId ? "unmanaged Pi session" : "open a session to choose a mode"}
				</span>
				<span className={styles.spacer} />
				<button className={styles.button} type="button" onClick={() => router.push("/mode-packs")}>Configure</button>
				<button className={styles.button} type="button" onClick={() => setPanel(panel === "import" ? null : "import")} aria-expanded={panel === "import"}>
					Import
				</button>
				<button className={styles.button} type="button" onClick={() => setPanel(panel === "runtime" ? null : "runtime")} aria-expanded={panel === "runtime"} disabled={!sessionId}>
					Runtime
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

			{panel === "runtime" && sessionId && modeStatus && (
				<section className={styles.panel} aria-label="Mode Pack runtime inspector">
					<h2 className={styles.panelTitle}>Mode Pack runtime inspector</h2>
					<div className={styles.inspector}>
						<dl>
							<dt>Mode Pack</dt><dd>{modeStatus.active ? `${modeStatus.active.modePackId} · r${modeStatus.active.modePackRevision}` : modeStatus.inferredModePackId ?? "unmanaged"}</dd>
							<dt>Binding</dt><dd>{modeStatus.active ? `${modeStatus.active.bindingId} · revision ${modeStatus.active.revision}` : "not committed"}</dd>
							<dt>Context</dt><dd>{modeStatus.active ? `${modeStatus.active.contextKind}: ${modeStatus.active.contextBinding ?? "none"}` : status?.session?.courseVersionId ?? "none"}</dd>
							<dt>Runtime</dt><dd>{modeStatus.runtime.verified ? "verified" : modeStatus.runtime.diagnostic ?? "not verified"}</dd>
							<dt>Prompt hash</dt><dd>{modeStatus.active?.receipt.effectivePromptHash ?? modeStatus.runtime.effectivePromptHash ?? "none"}</dd>
							<dt>Skills</dt><dd>{modeStatus.active?.receipt.loaded.skills.join(", ") || "none"}</dd>
							<dt>Plugins</dt><dd>{modeStatus.active?.receipt.loaded.plugins.join(", ") || "none"}</dd>
							<dt>Packages</dt><dd>{modeStatus.active?.receipt.loaded.packages.join(", ") || "none"}</dd>
							<dt>Tools</dt><dd>{modeStatus.runtime.activeTools.join(", ") || "none"}</dd>
							<dt>Workflows</dt><dd>{modeStatus.active?.receipt.loaded.workflows.join(", ") || "none"}</dd>
						</dl>
						{modeStatus.active && !modeStatus.runtime.verified && <p className={styles.empty}>The committed receipt will be reconstructed and checked before the next Pi command.</p>}
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
