import type { DatabaseSync } from "node:sqlite";
import { contentHash, deterministicId, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import { assertBeamerPresentationSource } from "./beamer.ts";
import type { BeamerDeck, CourseBuilderSnapshot } from "./types.ts";

export interface TeacherNotesDraft {
	deckId: string;
	deckRevision: number;
	title: string;
	source: string;
}

export interface TeacherNotes extends TeacherNotesDraft {
	notesId: string;
	projectId: string;
	lessonPlanId: string;
	revision: number;
	sourceHash: string;
	deckSourceHash: string;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface TeacherNotesView extends TeacherNotes {
	staleReasons: string[];
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const NOTES_ID_PREFIX = "teacher-notes";
const DRAFT_KEYS = ["deckId", "deckRevision", "title", "source"];
const LATEX_DOCUMENT_CLASSES = new Set(["article", "report", "book", "ctexart", "ctexrep", "ctexbook"]);

type TeacherNotesRow = {
	project_id: string;
	notes_id: string;
	revision: number;
	payload: string;
};

type TeacherNotesPatch = {
	oldText: string;
	newText: string;
};

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`${path}.${key} is not allowed`);
	}
	return value as Record<string, unknown>;
}

function requiredText(value: unknown, path: string, maxLength = 4000): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength)
		throw new Error(`${path} must contain 1..${maxLength} characters`);
	return value.trim();
}

function sourceText(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
	if (Buffer.byteLength(value, "utf8") > MAX_SOURCE_BYTES)
		throw new Error(`${path} exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`);
	assertStandaloneLatexSource(value);
	// This check intentionally only detects the existing malformed-command class.
	// Normal commands such as \\texttt{...} remain valid teacher-note content.
	assertBeamerPresentationSource(value);
	return value;
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000)
		throw new Error(`${path} must be an integer >= 1`);
	return value as number;
}

function revision(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000_000)
		throw new Error(`${path} must be an integer >= 0`);
	return value as number;
}

function timestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${path} must be ISO-8601`);
	return value;
}

function assertStandaloneLatexSource(source: string): void {
	const declarations = [...source.matchAll(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^}\r\n]+)\}/gu)];
	if (declarations.length !== 1) {
		throw new Error("Teacher notes source must contain exactly one standalone documentclass");
	}
	const className = declarations[0][1].trim();
	if (!LATEX_DOCUMENT_CLASSES.has(className)) {
		throw new Error("Teacher notes source must use article, report, book, ctexart, ctexrep or ctexbook");
	}
	if (!/\\begin\s*\{\s*document\s*\}/u.test(source) || !/\\end\s*\{\s*document\s*\}/u.test(source)) {
		throw new Error("Teacher notes source must contain begin{document} and end{document}");
	}
}

export function parseTeacherNotesDraft(value: unknown): TeacherNotesDraft {
	const draft = record(value, DRAFT_KEYS, "teacher notes");
	return {
		deckId: requiredText(draft.deckId, "deckId"),
		deckRevision: positiveInteger(draft.deckRevision, "deckRevision"),
		title: requiredText(draft.title, "title"),
		source: sourceText(draft.source, "source"),
	};
}

function parsePatch(value: unknown): TeacherNotesPatch[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 100)
		throw new Error("teacher notes patch must be a non-empty array of edits");
	return value.map((item) => parsePatchEdit(item));
}

function parsePatchEdit(value: unknown): TeacherNotesPatch {
	const patch = record(value, ["oldText", "newText"], "teacher notes patch edit");
	if (typeof patch.oldText !== "string" || patch.oldText.length === 0)
		throw new Error("teacher notes patch.oldText must be a non-empty string");
	if (typeof patch.newText !== "string") throw new Error("teacher notes patch.newText must be a string");
	return { oldText: patch.oldText, newText: patch.newText };
}

function withoutContentHash(notes: TeacherNotes): Omit<TeacherNotes, "contentHash"> {
	const { contentHash: _contentHash, ...payload } = notes;
	return payload;
}

function notesIdFor(projectId: string, deckId: string): string {
	return deterministicId(NOTES_ID_PREFIX, { projectId, deckId }, 40);
}

function assertStoredSourceHash(notes: TeacherNotes): void {
	if (notes.sourceHash !== `sha256:${sha256Hex(notes.source)}`)
		throw new Error("Corrupt Course Builder teacher notes source hash");
}

function validateStoredNotes(row: TeacherNotesRow): TeacherNotes {
	let value: unknown;
	try {
		value = JSON.parse(row.payload);
	} catch (error) {
		throw new Error(`Corrupt Course Builder teacher notes payload: ${String(error)}`);
	}
	const data = record(
		value,
		[
			"deckId",
			"deckRevision",
			"title",
			"source",
			"notesId",
			"projectId",
			"lessonPlanId",
			"revision",
			"sourceHash",
			"deckSourceHash",
			"createdAt",
			"updatedAt",
			"contentHash",
		],
		"saved teacher notes",
	);
	const draft = parseTeacherNotesDraft({
		deckId: data.deckId,
		deckRevision: data.deckRevision,
		title: data.title,
		source: data.source,
	});
	const notes = {
		...draft,
		notesId: requiredText(data.notesId, "notesId"),
		projectId: requiredText(data.projectId, "projectId"),
		lessonPlanId: requiredText(data.lessonPlanId, "lessonPlanId"),
		revision: positiveInteger(data.revision, "teacher notes.revision"),
		sourceHash: requiredText(data.sourceHash, "sourceHash"),
		deckSourceHash: requiredText(data.deckSourceHash, "deckSourceHash"),
		createdAt: timestamp(data.createdAt, "createdAt"),
		updatedAt: timestamp(data.updatedAt, "updatedAt"),
		contentHash: requiredText(data.contentHash, "contentHash"),
	} satisfies TeacherNotes;
	if (row.project_id !== notes.projectId || row.notes_id !== notes.notesId || row.revision !== notes.revision)
		throw new Error("Corrupt Course Builder teacher notes identity");
	if (notes.notesId !== notesIdFor(notes.projectId, notes.deckId))
		throw new Error("Corrupt Course Builder teacher notes deterministic identity");
	assertStoredSourceHash(notes);
	if (contentHash(withoutContentHash(notes)) !== notes.contentHash)
		throw new Error("Corrupt Course Builder teacher notes content hash");
	return notes;
}

function cloneNotes(notes: TeacherNotes): TeacherNotes {
	return { ...notes };
}

function cloneView(notes: TeacherNotes, snapshot: CourseBuilderSnapshot): TeacherNotesView {
	const deck = snapshot.decks.find((item) => item.deckId === notes.deckId);
	const staleReasons =
		!deck || deck.revision !== notes.deckRevision || deck.sourceHash !== notes.deckSourceHash
			? ["课件版本已变化"]
			: [];
	return { ...cloneNotes(notes), staleReasons };
}

function findDeck(snapshot: CourseBuilderSnapshot, deckId: string, deckRevision: number): BeamerDeck {
	const deck = snapshot.decks.find((item) => item.deckId === deckId);
	if (!deck || deck.projectId !== snapshot.project.projectId)
		throw new Error("Teacher notes deck is missing or belongs to another project");
	if (deck.revision !== deckRevision) throw new Error("Teacher notes deck revision changed; reload before saving");
	return deck;
}

function replacement(source: string, oldText: string, newText: string): string {
	const first = source.indexOf(oldText);
	if (first < 0) throw new Error("Teacher notes patch oldText was not found");
	if (source.indexOf(oldText, first + oldText.length) >= 0)
		throw new Error("Teacher notes patch oldText must occur exactly once");
	return `${source.slice(0, first)}${newText}${source.slice(first + oldText.length)}`;
}

/** Durable, append-only teacher lecture-script records on a Course Builder connection. */
export class CourseTeacherNotesLedger {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
		database.exec(
			"CREATE TABLE IF NOT EXISTS course_builder_teacher_notes (project_id TEXT NOT NULL, notes_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id, notes_id, revision))",
		);
	}

	private readRows(projectId: string): TeacherNotes[] {
		const rows = this.database
			.prepare(
				"SELECT project_id, notes_id, revision, payload FROM course_builder_teacher_notes WHERE project_id=? ORDER BY notes_id, revision",
			)
			.all(projectId) as unknown as TeacherNotesRow[];
		return rows.map((row) => this.readStoredRow(row));
	}

	private readAllRowsForNotesId(notesId: string): TeacherNotes[] {
		const rows = this.database
			.prepare(
				"SELECT project_id, notes_id, revision, payload FROM course_builder_teacher_notes WHERE notes_id=? ORDER BY project_id, revision",
			)
			.all(notesId) as unknown as TeacherNotesRow[];
		return rows.map((row) => this.readStoredRow(row));
	}

	private readStoredRow(row: TeacherNotesRow): TeacherNotes {
		try {
			return validateStoredNotes(row);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Corrupt Course Builder teacher notes")) throw error;
			throw new Error(`Corrupt Course Builder teacher notes payload: ${String(error)}`, { cause: error });
		}
	}

	private latest(projectId: string, notesId: string): TeacherNotes | null {
		return (
			this.readRows(projectId)
				.filter((item) => item.notesId === notesId)
				.at(-1) ?? null
		);
	}

	list(snapshot: CourseBuilderSnapshot): TeacherNotesView[] {
		const current = new Map<string, TeacherNotes>();
		for (const notes of this.readRows(snapshot.project.projectId)) {
			const previous = current.get(notes.deckId);
			if (!previous || notes.revision > previous.revision) current.set(notes.deckId, notes);
		}
		return [...current.values()]
			.sort((left, right) => left.deckId.localeCompare(right.deckId))
			.map((notes) => cloneView(notes, snapshot));
	}

	get(snapshot: CourseBuilderSnapshot, id: string): TeacherNotes {
		const notesId = requiredText(id, "notesId");
		const records = this.readAllRowsForNotesId(notesId);
		if (!records.length) throw new Error("Teacher notes were not found");
		const owned = records.filter((item) => item.projectId === snapshot.project.projectId);
		if (!owned.length) throw new Error("Teacher notes do not belong to this project");
		return cloneNotes(owned.at(-1)!);
	}

	save(getSnapshot: () => CourseBuilderSnapshot | null, draftValue: unknown, expectedRevision: number): TeacherNotes {
		const draft = parseTeacherNotesDraft(draftValue);
		return this.write(
			getSnapshot,
			(snapshot) => notesIdFor(snapshot.project.projectId, draft.deckId),
			expectedRevision,
			(snapshot, previous) => {
				const deck = findDeck(snapshot, draft.deckId, draft.deckRevision);
				const notesId = notesIdFor(snapshot.project.projectId, deck.deckId);
				const now = new Date().toISOString();
				return {
					...draft,
					notesId,
					projectId: snapshot.project.projectId,
					lessonPlanId: deck.lessonPlanId,
					revision: (previous?.revision ?? 0) + 1,
					sourceHash: `sha256:${sha256Hex(draft.source)}`,
					deckSourceHash: deck.sourceHash,
					createdAt: previous?.createdAt ?? now,
					updatedAt: now,
				};
			},
		);
	}

	patch(
		getSnapshot: () => CourseBuilderSnapshot | null,
		id: string,
		editsValue: unknown,
		expectedRevision: number,
		deckRevision: number,
	): TeacherNotes {
		const notesId = requiredText(id, "notesId");
		const edits = parsePatch(editsValue);
		positiveInteger(deckRevision, "deckRevision");
		return this.write(getSnapshot, notesId, expectedRevision, (snapshot, previous) => {
			if (!previous) throw new Error("Save teacher notes before patching them");
			if (previous.notesId !== notesId) throw new Error("Teacher notes identity changed; reload before patching");
			const deck = findDeck(snapshot, previous.deckId, deckRevision);
			const source = edits.reduce(
				(current, edit) => replacement(current, edit.oldText, edit.newText),
				previous.source,
			);
			const nextDraft = parseTeacherNotesDraft({
				deckId: previous.deckId,
				deckRevision,
				title: previous.title,
				source,
			});
			const now = new Date().toISOString();
			return {
				...nextDraft,
				notesId: previous.notesId,
				projectId: snapshot.project.projectId,
				lessonPlanId: deck.lessonPlanId,
				revision: previous.revision + 1,
				sourceHash: `sha256:${sha256Hex(nextDraft.source)}`,
				deckSourceHash: deck.sourceHash,
				createdAt: previous.createdAt,
				updatedAt: now,
			};
		});
	}

	private write(
		getSnapshot: () => CourseBuilderSnapshot | null,
		notesIdOrFactory: string | ((snapshot: CourseBuilderSnapshot) => string),
		expectedRevision: number,
		change: (snapshot: CourseBuilderSnapshot, previous: TeacherNotes | null) => Omit<TeacherNotes, "contentHash">,
	): TeacherNotes {
		revision(expectedRevision, "expectedRevision");
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const snapshot = getSnapshot();
			if (!snapshot) throw new Error("Open a course workspace first");
			const notesId = typeof notesIdOrFactory === "function" ? notesIdOrFactory(snapshot) : notesIdOrFactory;
			const previous = this.latest(snapshot.project.projectId, notesId);
			if ((previous?.revision ?? 0) !== expectedRevision)
				throw new Error(
					`Teacher notes revision conflict for ${notesId}: expected ${expectedRevision}, actual ${previous?.revision ?? 0}`,
				);
			const payload = change(snapshot, previous);
			if (payload.notesId !== notesId || payload.projectId !== snapshot.project.projectId)
				throw new Error("Teacher notes write escaped its project or stable identity");
			const notes: TeacherNotes = { ...payload, contentHash: contentHash(payload) };
			this.database
				.prepare("INSERT INTO course_builder_teacher_notes(project_id,notes_id,revision,payload) VALUES(?,?,?,?)")
				.run(notes.projectId, notes.notesId, notes.revision, stableStringify(notes));
			this.database.exec("COMMIT");
			return cloneNotes(notes);
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollback) {
				throw new AggregateError([error, rollback], "Teacher notes write and rollback both failed");
			}
			throw error;
		}
	}
}
