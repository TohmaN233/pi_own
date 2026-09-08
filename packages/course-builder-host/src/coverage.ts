import type { DatabaseSync } from "node:sqlite";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import { semesterPlanningIssue } from "./planning.ts";
import type { CourseBuilderSnapshot } from "./types.ts";

export interface CoverageRange {
	materialId: string;
	sourceHash: string;
	unit: "pages" | "lines" | "whole-file";
	start: number | null;
	end: number | null;
	summary: string;
}
export interface CoverageFile {
	materialId: string;
	sourceHash: string;
	summary: string;
	position: string;
	nextLesson: string;
}
export interface CoverageDraft {
	lessonPlanId: string;
	lessonRevision: number;
	deckId: string | null;
	deckRevision: number | null;
	coverage: CoverageFile[];
	completed: string[];
	remaining: string[];
	nextLesson: string;
}
export interface CoverageCheckpoint extends CoverageDraft {
	projectId: string;
	semesterPlanId: string;
	semesterRevision: number;
	revision: number;
	status: "planned" | "confirmed";
	confirmedAt: string | null;
	updatedAt: string;
	contentHash: string;
}
export interface CoverageCheckpointView extends CoverageCheckpoint {
	staleReasons: string[];
}

function record(value: unknown, keys: string[], path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${path}.${key} is not allowed`);
	return value as Record<string, unknown>;
}
function text(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 4000)
		throw new Error(`${path} must contain 1..4000 characters`);
	return value.trim();
}
function integer(value: unknown, path: string, min = 1): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > 10000000)
		throw new Error(`${path} must be an integer >= ${min}`);
	return value as number;
}
function lines(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || value.length > 40) throw new Error(`${path} must be an array of at most 40 entries`);
	return value.map((item) => text(item, path));
}
export function parseCoverageDraft(value: unknown): CoverageDraft {
	const draft = record(
		value,
		["lessonPlanId", "lessonRevision", "deckId", "deckRevision", "coverage", "completed", "remaining", "nextLesson"],
		"checkpoint",
	);
	if (!Array.isArray(draft.coverage) || draft.coverage.length > 128)
		throw new Error("checkpoint.coverage must contain at most 128 ranges");
	const files = new Map<string, CoverageFile>();
	const legacyPositions = new Map<string, string[]>();
	for (const value of draft.coverage) {
		if (value && typeof value === "object" && !Array.isArray(value) && !("unit" in value)) {
			const item = record(value, ["materialId", "sourceHash", "summary", "position", "nextLesson"], "coverage file");
			const materialId = text(item.materialId, "materialId");
			if (files.has(materialId))
				throw new Error(
					"One checkpoint per lesson and file; update the existing file record instead of adding ranges",
				);
			if (typeof item.position !== "string" || item.position.length > 4000)
				throw new Error("File position must be a string of at most 4000 characters");
			files.set(materialId, {
				materialId,
				sourceHash: text(item.sourceHash, "sourceHash"),
				summary: text(item.summary, "coverage.summary"),
				position: item.position.trim(),
				nextLesson: text(item.nextLesson, "coverage.nextLesson"),
			});
			continue;
		}
		// Read historical range-based records without rewriting their immutable rows.
		const range = record(value, ["materialId", "sourceHash", "unit", "start", "end", "summary"], "coverage");
		if (range.unit !== "pages" && range.unit !== "lines" && range.unit !== "whole-file")
			throw new Error("Coverage unit must be pages, lines or whole-file");
		if (range.unit === "whole-file" && (range.start !== null || range.end !== null))
			throw new Error("Whole-file coverage must use null start/end");
		const start = range.unit === "whole-file" ? null : integer(range.start, "coverage.start");
		const end = range.unit === "whole-file" ? null : integer(range.end, "coverage.end");
		if (start !== null && end !== null && end < start) throw new Error("Coverage end must be >= start");
		const materialId = text(range.materialId, "materialId"),
			sourceHash = text(range.sourceHash, "sourceHash"),
			summary = text(range.summary, "coverage.summary");
		const previous = files.get(materialId);
		if (previous && previous.sourceHash !== sourceHash)
			throw new Error("One file cannot reference different source versions in a checkpoint");
		const positions = legacyPositions.get(materialId) ?? [];
		positions.push(
			range.unit === "whole-file" ? "全文" : `第 ${start}–${end} ${range.unit === "pages" ? "页" : "行"}`,
		);
		legacyPositions.set(materialId, positions);
		files.set(materialId, {
			materialId,
			sourceHash,
			summary: previous ? [...new Set([previous.summary, summary])].join("\n") : summary,
			position: `旧记录定位（待核对）：${positions.join("；")}`,
			nextLesson: text(draft.nextLesson, "checkpoint.nextLesson"),
		});
	}
	const coverage = [...files.values()];
	const completed = lines(draft.completed, "checkpoint.completed");
	if (!completed.length) throw new Error("Record at least one covered concept");
	if ((draft.deckId === null) !== (draft.deckRevision === null))
		throw new Error("Deck identity and revision must be supplied together");
	return {
		lessonPlanId: text(draft.lessonPlanId, "lessonPlanId"),
		lessonRevision: integer(draft.lessonRevision, "lessonRevision"),
		deckId: draft.deckId === null ? null : text(draft.deckId, "deckId"),
		deckRevision: draft.deckRevision === null ? null : integer(draft.deckRevision, "deckRevision"),
		coverage,
		completed,
		remaining: lines(draft.remaining, "checkpoint.remaining"),
		nextLesson: text(draft.nextLesson, "checkpoint.nextLesson"),
	};
}

export function checkpointStaleReasons(checkpoint: CoverageCheckpoint, snapshot: CourseBuilderSnapshot): string[] {
	const reasons: string[] = [];
	const lesson = snapshot.lessonPlans.find((item) => item.lessonPlanId === checkpoint.lessonPlanId);
	if (!lesson || lesson.revision !== checkpoint.lessonRevision) reasons.push("单课教案版本已变化");
	if (
		!snapshot.semesterPlan ||
		snapshot.semesterPlan.semesterPlanId !== checkpoint.semesterPlanId ||
		snapshot.semesterPlan.revision !== checkpoint.semesterRevision ||
		semesterPlanningIssue(snapshot.project, snapshot.semesterPlan)
	)
		reasons.push("学期计划或课程规划已变化");
	if (checkpoint.deckId !== null) {
		const deck = snapshot.decks.find((item) => item.deckId === checkpoint.deckId);
		if (!deck || deck.revision !== checkpoint.deckRevision || deck.lessonPlanId !== checkpoint.lessonPlanId)
			reasons.push("课件版本已变化");
	}
	for (const range of checkpoint.coverage) {
		const material = snapshot.materials.find((item) => item.materialId === range.materialId);
		if (!material || material.sourceHash !== range.sourceHash)
			reasons.push(`参考文件已变化：${material?.name ?? range.materialId}`);
	}
	return [...new Set(reasons)];
}

/** Independent revision history on the existing LearningHarness connection. */
export class CourseCoverageLedger {
	private readonly database: DatabaseSync;
	constructor(database: DatabaseSync) {
		this.database = database;
		database.exec(
			"CREATE TABLE IF NOT EXISTS course_builder_checkpoint (project_id TEXT NOT NULL, lesson_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id, lesson_id, revision))",
		);
	}
	private read(projectId: string): CoverageCheckpoint[] {
		const rows = this.database
			.prepare(
				"SELECT project_id, lesson_id, revision, payload FROM course_builder_checkpoint WHERE project_id=? ORDER BY lesson_id, revision",
			)
			.all(projectId) as { project_id: string; lesson_id: string; revision: number; payload: string }[];
		return rows.map((row) => {
			const value: unknown = JSON.parse(row.payload);
			const data = record(
				value,
				[
					"lessonPlanId",
					"lessonRevision",
					"deckId",
					"deckRevision",
					"coverage",
					"completed",
					"remaining",
					"nextLesson",
					"projectId",
					"semesterPlanId",
					"semesterRevision",
					"revision",
					"status",
					"confirmedAt",
					"updatedAt",
					"contentHash",
				],
				"saved checkpoint",
			);
			const {
				projectId: savedProject,
				semesterPlanId,
				semesterRevision,
				revision,
				status,
				confirmedAt,
				updatedAt,
				contentHash: hash,
				...draft
			} = data;
			const normalized = parseCoverageDraft(draft);
			const { contentHash: _hash, ...payload } = data;
			if (
				savedProject !== row.project_id ||
				draft.lessonPlanId !== row.lesson_id ||
				revision !== row.revision ||
				contentHash(payload) !== hash ||
				(status !== "planned" && status !== "confirmed") ||
				typeof updatedAt !== "string" ||
				!Number.isFinite(Date.parse(updatedAt)) ||
				(status === "confirmed"
					? typeof confirmedAt !== "string" || !Number.isFinite(Date.parse(confirmedAt))
					: confirmedAt !== null)
			)
				throw new Error("Corrupt Course Builder checkpoint identity or hash");
			text(semesterPlanId, "semesterPlanId");
			integer(semesterRevision, "semesterRevision");
			integer(revision, "checkpoint.revision");
			return { ...data, ...normalized } as unknown as CoverageCheckpoint;
		});
	}
	list(snapshot: CourseBuilderSnapshot): CoverageCheckpointView[] {
		const current = new Map<string, CoverageCheckpoint>();
		for (const checkpoint of this.read(snapshot.project.projectId)) current.set(checkpoint.lessonPlanId, checkpoint);
		return [...current.values()].map((item) => ({ ...item, staleReasons: checkpointStaleReasons(item, snapshot) }));
	}
	save(getSnapshot: () => CourseBuilderSnapshot | null, value: unknown, expectedRevision: number): CoverageCheckpoint {
		const draft = parseCoverageDraft(value);
		return this.write(getSnapshot, draft.lessonPlanId, expectedRevision, (snapshot, previous) => {
			const lesson = snapshot.lessonPlans.find((item) => item.lessonPlanId === draft.lessonPlanId);
			if (!lesson || lesson.revision !== draft.lessonRevision)
				throw new Error("Checkpoint lesson is missing or its revision changed; reload before saving");
			if (
				!snapshot.semesterPlan ||
				lesson.semesterPlanRevision !== snapshot.semesterPlan.revision ||
				semesterPlanningIssue(snapshot.project, snapshot.semesterPlan)
			)
				throw new Error("Checkpoint requires the current semester/lesson relationship");
			if (draft.deckId !== null) {
				const deck = snapshot.decks.find((item) => item.deckId === draft.deckId);
				if (
					!deck ||
					deck.revision !== draft.deckRevision ||
					deck.lessonPlanId !== lesson.lessonPlanId ||
					deck.lessonPlanRevision !== lesson.revision
				)
					throw new Error("Checkpoint deck is missing, changed or belongs to another lesson");
			}
			for (const range of draft.coverage) {
				const material = snapshot.materials.find((item) => item.materialId === range.materialId);
				if (
					!material ||
					material.metadata.materialScope === "assignment" ||
					material.sourceHash !== range.sourceHash
				)
					throw new Error("Checkpoint reference is outside this course or its source changed");
			}
			return {
				...draft,
				projectId: snapshot.project.projectId,
				semesterPlanId: snapshot.semesterPlan.semesterPlanId,
				semesterRevision: snapshot.semesterPlan.revision,
				revision: (previous?.revision ?? 0) + 1,
				status: "planned",
				confirmedAt: null,
				updatedAt: new Date().toISOString(),
			};
		});
	}
	confirm(
		getSnapshot: () => CourseBuilderSnapshot | null,
		lessonId: string,
		expectedRevision: number,
	): CoverageCheckpoint {
		return this.write(getSnapshot, lessonId, expectedRevision, (snapshot, previous) => {
			if (!previous) throw new Error("Save a checkpoint before confirming it");
			const stale = checkpointStaleReasons(previous, snapshot);
			if (stale.length) throw new Error(`Checkpoint needs reconciliation: ${stale.join("; ")}`);
			if (previous.status === "confirmed") throw new Error("Checkpoint is already confirmed");
			const { contentHash: _hash, ...payload } = previous;
			const now = new Date().toISOString();
			return { ...payload, revision: previous.revision + 1, status: "confirmed", confirmedAt: now, updatedAt: now };
		});
	}
	private write(
		getSnapshot: () => CourseBuilderSnapshot | null,
		lessonId: string,
		expectedRevision: number,
		change: (
			snapshot: CourseBuilderSnapshot,
			previous: CoverageCheckpoint | null,
		) => Omit<CoverageCheckpoint, "contentHash">,
	): CoverageCheckpoint {
		integer(expectedRevision, "expectedRevision", 0);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const snapshot = getSnapshot();
			if (!snapshot) throw new Error("Open a course workspace first");
			const previous =
				this.read(snapshot.project.projectId)
					.filter((item) => item.lessonPlanId === lessonId)
					.at(-1) ?? null;
			if ((previous?.revision ?? 0) !== expectedRevision)
				throw new Error(
					`Checkpoint revision conflict: expected ${expectedRevision}, actual ${previous?.revision ?? 0}`,
				);
			const payload = change(snapshot, previous);
			const checkpoint = { ...payload, contentHash: contentHash(payload) };
			this.database
				.prepare("INSERT INTO course_builder_checkpoint(project_id,lesson_id,revision,payload) VALUES(?,?,?,?)")
				.run(checkpoint.projectId, checkpoint.lessonPlanId, checkpoint.revision, stableStringify(checkpoint));
			this.database.exec("COMMIT");
			return checkpoint;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollback) {
				throw new AggregateError([error, rollback], "Checkpoint write and rollback both failed");
			}
			throw error;
		}
	}
}
