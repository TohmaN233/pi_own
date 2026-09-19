import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StudyResearchHost } from "./study-research-host.ts";
import type { Scope, SourceVersion } from "./types.ts";
import { requiredHash, requiredRevision, requiredText } from "./validation.ts";

const TEXT = new TextEncoder();
const MAX_REQUEST_CHARS = 20_000;
const MAX_OPERATIONS = 128;
const MAX_OPERATION_CHARS = 20_000;
const PREPARING_LEASE_MS = 5 * 60 * 1_000;

export type ManuscriptOperation =
	| { kind: "add"; anchor: string; position: "before" | "after"; text: string; reason: string }
	| { kind: "replace"; oldText: string; newText: string; reason: string }
	| { kind: "delete"; oldText: string; reason: string };

export type ManuscriptPatchStatus = "requested" | "preparing" | "draft" | "confirmed" | "recovered" | "failed";

export interface ManuscriptPatch {
	patchId: string;
	projectId: string;
	sessionId: string;
	sourceId: string;
	sourceHash: string;
	targetPath: string;
	kind: "tex" | "docx";
	requestText: string;
	baseFileHash: string;
	finalFileHash: string | null;
	candidateHash: string | null;
	recoveryHash: string | null;
	operations: readonly ManuscriptOperation[];
	status: ManuscriptPatchStatus;
	revision: number;
	createdAt: string;
	updatedAt: string;
	confirmedAt: string | null;
	recoveredAt: string | null;
	diagnostic: string | null;
}

interface StoredManuscriptPatch extends ManuscriptPatch {
	sourcePath: string;
	draftPath: string | null;
	recoveryPath: string | null;
	/** A process-local writer may finish this lease; another process waits for expiry. */
	preparingLeaseId: string | null;
	preparingLeaseExpiresAt: string | null;
	contentHash: string;
}

interface ManuscriptPatchRow {
	patchId: string;
	projectId: string;
	sessionId: string;
	sourceId: string;
	revision: number;
	updatedAt: string;
	payload: string;
	payloadHash: string;
}

export interface ManuscriptPatchHostOptions {
	/** Private artifact directory. It must never be the manuscript source root. */
	storageRoot: string;
	clock?: () => Date;
	/** Test-only synchronous seam for competing writes at publication boundaries. */
	publicationHook?: (input: {
		action: "confirm" | "recover";
		path: string;
		claimPath: string;
		boundary: "claimed" | "before-publish";
	}) => void;
}

/**
 * JSZip remains an app-layer dependency. The Host owns source identity,
 * journals and writes; the source-reader adapter supplies this bounded seam.
 */
export type ManuscriptDocxAdapter = (
	bytes: Uint8Array,
	operations: readonly ManuscriptOperation[],
	date: string,
) => Promise<{ candidate: Uint8Array; clean: Uint8Array }>;

export class ManuscriptPatchError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ManuscriptPatchError";
		this.code = code;
	}
}

interface ResolvedSource {
	source: SourceVersion & { kind: "tex" | "docx" };
	path: string;
	bytes: Uint8Array;
	hash: string;
}

interface ResolvedOperation {
	operation: ManuscriptOperation;
	start: number;
	end: number;
	/** The normal text which occupies start..end in the clean final document. */
	clean: string;
	/** The review-color text which occupies start..end in the candidate document. */
	candidate: string;
}

function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function now(clock: () => Date): string {
	return clock().toISOString();
}

function copy<T>(value: T): T {
	return structuredClone(value);
}

function publicPatch(value: StoredManuscriptPatch): ManuscriptPatch {
	const {
		sourcePath: _sourcePath,
		draftPath: _draftPath,
		recoveryPath: _recoveryPath,
		preparingLeaseId: _preparingLeaseId,
		preparingLeaseExpiresAt: _preparingLeaseExpiresAt,
		contentHash: _contentHash,
		...result
	} = value;
	return copy(result);
}

function withContentHash(value: Omit<StoredManuscriptPatch, "contentHash">): StoredManuscriptPatch {
	return { ...value, contentHash: sha256(TEXT.encode(JSON.stringify(value))) };
}

function pathWithin(root: string, target: string): boolean {
	const result = relative(root, target);
	return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`));
}

function hasSingleOccurrence(value: string, needle: string): number {
	const first = value.indexOf(needle);
	if (first < 0)
		throw new ManuscriptPatchError("PATCH_TARGET_NOT_FOUND", "Patch target was not found in the current source");
	if (value.indexOf(needle, first + needle.length) >= 0) {
		throw new ManuscriptPatchError(
			"PATCH_TARGET_AMBIGUOUS",
			"Patch target occurs more than once; choose a unique bounded target",
		);
	}
	return first;
}

function requiredPatchText(value: unknown, label: string, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > MAX_OPERATION_CHARS || value.includes("\0")) {
		throw new ManuscriptPatchError("PATCH_INPUT_INVALID", `${label} must be a bounded string`);
	}
	if (!allowEmpty && !value.trim())
		throw new ManuscriptPatchError("PATCH_INPUT_INVALID", `${label} must not be empty`);
	return value;
}

function validateOperation(value: ManuscriptOperation, index: number): ManuscriptOperation {
	if (!value || typeof value !== "object")
		throw new ManuscriptPatchError("PATCH_INPUT_INVALID", `operation ${index} is invalid`);
	const reason = requiredPatchText(value.reason, `operation ${index} reason`);
	if (value.kind === "add") {
		if (value.position !== "before" && value.position !== "after")
			throw new ManuscriptPatchError("PATCH_INPUT_INVALID", `operation ${index} position is invalid`);
		return {
			kind: "add",
			anchor: requiredPatchText(value.anchor, `operation ${index} anchor`),
			position: value.position,
			text: requiredPatchText(value.text, `operation ${index} text`),
			reason,
		};
	}
	if (value.kind === "replace") {
		return {
			kind: "replace",
			oldText: requiredPatchText(value.oldText, `operation ${index} oldText`),
			newText: requiredPatchText(value.newText, `operation ${index} newText`),
			reason,
		};
	}
	if (value.kind === "delete") {
		return { kind: "delete", oldText: requiredPatchText(value.oldText, `operation ${index} oldText`), reason };
	}
	throw new ManuscriptPatchError("PATCH_INPUT_INVALID", `operation ${index} kind is invalid`);
}

function validateOperations(value: readonly ManuscriptOperation[]): ManuscriptOperation[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPERATIONS) {
		throw new ManuscriptPatchError("PATCH_INPUT_INVALID", `operations must contain 1..${MAX_OPERATIONS} entries`);
	}
	return value.map(validateOperation);
}

function applyResolved(source: string, operations: readonly ResolvedOperation[], field: "clean" | "candidate"): string {
	let result = source;
	for (const operation of [...operations].sort((left, right) => right.start - left.start || right.end - left.end)) {
		result = `${result.slice(0, operation.start)}${operation[field]}${result.slice(operation.end)}`;
	}
	return result;
}

function assertNonOverlapping(operations: readonly Pick<ResolvedOperation, "start" | "end">[]): void {
	const sorted = [...operations].sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < sorted.length; index++) {
		const previous = sorted[index - 1];
		const current = sorted[index];
		const previousIsInsertion = previous.start === previous.end;
		const currentIsInsertion = current.start === current.end;
		const overlaps =
			previousIsInsertion && currentIsInsertion
				? previous.start === current.start
				: previousIsInsertion
					? previous.start >= current.start && previous.start <= current.end
					: currentIsInsertion
						? current.start >= previous.start && current.start <= previous.end
						: current.start < previous.end;
		if (overlaps) {
			throw new ManuscriptPatchError(
				"PATCH_TARGET_OVERLAP",
				"Patch operations overlap; split the request into non-overlapping edits",
			);
		}
	}
}

/**
 * Comments must be invisible to delimiter scanning without moving any source
 * offsets. Deleting them made a range found after a comment point at the wrong
 * bytes in the original manuscript.
 */
function texWithoutCommentContents(value: string): string {
	const masked = value.split("");
	for (let index = 0; index < value.length; index++) {
		if (value[index] !== "%") continue;
		let slashes = 0;
		for (let previous = index - 1; previous >= 0 && value[previous] === "\\"; previous--) slashes++;
		if (slashes % 2 !== 0) continue;
		for (let end = index; end < value.length && value[end] !== "\r" && value[end] !== "\n"; end++) {
			masked[end] = " ";
		}
	}
	return masked.join("");
}

function texCharacterIsEscaped(value: string, index: number): boolean {
	let slashes = 0;
	for (let previous = index - 1; previous >= 0 && value[previous] === "\\"; previous--) slashes++;
	return slashes % 2 !== 0;
}

function texMathRanges(source: string): Array<{ start: number; end: number }> {
	const text = texWithoutCommentContents(source);
	const ranges: Array<{ start: number; end: number }> = [];
	const paired = [
		{ open: "\\[", close: "\\]" },
		{ open: "\\(", close: "\\)" },
		{ open: "$$", close: "$$" },
	] as const;
	for (const pair of paired) {
		let start = text.indexOf(pair.open);
		while (start >= 0) {
			const endAt = text.indexOf(pair.close, start + pair.open.length);
			if (endAt < 0)
				throw new ManuscriptPatchError(
					"TEX_UNSAFE_STRUCTURE",
					"Unclosed TeX math delimiter prevents a safe manuscript patch",
				);
			ranges.push({ start, end: endAt + pair.close.length });
			start = text.indexOf(pair.open, endAt + pair.close.length);
		}
	}
	const starts: number[] = [];
	for (let index = 0; index < text.length; index++) {
		if (
			text[index] !== "$" ||
			text[index - 1] === "$" ||
			text[index + 1] === "$" ||
			texCharacterIsEscaped(text, index)
		)
			continue;
		starts.push(index);
	}
	if (starts.length % 2 !== 0)
		throw new ManuscriptPatchError(
			"TEX_UNSAFE_STRUCTURE",
			"Unclosed TeX inline math prevents a safe manuscript patch",
		);
	for (let index = 0; index < starts.length; index += 2)
		ranges.push({ start: starts[index], end: starts[index + 1] + 1 });
	const environment =
		/\\begin\{(equation\*?|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|math|displaymath)\}[\s\S]*?\\end\{\1\}/gu;
	for (const match of text.matchAll(environment))
		ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
	return ranges;
}

function assertTexTextRange(source: string, start: number, end: number): void {
	for (const range of texMathRanges(source)) {
		if (start < range.end && end > range.start) {
			throw new ManuscriptPatchError(
				"TEX_MATH_PATCH_UNSUPPORTED",
				"Patches may not cross or modify TeX math; leave formulas unchanged",
			);
		}
	}
}

function texCandidate(operation: ManuscriptOperation): string {
	if (operation.kind === "add") return `\\ManuscriptInserted{${operation.text}}`;
	if (operation.kind === "replace")
		return `\\ManuscriptDeleted{${operation.oldText}}\\ManuscriptRewritten{${operation.newText}}`;
	return `\\ManuscriptDeleted{${operation.oldText}}`;
}

function resolveTexOperations(source: string, operations: readonly ManuscriptOperation[]): ResolvedOperation[] {
	const result = operations.map((operation) => {
		if (operation.kind === "add") {
			const anchor = hasSingleOccurrence(source, operation.anchor);
			const position = operation.position === "before" ? anchor : anchor + operation.anchor.length;
			assertTexTextRange(source, Math.max(0, position - 1), Math.min(source.length, position + 1));
			return {
				operation,
				start: position,
				end: position,
				clean: operation.text,
				candidate: texCandidate(operation),
			};
		}
		const start = hasSingleOccurrence(source, operation.oldText);
		const end = start + operation.oldText.length;
		assertTexTextRange(source, start, end);
		return {
			operation,
			start,
			end,
			clean: operation.kind === "replace" ? operation.newText : "",
			candidate: texCandidate(operation),
		};
	});
	assertNonOverlapping(result);
	return result;
}

function texCandidatePreamble(source: string): string {
	if (!/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/u.test(source)) {
		throw new ManuscriptPatchError("TEX_UNSAFE_STRUCTURE", "TeX candidate requires a documentclass preamble");
	}
	if (!/\\usepackage(?:\[[^\]]*\])?\{[^}]*xcolor[^}]*\}/u.test(source)) {
		source = source.replace(/(\\documentclass(?:\[[^\]]*\])?\{[^}]+\})/u, "$1\n\\usepackage{xcolor}");
	}
	const definitions = [
		"% Study manuscript candidate annotations; removed from the confirmed clean source.",
		"\\providecommand{\\ManuscriptInserted}[1]{{\\color{green!55!black}#1}}",
		"\\providecommand{\\ManuscriptRewritten}[1]{{\\color{blue}#1}}",
		"\\providecommand{\\ManuscriptDeleted}[1]{{\\color{red}\\texttt{[deleted]}~#1}}",
	].join("\n");
	return source.replace(/(\\begin\{document\})/u, `${definitions}\n$1`);
}

function decodeXmlText(value: string): string {
	return value
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'")
		.replace(/&amp;/gu, "&");
}

function encodeXmlText(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function xmlSpace(value: string): string {
	return /^\s|\s$/u.test(value) ? ' xml:space="preserve"' : "";
}

interface WordRun {
	start: number;
	end: number;
	whole: string;
	text: string;
	textStart: number;
	textEnd: number;
	textOpen: string;
	properties: string;
}

function wordRuns(xml: string): WordRun[] {
	const runs: WordRun[] = [];
	const pattern = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/gu;
	for (const match of xml.matchAll(pattern)) {
		const whole = match[0];
		const start = match.index ?? 0;
		const textMatches = [...whole.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)];
		if (textMatches.length !== 1) continue;
		const textMatch = textMatches[0];
		const textStart = start + (textMatch.index ?? 0);
		const textEnd = textStart + textMatch[0].length;
		const propertiesMatch = /<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>/u.exec(whole);
		const withoutProperties = propertiesMatch ? whole.replace(propertiesMatch[0], "") : whole;
		const withoutText = withoutProperties.replace(textMatch[0], "");
		if (!/^<w:r(?:\s[^>]*)?>\s*<\/w:r>$/u.test(withoutText)) continue;
		if (/^\s*$/u.test(decodeXmlText(textMatch[1]))) continue;
		runs.push({
			start,
			end: start + whole.length,
			whole,
			text: decodeXmlText(textMatch[1]),
			textStart,
			textEnd,
			textOpen: textMatch[0].slice(0, textMatch[0].indexOf(">") + 1),
			properties: propertiesMatch?.[0] ?? "",
		});
	}
	return runs;
}

function wordMathRanges(xml: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const match of xml.matchAll(/<m:oMath(?:Para)?(?:\s[^>]*)?>[\s\S]*?<\/m:oMath(?:Para)?>/gu)) {
		ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
	}
	return ranges;
}

function runWithText(run: WordRun, text: string, color: string | null, strike = false): string {
	let properties = run.properties;
	if (color) {
		if (properties) {
			properties = properties
				.replace(/<w:color(?:\s[^>]*)?\/>/gu, "")
				.replace(/<w:strike(?:\s[^>]*)?\/>/gu, "")
				.replace(/^(<w:rPr(?:\s[^>]*)?>)/u, `$1<w:color w:val="${color}"/>${strike ? "<w:strike/>" : ""}`);
		} else properties = `<w:rPr><w:color w:val="${color}"/>${strike ? "<w:strike/>" : ""}</w:rPr>`;
	}
	if (strike && !color) {
		if (properties) properties = properties.replace(/^(<w:rPr(?:\s[^>]*)?>)/u, "$1<w:strike/>");
		else properties = "<w:rPr><w:strike/></w:rPr>";
	}
	return `<w:r>${properties}<w:t${xmlSpace(text)}>${encodeXmlText(text)}</w:t></w:r>`;
}

/**
 * Candidate DOCX annotations are ordinary runs by design. Word's default
 * revision display replaces w:ins/w:del colors with a user-level palette,
 * so native revision markup cannot guarantee our review colors. The durable
 * journal retains each operation's identity and reason; this file only needs
 * a portable visual preview.
 */
function wordCandidateInsertion(run: WordRun, text: string): string {
	return runWithText(run, text, "168146");
}

function wordCandidateDeletion(run: WordRun, text: string): string {
	return runWithText(run, text, "C00000", true);
}

interface ResolvedWordOperation {
	operation: ManuscriptOperation;
	run: WordRun;
	localStart: number;
	localEnd: number;
	start: number;
	end: number;
}

function assertWordHasNoTrackedRevisions(xml: string): void {
	if (
		/<w:(?:ins|del|moveFrom|moveTo|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd|[A-Za-z][\w.-]*PrChange|tblGridChange|cellIns|cellDel|cellMerge|numberingChange|customXml(?:Ins|Del|MoveFrom|MoveTo)Range(?:Start|End))\b/iu.test(
			xml,
		) ||
		/<w14:(?:conflictIns|conflictDel|customXmlConflict(?:Ins|Del)Range(?:Start|End))\b/iu.test(xml)
	) {
		throw new ManuscriptPatchError(
			"WORD_TRACKED_REVISION_UNSUPPORTED",
			"Word documents with existing tracked revisions cannot be safely patched",
		);
	}
}

function resolveWordOperations(xml: string, operations: readonly ManuscriptOperation[]): ResolvedWordOperation[] {
	assertWordHasNoTrackedRevisions(xml);
	const runs = wordRuns(xml);
	const math = wordMathRanges(xml);
	const resolved = operations.map((operation) => {
		const target = operation.kind === "add" ? operation.anchor : operation.oldText;
		const candidates = runs.filter((run) => run.text.includes(target));
		if (candidates.length === 0) {
			throw new ManuscriptPatchError(
				"PATCH_TARGET_NOT_FOUND",
				"Patch target was not found in one safe Word text run",
			);
		}
		if (candidates.length > 1) {
			throw new ManuscriptPatchError(
				"PATCH_TARGET_AMBIGUOUS",
				"Patch target occurs in multiple Word text runs; choose a unique target",
			);
		}
		const run = candidates[0];
		for (const range of math) {
			if (run.start < range.end && run.end > range.start) {
				throw new ManuscriptPatchError(
					"WORD_MATH_PATCH_UNSUPPORTED",
					"Patches may not modify or cross OMML math; leave formulas unchanged",
				);
			}
		}
		const localStart = hasSingleOccurrence(run.text, target);
		const localEnd = localStart + target.length;
		const position = operation.kind === "add" && operation.position === "after" ? localEnd : localStart;
		return {
			operation,
			run,
			localStart,
			localEnd,
			start: run.start + position,
			end: operation.kind === "add" ? run.start + position : run.start + localEnd,
		};
	});
	assertNonOverlapping(resolved);
	return resolved;
}

function wordRunReplacement(run: WordRun, operations: readonly ResolvedWordOperation[], candidate: boolean): string {
	const normal = (value: string) => (value ? runWithText(run, value, null) : "");
	let cursor = 0;
	let replacement = "";
	for (const resolved of [...operations].sort(
		(left, right) => left.localStart - right.localStart || left.localEnd - right.localEnd,
	)) {
		const { operation } = resolved;
		if (operation.kind === "add") {
			const position = operation.position === "before" ? resolved.localStart : resolved.localEnd;
			replacement += normal(run.text.slice(cursor, position));
			replacement += candidate ? wordCandidateInsertion(run, operation.text) : normal(operation.text);
			cursor = position;
			continue;
		}
		replacement += normal(run.text.slice(cursor, resolved.localStart));
		const selected = run.text.slice(resolved.localStart, resolved.localEnd);
		if (operation.kind === "replace") {
			replacement += candidate
				? wordCandidateDeletion(run, selected) + runWithText(run, operation.newText, "266BD5")
				: normal(operation.newText);
		} else if (candidate) {
			replacement += wordCandidateDeletion(run, selected);
		}
		cursor = resolved.localEnd;
	}
	return replacement + normal(run.text.slice(cursor));
}

function applyWordOperations(xml: string, operations: readonly ManuscriptOperation[], candidate: boolean): string {
	const resolved = resolveWordOperations(xml, operations);
	const replacements = new Map<WordRun, ResolvedWordOperation[]>();
	for (const operation of resolved) {
		const group = replacements.get(operation.run) ?? [];
		group.push(operation);
		replacements.set(operation.run, group);
	}
	let result = xml;
	for (const [run, group] of [...replacements.entries()].sort(([left], [right]) => right.start - left.start)) {
		const replacement = wordRunReplacement(run, group, candidate);
		result = result.slice(0, run.start) + replacement + result.slice(run.end);
	}
	return result;
}

/** The app ZIP adapter changes only word/document.xml and preserves every other package entry. */
export function patchDocxDocumentXml(
	xml: string,
	operations: readonly ManuscriptOperation[],
	_date: string,
): { candidateXml: string; cleanXml: string } {
	if (!xml.includes("<w:document"))
		throw new ManuscriptPatchError(
			"DOCX_DOCUMENT_INVALID",
			"DOCX word/document.xml is not a WordprocessingML document",
		);
	return {
		candidateXml: applyWordOperations(xml, operations, true),
		cleanXml: applyWordOperations(xml, operations, false),
	};
}

function patchTex(
	bytes: Uint8Array,
	operations: readonly ManuscriptOperation[],
): { candidate: Uint8Array; clean: Uint8Array } {
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new ManuscriptPatchError(
			"TEX_ENCODING_UNSUPPORTED",
			"TeX manuscript must be valid UTF-8 before it can be patched",
		);
	}
	const resolved = resolveTexOperations(source, operations);
	const clean = applyResolved(source, resolved, "clean");
	const candidate = texCandidatePreamble(applyResolved(source, resolved, "candidate"));
	return { candidate: TEXT.encode(candidate), clean: TEXT.encode(clean) };
}

export class ManuscriptPatchHost {
	private readonly clock: () => Date;
	private readonly activePreparingLeases = new Set<string>();
	private docxAdapter: ManuscriptDocxAdapter | null = null;
	private readonly database: DatabaseSync;
	private readonly studyResearch: StudyResearchHost;
	private readonly options: ManuscriptPatchHostOptions;

	constructor(database: DatabaseSync, studyResearch: StudyResearchHost, options: ManuscriptPatchHostOptions) {
		this.database = database;
		this.studyResearch = studyResearch;
		this.options = options;
		if (!options.storageRoot || !options.storageRoot.trim())
			throw new ManuscriptPatchError("STORAGE_ROOT_REQUIRED", "Manuscript patch storage root is required");
		this.clock = options.clock ?? (() => new Date());
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_manuscript_patch (
				patch_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
				source_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
				payload TEXT NOT NULL, payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_manuscript_patch_project ON pi_study_manuscript_patch(project_id, updated_at, patch_id);
		`);
		this.ensurePatchRevisionColumn();
	}

	configureDocxAdapter(adapter: ManuscriptDocxAdapter): void {
		if (typeof adapter !== "function")
			throw new ManuscriptPatchError("DOCX_ADAPTER_INVALID", "DOCX patch adapter must be a function");
		this.docxAdapter = adapter;
	}

	list(scope: Scope): ManuscriptPatch[] {
		this.studyResearch.getPhase(scope);
		return (
			this.database
				.prepare(
					"SELECT patch_id AS patchId, project_id AS projectId, session_id AS sessionId, source_id AS sourceId, revision, updated_at AS updatedAt, payload, payload_hash AS payloadHash FROM pi_study_manuscript_patch WHERE project_id = ? ORDER BY updated_at DESC, patch_id DESC",
				)
				.all(scope.projectId) as unknown as ManuscriptPatchRow[]
		)
			.map((row) => publicPatch(this.decode(row)))
			.map(copy);
	}

	get(scope: Scope, patchId: string): ManuscriptPatch {
		return publicPatch(this.read(scope, patchId));
	}

	/** Browser routes alone call this method. An Agent extension only receives its durable request ID. */
	async requestFromUser(
		scope: Scope,
		input: { sourceId: string; sourceHash: string; requestText: string; expectedProjectRevision: number },
	): Promise<ManuscriptPatch> {
		this.assertResearch(scope);
		if (this.studyResearch.projectRevision(scope).revision !== input.expectedProjectRevision)
			throw new ManuscriptPatchError("PROJECT_CONFLICT", "Study project changed before manuscript request");
		const source = await this.currentSourceBytes(scope, input.sourceId, input.sourceHash);
		const requestText = requiredPatchText(input.requestText, "manuscript request");
		if (requestText.length > MAX_REQUEST_CHARS)
			throw new ManuscriptPatchError("PATCH_INPUT_INVALID", "manuscript request is too long");
		const timestamp = now(this.clock);
		const base: Omit<StoredManuscriptPatch, "contentHash"> = {
			patchId: `manuscript-${randomUUID()}`,
			projectId: scope.projectId,
			sessionId: scope.sessionId,
			sourceId: source.source.sourceId,
			sourceHash: source.source.contentHash,
			targetPath: source.source.relativePath,
			sourcePath: source.path,
			kind: source.source.kind,
			requestText,
			baseFileHash: source.hash,
			finalFileHash: null,
			candidateHash: null,
			recoveryHash: null,
			operations: [],
			status: "requested",
			revision: 1,
			createdAt: timestamp,
			updatedAt: timestamp,
			confirmedAt: null,
			recoveredAt: null,
			diagnostic: null,
			draftPath: null,
			recoveryPath: null,
			preparingLeaseId: null,
			preparingLeaseExpiresAt: null,
		};
		const saved = withContentHash(base);
		this.immediateTransaction(() => {
			// Source resolution crosses an async filesystem boundary. Re-check both
			// durable guards while this insertion holds the writer lock so a phase or
			// project revision cannot race a new user-authorized request into storage.
			this.assertResearch(scope);
			if (this.studyResearch.projectRevision(scope).revision !== input.expectedProjectRevision)
				throw new ManuscriptPatchError("PROJECT_CONFLICT", "Study project changed before manuscript request");
			this.insert(saved);
		});
		return publicPatch(saved);
	}

	/** Draft construction may be invoked by the scoped Research tool, never confirm or issue a user request. */
	async draft(
		scope: Scope,
		input: { patchId: string; expectedPatchRevision: number; operations: readonly ManuscriptOperation[] },
	): Promise<ManuscriptPatch> {
		this.assertResearch(scope);
		const previous = this.read(scope, input.patchId);
		requiredRevision(input.expectedPatchRevision, "expected manuscript patch revision");
		if (previous.revision !== input.expectedPatchRevision)
			throw new ManuscriptPatchError("PATCH_CONFLICT", "Manuscript patch changed before draft generation");
		if (previous.status !== "requested" && previous.status !== "failed")
			throw new ManuscriptPatchError(
				"PATCH_STATE_INVALID",
				"Only a requested or failed manuscript patch can be drafted",
			);
		const operations = validateOperations(input.operations);
		const source = await this.currentSourceBytes(scope, previous.sourceId, previous.sourceHash);
		if (source.hash !== previous.baseFileHash)
			throw new ManuscriptPatchError("SOURCE_CONFLICT", "Manuscript source changed since the user request");
		const generated =
			previous.kind === "tex"
				? patchTex(source.bytes, operations)
				: await this.patchDocx(source.bytes, operations, previous.createdAt);
		const candidateHash = sha256(generated.candidate);
		const finalFileHash = sha256(generated.clean);
		const recoveryHash = sha256(source.bytes);
		const extension = previous.kind === "tex" ? "tex" : "docx";
		const root = resolve(this.options.storageRoot);
		const draftPath = join(root, `${previous.patchId}.candidate.${extension}`);
		const recoveryPath = join(root, `${previous.patchId}.original.${extension}`);
		const leaseId = randomUUID();
		const preparing = this.revise(previous, {
			operations,
			candidateHash,
			finalFileHash,
			recoveryHash,
			draftPath,
			recoveryPath,
			status: "preparing",
			diagnostic: null,
			preparingLeaseId: leaseId,
			preparingLeaseExpiresAt: this.preparingLeaseExpiry(),
		});
		this.transitionInResearch(scope, previous, preparing);
		this.activePreparingLeases.add(this.leaseKey(preparing));
		try {
			await this.writeDurable(draftPath, generated.candidate);
			await this.writeDurable(recoveryPath, source.bytes);
			await this.assertArtifact(draftPath, candidateHash);
			await this.assertArtifact(recoveryPath, recoveryHash);
			const complete = this.revise(preparing, {
				status: "draft",
				preparingLeaseId: null,
				preparingLeaseExpiresAt: null,
			});
			const committed = this.transitionOrCurrent(scope, preparing, complete);
			if (committed.status !== "draft") {
				throw new ManuscriptPatchError(
					"PATCH_CONFLICT",
					"Manuscript patch changed while its draft artifacts were finishing",
				);
			}
			return publicPatch(committed);
		} catch (error) {
			this.failPreparing(preparing, error);
			throw error;
		} finally {
			this.activePreparingLeases.delete(this.leaseKey(preparing));
		}
	}

	async confirmFromUser(
		scope: Scope,
		input: { patchId: string; expectedPatchRevision: number },
	): Promise<ManuscriptPatch> {
		this.assertResearch(scope);
		const patch = this.read(scope, input.patchId);
		if (patch.status !== "draft")
			throw new ManuscriptPatchError("PATCH_STATE_INVALID", "Only a candidate manuscript patch can be confirmed");
		if (patch.revision !== input.expectedPatchRevision)
			throw new ManuscriptPatchError("PATCH_CONFLICT", "Manuscript patch changed before confirmation");
		if (!patch.finalFileHash || !patch.recoveryPath || !patch.recoveryHash)
			throw new ManuscriptPatchError(
				"PATCH_CORRUPT",
				"Candidate manuscript patch is missing clean or recovery content",
			);
		const source = await this.currentSourceBytes(scope, patch.sourceId, patch.sourceHash);
		if (source.hash !== patch.baseFileHash)
			throw new ManuscriptPatchError(
				"SOURCE_CONFLICT",
				"Manuscript source changed after the candidate was generated",
			);
		// Regenerate from the immutable source backup. Candidate review XML/TeX never becomes the final source.
		const original = await this.readArtifact(patch.recoveryPath, patch.recoveryHash);
		const clean =
			patch.kind === "tex"
				? patchTex(original, patch.operations).clean
				: (await this.patchDocx(original, patch.operations, patch.createdAt)).clean;
		if (sha256(clean) !== patch.finalFileHash)
			throw new ManuscriptPatchError(
				"PATCH_CORRUPT",
				"Candidate clean output no longer matches its durable journal",
			);
		const confirmed = this.publishAndTransition(
			scope,
			patch,
			input.expectedPatchRevision,
			source.path,
			patch.baseFileHash,
			clean,
			"confirm",
		);
		return publicPatch(confirmed);
	}

	async recoverFromUser(
		scope: Scope,
		input: { patchId: string; expectedPatchRevision: number },
	): Promise<ManuscriptPatch> {
		this.assertResearch(scope);
		const patch = this.read(scope, input.patchId);
		if (patch.status !== "confirmed")
			throw new ManuscriptPatchError("PATCH_STATE_INVALID", "Only a confirmed manuscript patch can be recovered");
		if (patch.revision !== input.expectedPatchRevision)
			throw new ManuscriptPatchError("PATCH_CONFLICT", "Manuscript patch changed before recovery");
		if (!patch.finalFileHash || !patch.recoveryPath || !patch.recoveryHash)
			throw new ManuscriptPatchError("PATCH_CORRUPT", "Recovery journal is incomplete");
		const source = await this.currentSourceBytes(scope, patch.sourceId, patch.sourceHash, false);
		if (source.hash !== patch.finalFileHash)
			throw new ManuscriptPatchError(
				"SOURCE_CONFLICT",
				"Manuscript source changed after confirmation; recovery will not overwrite it",
			);
		const recovery = await this.readArtifact(patch.recoveryPath, patch.recoveryHash);
		const recovered = this.publishAndTransition(
			scope,
			patch,
			input.expectedPatchRevision,
			source.path,
			patch.finalFileHash,
			recovery,
			"recover",
		);
		return publicPatch(recovered);
	}

	async readCandidate(
		scope: Scope,
		patchId: string,
	): Promise<{ kind: "tex" | "docx"; bytes: Uint8Array; fileName: string }> {
		const patch = this.read(scope, patchId);
		if (!patch.draftPath || !patch.candidateHash || !["draft", "confirmed", "recovered"].includes(patch.status)) {
			throw new ManuscriptPatchError("PATCH_CANDIDATE_UNAVAILABLE", "No completed candidate preview is available");
		}
		return {
			kind: patch.kind,
			bytes: await this.readArtifact(patch.draftPath, patch.candidateHash),
			fileName: `${patch.patchId}.candidate.${patch.kind}`,
		};
	}

	/** Reconcile durable journals after process loss. It never overwrites a manuscript. */
	async reconcile(scope: Scope): Promise<ManuscriptPatch[]> {
		this.studyResearch.getPhase(scope);
		const records = this.listStored(scope);
		const result: ManuscriptPatch[] = [];
		for (const patch of records) {
			if (patch.status === "preparing") {
				const ready =
					patch.draftPath && patch.candidateHash && patch.recoveryPath && patch.recoveryHash
						? (await this.artifactMatches(patch.draftPath, patch.candidateHash)) &&
							(await this.artifactMatches(patch.recoveryPath, patch.recoveryHash))
						: false;
				if (ready) {
					const next = this.revise(patch, {
						status: "draft",
						preparingLeaseId: null,
						preparingLeaseExpiresAt: null,
					});
					result.push(publicPatch(this.transitionOrCurrent(scope, patch, next)));
				} else if (this.preparingLeaseIsLive(patch)) {
					result.push(publicPatch(patch));
				} else {
					const next = this.revise(patch, {
						status: "failed",
						diagnostic: "Draft write lease expired before both artifacts became durable",
						preparingLeaseId: null,
						preparingLeaseExpiresAt: null,
					});
					result.push(publicPatch(this.transitionOrCurrent(scope, patch, next)));
				}
				continue;
			}
			if (patch.status !== "draft" && patch.status !== "confirmed") continue;
			try {
				this.restoreClaimAfterInterruptedPublication(patch);
				const source = await this.currentSourceBytes(scope, patch.sourceId, patch.sourceHash, false);
				if (patch.status === "draft" && patch.finalFileHash && source.hash === patch.finalFileHash) {
					const confirmed = this.revise(patch, {
						status: "confirmed",
						confirmedAt: patch.confirmedAt ?? now(this.clock),
						diagnostic: "Recovered confirmation journal after an interrupted write",
					});
					result.push(publicPatch(this.transitionOrCurrent(scope, patch, confirmed)));
				} else if (patch.status === "confirmed" && source.hash === patch.baseFileHash) {
					const recovered = this.revise(patch, {
						status: "recovered",
						recoveredAt: patch.recoveredAt ?? now(this.clock),
						diagnostic: "Recovered rollback journal after an interrupted write",
					});
					result.push(publicPatch(this.transitionOrCurrent(scope, patch, recovered)));
				} else if (
					(patch.status === "draft" && source.hash !== patch.baseFileHash) ||
					(patch.status === "confirmed" && source.hash !== patch.finalFileHash)
				) {
					const failed = this.revise(patch, {
						status: "failed",
						diagnostic: "Manuscript bytes differ from the durable journal; no automatic overwrite was attempted",
					});
					result.push(publicPatch(this.transitionOrCurrent(scope, patch, failed)));
				}
			} catch (error) {
				const failed = this.revise(patch, { status: "failed", diagnostic: this.diagnostic(error) });
				result.push(publicPatch(this.transitionOrCurrent(scope, patch, failed)));
			}
		}
		return result;
	}

	private assertResearch(scope: Scope): void {
		if (this.studyResearch.getPhase(scope).phase !== "research")
			throw new ManuscriptPatchError("RESEARCH_REQUIRED", "Manuscript changes require the explicit Research phase");
	}

	private immediateTransaction<T>(work: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private transitionInResearch(scope: Scope, previous: StoredManuscriptPatch, next: StoredManuscriptPatch): void {
		this.immediateTransaction(() => {
			this.assertResearch(scope);
			this.transition(previous, next);
		});
	}

	private transitionOrCurrent(
		scope: Scope,
		previous: StoredManuscriptPatch,
		next: StoredManuscriptPatch,
	): StoredManuscriptPatch {
		try {
			this.transition(previous, next);
			return next;
		} catch (error) {
			if (!(error instanceof ManuscriptPatchError) || error.code !== "PATCH_CONFLICT") throw error;
			return this.read(scope, previous.patchId);
		}
	}

	private failPreparing(preparing: StoredManuscriptPatch, error: unknown): void {
		const failed = this.revise(preparing, {
			status: "failed",
			diagnostic: this.diagnostic(error),
			preparingLeaseId: null,
			preparingLeaseExpiresAt: null,
		});
		try {
			this.transition(preparing, failed);
		} catch (transitionError) {
			if (!(transitionError instanceof ManuscriptPatchError) || transitionError.code !== "PATCH_CONFLICT") {
				throw transitionError;
			}
			console.info("[study-manuscript] preparing failure lost its CAS race", {
				patchId: preparing.patchId,
				leaseId: preparing.preparingLeaseId,
			});
		}
	}

	private preparingLeaseExpiry(): string {
		return new Date(this.clock().getTime() + PREPARING_LEASE_MS).toISOString();
	}

	private leaseKey(patch: Pick<StoredManuscriptPatch, "patchId" | "preparingLeaseId">): string {
		return [patch.patchId, patch.preparingLeaseId ?? "missing"].join(":");
	}

	private preparingLeaseIsLive(patch: StoredManuscriptPatch): boolean {
		if (!patch.preparingLeaseId || !patch.preparingLeaseExpiresAt) return false;
		if (this.activePreparingLeases.has(this.leaseKey(patch))) return true;
		const expiresAt = Date.parse(patch.preparingLeaseExpiresAt);
		return Number.isFinite(expiresAt) && expiresAt > this.clock().getTime();
	}

	private publishAndTransition(
		scope: Scope,
		patch: StoredManuscriptPatch,
		expectedPatchRevision: number,
		path: string,
		expectedSourceHash: string,
		replacement: Uint8Array,
		action: "confirm" | "recover",
	): StoredManuscriptPatch {
		return this.immediateTransaction(() => {
			this.assertResearch(scope);
			const current = this.read(scope, patch.patchId);
			const expectedStatus: ManuscriptPatchStatus = action === "confirm" ? "draft" : "confirmed";
			if (current.status !== expectedStatus)
				throw new ManuscriptPatchError("PATCH_STATE_INVALID", "Manuscript patch changed before publication");
			if (current.revision !== expectedPatchRevision || current.contentHash !== patch.contentHash)
				throw new ManuscriptPatchError("PATCH_CONFLICT", "Manuscript patch changed before publication");
			this.publishClaimedSource(path, current.patchId, expectedSourceHash, replacement, action, () =>
				this.assertResearch(scope),
			);
			const next = this.revise(
				current,
				action === "confirm"
					? { status: "confirmed", confirmedAt: now(this.clock), diagnostic: null }
					: { status: "recovered", recoveredAt: now(this.clock), diagnostic: null },
			);
			this.transition(current, next);
			return next;
		});
	}

	private async currentSourceBytes(
		scope: Scope,
		sourceId: string,
		sourceHash: string,
		requireRegisteredBytes = true,
	): Promise<ResolvedSource> {
		requiredText(sourceId, "sourceId", 128);
		requiredHash(sourceHash, "sourceHash");
		const source = this.studyResearch
			.listSources(scope)
			.find((item) => item.sourceId === sourceId && item.current && item.contentHash === sourceHash);
		if (!source) throw new ManuscriptPatchError("SOURCE_CONFLICT", "Registered manuscript source identity changed");
		if (source.kind !== "tex" && source.kind !== "docx")
			throw new ManuscriptPatchError(
				"SOURCE_KIND_UNSUPPORTED",
				"Only TeX and DOCX manuscripts support explicit patches",
			);
		const root = await realpath(source.sourceRoot);
		const lexical = resolve(root, source.relativePath);
		if (!pathWithin(root, lexical))
			throw new ManuscriptPatchError("SOURCE_PATH_INVALID", "Registered manuscript path escapes its source root");
		const path = await realpath(lexical);
		if (!pathWithin(root, path))
			throw new ManuscriptPatchError("SOURCE_PATH_INVALID", "Registered manuscript symlink escapes its source root");
		const bytes = await this.readStable(path);
		const hash = sha256(bytes);
		if (requireRegisteredBytes && hash !== source.contentHash)
			throw new ManuscriptPatchError(
				"SOURCE_CONFLICT",
				"Registered manuscript bytes changed; refresh the source before drafting or confirming",
			);
		return { source: source as SourceVersion & { kind: "tex" | "docx" }, path, bytes, hash };
	}

	private async patchDocx(
		bytes: Uint8Array,
		operations: readonly ManuscriptOperation[],
		artifactDate: string,
	): Promise<{ candidate: Uint8Array; clean: Uint8Array }> {
		if (!this.docxAdapter)
			throw new ManuscriptPatchError("DOCX_ADAPTER_UNAVAILABLE", "DOCX patch adapter is not configured");
		const result = await this.docxAdapter(bytes, operations, artifactDate);
		if (!result || !(result.candidate instanceof Uint8Array) || !(result.clean instanceof Uint8Array)) {
			throw new ManuscriptPatchError("DOCX_ADAPTER_INVALID", "DOCX patch adapter returned invalid bytes");
		}
		if (
			result.candidate.byteLength === 0 ||
			result.clean.byteLength === 0 ||
			result.candidate.byteLength > 128 * 1024 * 1024 ||
			result.clean.byteLength > 128 * 1024 * 1024
		) {
			throw new ManuscriptPatchError("DOCX_ADAPTER_INVALID", "DOCX patch adapter returned unbounded bytes");
		}
		return result;
	}

	private async readStable(path: string): Promise<Uint8Array> {
		const handle = await open(path, "r");
		try {
			const before = await handle.stat();
			if (!before.isFile())
				throw new ManuscriptPatchError("SOURCE_NOT_FILE", "Registered manuscript is not a regular file");
			if (before.size > 64 * 1024 * 1024)
				throw new ManuscriptPatchError("SOURCE_TOO_LARGE", "Manuscript exceeds the 64 MiB patch limit");
			const buffer = Buffer.alloc(before.size);
			let offset = 0;
			while (offset < buffer.byteLength) {
				const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			const after = await handle.stat();
			if (
				offset !== before.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			) {
				throw new ManuscriptPatchError(
					"SOURCE_CHANGED_WHILE_READING",
					"Manuscript changed while its bytes were being read",
				);
			}
			return new Uint8Array(buffer);
		} finally {
			await handle.close();
		}
	}

	private async writeDurable(path: string, bytes: Uint8Array): Promise<void> {
		const root = resolve(this.options.storageRoot);
		const target = resolve(path);
		if (!pathWithin(root, target))
			throw new ManuscriptPatchError(
				"ARTIFACT_PATH_INVALID",
				"Manuscript artifact path escapes its private storage root",
			);
		await mkdir(dirname(target), { recursive: true });
		const temporary = `${target}.${randomUUID()}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, target);
	}

	/**
	 * The filesystem has no general async compare-and-swap. Claim the source by
	 * hard-linking it under a per-patch name, remove the public name, validate the
	 * claimed bytes before and after staging, and publish only by linking a staged
	 * replacement into an absent public name. An external editor that creates a
	 * new path wins; it is never replaced by a later rename. This makes the
	 * publication name safe, but cannot turn a filesystem with existing writable
	 * file handles into a general atomic compare-and-swap.
	 */
	private publishClaimedSource(
		path: string,
		patchId: string,
		expectedHash: string,
		replacement: Uint8Array,
		action: "confirm" | "recover",
		assertCommit: () => void,
	): void {
		const claimPath = `${path}.${patchId}.manuscript-claim`;
		const stagePath = `${path}.${randomUUID()}.manuscript-stage`;
		const replacementHash = sha256(replacement);
		let claimed = false;
		let staged = false;
		try {
			const metadata = statSync(path);
			if (!metadata.isFile())
				throw new ManuscriptPatchError("SOURCE_NOT_FILE", "Registered manuscript is not a regular file");
			linkSync(path, claimPath);
			claimed = true;
			unlinkSync(path);
			this.options.publicationHook?.({ action, path, claimPath, boundary: "claimed" });
			assertCommit();
			this.assertFileHash(
				claimPath,
				expectedHash,
				"Manuscript changed at the publication boundary; no replacement was published",
			);
			const descriptor = openSync(stagePath, "wx", metadata.mode);
			try {
				writeFileSync(descriptor, replacement);
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			staged = true;
			this.assertFileHash(stagePath, replacementHash, "Staged manuscript bytes changed before publication");
			this.options.publicationHook?.({ action, path, claimPath, boundary: "before-publish" });
			assertCommit();
			this.assertFileHash(
				claimPath,
				expectedHash,
				"Manuscript changed while publication was pending; no replacement was published",
			);
			try {
				linkSync(stagePath, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					throw new ManuscriptPatchError(
						"SOURCE_PUBLICATION_CONFLICT",
						"An external editor created a new manuscript version while publication was pending",
					);
				}
				throw error;
			}
			this.assertFileHash(path, replacementHash, "Published manuscript bytes changed at the publication boundary");
			unlinkSync(stagePath);
			staged = false;
			unlinkSync(claimPath);
			claimed = false;
		} catch (error) {
			if (staged) this.removeOwnPath(stagePath);
			if (claimed) {
				const restored = this.restoreClaimIfSourceAbsent(claimPath, path);
				if (restored || this.pathExists(path)) this.removeOwnPath(claimPath);
			}
			throw error;
		}
	}

	private assertFileHash(path: string, expectedHash: string, message: string): void {
		if (sha256(new Uint8Array(readFileSync(path))) !== expectedHash)
			throw new ManuscriptPatchError("SOURCE_CONFLICT", message);
	}

	private restoreClaimIfSourceAbsent(claimPath: string, path: string): boolean {
		try {
			linkSync(claimPath, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		unlinkSync(claimPath);
		return true;
	}

	/**
	 * A process crash after unlinking the public name leaves a deterministic
	 * claim beside the source. Recreate the name only if it is still absent;
	 * an editor's later version is never replaced during reconciliation.
	 */
	private restoreClaimAfterInterruptedPublication(patch: StoredManuscriptPatch): void {
		const claimPath = `${patch.sourcePath}.${patch.patchId}.manuscript-claim`;
		if (!this.pathExists(claimPath)) return;
		const expectedClaimHash = patch.status === "draft" ? patch.baseFileHash : patch.finalFileHash;
		const publishedHash = patch.status === "draft" ? patch.finalFileHash : patch.baseFileHash;
		if (!expectedClaimHash || !publishedHash)
			throw new ManuscriptPatchError(
				"PATCH_CORRUPT",
				"Interrupted publication claim is missing expected journal hashes",
			);
		try {
			this.assertFileHash(claimPath, expectedClaimHash, "Interrupted publication claim does not match its journal");
			if (!this.pathExists(patch.sourcePath)) {
				if (!this.restoreClaimIfSourceAbsent(claimPath, patch.sourcePath)) return;
				console.info("[study-manuscript] restored source name from interrupted claim", { patchId: patch.patchId });
				return;
			}
			const sourceHash = sha256(new Uint8Array(readFileSync(patch.sourcePath)));
			if (sourceHash !== expectedClaimHash && sourceHash !== publishedHash) {
				throw new ManuscriptPatchError(
					"SOURCE_CONFLICT",
					"Interrupted publication found unexpected manuscript bytes; no claim cleanup or overwrite was attempted",
				);
			}
			this.removeOwnPath(claimPath);
			console.info("[study-manuscript] removed owned claim after interrupted publication", {
				patchId: patch.patchId,
				publication: sourceHash === publishedHash ? "published" : "unpublished",
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private removeOwnPath(path: string): void {
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private pathExists(path: string): boolean {
		try {
			statSync(path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	private async readArtifact(path: string, expectedHash: string): Promise<Uint8Array> {
		const root = resolve(this.options.storageRoot);
		const target = resolve(path);
		if (!pathWithin(root, target))
			throw new ManuscriptPatchError(
				"ARTIFACT_PATH_INVALID",
				"Manuscript artifact path escapes its private storage root",
			);
		const bytes = new Uint8Array(await readFile(target));
		if (sha256(bytes) !== expectedHash)
			throw new ManuscriptPatchError("ARTIFACT_CORRUPT", "Manuscript artifact failed its durable hash check");
		return bytes;
	}

	private async artifactMatches(path: string, expectedHash: string): Promise<boolean> {
		try {
			await this.readArtifact(path, expectedHash);
			return true;
		} catch {
			return false;
		}
	}

	private async assertArtifact(path: string, expectedHash: string): Promise<void> {
		await this.readArtifact(path, expectedHash);
	}

	private listStored(scope: Scope): StoredManuscriptPatch[] {
		return (
			this.database
				.prepare(
					"SELECT patch_id AS patchId, project_id AS projectId, session_id AS sessionId, source_id AS sourceId, revision, updated_at AS updatedAt, payload, payload_hash AS payloadHash FROM pi_study_manuscript_patch WHERE project_id = ? ORDER BY updated_at DESC, patch_id DESC",
				)
				.all(scope.projectId) as unknown as ManuscriptPatchRow[]
		).map((row) => this.decode(row));
	}

	private read(scope: Scope, patchId: string): StoredManuscriptPatch {
		this.studyResearch.getPhase(scope);
		requiredText(patchId, "manuscript patch ID", 128);
		const row = this.database
			.prepare(
				"SELECT patch_id AS patchId, project_id AS projectId, session_id AS sessionId, source_id AS sourceId, revision, updated_at AS updatedAt, payload, payload_hash AS payloadHash FROM pi_study_manuscript_patch WHERE patch_id = ? AND project_id = ?",
			)
			.get(patchId, scope.projectId) as unknown as ManuscriptPatchRow | undefined;
		if (!row) throw new ManuscriptPatchError("PATCH_NOT_FOUND", "Manuscript patch was not found in this project");
		const patch = this.decode(row);
		if (patch.sessionId !== scope.sessionId)
			throw new ManuscriptPatchError("PATCH_SESSION_FORBIDDEN", "Manuscript patch belongs to another conversation");
		return patch;
	}

	private decode(row: ManuscriptPatchRow): StoredManuscriptPatch {
		let patch: StoredManuscriptPatch;
		try {
			patch = JSON.parse(row.payload) as StoredManuscriptPatch;
		} catch {
			throw new ManuscriptPatchError("PATCH_CORRUPT", "Manuscript patch journal is not valid JSON");
		}
		if (
			!patch ||
			typeof patch !== "object" ||
			patch.patchId !== row.patchId ||
			patch.projectId !== row.projectId ||
			patch.revision !== row.revision ||
			patch.contentHash !== row.payloadHash
		) {
			throw new ManuscriptPatchError("PATCH_CORRUPT", "Manuscript patch journal identity is invalid");
		}
		const { contentHash: identity, ...body } = patch;
		if (sha256(TEXT.encode(JSON.stringify(body))) !== identity) {
			throw new ManuscriptPatchError("PATCH_CORRUPT", "Manuscript patch journal hash check failed");
		}
		if (patch.kind !== "tex" && patch.kind !== "docx")
			throw new ManuscriptPatchError("PATCH_CORRUPT", "Manuscript patch source kind is invalid");
		try {
			requiredText(patch.targetPath, "manuscript target path", 4_096);
			requiredText(patch.sourcePath, "manuscript source path", 16_384);
			if (!isAbsolute(patch.sourcePath)) throw new Error("source path must be absolute");
		} catch {
			throw new ManuscriptPatchError("PATCH_CORRUPT", "Manuscript patch target path is invalid");
		}
		if (!(["requested", "preparing", "draft", "confirmed", "recovered", "failed"] as string[]).includes(patch.status))
			throw new ManuscriptPatchError("PATCH_CORRUPT", "Manuscript patch status is invalid");
		return patch;
	}

	private ensurePatchRevisionColumn(): void {
		const columns = this.database.prepare("PRAGMA table_info(pi_study_manuscript_patch)").all() as { name: string }[];
		if (columns.some((column) => column.name === "revision")) return;
		this.database.exec("ALTER TABLE pi_study_manuscript_patch ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
		this.database.exec(
			"UPDATE pi_study_manuscript_patch SET revision = CAST(json_extract(payload, '$.revision') AS INTEGER) WHERE json_valid(payload) AND CAST(json_extract(payload, '$.revision') AS INTEGER) > 0",
		);
	}

	private insert(value: StoredManuscriptPatch): void {
		const { contentHash: _contentHash, ...body } = value;
		const checked = withContentHash(body);
		const result = this.database
			.prepare(
				"INSERT INTO pi_study_manuscript_patch(patch_id, project_id, session_id, source_id, revision, updated_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				checked.patchId,
				checked.projectId,
				checked.sessionId,
				checked.sourceId,
				checked.revision,
				checked.updatedAt,
				JSON.stringify(checked),
				checked.contentHash,
			);
		if (result.changes !== 1) throw new ManuscriptPatchError("PATCH_CONFLICT", "Manuscript patch already exists");
	}

	private transition(previous: StoredManuscriptPatch, value: StoredManuscriptPatch): void {
		if (value.revision !== previous.revision + 1)
			throw new ManuscriptPatchError(
				"PATCH_CORRUPT",
				"Manuscript patch transition must advance exactly one revision",
			);
		const { contentHash: _contentHash, ...body } = value;
		const checked = withContentHash(body);
		const result = this.database
			.prepare(
				"UPDATE pi_study_manuscript_patch SET revision = ?, updated_at = ?, payload = ?, payload_hash = ? WHERE patch_id = ? AND project_id = ? AND revision = ? AND payload_hash = ?",
			)
			.run(
				checked.revision,
				checked.updatedAt,
				JSON.stringify(checked),
				checked.contentHash,
				previous.patchId,
				previous.projectId,
				previous.revision,
				previous.contentHash,
			);
		if (result.changes !== 1)
			throw new ManuscriptPatchError("PATCH_CONFLICT", "Manuscript patch changed before this transition");
	}

	private revise(
		patch: StoredManuscriptPatch,
		change: Partial<
			Omit<
				StoredManuscriptPatch,
				| "patchId"
				| "projectId"
				| "sessionId"
				| "sourceId"
				| "sourceHash"
				| "targetPath"
				| "sourcePath"
				| "kind"
				| "requestText"
				| "baseFileHash"
				| "createdAt"
				| "contentHash"
				| "revision"
				| "updatedAt"
			>
		>,
	): StoredManuscriptPatch {
		const { contentHash: _contentHash, ...body } = patch;
		return withContentHash({ ...body, ...change, revision: patch.revision + 1, updatedAt: now(this.clock) });
	}

	private diagnostic(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		return message.replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/gu, "[local path]").slice(0, 2_000);
	}
}
