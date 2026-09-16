import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import JSZip, { type JSZipObject } from "jszip";
import { PdftotextExtractor, type PdfTextExtractor } from "../../../packages/course-host/src/index.ts";

/**
 * The reader is deliberately a source adapter, not a TeX compiler or a proof
 * checker.  Paths in the returned source records are relative to rootPath;
 * rootPath itself is returned only for trusted server-side callers.
 */

export type StudySourceKind = "tex" | "docx" | "pdf";
export type StudySourceMode = "source-first" | "pdf-only";
export type StudySourceRole = "primary" | "tex-include" | "linked-pdf";

export interface StudySourceLimits {
	maxFiles: number;
	maxDepth: number;
	maxTotalBytes: number;
	maxFileBytes: number;
	maxOutputBytes: number;
	maxChunkLines: number;
	maxChunkBytes: number;
	maxDirectoryEntries: number;
	maxArchiveEntries: number;
}

export const DEFAULT_STUDY_SOURCE_LIMITS: Readonly<StudySourceLimits> = Object.freeze({
	maxFiles: 128,
	maxDepth: 12,
	maxTotalBytes: 64 * 1024 * 1024,
	maxFileBytes: 32 * 1024 * 1024,
	maxOutputBytes: 32 * 1024 * 1024,
	maxChunkLines: 80,
	maxChunkBytes: 16 * 1024,
	maxDirectoryEntries: 512,
	maxArchiveEntries: 512,
});

export interface StudySourceReaderOptions {
	/** A root-relative or absolute path to the selected paper entry. */
	entryPath?: string;
	limits?: Partial<StudySourceLimits>;
	/** Tests and trusted callers may provide an already-bounded extractor. */
	pdfExtractor?: PdfTextExtractor;
	/** Defaults to PI_PDFTOTEXT_PATH, then pdftotext on PATH. */
	pdfCommand?: string;
}

export type StudySourceLocation =
	| { kind: "tex-lines"; path: string; startLine: number; endLine: number }
	| { kind: "pdf-page"; path: string; page: number }
	| { kind: "docx-paragraph"; path: string; paragraph: number };

export interface StudySourceMath {
	format: "omml";
	/** Exact XML fragment from word/document.xml. It is never flattened into text. */
	xml: string;
}

export interface StudySourceProvenance {
	parser: "tex-source" | "pdftotext" | "docx-xml";
	extraction: "exact-source" | "pdf-text-layer" | "paragraph-xml";
	math: "source-preserved" | "unverified-text-layer" | "omml-preserved";
	role: StudySourceRole;
}

export interface StudySourceChunk {
	id: string;
	kind: "tex-source" | "pdf-page" | "docx-paragraph";
	path: string;
	hash: string;
	text: string;
	location: StudySourceLocation;
	provenance: StudySourceProvenance;
	/** Exact paragraph XML for docx chunks; null for TeX/PDF chunks. */
	sourceXml: string | null;
	/** OMML fragments in source order. Empty means this paragraph has no formula. */
	math: readonly StudySourceMath[];
}

export type StudySourceDiagnosticSeverity = "info" | "warning" | "error";

export interface StudySourceDiagnostic {
	severity: StudySourceDiagnosticSeverity;
	code: string;
	message: string;
	path: string | null;
	location: StudySourceLocation | null;
	/** PDF text extraction always requires a visual/original-page check for math. */
	requiresPdfInspection: boolean;
}

export type StudySourceDependencyRelation = "tex-include" | "linked-pdf";
export type StudySourceDependencyStatus =
	| "included"
	| "missing"
	| "outside-root"
	| "cycle"
	| "depth-limit"
	| "invalid-literal";

export interface StudySourceDependency {
	path: string;
	relation: StudySourceDependencyRelation;
	status: StudySourceDependencyStatus;
	hash: string | null;
	bytes: number | null;
	location: StudySourceLocation | null;
}

export interface StudySourceDocument {
	kind: StudySourceKind;
	role: StudySourceRole;
	path: string;
	hash: string;
	bytes: number;
	chunks: readonly StudySourceChunk[];
	diagnostics: readonly StudySourceDiagnostic[];
	dependencies: readonly StudySourceDependency[];
	provenance: StudySourceProvenance;
}

/**
 * A manifest repeats the primary document's kind/path/hash/bytes/chunks fields
 * so consumers that only need the selected source do not need to special-case
 * the documents array. `chunks` and `dependencies` contain all included files.
 */
export interface StudySourceManifest {
	version: 1;
	rootPath: string;
	mode: StudySourceMode;
	kind: StudySourceKind;
	path: string;
	hash: string;
	bytes: number;
	chunks: readonly StudySourceChunk[];
	diagnostics: readonly StudySourceDiagnostic[];
	dependencies: readonly StudySourceDependency[];
	provenance: StudySourceProvenance;
	documents: readonly StudySourceDocument[];
	limits: Readonly<StudySourceLimits>;
}

export class StudySourceReaderError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StudySourceReaderError";
		this.code = code;
	}
}

export class StudySourceLimitError extends StudySourceReaderError {
	constructor(code: string, message: string) {
		super(code, message);
		this.name = "StudySourceLimitError";
	}
}

interface SourceSnapshot {
	realPath: string;
	path: string;
	bytes: number;
	hash: string;
	content: Uint8Array;
}

interface InternalDocument {
	snapshot: SourceSnapshot;
	kind: StudySourceKind;
	role: StudySourceRole;
	chunks: StudySourceChunk[];
	diagnostics: StudySourceDiagnostic[];
	dependencies: StudySourceDependency[];
	provenance: StudySourceProvenance;
}

interface PathResolution {
	status: "found" | "missing" | "outside-root";
	path: string;
	realPath: string | null;
	message?: string;
}

interface ReaderState {
	readonly rootPath: string;
	readonly limits: Readonly<StudySourceLimits>;
	readonly options: StudySourceReaderOptions;
	readonly snapshotsByPath: Map<string, SourceSnapshot>;
	readonly documentsByPath: Map<string, InternalDocument>;
	readonly dependencies: StudySourceDependency[];
	readonly chunks: StudySourceChunk[];
	totalInputBytes: number;
	totalOutputBytes: number;
}

const TEXT_ENCODER = new TextEncoder();
function positiveLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new StudySourceReaderError("INVALID_LIMIT", `${name} must be a positive safe integer`);
	}
	return value;
}

function resolveLimits(options: StudySourceReaderOptions): Readonly<StudySourceLimits> {
	const candidate = { ...DEFAULT_STUDY_SOURCE_LIMITS, ...(options.limits ?? {}) };
	for (const [name, value] of Object.entries(candidate)) {
		if (name === "maxDepth") {
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new StudySourceReaderError("INVALID_LIMIT", "maxDepth must be a non-negative safe integer");
			}
		} else positiveLimit(value, name);
	}
	return Object.freeze(candidate);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function utf8Bytes(text: string): number {
	return TEXT_ENCODER.encode(text).byteLength;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	const object = value as Record<PropertyKey, unknown>;
	for (const child of Object.values(object)) deepFreeze(child);
	return Object.freeze(value);
}

function pathWithinRoot(rootPath: string, targetPath: string): boolean {
	const targetRelative = relative(rootPath, targetPath);
	return targetRelative === "" || (!isAbsolute(targetRelative) && targetRelative !== ".." && !targetRelative.startsWith(`..${sep}`));
}

function relativePath(rootPath: string, targetPath: string): string {
	const result = relative(rootPath, targetPath);
	if (!pathWithinRoot(rootPath, targetPath) || !result) {
		throw new StudySourceReaderError("SOURCE_OUTSIDE_ROOT", `Source path escapes the selected root: ${targetPath}`);
	}
	return result.split(sep).join("/");
}

function texLineSegments(text: string): string[] {
	if (text.length === 0) return [""];
	const segments: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === "\r") {
			const end = text[index + 1] === "\n" ? index + 2 : index + 1;
			segments.push(text.slice(start, end));
			start = end;
			index = end - 1;
		} else if (character === "\n") {
			segments.push(text.slice(start, index + 1));
			start = index + 1;
		}
	}
	if (start < text.length) segments.push(text.slice(start));
	return segments;
}

function splitUtf8(text: string, maxBytes: number): string[] {
	if (utf8Bytes(text) <= maxBytes) return [text];
	const pieces: string[] = [];
	let current = "";
	let currentBytes = 0;
	for (const character of text) {
		const characterBytes = utf8Bytes(character);
		if (current && currentBytes + characterBytes > maxBytes) {
			pieces.push(current);
			current = "";
			currentBytes = 0;
		}
		if (characterBytes > maxBytes) {
			throw new StudySourceReaderError("INVALID_LIMIT", "maxChunkBytes must fit every UTF-8 code point");
		}
		current += character;
		currentBytes += characterBytes;
	}
	if (current) pieces.push(current);
	return pieces;
}

function diagnostic(
	severity: StudySourceDiagnosticSeverity,
	code: string,
	message: string,
	path: string | null,
	location: StudySourceLocation | null = null,
	requiresPdfInspection = false,
): StudySourceDiagnostic {
	return { severity, code, message, path, location, requiresPdfInspection };
}

function pathDepth(rootPath: string, targetPath: string): number {
	const rel = relativePath(rootPath, targetPath);
	return Math.max(0, rel.split("/").length - 1);
}

async function readStableFile(realPath: string, limits: Readonly<StudySourceLimits>): Promise<Uint8Array> {
	const handle = await open(realPath, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new StudySourceReaderError("SOURCE_NOT_FILE", `Source is not a regular file: ${realPath}`);
		if (before.size > limits.maxFileBytes) {
			throw new StudySourceLimitError(
				"MAX_FILE_BYTES",
				`Source file ${realPath} exceeds ${limits.maxFileBytes} bytes`,
			);
		}
		const pieces: Buffer[] = [];
		let total = 0;
		const blockSize = Math.min(64 * 1024, limits.maxFileBytes);
		while (true) {
			const block = Buffer.allocUnsafe(Math.min(blockSize, limits.maxFileBytes - total + 1));
			const { bytesRead } = await handle.read(block, 0, block.byteLength, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > limits.maxFileBytes) {
				throw new StudySourceLimitError(
					"MAX_FILE_BYTES",
					`Source file ${realPath} exceeds ${limits.maxFileBytes} bytes while reading`,
				);
			}
			pieces.push(block.subarray(0, bytesRead));
		}
		const after = await handle.stat();
		const changed =
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			before.ino !== after.ino ||
			before.dev !== after.dev ||
			total !== after.size;
		if (changed) {
			throw new StudySourceReaderError(
				"SOURCE_CHANGED_WHILE_READING",
				`Source changed while being read: ${realPath}`,
			);
		}
		const content = new Uint8Array(total);
		let offset = 0;
		for (const piece of pieces) {
			content.set(piece, offset);
			offset += piece.byteLength;
		}
		return content;
	} finally {
		await handle.close();
	}
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new StudySourceReaderError(
			"UNKNOWN_ENCODING",
			`${path} is not valid UTF-8; convert unknown or UTF-16 encodings before reading`,
		);
	}
}

async function resolveExistingPath(rootPath: string, candidatePath: string): Promise<PathResolution> {
	const lexical = resolve(candidatePath);
	if (!pathWithinRoot(rootPath, lexical)) {
		return {
			status: "outside-root",
			path: lexical,
			realPath: null,
			message: `Path escapes the selected root: ${lexical}`,
		};
	}
	try {
		const realPath = await realpath(lexical);
		if (!pathWithinRoot(rootPath, realPath)) {
			return {
				status: "outside-root",
				path: lexical,
				realPath: realPath,
				message: `Symlink target escapes the selected root: ${realPath}`,
			};
		}
		return { status: "found", path: lexical, realPath };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
		if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing", path: lexical, realPath: null };
		throw error;
	}
}

async function snapshotPath(state: ReaderState, realPath: string): Promise<SourceSnapshot> {
	const path = relativePath(state.rootPath, realPath);
	const existing = state.snapshotsByPath.get(path);
	if (existing) return existing;
	if (state.snapshotsByPath.size >= state.limits.maxFiles) {
		throw new StudySourceLimitError("MAX_FILES", `Study source exceeds ${state.limits.maxFiles} files`);
	}
	const content = await readStableFile(realPath, state.limits);
	if (state.totalInputBytes + content.byteLength > state.limits.maxTotalBytes) {
		throw new StudySourceLimitError(
			"MAX_TOTAL_BYTES",
			`Study sources exceed ${state.limits.maxTotalBytes} total bytes`,
		);
	}
	const snapshot: SourceSnapshot = { realPath, path, bytes: content.byteLength, hash: sha256(content), content };
	state.totalInputBytes += content.byteLength;
	state.snapshotsByPath.set(path, snapshot);
	return snapshot;
}

function consumeOutput(state: ReaderState, bytes: number): void {
	if (state.totalOutputBytes + bytes > state.limits.maxOutputBytes) {
		throw new StudySourceLimitError(
			"MAX_OUTPUT_BYTES",
			`Extracted study source exceeds ${state.limits.maxOutputBytes} output bytes`,
		);
	}
	state.totalOutputBytes += bytes;
}

function chunkId(path: string, hash: string, ordinal: number): string {
	return sha256(TEXT_ENCODER.encode(`${path}\u0000${hash}\u0000${ordinal}`));
}

function makeTexChunks(
	snapshot: SourceSnapshot,
	role: StudySourceRole,
	text: string,
	limits: Readonly<StudySourceLimits>,
): StudySourceChunk[] {
	const chunks: StudySourceChunk[] = [];
	let current = "";
	let currentBytes = 0;
	let currentLines = 0;
	let currentStartLine = 1;
	let currentEndLine = 1;
	let ordinal = 0;
	const flush = (): void => {
		if (!current && chunks.length > 0) return;
		chunks.push({
			id: chunkId(snapshot.path, snapshot.hash, ordinal),
			kind: "tex-source",
			path: snapshot.path,
			hash: snapshot.hash,
			text: current,
			location: { kind: "tex-lines", path: snapshot.path, startLine: currentStartLine, endLine: currentEndLine },
			provenance: { parser: "tex-source", extraction: "exact-source", math: "source-preserved", role },
			sourceXml: null,
			math: [],
		});
		ordinal += 1;
		current = "";
		currentBytes = 0;
		currentLines = 0;
	};
	let lineNumber = 1;
	for (const line of texLineSegments(text)) {
		const pieces = splitUtf8(line, limits.maxChunkBytes);
		for (const [pieceIndex, piece] of pieces.entries()) {
			const startsLine = pieceIndex === 0;
			const pieceBytes = utf8Bytes(piece);
			if (
				current &&
				(currentBytes + pieceBytes > limits.maxChunkBytes || currentLines + (startsLine ? 1 : 0) > limits.maxChunkLines)
			) {
				flush();
			}
			if (!current) {
				currentStartLine = lineNumber;
				currentEndLine = lineNumber;
			}
			current += piece;
			currentBytes += pieceBytes;
			if (startsLine) currentLines += 1;
			currentEndLine = lineNumber;
			if (currentBytes >= limits.maxChunkBytes || currentLines >= limits.maxChunkLines) flush();
		}
		lineNumber += 1;
	}
	flush();
	return chunks;
}

function texLineAt(text: string, index: number): number {
	return text.slice(0, index).split(/\r\n|\r|\n/u).length;
}

function parsingTextWithoutComments(text: string): string {
	return text
		.split(/(\r\n|\r|\n)/u)
		.map((part) => {
			if (/^\r\n|^\r|^\n$/u.test(part)) return part;
			let escaped = false;
			for (let index = 0; index < part.length; index++) {
				const character = part[index];
				if (character === "%" && !escaped) return `${part.slice(0, index)}${" ".repeat(part.length - index)}`;
				escaped = character === "\\" ? !escaped : false;
			}
			return part;
		})
		.join("");
}

interface TexIncludeRequest {
	command: "input" | "include";
		literal: string;
	index: number;
	line: number;
}

function texIncludeRequests(text: string): TexIncludeRequest[] {
	const parsingText = parsingTextWithoutComments(text);
	const requests: TexIncludeRequest[] = [];
	const pattern = /(?<![\\A-Za-z@])\\(input|include)\b\s*(?:\[[^\]\r\n]*\]\s*)?\{([^}]*)\}/gu;
	for (const match of parsingText.matchAll(pattern)) {
		const index = match.index ?? 0;
		const command = match[1];
		const literal = match[2];
		if ((command !== "input" && command !== "include") || literal === undefined) continue;
		requests.push({ command, literal: literal.trim(), index, line: texLineAt(text, index) });
	}
	return requests;
}

function validTexLiteral(value: string): boolean {
	return value.length > 0 && value.length <= 512 && !/[\\\u0000\r\n%{}]/u.test(value);
}

function displayTexLiteral(value: string): string {
	return value.length <= 512 ? value : `${value.slice(0, 512)}… (${value.length} characters)`;
}

async function resolveTexInclude(
	state: ReaderState,
	parent: SourceSnapshot,
	literal: string,
): Promise<PathResolution> {
	if (!validTexLiteral(literal)) {
		return {
			status: "missing",
			path: displayTexLiteral(literal),
			realPath: null,
			message: "TeX include is not a bounded literal path",
		};
	}
	const base = resolve(dirname(parent.realPath), literal);
	const exact = await resolveExistingPath(state.rootPath, base);
	if (exact.status === "found" || exact.status === "outside-root") return exact;
	if (extname(base).length > 0) return exact;
	return resolveExistingPath(state.rootPath, `${base}.tex`);
}

function makePdfChunks(state: ReaderState, snapshot: SourceSnapshot, role: StudySourceRole, text: string): StudySourceChunk[] {
	consumeOutput(state, utf8Bytes(text));
	const pages = text.split("\f");
	if (pages.length > 1 && pages.at(-1) === "") pages.pop();
	if (pages.length === 0) pages.push("");
	return pages.map((pageText, index) => ({
		id: chunkId(snapshot.path, snapshot.hash, index),
		kind: "pdf-page",
		path: snapshot.path,
		hash: snapshot.hash,
		text: pageText,
		location: { kind: "pdf-page", path: snapshot.path, page: index + 1 },
		provenance: { parser: "pdftotext", extraction: "pdf-text-layer", math: "unverified-text-layer", role },
		sourceXml: null,
		math: [],
	}));
}

function localXmlName(name: string): string {
	const separator = name.lastIndexOf(":");
	return separator >= 0 ? name.slice(separator + 1) : name;
}

function xmlPrefix(name: string): string {
	const separator = name.lastIndexOf(":");
	return separator >= 0 ? name.slice(0, separator) : "";
}

interface XmlToken {
	raw: string;
	name: string;
	closing: boolean;
	selfClosing: boolean;
	start: number;
	end: number;
}

function xmlTagEnd(xml: string, start: number): number {
	let quote: '"' | "'" | null = null;
	for (let index = start + 1; index < xml.length; index += 1) {
		const character = xml[index];
		if (quote !== null) {
			if (character === quote) quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ">") return index + 1;
	}
	throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX XML contains an unclosed tag");
}

function xmlTokens(xml: string): XmlToken[] {
	const tokens: XmlToken[] = [];
	let cursor = 0;
	while (true) {
		const start = xml.indexOf("<", cursor);
		if (start < 0) break;
		if (xml.startsWith("<!--", start)) {
			const end = xml.indexOf("-->", start + 4);
			if (end < 0) throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX XML contains an unclosed comment");
			cursor = end + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", start)) {
			const end = xml.indexOf("]]>", start + 9);
			if (end < 0) throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX XML contains an unclosed CDATA section");
			cursor = end + 3;
			continue;
		}
		if (xml.startsWith("<?", start)) {
			const end = xml.indexOf("?>", start + 2);
			if (end < 0) throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX XML contains an unclosed processing instruction");
			cursor = end + 2;
			continue;
		}
		const end = xmlTagEnd(xml, start);
		const raw = xml.slice(start, end);
		cursor = end;
		if (raw.startsWith("<!")) continue;
		const closingMatch = /^<\s*\/\s*([A-Za-z_][\w:.-]*)/u.exec(raw);
		if (closingMatch) {
			tokens.push({ raw, name: closingMatch[1] ?? "", closing: true, selfClosing: false, start, end });
			continue;
		}
		const openingMatch = /^<\s*([A-Za-z_][\w:.-]*)\b/u.exec(raw);
		if (!openingMatch) continue;
		tokens.push({
			raw,
			name: openingMatch[1] ?? "",
			closing: false,
			selfClosing: /\/\s*>$/u.test(raw),
			start,
			end,
		});
	}
	return tokens;
}

function decodeXmlText(value: string): string {
	return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/giu, (entity) => {
		if (entity === "&amp;") return "&";
		if (entity === "&lt;") return "<";
		if (entity === "&gt;") return ">";
		if (entity === "&quot;") return '"';
		if (entity === "&apos;") return "'";
		const rawNumber = entity.startsWith("&#x") || entity.startsWith("&#X") ? entity.slice(3, -1) : entity.slice(2, -1);
		const number = Number.parseInt(rawNumber, entity.startsWith("&#x") || entity.startsWith("&#X") ? 16 : 10);
		return Number.isSafeInteger(number) && number >= 0 ? String.fromCodePoint(number) : entity;
	});
}

interface DocxParagraphDraft {
	xml: string;
	text: string;
	math: StudySourceMath[];
}

function elementFragments(xml: string, names: ReadonlySet<string>): string[] {
	const fragments: string[] = [];
	const stack: Array<{ name: string; start: number; selected: boolean }> = [];
	for (const token of xmlTokens(xml)) {
		const name = localXmlName(token.name);
		if (token.closing) {
			const opened = stack.pop();
			if (!opened || opened.name !== name) throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX XML has mismatched tags");
			if (opened.selected) fragments.push(xml.slice(opened.start, token.end));
			continue;
		}
		const selected = names.has(name) && !stack.some((item) => item.selected);
		if (!token.selfClosing) stack.push({ name, start: token.start, selected });
	}
	if (stack.length > 0) throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX XML has unclosed tags");
	return fragments;
}

function paragraphText(xml: string): string {
	const tokens = xmlTokens(xml);
	let text = "";
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token || token.closing || token.selfClosing) {
			if (!token?.closing && token?.selfClosing && localXmlName(token.name) === "tab") text += "\t";
			if (!token?.closing && token?.selfClosing && ["br", "cr"].includes(localXmlName(token.name))) text += "\n";
			continue;
		}
		if (localXmlName(token.name) !== "t" || xmlPrefix(token.name).toLowerCase() === "m") continue;
		const closingIndex = tokens.findIndex(
			(candidate, candidateIndex) =>
				candidateIndex > index && candidate.closing && localXmlName(candidate.name) === "t" && candidate.name === token.name,
		);
		if (closingIndex < 0) throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX text element is unclosed");
		const closing = tokens[closingIndex];
		if (closing) text += decodeXmlText(xml.slice(token.end, closing.start));
		index = closingIndex;
	}
	return text;
}

function docxParagraphs(xml: string): DocxParagraphDraft[] {
	if (!/<(?:[A-Za-z_][\w.-]*:)?document\b/iu.test(xml)) {
		throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX document.xml has no document root");
	}
	const tokens = xmlTokens(xml);
	const paragraphs: DocxParagraphDraft[] = [];
	const stack: Array<{ start: number; name: string }> = [];
	for (const token of tokens) {
		const name = localXmlName(token.name);
		if (token.closing) {
			const opened = stack.at(-1);
			if (!opened || opened.name !== name) {
				if (name === "p") throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX paragraph tags are mismatched");
				continue;
			}
			stack.pop();
			if (name === "p") {
				const paragraphXml = xml.slice(opened.start, token.end);
				paragraphs.push({
					xml: paragraphXml,
					text: paragraphText(paragraphXml),
					math: elementFragments(paragraphXml, new Set(["oMath", "oMathPara"])).map((fragment) => ({ format: "omml", xml: fragment })),
				});
			}
			continue;
		}
		if (token.selfClosing) continue;
		stack.push({ start: token.start, name });
	}
	if (stack.some((item) => item.name === "p")) throw new StudySourceReaderError("DOCX_XML_INVALID", "DOCX paragraph is unclosed");
	return paragraphs;
}

async function readZipEntryBounded(entry: JSZipObject, maxBytes: number): Promise<Uint8Array> {
	const stream = entry.nodeStream("nodebuffer") as Readable;
	return new Promise((resolvePromise, reject) => {
		const chunks: Uint8Array[] = [];
		let total = 0;
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			stream.destroy();
			reject(error);
		};
		stream.on("data", (value: unknown) => {
			if (settled) return;
			if (!(value instanceof Uint8Array)) {
				fail(new StudySourceReaderError("DOCX_ARCHIVE_INVALID", `DOCX entry ${entry.name} emitted invalid data`));
				return;
			}
			if (total + value.byteLength > maxBytes) {
				fail(new StudySourceLimitError("MAX_FILE_BYTES", `DOCX entry ${entry.name} exceeds ${maxBytes} bytes`));
				return;
			}
			const piece = new Uint8Array(value.byteLength);
			piece.set(value);
			chunks.push(piece);
			total += piece.byteLength;
		});
		stream.on("error", (error: Error) => fail(new StudySourceReaderError("DOCX_ARCHIVE_INVALID", `Failed to decompress DOCX entry ${entry.name}: ${error.message}`)));
		stream.on("end", () => {
			if (settled) return;
			settled = true;
			const output = new Uint8Array(total);
			let offset = 0;
			for (const piece of chunks) {
				output.set(piece, offset);
				offset += piece.byteLength;
			}
			resolvePromise(output);
		});
	});
}

async function parseDocx(state: ReaderState, document: InternalDocument): Promise<void> {
	let archive: JSZip;
	try {
		archive = await JSZip.loadAsync(document.snapshot.content);
	} catch (error) {
		throw new StudySourceReaderError(
			"DOCX_ARCHIVE_INVALID",
			`Invalid DOCX archive ${document.snapshot.path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const entries = Object.values(archive.files);
	if (entries.length > state.limits.maxArchiveEntries) {
		throw new StudySourceLimitError(
			"MAX_ARCHIVE_ENTRIES",
			`DOCX archive ${document.snapshot.path} exceeds ${state.limits.maxArchiveEntries} entries`,
		);
	}
	const entry = archive.file("word/document.xml");
	if (!entry || entry.dir) throw new StudySourceReaderError("DOCX_DOCUMENT_MISSING", `${document.snapshot.path} has no word/document.xml`);
	const xmlBytes = await readZipEntryBounded(entry, Math.min(state.limits.maxFileBytes, state.limits.maxOutputBytes));
	const xml = decodeUtf8(xmlBytes, `${document.snapshot.path}!word/document.xml`);
	const paragraphs = docxParagraphs(xml);
	for (const [index, paragraph] of paragraphs.entries()) {
		const outputSize = utf8Bytes(paragraph.text) + utf8Bytes(paragraph.xml) + paragraph.math.reduce((sum, item) => sum + utf8Bytes(item.xml), 0);
		consumeOutput(state, outputSize);
		const paragraphNumber = index + 1;
		const location: StudySourceLocation = { kind: "docx-paragraph", path: document.snapshot.path, paragraph: paragraphNumber };
		document.chunks.push({
			id: chunkId(document.snapshot.path, document.snapshot.hash, index),
			kind: "docx-paragraph",
			path: document.snapshot.path,
			hash: document.snapshot.hash,
			text: paragraph.text,
			location,
			provenance: { parser: "docx-xml", extraction: "paragraph-xml", math: "omml-preserved", role: document.role },
			sourceXml: paragraph.xml,
			math: paragraph.math,
		});
	}
	if (paragraphs.some((paragraph) => paragraph.math.length > 0)) {
		document.diagnostics.push(
			diagnostic(
				"info",
				"DOCX_OMML_PRESERVED",
				"OMML formula XML was preserved in chunk.math and was not flattened into paragraph text",
				document.snapshot.path,
			),
		);
	}
}

async function makeDocument(state: ReaderState, snapshot: SourceSnapshot, kind: StudySourceKind, role: StudySourceRole): Promise<InternalDocument> {
	const document: InternalDocument = {
		snapshot,
		kind,
		role,
		chunks: [],
		diagnostics: [],
		dependencies: [],
		provenance:
			kind === "tex"
				? { parser: "tex-source", extraction: "exact-source", math: "source-preserved", role }
			: kind === "pdf"
				? { parser: "pdftotext", extraction: "pdf-text-layer", math: "unverified-text-layer", role }
				: { parser: "docx-xml", extraction: "paragraph-xml", math: "omml-preserved", role },
	};
	if (kind === "tex") {
		const text = decodeUtf8(snapshot.content, snapshot.path);
		consumeOutput(state, snapshot.content.byteLength);
		document.chunks.push(...makeTexChunks(snapshot, role, text, state.limits));
	} else if (kind === "pdf") {
		const extractor =
			state.options.pdfExtractor ??
			new PdftotextExtractor({
				command: state.options.pdfCommand ?? process.env.PI_PDFTOTEXT_PATH ?? "pdftotext",
				maxInputBytes: state.limits.maxFileBytes,
				maxOutputBytes: state.limits.maxOutputBytes,
			});
		const extracted = await extractor.extract(snapshot.content, snapshot.path);
		if (utf8Bytes(extracted) > state.limits.maxOutputBytes) {
			throw new StudySourceLimitError("MAX_OUTPUT_BYTES", `PDF ${snapshot.path} exceeds extracted output limit`);
		}
		document.chunks.push(...makePdfChunks(state, snapshot, role, extracted));
		document.diagnostics.push(
			diagnostic(
				"warning",
				"PDF_TEXT_MATH_UNVERIFIED",
				"PDF text-layer extraction preserves page locations, but mathematical symbols and layout require inspection of the original PDF page image",
				snapshot.path,
				null,
				true,
			),
		);
		if (!extracted.trim()) {
			document.diagnostics.push(
				diagnostic(
					"warning",
					"PDF_TEXT_LAYER_EMPTY",
					"The PDF produced no text-layer content; inspect the original PDF pages or OCR explicitly",
					snapshot.path,
					null,
					true,
				),
			);
		}
	} else {
		await parseDocx(state, document);
	}
	return document;
}

function sourceKindForPath(path: string): StudySourceKind | null {
	const extension = extname(path).toLowerCase();
	return extension === ".tex" ? "tex" : extension === ".docx" ? "docx" : extension === ".pdf" ? "pdf" : null;
}

function assertDepth(state: ReaderState, realPath: string): void {
	if (pathDepth(state.rootPath, realPath) > state.limits.maxDepth) {
		throw new StudySourceLimitError("MAX_DEPTH", `Source path exceeds maximum depth ${state.limits.maxDepth}: ${realPath}`);
	}
}

async function loadTexRecursive(state: ReaderState, realPath: string, role: StudySourceRole, stack: readonly string[]): Promise<InternalDocument> {
	assertDepth(state, realPath);
	const snapshot = await snapshotPath(state, realPath);
	const existing = state.documentsByPath.get(snapshot.path);
	if (existing) return existing;
	const document = await makeDocument(state, snapshot, "tex", role);
	state.documentsByPath.set(snapshot.path, document);
	state.chunks.push(...document.chunks);
	const text = document.chunks.map((chunk) => chunk.text).join("");
	for (const request of texIncludeRequests(text)) {
		const location: StudySourceLocation = { kind: "tex-lines", path: snapshot.path, startLine: request.line, endLine: request.line };
		const resolution = await resolveTexInclude(state, snapshot, request.literal);
		if (resolution.status === "missing") {
			const dependency: StudySourceDependency = {
				path: resolution.message ? resolution.path : request.literal,
				relation: "tex-include",
				status: resolution.message ? "invalid-literal" : "missing",
				hash: null,
				bytes: null,
				location,
			};
			document.dependencies.push(dependency);
			state.dependencies.push(dependency);
			document.diagnostics.push(
				diagnostic(
					"error",
					resolution.message ? "TEX_INCLUDE_INVALID_LITERAL" : "TEX_INCLUDE_MISSING",
					resolution.message ?? `TeX ${request.command} target was not found: ${request.literal}`,
					snapshot.path,
					location,
				),
			);
			continue;
		}
		if (resolution.status === "outside-root" || !resolution.realPath) {
			const dependency: StudySourceDependency = {
				path: request.literal,
				relation: "tex-include",
				status: "outside-root",
				hash: null,
				bytes: null,
				location,
			};
			document.dependencies.push(dependency);
			state.dependencies.push(dependency);
			document.diagnostics.push(
				diagnostic("error", "TEX_INCLUDE_OUTSIDE_ROOT", resolution.message ?? "TeX include escapes the selected root", snapshot.path, location),
			);
			continue;
		}
		const includeRealPath = resolution.realPath;
		const includeSnapshotPath = relativePath(state.rootPath, includeRealPath);
		if (stack.includes(includeSnapshotPath) || includeSnapshotPath === snapshot.path) {
			const dependency: StudySourceDependency = {
				path: includeSnapshotPath,
				relation: "tex-include",
				status: "cycle",
				hash: null,
				bytes: null,
				location,
			};
			document.dependencies.push(dependency);
			state.dependencies.push(dependency);
			document.diagnostics.push(diagnostic("error", "TEX_INCLUDE_CYCLE", `TeX include cycle detected at ${includeSnapshotPath}`, snapshot.path, location));
			continue;
		}
		if (pathDepth(state.rootPath, includeRealPath) > state.limits.maxDepth) {
			const dependency: StudySourceDependency = {
				path: includeSnapshotPath,
				relation: "tex-include",
				status: "depth-limit",
				hash: null,
				bytes: null,
				location,
			};
			document.dependencies.push(dependency);
			state.dependencies.push(dependency);
			document.diagnostics.push(diagnostic("error", "MAX_DEPTH", `TeX include exceeds maximum depth ${state.limits.maxDepth}`, snapshot.path, location));
			continue;
		}
		const included = await loadTexRecursive(state, includeRealPath, "tex-include", [...stack, snapshot.path]);
		const dependency: StudySourceDependency = {
			path: included.snapshot.path,
			relation: "tex-include",
			status: "included",
			hash: included.snapshot.hash,
			bytes: included.snapshot.bytes,
			location,
		};
		document.dependencies.push(dependency);
		state.dependencies.push(dependency);
	}
	return document;
}

async function findLinkedPdf(state: ReaderState, primary: SourceSnapshot): Promise<PathResolution> {
	const extension = extname(primary.realPath).toLowerCase();
	if (extension !== ".tex" && extension !== ".docx") return { status: "missing", path: "", realPath: null };
	const stem = primary.realPath.slice(0, -extension.length);
	const exact = await resolveExistingPath(state.rootPath, `${stem}.pdf`);
	if (exact.status !== "missing") return exact;
	const directory = dirname(primary.realPath);
	const entries = await readdir(directory, { withFileTypes: true });
	if (entries.length > state.limits.maxDirectoryEntries) {
		throw new StudySourceLimitError("MAX_DIRECTORY_ENTRIES", `Directory ${directory} exceeds ${state.limits.maxDirectoryEntries} entries`);
	}
	const expected = `${stem.split(/[\\/]/u).at(-1)?.toLowerCase() ?? ""}.pdf`;
	const match = entries.find((entry) => entry.name.toLowerCase() === expected && !entry.isDirectory());
	return match ? resolveExistingPath(state.rootPath, join(directory, match.name)) : exact;
}

async function resolveEntry(state: ReaderState): Promise<{ realPath: string; kind: StudySourceKind }> {
	if (state.options.entryPath !== undefined) {
		if (!state.options.entryPath.trim()) throw new StudySourceReaderError("INVALID_ENTRY", "entryPath must not be empty");
		if (extname(state.options.entryPath).toLowerCase() === ".doc") {
			throw new StudySourceReaderError("LEGACY_DOC_UNSUPPORTED", "Legacy .doc files are unsupported; convert to .docx explicitly");
		}
		const candidate = isAbsolute(state.options.entryPath) ? state.options.entryPath : resolve(state.rootPath, state.options.entryPath);
		const resolution = await resolveExistingPath(state.rootPath, candidate);
		if (resolution.status === "outside-root") {
			throw new StudySourceReaderError("SOURCE_OUTSIDE_ROOT", resolution.message ?? "Study entry escapes the selected root");
		}
		if (resolution.status !== "found" || !resolution.realPath) {
			throw new StudySourceReaderError("ENTRY_NOT_FOUND", resolution.message ?? `Study entry was not found: ${state.options.entryPath}`);
		}
		const kind = sourceKindForPath(resolution.realPath);
		if (!kind) {
			throw new StudySourceReaderError("UNSUPPORTED_SOURCE_TYPE", `Unsupported study source type: ${state.options.entryPath}`);
		}
		assertDepth(state, resolution.realPath);
		return { realPath: resolution.realPath, kind };
	}
	const entries = await readdir(state.rootPath, { withFileTypes: true });
	if (entries.length > state.limits.maxDirectoryEntries) {
		throw new StudySourceLimitError("MAX_DIRECTORY_ENTRIES", `Source root exceeds ${state.limits.maxDirectoryEntries} entries`);
	}
	const names = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
	const lowerNames = new Map(names.map((name) => [name.toLowerCase(), name]));
	const ordered = [
		"main.tex",
		"main.docx",
		...names.filter((name) => [".tex", ".docx"].includes(extname(name).toLowerCase())).sort((left, right) => left.localeCompare(right)),
		"main.pdf",
		...names.filter((name) => extname(name).toLowerCase() === ".pdf").sort((left, right) => left.localeCompare(right)),
	];
	const selectedName = ordered.map((name) => lowerNames.get(name.toLowerCase())).find((name): name is string => name !== undefined);
	if (!selectedName) {
		if (names.some((name) => extname(name).toLowerCase() === ".doc")) {
			throw new StudySourceReaderError("LEGACY_DOC_UNSUPPORTED", "Legacy .doc files are unsupported; convert to .docx explicitly");
		}
		throw new StudySourceReaderError("NO_SOURCE_ENTRY", "No main.tex, main.docx, or PDF source was found at the selected root");
	}
	const resolution = await resolveExistingPath(state.rootPath, join(state.rootPath, selectedName));
	if (resolution.status === "outside-root") {
		throw new StudySourceReaderError("SOURCE_OUTSIDE_ROOT", resolution.message ?? `Study entry escapes the selected root: ${selectedName}`);
	}
	if (resolution.status !== "found" || !resolution.realPath) {
		throw new StudySourceReaderError("ENTRY_NOT_FOUND", resolution.message ?? `Study entry was not found: ${selectedName}`);
	}
	const kind = sourceKindForPath(resolution.realPath);
	if (!kind) throw new StudySourceReaderError("UNSUPPORTED_SOURCE_TYPE", `Unsupported study source type: ${selectedName}`);
	return { realPath: resolution.realPath, kind };
}

function addLinkedPdfDiagnostic(primary: InternalDocument, linked: InternalDocument): void {
	const message = `PDF ${linked.snapshot.path} is linked to source ${primary.snapshot.path}; version correspondence is unverified and must not be inferred from filename or extraction success`;
	const item = diagnostic("warning", "LINKED_PDF_VERSION_UNVERIFIED", message, primary.snapshot.path);
	primary.diagnostics.push(item);
}

function publicDocument(document: InternalDocument): StudySourceDocument {
	return {
		kind: document.kind,
		role: document.role,
		path: document.snapshot.path,
		hash: document.snapshot.hash,
		bytes: document.snapshot.bytes,
		chunks: [...document.chunks],
		diagnostics: [...document.diagnostics],
		dependencies: [...document.dependencies],
		provenance: document.provenance,
	};
}

async function readRootPath(rootPath: string): Promise<string> {
	const realRoot = await realpath(rootPath);
	const handle = await open(realRoot, "r");
	try {
		const stats = await handle.stat();
		if (!stats.isDirectory()) throw new StudySourceReaderError("ROOT_NOT_DIRECTORY", `Study source root is not a directory: ${rootPath}`);
	} finally {
		await handle.close();
	}
	return realRoot;
}

/** Read a bounded paper source tree without modifying any input files. */
export async function readStudySources(rootPath: string, options: StudySourceReaderOptions = {}): Promise<StudySourceManifest> {
	if (!rootPath.trim()) throw new StudySourceReaderError("INVALID_ROOT", "rootPath must not be empty");
	const limits = resolveLimits(options);
	const realRoot = await readRootPath(rootPath);
	const state: ReaderState = {
		rootPath: realRoot,
		limits,
		options,
		snapshotsByPath: new Map(),
		documentsByPath: new Map(),
		dependencies: [],
		chunks: [],
		totalInputBytes: 0,
		totalOutputBytes: 0,
	};
	const entry = await resolveEntry(state);
	const primarySnapshot = await snapshotPath(state, entry.realPath);
	let primary: InternalDocument;
	if (entry.kind === "tex") primary = await loadTexRecursive(state, entry.realPath, "primary", []);
	else {
		primary = await makeDocument(state, primarySnapshot, entry.kind, "primary");
		state.documentsByPath.set(primarySnapshot.path, primary);
		state.chunks.push(...primary.chunks);
	}
	if (entry.kind !== "pdf") {
		const linkedResolution = await findLinkedPdf(state, primarySnapshot);
		if (linkedResolution.status === "outside-root") {
			const item = diagnostic("error", "LINKED_PDF_OUTSIDE_ROOT", linkedResolution.message ?? "Linked PDF escapes selected root", primary.snapshot.path);
			primary.diagnostics.push(item);
		} else if (linkedResolution.status === "found" && linkedResolution.realPath) {
			assertDepth(state, linkedResolution.realPath);
			const linkedSnapshot = await snapshotPath(state, linkedResolution.realPath);
			const linked =
				state.documentsByPath.get(linkedSnapshot.path) ?? (await makeDocument(state, linkedSnapshot, "pdf", "linked-pdf"));
			state.documentsByPath.set(linkedSnapshot.path, linked);
			state.chunks.push(...linked.chunks);
			const dependency: StudySourceDependency = {
				path: linked.snapshot.path,
				relation: "linked-pdf",
				status: "included",
				hash: linked.snapshot.hash,
				bytes: linked.snapshot.bytes,
				location: null,
			};
			primary.dependencies.push(dependency);
			state.dependencies.push(dependency);
			addLinkedPdfDiagnostic(primary, linked);
		}
	}
	const documents = [...state.documentsByPath.values()].map(publicDocument);
	const allDiagnostics = documents.flatMap((document) => document.diagnostics);
	const manifest: StudySourceManifest = {
		version: 1,
		rootPath: realRoot,
		mode: entry.kind === "pdf" ? "pdf-only" : "source-first",
		kind: primary.kind,
		path: primary.snapshot.path,
		hash: primary.snapshot.hash,
		bytes: primary.snapshot.bytes,
		chunks: [...state.chunks],
		diagnostics: allDiagnostics,
		dependencies: [...state.dependencies],
		provenance: primary.provenance,
		documents,
		limits,
	};
	return deepFreeze(manifest);
}

/** Singular alias for callers that treat one selected root as one paper. */
export const readStudySource = readStudySources;
