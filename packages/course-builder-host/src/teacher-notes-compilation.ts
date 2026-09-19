import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { contentHash, deterministicId, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import { compileLatexDocument, resolveSyncTexCommand } from "./beamer.ts";
import type { TeacherNotes } from "./teacher-notes.ts";
import type {
	BeamerAsset,
	BeamerCompileReceipt,
	BeamerDeck,
	CompileDiagnostic,
	CourseBuilderSnapshot,
} from "./types.ts";

const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_SYNCTEX_BYTES = 64 * 1024 * 1024;
const MAX_SYNCTEX_COORDINATE = 1_000_000;
const SYNCTEX_TIMEOUT_MS = 10_000;
const SYNCTEX_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

export interface TeacherNotesCompileOptions {
	trustedTex: boolean;
	assertActive?: () => void | Promise<void>;
	compiler?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	passes?: number;
	maxOutputBytes?: number;
	maxPdfBytes?: number;
	assets?: readonly BeamerAsset[];
}

export interface TeacherNotesCompileReceipt {
	receiptId: string;
	projectId: string;
	notesId: string;
	notesRevision: number;
	sourceHash: string;
	deckId: string;
	deckRevision: number;
	deckSourceHash: string;
	compiler: string;
	arguments: string[];
	succeeded: boolean;
	exitCode: number | null;
	pageCount: number | null;
	pdfHash: string | null;
	logHash: string;
	diagnostics: CompileDiagnostic[];
	createdAt: string;
	contentHash: string;
}

interface TeacherNotesCompileRow {
	receipt_id: string;
	project_id: string;
	notes_id: string;
	payload: string;
	log: string;
	pdf: Uint8Array | null;
}

interface TeacherNotesCompileMetadataRow {
	receipt_id: string;
	project_id: string;
	notes_id: string;
	payload: string;
}

interface TeacherNotesCompileLogRow extends TeacherNotesCompileMetadataRow {
	log: string;
}

interface TeacherNotesCompilePdfRow extends TeacherNotesCompileMetadataRow {
	pdf: Uint8Array | null;
}

interface TeacherNotesSyncTexRow {
	receipt_id: string;
	project_id: string;
	source_hash: string;
	sync_tex: Uint8Array | null;
	sync_tex_hash: string;
	sync_tex_command: string;
}

interface TeacherNotesSyncTexMetadataRow {
	receipt_id: string;
	project_id: string;
	source_hash: string;
	sync_tex_size: number | null;
	sync_tex_hash: string;
	sync_tex_command: string;
}

interface StoredTeacherNotesCompile {
	receipt: TeacherNotesCompileReceipt;
	log: string;
	pdf: Uint8Array | null;
}

export type TeacherNotesSyncTexQuery = { line: number } | { page: number; x: number; y: number };
export type TeacherNotesSyncTexLocation =
	| { page: number; x: number; y: number; width: number; height: number }
	| { line: number; column: number };

interface StoredTeacherNotesSyncTex {
	bytes: Uint8Array;
	command: string;
}

type SyncTexReceipt = Pick<
	TeacherNotesCompileReceipt | BeamerCompileReceipt,
	"receiptId" | "projectId" | "sourceHash" | "succeeded" | "pageCount" | "pdfHash"
>;

/** A validated Beamer map, written by the Host inside its receipt transaction. */
export interface BeamerSyncTexArtifact {
	receiptId: string;
	projectId: string;
	sourceHash: string;
	bytes: Uint8Array;
	command: string;
}

export class TeacherNotesCompilationError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TeacherNotesCompilationError";
		this.code = code;
	}
}

interface SyncTexProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	outputLimited: boolean;
}

function assertStoredSyncTexCommand(command: unknown): string {
	if (typeof command !== "string" || command.length === 0 || command.length > 4_000)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes SyncTeX command is invalid");
	if (basename(command).toLowerCase() !== "synctex.exe")
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes SyncTeX command is not synctex.exe");
	return command;
}

function assertSyncTexBytes(bytes: Uint8Array | null, expectedHash: string): Uint8Array {
	if (!bytes || bytes.byteLength < 2 || bytes.byteLength > MAX_SYNCTEX_BYTES)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes SyncTeX mapping is missing or too large");
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes SyncTeX mapping is not gzip data");
	if (expectedHash !== `sha256:${sha256Hex(bytes)}`)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes SyncTeX mapping failed its content hash");
	return cloneBytes(bytes);
}

function assertSyncTexQuery(value: unknown): TeacherNotesSyncTexQuery {
	if (!isRecord(value))
		throw new TeacherNotesCompilationError("INVALID_INPUT", "SyncTeX query must be a line or page coordinate query");
	const keys = Object.keys(value).sort();
	if (keys.length === 1 && keys[0] === "line") {
		const line = value.line;
		if (!Number.isSafeInteger(line) || (line as number) < 1 || (line as number) > 10_000_000)
			throw new TeacherNotesCompilationError("INVALID_INPUT", "SyncTeX line must be an integer from 1 to 10000000");
		return { line: line as number };
	}
	if (keys.length === 3 && keys[0] === "page" && keys[1] === "x" && keys[2] === "y") {
		const page = value.page;
		const x = value.x;
		const y = value.y;
		if (!Number.isSafeInteger(page) || (page as number) < 1 || (page as number) > 10_000_000)
			throw new TeacherNotesCompilationError("INVALID_INPUT", "SyncTeX page must be an integer from 1 to 10000000");
		for (const [field, coordinate] of [
			["x", x],
			["y", y],
		] as const)
			if (
				typeof coordinate !== "number" ||
				!Number.isFinite(coordinate) ||
				coordinate < 0 ||
				coordinate > MAX_SYNCTEX_COORDINATE
			)
				throw new TeacherNotesCompilationError(
					"INVALID_INPUT",
					`SyncTeX ${field} must be a PDF point from 0 to ${MAX_SYNCTEX_COORDINATE}`,
				);
		return { page: page as number, x: x as number, y: y as number };
	}
	throw new TeacherNotesCompilationError("INVALID_INPUT", "SyncTeX query must contain exactly line or page,x,y");
}

function numericField(block: string, field: string): number | null {
	const match = new RegExp(`^${field}:([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)\\s*$`, "mu").exec(block);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

function integerField(block: string, field: string): number | null {
	const value = numericField(block, field);
	return value !== null && Number.isSafeInteger(value) ? value : null;
}

function syncTexOutputBlocks(output: string): string[] {
	const begin = output.indexOf("SyncTeX result begin");
	const end = output.indexOf("SyncTeX result end", begin < 0 ? 0 : begin);
	const body = begin >= 0 ? output.slice(begin, end >= 0 ? end : undefined) : output;
	return body.split(/^Output:/mu).slice(1);
}

function parseForwardResult(output: string, pageCount: number | null): TeacherNotesSyncTexLocation {
	for (const block of syncTexOutputBlocks(output)) {
		const page = integerField(block, "Page");
		const horizontal = numericField(block, "h");
		const vertical = numericField(block, "v");
		const width = numericField(block, "W");
		const height = numericField(block, "H");
		const topLeftY = vertical !== null && height !== null ? vertical - height : null;
		if (
			page !== null &&
			(pageCount === null || page <= pageCount) &&
			horizontal !== null &&
			vertical !== null &&
			width !== null &&
			height !== null &&
			horizontal >= 0 &&
			horizontal <= MAX_SYNCTEX_COORDINATE &&
			topLeftY !== null &&
			Number.isFinite(topLeftY) &&
			topLeftY >= 0 &&
			topLeftY <= MAX_SYNCTEX_COORDINATE &&
			width >= 0 &&
			width <= MAX_SYNCTEX_COORDINATE &&
			height >= 0 &&
			height <= MAX_SYNCTEX_COORDINATE
		)
			return { page, x: horizontal, y: topLeftY, width, height };
	}
	throw new TeacherNotesCompilationError("SYNCTEX_RESULT_INVALID", "SyncTeX returned no bounded forward location");
}

function parseBackwardResult(
	output: string,
	sourceLineCount: number,
	expectedSourceName: string,
): TeacherNotesSyncTexLocation {
	for (const block of syncTexOutputBlocks(output)) {
		const input = /^Input:(.+?)\s*$/mu.exec(block)?.[1]?.trim();
		const line = integerField(block, "Line");
		const column = integerField(block, "Column");
		const sourceName = input
			?.replace(/[\\/]+$/u, "")
			.split(/[\\/]/u)
			.at(-1);
		if (
			sourceName !== expectedSourceName ||
			line === null ||
			line < 1 ||
			line > sourceLineCount ||
			column === null ||
			column < -1
		)
			continue;
		return { line, column };
	}
	if (syncTexOutputBlocks(output).some((block) => /^Input:/mu.test(block)))
		throw new TeacherNotesCompilationError(
			"SYNCTEX_SOURCE_MISMATCH",
			`SyncTeX returned a source other than ${expectedSourceName}`,
		);
	throw new TeacherNotesCompilationError("SYNCTEX_RESULT_INVALID", "SyncTeX returned no bounded backward location");
}

function assertAllocatedSyncTexDirectory(directory: string): void {
	const root = resolve(tmpdir());
	const candidate = resolve(directory);
	const relativePath = relative(root, candidate);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath) ||
		!basename(candidate).startsWith("pi-own-tex-synctex-")
	)
		throw new TeacherNotesCompilationError(
			"CLEANUP_TARGET_INVALID",
			"Refusing to remove an unexpected SyncTeX temp path",
		);
}

function runBoundedSyncTexProcess(options: {
	command: string;
	args: readonly string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
}): Promise<SyncTexProcessResult> {
	return new Promise((resolveProcess, rejectProcess) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(options.command, [...options.args], {
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
			});
		} catch (error) {
			rejectProcess(
				new TeacherNotesCompilationError("SYNCTEX_START_FAILED", `Unable to start SyncTeX: ${String(error)}`, {
					cause: error,
				}),
			);
			return;
		}
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		let timedOut = false;
		let outputLimited = false;
		const finish = (result: SyncTexProcessResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveProcess(result);
		};
		const killForLimit = (): void => {
			if (settled || outputLimited) return;
			outputLimited = true;
			child.kill("SIGKILL");
		};
		const append = (target: Buffer[], chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > SYNCTEX_MAX_OUTPUT_BYTES) {
				killForLimit();
				return;
			}
			target.push(chunk);
		};
		const timer = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			child.kill("SIGKILL");
		}, SYNCTEX_TIMEOUT_MS);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectProcess(
				new TeacherNotesCompilationError("SYNCTEX_START_FAILED", `Unable to start SyncTeX: ${error.message}`, {
					cause: error,
				}),
			);
		});
		child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
		child.once("close", (exitCode) => {
			finish({
				exitCode,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
				outputLimited,
			});
		});
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
	if (!isRecord(value)) throw new TeacherNotesCompilationError("CORRUPT_STATE", `${path} must be an object`);
	for (const key of Object.keys(value))
		if (!keys.includes(key)) throw new TeacherNotesCompilationError("CORRUPT_STATE", `${path}.${key} is not allowed`);
	return value;
}

function text(value: unknown, path: string, maxLength = 4_000): string {
	if (typeof value !== "string" || !value || value.length > maxLength)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", `${path} must be a non-empty string`);
	return value;
}

function hash(value: unknown, path: string): string {
	const result = text(value, path, 80);
	if (!/^sha256:[0-9a-f]{64}$/u.test(result))
		throw new TeacherNotesCompilationError("CORRUPT_STATE", `${path} is not a SHA-256 hash`);
	return result;
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", `${path} must be a positive integer`);
	return value as number;
}

function nullableInteger(value: unknown, path: string): number | null {
	if (value === null) return null;
	return positiveInteger(value, path);
}

function timestamp(value: unknown, path: string): string {
	const result = text(value, path, 128);
	if (!Number.isFinite(Date.parse(result)))
		throw new TeacherNotesCompilationError("CORRUPT_STATE", `${path} must be ISO-8601`);
	return result;
}

function withoutContentHash(receipt: TeacherNotesCompileReceipt): Omit<TeacherNotesCompileReceipt, "contentHash"> {
	const { contentHash: _contentHash, ...payload } = receipt;
	return payload;
}

function cloneReceipt(receipt: TeacherNotesCompileReceipt): TeacherNotesCompileReceipt {
	return {
		...receipt,
		arguments: [...receipt.arguments],
		diagnostics: receipt.diagnostics.map((item) => ({ ...item })),
	};
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
	if (left === null || right === null) return left === right;
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}

function assertPdfBytes(bytes: Uint8Array | null, receipt: Pick<SyncTexReceipt, "pdfHash">): void {
	if (!bytes || bytes.byteLength < 5 || bytes.byteLength > MAX_PDF_BYTES)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Successful teacher notes receipt has no bounded PDF");
	if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Successful teacher notes receipt has an invalid PDF");
	if (receipt.pdfHash !== `sha256:${sha256Hex(bytes)}`)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes PDF failed its content hash");
}

function parseDiagnostic(value: unknown, path: string): CompileDiagnostic {
	const data = exactRecord(value, ["code", "severity", "message"], path);
	const severity = data.severity;
	if (severity !== "critical" && severity !== "major" && severity !== "minor")
		throw new TeacherNotesCompilationError("CORRUPT_STATE", `${path}.severity is invalid`);
	return {
		code: text(data.code, `${path}.code`, 128),
		severity,
		message: text(data.message, `${path}.message`, 12_000),
	};
}

function parseReceiptMetadata(row: TeacherNotesCompileMetadataRow): TeacherNotesCompileReceipt {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.payload);
	} catch (error) {
		throw new TeacherNotesCompilationError("CORRUPT_STATE", `Teacher notes compile payload is not valid JSON`, {
			cause: error,
		});
	}
	const data = exactRecord(
		parsed,
		[
			"receiptId",
			"projectId",
			"notesId",
			"notesRevision",
			"sourceHash",
			"deckId",
			"deckRevision",
			"deckSourceHash",
			"compiler",
			"arguments",
			"succeeded",
			"exitCode",
			"pageCount",
			"pdfHash",
			"logHash",
			"diagnostics",
			"createdAt",
			"contentHash",
		],
		"teacher notes compile receipt",
	);
	if (typeof data.succeeded !== "boolean")
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "teacher notes compile receipt.succeeded is invalid");
	if (data.exitCode !== null && !Number.isSafeInteger(data.exitCode))
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "teacher notes compile receipt.exitCode is invalid");
	if (!Array.isArray(data.arguments) || data.arguments.length > 32)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "teacher notes compile receipt.arguments is invalid");
	const args = data.arguments.map((item, index) =>
		text(item, `teacher notes compile receipt.arguments[${index}]`, 4_000),
	);
	if (!Array.isArray(data.diagnostics) || data.diagnostics.length > 1_000)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "teacher notes compile receipt.diagnostics is invalid");
	const receipt: TeacherNotesCompileReceipt = {
		receiptId: text(data.receiptId, "teacher notes compile receipt.receiptId", 256),
		projectId: text(data.projectId, "teacher notes compile receipt.projectId", 256),
		notesId: text(data.notesId, "teacher notes compile receipt.notesId", 256),
		notesRevision: positiveInteger(data.notesRevision, "teacher notes compile receipt.notesRevision"),
		sourceHash: hash(data.sourceHash, "teacher notes compile receipt.sourceHash"),
		deckId: text(data.deckId, "teacher notes compile receipt.deckId", 256),
		deckRevision: positiveInteger(data.deckRevision, "teacher notes compile receipt.deckRevision"),
		deckSourceHash: hash(data.deckSourceHash, "teacher notes compile receipt.deckSourceHash"),
		compiler: text(data.compiler, "teacher notes compile receipt.compiler", 256),
		arguments: args,
		succeeded: data.succeeded,
		exitCode: data.exitCode as number | null,
		pageCount: nullableInteger(data.pageCount, "teacher notes compile receipt.pageCount"),
		pdfHash: data.pdfHash === null ? null : hash(data.pdfHash, "teacher notes compile receipt.pdfHash"),
		logHash: hash(data.logHash, "teacher notes compile receipt.logHash"),
		diagnostics: data.diagnostics.map((item, index) =>
			parseDiagnostic(item, `teacher notes compile receipt.diagnostics[${index}]`),
		),
		createdAt: timestamp(data.createdAt, "teacher notes compile receipt.createdAt"),
		contentHash: hash(data.contentHash, "teacher notes compile receipt.contentHash"),
	};
	if (row.receipt_id !== receipt.receiptId || row.project_id !== receipt.projectId || row.notes_id !== receipt.notesId)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes compile receipt identity is inconsistent");
	if (contentHash(withoutContentHash(receipt)) !== receipt.contentHash)
		throw new TeacherNotesCompilationError(
			"CORRUPT_STATE",
			"Teacher notes compile receipt has an invalid content hash",
		);
	if (receipt.succeeded && (receipt.exitCode !== 0 || !receipt.pdfHash))
		throw new TeacherNotesCompilationError(
			"CORRUPT_STATE",
			"Successful teacher notes receipt has invalid result fields",
		);
	if (!receipt.succeeded && receipt.pdfHash !== null)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Failed teacher notes receipts cannot expose a PDF");
	return receipt;
}

function validateStoredLog(row: { log: string }, receipt: TeacherNotesCompileReceipt): void {
	if (typeof row.log !== "string" || Buffer.byteLength(row.log, "utf8") > MAX_LOG_BYTES)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes compile log exceeds its bound");
	if (receipt.logHash !== `sha256:${sha256Hex(row.log)}`)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes compile log failed its content hash");
}

function validateStoredPdf(row: { pdf: Uint8Array | null }, receipt: TeacherNotesCompileReceipt): void {
	if (receipt.succeeded) {
		if (receipt.exitCode !== 0 || !receipt.pdfHash) {
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Successful teacher notes receipt has invalid result fields",
			);
		}
		assertPdfBytes(row.pdf, receipt);
	} else if (row.pdf !== null || receipt.pdfHash !== null) {
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Failed teacher notes receipts cannot expose a PDF");
	}
}

function parseReceipt(row: TeacherNotesCompileRow): TeacherNotesCompileReceipt {
	const receipt = parseReceiptMetadata(row);
	validateStoredLog(row, receipt);
	validateStoredPdf(row, receipt);
	return receipt;
}

function sourceHashOf(notes: TeacherNotes): string {
	if (notes.sourceHash !== `sha256:${sha256Hex(notes.source)}`)
		throw new TeacherNotesCompilationError("SOURCE_HASH_MISMATCH", "Teacher notes source does not match its hash");
	return notes.sourceHash;
}

function requireCurrentNotes(snapshot: CourseBuilderSnapshot, notesId: string, expectedRevision: number): TeacherNotes {
	const candidates = snapshot.teacherNotes.filter((item) => item.notesId === notesId);
	if (!candidates.length)
		throw new TeacherNotesCompilationError("TEACHER_NOTES_NOT_FOUND", "Teacher notes were not found in this course");
	const notes = [...candidates].sort((left, right) => right.revision - left.revision)[0];
	if (candidates.filter((item) => item.revision === notes.revision).length !== 1)
		throw new TeacherNotesCompilationError("CORRUPT_STATE", "Duplicate current teacher notes revision");
	if (notes.projectId !== snapshot.project.projectId)
		throw new TeacherNotesCompilationError("PROJECT_MISMATCH", "Teacher notes belong to another project");
	if (notes.revision !== expectedRevision)
		throw new TeacherNotesCompilationError(
			"REVISION_CONFLICT",
			`Teacher notes revision conflict: expected ${expectedRevision}, actual ${notes.revision}`,
		);
	sourceHashOf(notes);
	return notes;
}

function requireObservedDeck(
	snapshot: CourseBuilderSnapshot,
	notes: TeacherNotes,
): { revision: number; sourceHash: string } {
	const decks = snapshot.decks.filter((item) => item.deckId === notes.deckId);
	if (decks.length !== 1 || decks[0].projectId !== snapshot.project.projectId)
		throw new TeacherNotesCompilationError("DECK_NOT_FOUND", "The teacher notes originating deck is unavailable");
	const deck = decks[0];
	if (typeof deck.sourceHash !== "string" || deck.sourceHash !== `sha256:${sha256Hex(deck.source)}`)
		throw new TeacherNotesCompilationError(
			"CORRUPT_STATE",
			"The teacher notes originating deck has an invalid source hash",
		);
	return { revision: deck.revision, sourceHash: deck.sourceHash };
}

function assertCompileSnapshot(
	snapshot: CourseBuilderSnapshot | null,
	notes: TeacherNotes,
	expectedRevision: number,
	expectedSourceHash: string,
	observedDeck: { revision: number; sourceHash: string },
): asserts snapshot is CourseBuilderSnapshot {
	if (!snapshot) throw new TeacherNotesCompilationError("PROJECT_BINDING_REQUIRED", "Open the course workspace first");
	const currentNotes = requireCurrentNotes(snapshot, notes.notesId, expectedRevision);
	if (
		currentNotes.sourceHash !== expectedSourceHash ||
		currentNotes.deckId !== notes.deckId ||
		currentNotes.deckRevision !== notes.deckRevision ||
		currentNotes.deckSourceHash !== notes.deckSourceHash
	)
		throw new TeacherNotesCompilationError(
			"STALE_TEACHER_NOTES",
			"Teacher notes changed before compilation was persisted",
		);
	const currentDeck = requireObservedDeck(snapshot, notes);
	if (currentDeck.revision !== observedDeck.revision || currentDeck.sourceHash !== observedDeck.sourceHash)
		throw new TeacherNotesCompilationError(
			"STALE_DECK",
			"The originating deck changed during teacher notes compilation",
		);
}

function requireReceiptNotes(snapshot: CourseBuilderSnapshot, receipt: TeacherNotesCompileReceipt): TeacherNotes {
	if (receipt.projectId !== snapshot.project.projectId)
		throw new TeacherNotesCompilationError(
			"PROJECT_MISMATCH",
			"Teacher notes compile receipt belongs to another project",
		);
	const notes = requireCurrentNotes(snapshot, receipt.notesId, receipt.notesRevision);
	if (
		notes.projectId !== receipt.projectId ||
		notes.sourceHash !== receipt.sourceHash ||
		notes.deckId !== receipt.deckId ||
		notes.deckRevision !== receipt.deckRevision ||
		notes.deckSourceHash !== receipt.deckSourceHash
	)
		throw new TeacherNotesCompilationError(
			"STALE_TEACHER_NOTES",
			"Teacher notes revision or source hash no longer matches the SyncTeX receipt",
		);
	return notes;
}

function hasCurrentReceiptNotes(snapshot: CourseBuilderSnapshot, receipt: TeacherNotesCompileReceipt): boolean {
	try {
		requireReceiptNotes(snapshot, receipt);
		return true;
	} catch (error) {
		if (
			error instanceof TeacherNotesCompilationError &&
			(error.code === "REVISION_CONFLICT" ||
				error.code === "STALE_TEACHER_NOTES" ||
				error.code === "TEACHER_NOTES_NOT_FOUND")
		)
			return false;
		throw error;
	}
}

function requireReceiptDeck(snapshot: CourseBuilderSnapshot, receipt: BeamerCompileReceipt): BeamerDeck {
	if (receipt.projectId !== snapshot.project.projectId)
		throw new TeacherNotesCompilationError("PROJECT_MISMATCH", "Beamer compile receipt belongs to another project");
	const decks = snapshot.decks.filter((item) => item.deckId === receipt.deckId);
	if (decks.length !== 1 || decks[0].projectId !== snapshot.project.projectId)
		throw new TeacherNotesCompilationError("DECK_NOT_FOUND", "The Beamer deck is unavailable for SyncTeX lookup");
	const deck = decks[0];
	if (deck.sourceHash !== `sha256:${sha256Hex(deck.source)}`)
		throw new TeacherNotesCompilationError("SOURCE_HASH_MISMATCH", "Beamer source does not match its hash");
	if (deck.revision !== receipt.deckRevision || deck.sourceHash !== receipt.sourceHash)
		throw new TeacherNotesCompilationError(
			"STALE_DECK",
			"Beamer revision or source hash no longer matches the SyncTeX receipt",
		);
	return deck;
}

function hasCurrentReceiptDeck(snapshot: CourseBuilderSnapshot, receipt: BeamerCompileReceipt): boolean {
	try {
		requireReceiptDeck(snapshot, receipt);
		return true;
	} catch (error) {
		if (
			error instanceof TeacherNotesCompilationError &&
			(error.code === "PROJECT_MISMATCH" || error.code === "DECK_NOT_FOUND" || error.code === "STALE_DECK")
		)
			return false;
		throw error;
	}
}

/** Durable, append-only teacher lecture-script compilation receipts. */
export class CourseTeacherNotesCompiler {
	private readonly database: DatabaseSync;

	constructor(database: DatabaseSync) {
		this.database = database;
		database.exec(
			"CREATE TABLE IF NOT EXISTS course_builder_teacher_notes_compile (receipt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, notes_id TEXT NOT NULL, payload TEXT NOT NULL, log TEXT NOT NULL, pdf BLOB)",
		);
		database.exec(
			"CREATE TABLE IF NOT EXISTS course_builder_teacher_notes_compile_synctex (receipt_id TEXT NOT NULL, project_id TEXT NOT NULL, source_hash TEXT NOT NULL, sync_tex BLOB NOT NULL, sync_tex_hash TEXT NOT NULL, sync_tex_command TEXT NOT NULL, PRIMARY KEY(receipt_id, project_id, source_hash))",
		);
	}

	private readRow(row: TeacherNotesCompileRow): StoredTeacherNotesCompile {
		const receipt = parseReceipt(row);
		return { receipt, log: row.log, pdf: row.pdf ? cloneBytes(row.pdf) : null };
	}

	private readById(receiptId: string): StoredTeacherNotesCompile | null {
		const row = this.database
			.prepare(
				"SELECT receipt_id,project_id,notes_id,payload,log,pdf FROM course_builder_teacher_notes_compile WHERE receipt_id=?",
			)
			.get(receiptId) as TeacherNotesCompileRow | undefined;
		return row ? this.readRow(row) : null;
	}

	private readMetadataById(receiptId: string, projectId: string): TeacherNotesCompileReceipt | null {
		const row = this.database
			.prepare(
				"SELECT receipt_id,project_id,notes_id,payload FROM course_builder_teacher_notes_compile WHERE receipt_id=? AND project_id=?",
			)
			.get(receiptId, projectId) as TeacherNotesCompileMetadataRow | undefined;
		return row ? parseReceiptMetadata(row) : null;
	}

	private readLogById(
		receiptId: string,
		projectId: string,
	): { receipt: TeacherNotesCompileReceipt; log: string } | null {
		const row = this.database
			.prepare(
				"SELECT receipt_id,project_id,notes_id,payload,log FROM course_builder_teacher_notes_compile WHERE receipt_id=? AND project_id=?",
			)
			.get(receiptId, projectId) as TeacherNotesCompileLogRow | undefined;
		if (!row) return null;
		const receipt = parseReceiptMetadata(row);
		validateStoredLog(row, receipt);
		return { receipt, log: row.log };
	}

	private readPdfById(
		receiptId: string,
		projectId: string,
	): { receipt: TeacherNotesCompileReceipt; pdf: Uint8Array | null } | null {
		const row = this.database
			.prepare(
				"SELECT receipt_id,project_id,notes_id,payload,pdf FROM course_builder_teacher_notes_compile WHERE receipt_id=? AND project_id=?",
			)
			.get(receiptId, projectId) as TeacherNotesCompilePdfRow | undefined;
		if (!row) return null;
		const receipt = parseReceiptMetadata(row);
		validateStoredPdf(row, receipt);
		return { receipt, pdf: row.pdf ? cloneBytes(row.pdf) : null };
	}

	private readSyncTexMetadataById(receipt: SyncTexReceipt): TeacherNotesSyncTexMetadataRow | null {
		const rows = this.database
			.prepare(
				"SELECT receipt_id,project_id,source_hash,length(sync_tex) AS sync_tex_size,sync_tex_hash,sync_tex_command FROM course_builder_teacher_notes_compile_synctex WHERE receipt_id=? AND project_id=?",
			)
			.all(receipt.receiptId, receipt.projectId) as unknown as TeacherNotesSyncTexMetadataRow[];
		if (!rows.length) return null;
		if (rows.length !== 1)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping has duplicate receipt rows",
			);
		const row = rows[0];
		if (row.receipt_id !== receipt.receiptId || row.project_id !== receipt.projectId)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping identity is inconsistent",
			);
		if (row.source_hash !== receipt.sourceHash)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping source hash does not match its receipt",
			);
		hash(row.source_hash, "teacher notes SyncTeX mapping.source_hash");
		const syncTexSize = row.sync_tex_size;
		if (
			syncTexSize === null ||
			!Number.isSafeInteger(syncTexSize) ||
			syncTexSize < 2 ||
			syncTexSize > MAX_SYNCTEX_BYTES
		)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping is missing or too large",
			);
		hash(row.sync_tex_hash, "teacher notes SyncTeX mapping.sync_tex_hash");
		assertStoredSyncTexCommand(row.sync_tex_command);
		return row;
	}

	private readSyncTexById(receipt: SyncTexReceipt): StoredTeacherNotesSyncTex | null {
		const rows = this.database
			.prepare(
				"SELECT receipt_id,project_id,source_hash,sync_tex,sync_tex_hash,sync_tex_command FROM course_builder_teacher_notes_compile_synctex WHERE receipt_id=? AND project_id=?",
			)
			.all(receipt.receiptId, receipt.projectId) as unknown as TeacherNotesSyncTexRow[];
		if (!rows.length) return null;
		if (rows.length !== 1)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping has duplicate receipt rows",
			);
		const row = rows[0];
		if (row.receipt_id !== receipt.receiptId || row.project_id !== receipt.projectId)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping identity is inconsistent",
			);
		if (row.source_hash !== receipt.sourceHash)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping source hash does not match its receipt",
			);
		const sourceHash = hash(row.source_hash, "teacher notes SyncTeX mapping.source_hash");
		const bytes = assertSyncTexBytes(row.sync_tex, row.sync_tex_hash);
		if (sourceHash !== receipt.sourceHash)
			throw new TeacherNotesCompilationError(
				"CORRUPT_STATE",
				"Teacher notes SyncTeX mapping source hash does not match its receipt",
			);
		return { bytes, command: assertStoredSyncTexCommand(row.sync_tex_command) };
	}

	list(snapshot: CourseBuilderSnapshot): TeacherNotesCompileReceipt[] {
		const rows = this.database
			.prepare(
				"SELECT receipt_id,project_id,notes_id,payload FROM course_builder_teacher_notes_compile WHERE project_id=?",
			)
			.all(snapshot.project.projectId) as unknown as TeacherNotesCompileMetadataRow[];
		return rows
			.map((row) => parseReceiptMetadata(row))
			.sort(
				(left, right) =>
					left.createdAt.localeCompare(right.createdAt) || left.receiptId.localeCompare(right.receiptId),
			)
			.map(cloneReceipt);
	}

	getReceipt(snapshot: CourseBuilderSnapshot, receiptId: string): TeacherNotesCompileReceipt {
		if (!receiptId.trim()) throw new TeacherNotesCompilationError("INVALID_INPUT", "receiptId is required");
		const receipt = this.readMetadataById(receiptId, snapshot.project.projectId);
		if (!receipt)
			throw new TeacherNotesCompilationError(
				"TEACHER_NOTES_COMPILE_NOT_FOUND",
				"Teacher notes compile receipt is unavailable in this project",
			);
		return cloneReceipt(receipt);
	}

	getPdf(snapshot: CourseBuilderSnapshot, receiptId: string): Uint8Array {
		if (!receiptId.trim()) throw new TeacherNotesCompilationError("INVALID_INPUT", "receiptId is required");
		const stored = this.readPdfById(receiptId, snapshot.project.projectId);
		if (!stored)
			throw new TeacherNotesCompilationError(
				"TEACHER_NOTES_COMPILE_NOT_FOUND",
				"Teacher notes compile receipt is unavailable in this project",
			);
		if (!stored.receipt.succeeded)
			throw new TeacherNotesCompilationError("PDF_UNAVAILABLE", "A failed teacher notes compilation has no PDF");
		assertPdfBytes(stored.pdf, stored.receipt);
		return cloneBytes(stored.pdf!);
	}

	getLog(snapshot: CourseBuilderSnapshot, receiptId: string): string {
		if (!receiptId.trim()) throw new TeacherNotesCompilationError("INVALID_INPUT", "receiptId is required");
		const stored = this.readLogById(receiptId, snapshot.project.projectId);
		if (!stored)
			throw new TeacherNotesCompilationError(
				"TEACHER_NOTES_COMPILE_NOT_FOUND",
				"Teacher notes compile receipt is unavailable in this project",
			);
		return stored.log;
	}

	hasSyncTex(snapshot: CourseBuilderSnapshot, receiptId: string): boolean {
		if (typeof receiptId !== "string" || !receiptId.trim())
			throw new TeacherNotesCompilationError("INVALID_INPUT", "receiptId is required");
		const receipt = this.readMetadataById(receiptId, snapshot.project.projectId);
		if (!receipt || !receipt.succeeded) return false;
		if (!this.readSyncTexMetadataById(receipt)) return false;
		return hasCurrentReceiptNotes(snapshot, receipt);
	}

	prepareBeamerSyncTex(
		receipt: BeamerCompileReceipt,
		bytes: Uint8Array | undefined,
		command: string | undefined,
	): BeamerSyncTexArtifact {
		if (!receipt.succeeded || receipt.exitCode !== 0 || !receipt.pdfHash)
			throw new TeacherNotesCompilationError(
				"SYNCTEX_UNAVAILABLE",
				"A successful Beamer receipt is required for SyncTeX",
			);
		if (!/^sha256:[0-9a-f]{64}$/u.test(receipt.sourceHash))
			throw new TeacherNotesCompilationError("SOURCE_HASH_MISMATCH", "Beamer receipt has an invalid source hash");
		if (!bytes)
			throw new TeacherNotesCompilationError(
				"COMPILE_SYNCTEX_REQUIRED",
				"Successful Beamer compilation produced no SyncTeX mapping",
			);
		if (!command)
			throw new TeacherNotesCompilationError(
				"SYNCTEX_COMMAND_REQUIRED",
				"Successful Beamer SyncTeX mapping has no executable command",
			);
		return {
			receiptId: receipt.receiptId,
			projectId: receipt.projectId,
			sourceHash: receipt.sourceHash,
			bytes: assertSyncTexBytes(bytes, `sha256:${sha256Hex(bytes)}`),
			command: assertStoredSyncTexCommand(command),
		};
	}

	/** Called by CourseBuilderHost while its compile receipt transaction is open. */
	persistBeamerSyncTex(artifact: BeamerSyncTexArtifact): void {
		const rows = this.database
			.prepare(
				"SELECT receipt_id,project_id,source_hash,sync_tex,sync_tex_hash,sync_tex_command FROM course_builder_teacher_notes_compile_synctex WHERE receipt_id=? AND project_id=?",
			)
			.all(artifact.receiptId, artifact.projectId) as unknown as TeacherNotesSyncTexRow[];
		if (rows.length > 1)
			throw new TeacherNotesCompilationError("CORRUPT_STATE", "Beamer SyncTeX mapping has duplicate receipt rows");
		if (rows.length === 1) {
			const existing = rows[0];
			if (
				existing.receipt_id !== artifact.receiptId ||
				existing.project_id !== artifact.projectId ||
				existing.source_hash !== artifact.sourceHash ||
				!bytesEqual(assertSyncTexBytes(existing.sync_tex, existing.sync_tex_hash), artifact.bytes) ||
				assertStoredSyncTexCommand(existing.sync_tex_command) !== artifact.command
			)
				throw new TeacherNotesCompilationError(
					"RECEIPT_CONFLICT",
					"Beamer SyncTeX receipt collision has different bytes",
				);
			return;
		}
		this.database
			.prepare(
				"INSERT INTO course_builder_teacher_notes_compile_synctex(receipt_id,project_id,source_hash,sync_tex,sync_tex_hash,sync_tex_command) VALUES(?,?,?,?,?,?)",
			)
			.run(
				artifact.receiptId,
				artifact.projectId,
				artifact.sourceHash,
				artifact.bytes,
				`sha256:${sha256Hex(artifact.bytes)}`,
				artifact.command,
			);
	}

	hasBeamerSyncTex(snapshot: CourseBuilderSnapshot, receipt: BeamerCompileReceipt): boolean {
		if (!receipt.succeeded) return false;
		if (!this.readSyncTexMetadataById(receipt)) return false;
		return hasCurrentReceiptDeck(snapshot, receipt);
	}

	async locateBeamer(
		snapshot: CourseBuilderSnapshot,
		receipt: BeamerCompileReceipt,
		pdf: Uint8Array,
		query: TeacherNotesSyncTexQuery,
	): Promise<TeacherNotesSyncTexLocation> {
		const normalizedQuery = assertSyncTexQuery(query);
		if (!receipt.succeeded)
			throw new TeacherNotesCompilationError(
				"SYNCTEX_UNAVAILABLE",
				"This Beamer compilation failed; recompile before using SyncTeX",
			);
		const deck = requireReceiptDeck(snapshot, receipt);
		const mapping = this.readSyncTexById(receipt);
		if (!mapping)
			throw new TeacherNotesCompilationError(
				"SYNCTEX_UNAVAILABLE",
				"No SyncTeX mapping is stored for this receipt; recompile Beamer before locating",
			);
		return this.locateStored(receipt, mapping, deck.source, pdf, "deck.tex", normalizedQuery);
	}

	private async locateStored(
		receipt: SyncTexReceipt,
		mapping: StoredTeacherNotesSyncTex,
		source: string,
		pdf: Uint8Array,
		sourceName: "teacher-notes.tex" | "deck.tex",
		query: TeacherNotesSyncTexQuery,
	): Promise<TeacherNotesSyncTexLocation> {
		assertPdfBytes(pdf, receipt);
		let directory: string | null = null;
		try {
			directory = await mkdtemp(join(tmpdir(), "pi-own-tex-synctex-"));
			const lookupDirectory = join(directory, "temp");
			const stem = sourceName.slice(0, -4);
			await mkdir(lookupDirectory);
			await writeFile(join(directory, sourceName), source, "utf8");
			await writeFile(join(lookupDirectory, `${stem}.pdf`), pdf);
			await writeFile(join(lookupDirectory, `${stem}.synctex.gz`), mapping.bytes);
			const environment: NodeJS.ProcessEnv = {
				PATH: process.env.PATH,
				SYSTEMROOT: process.env.SYSTEMROOT,
				WINDIR: process.env.WINDIR,
				HOME: directory,
				TMPDIR: directory,
				TEMP: directory,
				TMP: directory,
				NODE_ENV: process.env.NODE_ENV ?? "production",
			};
			const processResult = await runBoundedSyncTexProcess({
				command: mapping.command,
				cwd: directory,
				args:
					"line" in query
						? ["view", "-i", `${query.line}:0:${sourceName}`, "-o", `temp/${stem}.pdf`]
						: ["edit", "-o", `${query.page}:${query.x}:${query.y}:temp/${stem}.pdf`],
				env: environment,
			});
			if (processResult.timedOut)
				throw new TeacherNotesCompilationError(
					"SYNCTEX_TIMEOUT",
					"SyncTeX exceeded its 10 second execution budget",
				);
			if (processResult.outputLimited)
				throw new TeacherNotesCompilationError("SYNCTEX_OUTPUT_LIMIT", "SyncTeX exceeded its 1 MiB output budget");
			if (processResult.exitCode !== 0)
				throw new TeacherNotesCompilationError(
					"SYNCTEX_QUERY_FAILED",
					`SyncTeX exited with code ${processResult.exitCode ?? "null"}: ${`${processResult.stdout}\n${processResult.stderr}`.trim().slice(0, 4_000)}`,
				);
			const output = `${processResult.stdout}\n${processResult.stderr}`;
			return "line" in query
				? parseForwardResult(output, receipt.pageCount)
				: parseBackwardResult(output, source.split(/\r?\n/u).length, sourceName);
		} finally {
			if (directory) {
				assertAllocatedSyncTexDirectory(directory);
				await rm(directory, { recursive: true, force: true });
			}
		}
	}

	async locate(
		snapshot: CourseBuilderSnapshot,
		receiptId: string,
		query: TeacherNotesSyncTexQuery,
	): Promise<TeacherNotesSyncTexLocation> {
		const normalizedQuery = assertSyncTexQuery(query);
		if (typeof receiptId !== "string" || !receiptId.trim())
			throw new TeacherNotesCompilationError("INVALID_INPUT", "receiptId is required");
		const receipt = this.getReceipt(snapshot, receiptId);
		if (!receipt.succeeded)
			throw new TeacherNotesCompilationError(
				"SYNCTEX_UNAVAILABLE",
				"This teacher notes compilation failed; recompile before using SyncTeX",
			);
		const mapping = this.readSyncTexById(receipt);
		if (!mapping)
			throw new TeacherNotesCompilationError(
				"SYNCTEX_UNAVAILABLE",
				"No SyncTeX mapping is stored for this receipt; recompile teacher notes before locating",
			);
		const storedPdf = this.readPdfById(receiptId, snapshot.project.projectId);
		if (!storedPdf?.pdf) throw new TeacherNotesCompilationError("CORRUPT_STATE", "Teacher notes PDF is unavailable");
		const notes = requireReceiptNotes(snapshot, receipt);
		return this.locateStored(receipt, mapping, notes.source, storedPdf.pdf, "teacher-notes.tex", normalizedQuery);
	}

	async compile(
		getSnapshot: () => CourseBuilderSnapshot | null,
		notesId: string,
		expectedRevision: number,
		options: TeacherNotesCompileOptions,
	): Promise<TeacherNotesCompileReceipt> {
		if (options.trustedTex !== true)
			throw new TeacherNotesCompilationError(
				"TEX_TRUST_REQUIRED",
				"Compiler disabled. The local owner must set PI_COURSE_BUILDER_TRUSTED_TEX=1 for trusted source.",
			);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
			throw new TeacherNotesCompilationError("INVALID_INPUT", "expectedRevision must be a positive integer");
		if (typeof notesId !== "string" || !notesId.trim())
			throw new TeacherNotesCompilationError("INVALID_INPUT", "notesId is required");
		const initialSnapshot = getSnapshot();
		if (!initialSnapshot)
			throw new TeacherNotesCompilationError("PROJECT_BINDING_REQUIRED", "Open the course workspace first");
		const notes = requireCurrentNotes(initialSnapshot, notesId, expectedRevision);
		const observedDeck = requireObservedDeck(initialSnapshot, notes);
		await options.assertActive?.();
		const result = await compileLatexDocument({
			source: notes.source,
			sourceHash: notes.sourceHash,
			documentKind: "teacher-notes",
			compiler: options.compiler,
			env: options.env,
			timeoutMs: options.timeoutMs,
			passes: options.passes,
			maxOutputBytes: options.maxOutputBytes,
			maxPdfBytes: options.maxPdfBytes,
			assets: options.assets,
		});
		await options.assertActive?.();
		const finalSnapshot = getSnapshot();
		assertCompileSnapshot(finalSnapshot, notes, expectedRevision, notes.sourceHash, observedDeck);
		if (result.succeeded && !result.pdfBytes)
			throw new TeacherNotesCompilationError(
				"COMPILE_ARTIFACT_REQUIRED",
				"Successful teacher notes compilation produced no PDF",
			);
		if (result.succeeded && !result.syncTexBytes)
			throw new TeacherNotesCompilationError(
				"COMPILE_SYNCTEX_REQUIRED",
				"Successful teacher notes compilation produced no SyncTeX mapping; recompile with SyncTeX enabled",
			);
		const pdf = result.succeeded ? result.pdfBytes : null;
		const syncTex = result.succeeded ? (result.syncTexBytes ?? null) : null;
		const syncTexCommand = syncTex ? await resolveSyncTexCommand(options.compiler) : null;
		const base = {
			projectId: notes.projectId,
			notesId: notes.notesId,
			notesRevision: notes.revision,
			sourceHash: notes.sourceHash,
			deckId: notes.deckId,
			deckRevision: notes.deckRevision,
			deckSourceHash: notes.deckSourceHash,
			compiler: result.compiler,
			arguments: result.arguments,
			succeeded: result.succeeded,
			exitCode: result.exitCode,
			pageCount: result.pageCount,
			pdfHash: pdf ? `sha256:${sha256Hex(pdf)}` : null,
			logHash: result.logHash,
			diagnostics: result.diagnostics,
			createdAt: result.createdAt,
		};
		const receiptId = deterministicId("teacher-notes-compile", base, 40);
		const receipt: TeacherNotesCompileReceipt = {
			receiptId,
			...base,
			contentHash: contentHash({ receiptId, ...base }),
		};
		return this.persist(getSnapshot, receipt, result.log, pdf, syncTex, syncTexCommand, observedDeck);
	}

	private persist(
		getSnapshot: () => CourseBuilderSnapshot | null,
		receipt: TeacherNotesCompileReceipt,
		log: string,
		pdf: Uint8Array | null,
		syncTex: Uint8Array | null,
		syncTexCommand: string | null,
		observedDeck: { revision: number; sourceHash: string },
	): TeacherNotesCompileReceipt {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const lockedSnapshot = getSnapshot();
			const notes = lockedSnapshot
				? requireCurrentNotes(lockedSnapshot, receipt.notesId, receipt.notesRevision)
				: null;
			if (!notes || notes.sourceHash !== receipt.sourceHash || notes.deckId !== receipt.deckId)
				throw new TeacherNotesCompilationError("STALE_TEACHER_NOTES", "Teacher notes changed before persistence");
			const deck = requireObservedDeck(lockedSnapshot!, notes);
			if (deck.revision !== observedDeck.revision || deck.sourceHash !== observedDeck.sourceHash)
				throw new TeacherNotesCompilationError("STALE_DECK", "The originating deck changed before persistence");
			const existing = this.readById(receipt.receiptId);
			if (existing) {
				const existingSyncTex = this.readSyncTexById(receipt);
				if (
					stableStringify(existing.receipt) !== stableStringify(receipt) ||
					existing.log !== log ||
					!bytesEqual(existing.pdf, pdf) ||
					!bytesEqual(existingSyncTex?.bytes ?? null, syncTex) ||
					(existingSyncTex?.command ?? null) !== syncTexCommand
				)
					throw new TeacherNotesCompilationError(
						"RECEIPT_CONFLICT",
						"Teacher notes compile receipt collision has different bytes",
					);
				this.database.exec("COMMIT");
				return cloneReceipt(existing.receipt);
			}
			this.database
				.prepare(
					"INSERT INTO course_builder_teacher_notes_compile(receipt_id,project_id,notes_id,payload,log,pdf) VALUES(?,?,?,?,?,?)",
				)
				.run(receipt.receiptId, receipt.projectId, receipt.notesId, stableStringify(receipt), log, pdf);
			if (syncTex) {
				if (!syncTexCommand)
					throw new TeacherNotesCompilationError(
						"SYNCTEX_COMMAND_REQUIRED",
						"Successful teacher notes SyncTeX mapping has no executable command",
					);
				assertSyncTexBytes(syncTex, `sha256:${sha256Hex(syncTex)}`);
				this.database
					.prepare(
						"INSERT INTO course_builder_teacher_notes_compile_synctex(receipt_id,project_id,source_hash,sync_tex,sync_tex_hash,sync_tex_command) VALUES(?,?,?,?,?,?)",
					)
					.run(
						receipt.receiptId,
						receipt.projectId,
						receipt.sourceHash,
						syncTex,
						`sha256:${sha256Hex(syncTex)}`,
						assertStoredSyncTexCommand(syncTexCommand),
					);
			}
			this.database.exec("COMMIT");
			return cloneReceipt(receipt);
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollback) {
				throw new AggregateError([error, rollback], "Teacher notes compile persistence and rollback both failed");
			}
			throw error;
		}
	}
}
