import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { contentHash, deterministicId, sha256Hex } from "../../harness-core/src/index.ts";
import type {
	BeamerAsset,
	BeamerCompiledArtifact,
	BeamerCompileReceipt,
	BeamerDeck,
	BeamerProfile,
	CompileDiagnostic,
	CourseBuilderProject,
	DeckReview,
	DeckReviewIssue,
} from "./types.ts";

export class BeamerWorkflowError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "BeamerWorkflowError";
		this.code = code;
	}
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export function beamerCommandLeaks(source: string): { line: number; command: string }[] {
	// Mask literal TeX demonstrations and comments without changing line offsets.
	const masked = source.replace(
		/\\begin\{(verbatim\*?|lstlisting)\}[\s\S]*?\\end\{\1\}|\\verb\*?([^\w\s])[^\n]*?\2|(?<!\\)%[^\n]*/gu,
		(value) => value.replace(/[^\n]/gu, " "),
	);
	const issues: { line: number; command: string }[] = [];
	for (const match of masked.matchAll(/(\\+)(texttt|textbf|textit|textrm|textsf|emph|alert)\s*\{/gu)) {
		if (match[1].length % 2 === 0)
			issues.push({ line: masked.slice(0, match.index).split("\n").length, command: match[2] });
	}
	return issues;
}

export function assertBeamerPresentationSource(source: string): void {
	const issues = beamerCommandLeaks(source);
	if (issues.length)
		throw new BeamerWorkflowError(
			"TEX_COMMAND_LEAK",
			`TEX_COMMAND_LEAK: ${issues.map((issue) => `line ${issue.line}: ${issue.command}`).join("; ")}. A line break consumed the command backslash; separate the line break from a valid formatting command. Repair all listed occurrences and retry.`,
		);
}
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 64 * 1024 * 1024;
const DANGEROUS_TEX = [
	/\\(?:immediate\s*)?write18\b/iu,
	/\\(?:openin|openout|read|write)\b/iu,
	/\\(?:input|include|includeonly|openin|openout|read|write|filecontents|directlua|special|catcode|csname)\b/iu,
	/\^\^/u,
	/\\begin\s*\{filecontents\*?\}/iu,
	/\\catcode\b/iu,
	/\\csname\s*(?:input|write18|openin|openout)\s*\\endcsname/iu,
	/\\usepackage\s*\{(?:shellesc|catchfile)\}/iu,
];

function isoTimestamp(value: string, field: string): string {
	if (!Number.isFinite(Date.parse(value)))
		throw new BeamerWorkflowError("INVALID_TIMESTAMP", `${field} must be ISO-8601`);
	return value;
}

function clampInteger(value: number, field: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new BeamerWorkflowError("INVALID_LIMIT", `${field} must be an integer from ${min} to ${max}`);
	}
	return value;
}

export function assertSafeBeamerSource(source: string): void {
	if (typeof source !== "string" || !source.trim()) {
		throw new BeamerWorkflowError("EMPTY_BEAMER_SOURCE", "Beamer source must be a non-empty string");
	}
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
		throw new BeamerWorkflowError("BEAMER_SOURCE_TOO_LARGE", `Beamer source exceeds ${MAX_SOURCE_BYTES} bytes`);
	}
	if (!/\\documentclass(?:\[[^\]]*\])?\{beamer\}/u.test(source)) {
		throw new BeamerWorkflowError("BEAMER_DOCUMENT_REQUIRED", "Source must declare the beamer document class");
	}
	for (const pattern of DANGEROUS_TEX) {
		if (pattern.test(source)) {
			throw new BeamerWorkflowError(
				"UNSAFE_TEX_PRIMITIVE",
				"Beamer source contains a TeX primitive that is not permitted by the bounded compiler",
			);
		}
	}
}

export function assertBeamerAssets(source: string, assets: readonly BeamerAsset[]): void {
	const paths = new Set<string>();
	let total = 0;
	for (const asset of assets) {
		if (!/^assets\/[A-Za-z0-9_-]+\.(?:png|jpe?g|pdf)$/iu.test(asset.path) || paths.has(asset.path))
			throw new BeamerWorkflowError("UNSAFE_ASSET_PATH", "Asset paths must be unique, relative published paths");
		if (`sha256:${sha256Hex(asset.bytes)}` !== asset.contentHash)
			throw new BeamerWorkflowError("ASSET_HASH_MISMATCH", "Asset content changed");
		total += asset.bytes.byteLength;
		if (total > 64 * 1024 * 1024) throw new BeamerWorkflowError("ASSETS_TOO_LARGE", "Asset batch exceeds 64 MiB");
		paths.add(asset.path);
	}
	for (const match of source.matchAll(/\\includegraphics\*?(?:\[[^\]]*\])?\{([^}]+)\}/gu)) {
		if (!paths.has(match[1]))
			throw new BeamerWorkflowError("UNKNOWN_ASSET", `Unknown published graphic: ${match[1]}`);
	}
	if (
		/\\(?:graphicspath|input@path|usepackage|RequirePackage|documentclass)(?:\[[^\]]*\])?\{[^}]*[./\\][^}]*\}/u.test(
			source,
		)
	)
		throw new BeamerWorkflowError("UNSAFE_TEX_PATH", "TeX package and input paths may not escape the project");
}

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	outputLimited: boolean;
}

export type LatexDocumentKind = "beamer" | "teacher-notes";

/** Resolve the companion SyncTeX executable without guessing a different tool. */
export async function resolveSyncTexCommand(compiler?: string): Promise<string> {
	const configured = compiler?.trim() || process.env.PI_XELATEX_PATH?.trim() || "";
	if (configured && (isAbsolute(configured) || configured.includes("/") || configured.includes("\\"))) {
		const candidate = join(dirname(resolve(configured)), "synctex.exe");
		try {
			const info = await lstat(candidate);
			if (info.isFile()) return candidate;
		} catch (error) {
			if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
		}
	}
	return "synctex.exe";
}

export interface CompileLatexDocumentOptions {
	source: string;
	sourceHash: string;
	documentKind: LatexDocumentKind;
	compiler?: string;
	passes?: number;
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxPdfBytes?: number;
	env?: NodeJS.ProcessEnv;
	createdAt?: string;
	assets?: readonly BeamerAsset[];
}

export interface CompileLatexDocumentResult {
	sourceHash: string;
	documentKind: LatexDocumentKind;
	pdfBytes: Uint8Array | null;
	/** The compressed SyncTeX map produced for this document, when available. */
	syncTexBytes?: Uint8Array;
	log: string;
	compiler: string;
	arguments: string[];
	succeeded: boolean;
	exitCode: number | null;
	pageCount: number | null;
	pdfHash: string | null;
	logHash: string;
	diagnostics: CompileDiagnostic[];
	createdAt: string;
}

const TEACHER_NOTES_DOCUMENT_CLASSES = new Set(["article", "report", "book", "ctexart", "ctexrep", "ctexbook"]);
const MAX_SYNCTEX_BYTES = 64 * 1024 * 1024;

function isNodeErrorWithCode(value: unknown, code: string): boolean {
	return value instanceof Error && "code" in value && (value as NodeJS.ErrnoException).code === code;
}

function assertStandaloneTeacherNotesSource(source: string): void {
	const declarations = [...source.matchAll(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^}\r\n]+)\}/gu)];
	if (declarations.length !== 1)
		throw new BeamerWorkflowError(
			"TEACHER_NOTES_DOCUMENT_REQUIRED",
			"Teacher notes source must contain exactly one standalone documentclass",
		);
	if (!TEACHER_NOTES_DOCUMENT_CLASSES.has(declarations[0][1].trim()))
		throw new BeamerWorkflowError(
			"TEACHER_NOTES_DOCUMENT_REQUIRED",
			"Teacher notes source must use article, report, book, ctexart, ctexrep or ctexbook",
		);
	if (!/\\begin\s*\{\s*document\s*\}/u.test(source) || !/\\end\s*\{\s*document\s*\}/u.test(source))
		throw new BeamerWorkflowError(
			"TEACHER_NOTES_DOCUMENT_REQUIRED",
			"Teacher notes source must contain begin{document} and end{document}",
		);
}

function assertSafeTeacherNotesSource(source: string): void {
	if (typeof source !== "string" || !source.trim())
		throw new BeamerWorkflowError("EMPTY_TEACHER_NOTES_SOURCE", "Teacher notes source must be a non-empty string");
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES)
		throw new BeamerWorkflowError(
			"TEACHER_NOTES_SOURCE_TOO_LARGE",
			`Teacher notes source exceeds ${MAX_SOURCE_BYTES} bytes`,
		);
	assertStandaloneTeacherNotesSource(source);
	for (const pattern of DANGEROUS_TEX) {
		if (pattern.test(source))
			throw new BeamerWorkflowError(
				"UNSAFE_TEX_PRIMITIVE",
				"Teacher notes source contains a TeX primitive that is not permitted by the bounded compiler",
			);
	}
	assertBeamerPresentationSource(source);
}

function runBoundedProcess(options: {
	command: string;
	args: readonly string[];
	cwd: string;
	timeoutMs: number;
	maxOutputBytes: number;
	env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
	return new Promise((resolveProcess, rejectProcess) => {
		const child = spawn(options.command, [...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let settled = false;
		let timedOut = false;
		let outputLimited = false;
		const finish = (result: ProcessResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveProcess(result);
		};
		const killForLimit = (): void => {
			outputLimited = true;
			child.kill("SIGKILL");
		};
		const append = (target: Buffer[], chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > options.maxOutputBytes) {
				killForLimit();
				return;
			}
			target.push(chunk);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectProcess(
				new BeamerWorkflowError(
					"BEAMER_COMPILER_START_FAILED",
					`Unable to start ${options.command}: ${error.message}`,
				),
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

function compileDiagnostics(log: string, result: ProcessResult): CompileDiagnostic[] {
	const diagnostics: CompileDiagnostic[] = [];
	if (result.timedOut)
		diagnostics.push({
			code: "COMPILE_TIMEOUT",
			severity: "critical",
			message: "XeLaTeX exceeded its execution budget",
		});
	if (result.outputLimited)
		diagnostics.push({
			code: "COMPILE_OUTPUT_LIMIT",
			severity: "critical",
			message: "XeLaTeX exceeded its output budget",
		});
	if (result.exitCode !== 0)
		diagnostics.push({
			code: "COMPILE_EXIT",
			severity: "critical",
			message: `XeLaTeX exited with code ${result.exitCode ?? "null"}`,
		});
	// XeTeX emits both file:line errors and traditional ! errors (including
	// runaway arguments with no source line). Preserve the engine's evidence.
	const lines = log.split(/\r?\n/u);
	const seenErrors = new Set<string>();
	for (let index = 0; index < lines.length; index++) {
		if (!/^!\s|^.+\.(?:tex|sty|cls|vrb):\d+:\s/u.test(lines[index])) continue;
		const context = lines
			.slice(index, index + 7)
			.join("\n")
			.trim();
		if (seenErrors.has(context)) continue;
		seenErrors.add(context);
		diagnostics.push({ code: "TEX_ERROR", severity: "critical", message: context });
	}
	if (/Undefined control sequence/iu.test(log))
		diagnostics.push({
			code: "UNDEFINED_CONTROL_SEQUENCE",
			severity: "critical",
			message: "The log contains an undefined control sequence",
		});
	if (/Citation [`'][^`']+[`'].*undefined|There were undefined citations/iu.test(log))
		diagnostics.push({
			code: "UNDEFINED_CITATION",
			severity: "critical",
			message: "The log contains unresolved citations",
		});
	if (/Reference [`'][^`']+[`'].*undefined|There were undefined references/iu.test(log))
		diagnostics.push({
			code: "UNDEFINED_REFERENCE",
			severity: "major",
			message: "The log contains unresolved references",
		});
	for (const match of log.matchAll(/Overfull \\([hv])box \((\d+(?:\.\d+)?)pt too (?:wide|high)\)([^\r\n]*)/giu)) {
		const amount = Number(match[2] ?? 0);
		diagnostics.push({
			code: match[1] === "v" ? "OVERFULL_VBOX" : "OVERFULL_HBOX",
			severity: amount > 10 ? "critical" : "major",
			message: `Overfull ${match[1]}box is ${amount}pt beyond its boundary${match[3]}`,
		});
	}
	return diagnostics;
}

function pageCountFromLog(log: string): number | null {
	const match = /Output written on .+? \((\d+) pages?/iu.exec(log);
	return match ? Number(match[1]) : null;
}

export interface CompileBeamerOptions {
	project: CourseBuilderProject;
	deck: BeamerDeck;
	compiler?: string;
	passes?: number;
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxPdfBytes?: number;
	env?: NodeJS.ProcessEnv;
	createdAt?: string;
	assets?: readonly BeamerAsset[];
}

export async function compileLatexDocument(options: CompileLatexDocumentOptions): Promise<CompileLatexDocumentResult> {
	if (options.documentKind !== "beamer" && options.documentKind !== "teacher-notes")
		throw new BeamerWorkflowError("INVALID_DOCUMENT_KIND", "documentKind must be beamer or teacher-notes");
	const source = options.source;
	if (options.documentKind === "beamer") {
		assertSafeBeamerSource(source);
		assertBeamerPresentationSource(source);
	} else assertSafeTeacherNotesSource(source);
	assertBeamerAssets(source, options.assets ?? []);
	if (options.sourceHash !== `sha256:${sha256Hex(source)}`)
		throw new BeamerWorkflowError("SOURCE_HASH_MISMATCH", "Document source does not match its hash");
	const compiler = options.compiler?.trim() || process.env.PI_XELATEX_PATH?.trim() || "xelatex";
	const passes = clampInteger(options.passes ?? 2, "passes", 1, 3);
	const timeoutMs = clampInteger(options.timeoutMs ?? 30_000, "timeoutMs", 1_000, 120_000);
	const maxOutputBytes = clampInteger(
		options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		"maxOutputBytes",
		4_096,
		16 * 1024 * 1024,
	);
	const maxPdfBytes = clampInteger(
		options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES,
		"maxPdfBytes",
		4_096,
		256 * 1024 * 1024,
	);
	const createdAt = isoTimestamp(options.createdAt ?? new Date().toISOString(), "createdAt");
	const inputName = options.documentKind === "beamer" ? "deck.tex" : "teacher-notes.tex";
	const stem = inputName.slice(0, -4);
	const args = [
		"-no-shell-escape",
		"-interaction=nonstopmode",
		"-halt-on-error",
		"-file-line-error",
		"-synctex=1",
		inputName,
	];
	let directory: string | null = null;
	let log = "";
	let finalLog = "";
	let finalResult: ProcessResult = { exitCode: null, stdout: "", stderr: "", timedOut: false, outputLimited: false };
	let pdfBytes: Uint8Array | null = null;
	let syncTexBytes: Uint8Array | undefined;
	try {
		directory = await mkdtemp(
			join(tmpdir(), options.documentKind === "beamer" ? "pi-own-beamer-" : "pi-own-teacher-notes-"),
		);
		await writeFile(join(directory, inputName), source, "utf8");
		await mkdir(join(directory, "assets"));
		for (const asset of options.assets ?? []) await writeFile(join(directory, asset.path), asset.bytes);
		const environment: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			SYSTEMROOT: process.env.SYSTEMROOT,
			WINDIR: process.env.WINDIR,
			HOME: directory,
			TMPDIR: directory,
			TEMP: directory,
			TMP: directory,
			...(options.env ?? {}),
			NODE_ENV: options.env?.NODE_ENV ?? process.env.NODE_ENV ?? "production",
			openin_any: "p",
			openout_any: "p",
			shell_escape: "f",
		};
		for (let pass = 0; pass < passes; pass++) {
			finalResult = await runBoundedProcess({
				command: compiler,
				args,
				cwd: directory,
				timeoutMs,
				maxOutputBytes,
				env: environment,
			});
			finalLog = `${finalResult.stdout}\n${finalResult.stderr}`;
			try {
				const logInfo = await lstat(join(directory, `${stem}.log`));
				if (!logInfo.isFile() || logInfo.size > maxOutputBytes)
					throw new BeamerWorkflowError("BEAMER_LOG_TOO_LARGE", "Compiler log exceeds its budget");
				finalLog += `\n${await readFile(join(directory, `${stem}.log`), "utf8")}`;
			} catch (error) {
				if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
			}
			log += `\n=== pass ${pass + 1} ===\n${finalLog}`;
			if (finalResult.exitCode !== 0 || finalResult.timedOut || finalResult.outputLimited) break;
		}
		try {
			const info = await lstat(join(directory, `${stem}.pdf`));
			if (!info.isFile() || info.size < 5 || info.size > maxPdfBytes)
				throw new BeamerWorkflowError(
					options.documentKind === "beamer" ? "BEAMER_PDF_TOO_LARGE" : "LATEX_PDF_TOO_LARGE",
					"Compiler output is not a bounded PDF file",
				);
			const candidate = await readFile(join(directory, `${stem}.pdf`));
			if (candidate.subarray(0, 5).toString() !== "%PDF-")
				throw new BeamerWorkflowError("INVALID_PDF", "Compiler output has no PDF header");
			if (candidate.byteLength > maxPdfBytes)
				throw new BeamerWorkflowError(
					options.documentKind === "beamer" ? "BEAMER_PDF_TOO_LARGE" : "LATEX_PDF_TOO_LARGE",
					`Compiled PDF exceeds ${maxPdfBytes} bytes`,
				);
			pdfBytes = new Uint8Array(candidate);
		} catch (error) {
			if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
			pdfBytes = null;
		}
		try {
			const info = await lstat(join(directory, `${stem}.synctex.gz`));
			if (!info.isFile() || info.size < 2 || info.size > MAX_SYNCTEX_BYTES)
				throw new BeamerWorkflowError(
					"LATEX_SYNCTEX_TOO_LARGE",
					"Compiler SyncTeX output is not a bounded mapping file",
				);
			const candidate = await readFile(join(directory, `${stem}.synctex.gz`));
			if (candidate.byteLength < 2 || candidate.byteLength > MAX_SYNCTEX_BYTES)
				throw new BeamerWorkflowError(
					"LATEX_SYNCTEX_TOO_LARGE",
					"Compiler SyncTeX output exceeds its byte budget",
				);
			syncTexBytes = new Uint8Array(candidate);
		} catch (error) {
			if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
		}
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true });
	}
	const diagnostics = compileDiagnostics(finalLog, finalResult);
	if (!pdfBytes) diagnostics.push({ code: "PDF_MISSING", severity: "critical", message: "No valid PDF was produced" });
	const succeeded =
		finalResult.exitCode === 0 &&
		!finalResult.timedOut &&
		!finalResult.outputLimited &&
		pdfBytes !== null &&
		!diagnostics.some((item) => item.severity === "critical");
	return {
		sourceHash: options.sourceHash,
		documentKind: options.documentKind,
		pdfBytes,
		syncTexBytes,
		log,
		compiler: basename(resolve(compiler)),
		arguments: args,
		succeeded,
		exitCode: finalResult.exitCode,
		pageCount: pageCountFromLog(finalLog),
		pdfHash: pdfBytes ? `sha256:${sha256Hex(pdfBytes)}` : null,
		logHash: `sha256:${sha256Hex(log)}`,
		diagnostics,
		createdAt,
	};
}

export async function compileBeamerDeck(options: CompileBeamerOptions): Promise<{
	receipt: BeamerCompileReceipt;
	artifact: BeamerCompiledArtifact | null;
	log: string;
}> {
	assertSafeBeamerSource(options.deck.source);
	assertBeamerPresentationSource(options.deck.source);
	assertBeamerAssets(options.deck.source, options.assets ?? []);
	if (options.deck.sourceHash !== `sha256:${sha256Hex(options.deck.source)}`)
		throw new BeamerWorkflowError("SOURCE_HASH_MISMATCH", "Deck source does not match its hash");
	if (options.deck.projectId !== options.project.projectId) {
		throw new BeamerWorkflowError("PROJECT_MISMATCH", "Deck belongs to another Course Builder project");
	}
	const result = await compileLatexDocument({
		source: options.deck.source,
		sourceHash: options.deck.sourceHash,
		documentKind: "beamer",
		compiler: options.compiler,
		passes: options.passes,
		timeoutMs: options.timeoutMs,
		maxOutputBytes: options.maxOutputBytes,
		maxPdfBytes: options.maxPdfBytes,
		env: options.env,
		createdAt: options.createdAt,
		assets: options.assets,
	});
	if (result.succeeded && !result.syncTexBytes)
		throw new BeamerWorkflowError(
			"COMPILE_SYNCTEX_REQUIRED",
			"Successful Beamer compilation produced no SyncTeX mapping; recompile with SyncTeX enabled",
		);
	const syncTexCommand = result.succeeded ? await resolveSyncTexCommand(options.compiler) : undefined;
	const base = {
		projectId: options.project.projectId,
		deckId: options.deck.deckId,
		deckRevision: options.deck.revision,
		sourceHash: options.deck.sourceHash,
		compiler: result.compiler,
		arguments: result.arguments,
		succeeded: result.succeeded,
		exitCode: result.exitCode,
		pageCount: result.pageCount,
		pdfHash: result.pdfHash,
		logHash: result.logHash,
		diagnostics: result.diagnostics,
		createdAt: result.createdAt,
	};
	const receiptId = deterministicId("beamer-compile", base, 40);
	const receipt: BeamerCompileReceipt = {
		receiptId,
		...base,
		contentHash: contentHash({ receiptId, ...base }),
	};
	return {
		receipt,
		artifact: result.pdfBytes
			? {
				receiptId,
				pdfBytes: result.pdfBytes,
				...(result.succeeded
					? { syncTexBytes: result.syncTexBytes, syncTexCommand }
					: {}),
			}
			: null,
		log: result.log,
	};
}

function addIssue(
	issues: DeckReviewIssue[],
	code: string,
	severity: DeckReviewIssue["severity"],
	message: string,
	location: string | null = null,
): void {
	issues.push({ code, severity, message, location });
}

function frameSources(source: string): Array<{ title: string; body: string }> {
	const frames: Array<{ title: string; body: string }> = [];
	for (const match of source.matchAll(/\\begin\{frame\}(?:\{([^}]*)\})?([\s\S]*?)\\end\{frame\}/gu)) {
		const body = match[2] ?? "";
		const explicit = match[1]?.trim();
		const titleMatch = /\\frametitle\{([^}]*)\}/u.exec(body);
		frames.push({ title: explicit || titleMatch?.[1]?.trim() || `frame-${frames.length + 1}`, body });
	}
	return frames;
}

export function reviewBeamerDeck(options: {
	project: CourseBuilderProject;
	deck: BeamerDeck;
	compileReceipt?: BeamerCompileReceipt | null;
	createdAt?: string;
}): DeckReview {
	assertSafeBeamerSource(options.deck.source);
	if (options.deck.projectId !== options.project.projectId) {
		throw new BeamerWorkflowError("PROJECT_MISMATCH", "Deck belongs to another project");
	}
	const createdAt = isoTimestamp(options.createdAt ?? new Date().toISOString(), "createdAt");
	const issues: DeckReviewIssue[] = [];
	const source = options.deck.source;
	for (const issue of beamerCommandLeaks(source))
		addIssue(
			issues,
			"TEX_COMMAND_LEAK",
			"critical",
			`Formatting command ${issue.command} will print literally; separate the line break and command backslash`,
			`line ${issue.line}`,
		);
	const frames = frameSources(source);
	const profile: BeamerProfile = options.project.beamerProfile;
	if (frames.length === 0) addIssue(issues, "NO_FRAMES", "critical", "The Beamer deck has no frames");
	const aspectToken = profile.aspectRatio === "169" ? "aspectratio=169" : "aspectratio=43";
	if (!source.includes(aspectToken))
		addIssue(issues, "ASPECT_RATIO_MISMATCH", "major", `Document class does not contain ${aspectToken}`);
	if (profile.overlayPolicy === "deny" && /\\(?:pause|only|onslide|uncover)\b/iu.test(source)) {
		addIssue(issues, "OVERLAY_DENIED", "major", "The project profile forbids Beamer overlays");
	}
	if (/\\tiny\b/u.test(source)) addIssue(issues, "TINY_TEXT", "major", "User-facing content uses \\tiny");
	if (/\[(?:TODO|XXX|name)\]/iu.test(source))
		addIssue(issues, "PLACEHOLDER", "major", "The deck contains an unreplaced placeholder");
	if (profile.referencesPolicy === "required" && !/\\begin\{thebibliography\}|\\bibliography\{/u.test(source)) {
		addIssue(issues, "REFERENCES_REQUIRED", "major", "The Beamer profile requires a references section");
	}
	if (profile.backupSlides > 0 && !/\\appendix\b/u.test(source)) {
		addIssue(
			issues,
			"BACKUP_SLIDES_REQUIRED",
			"minor",
			"The project requests backup slides but the deck has no appendix",
		);
	}
	for (const frame of frames) {
		const itemCount = [...frame.body.matchAll(/\\item\b/gu)].length;
		const displayMath = [...frame.body.matchAll(/\\\[|\\begin\{(?:equation\*?|align\*?|gather\*?)\}/gu)].length;
		const newCommands = [...frame.body.matchAll(/\\newcommand\b/gu)].length;
		const boxes = [...frame.body.matchAll(/\\begin\{(?:alertblock|exampleblock|block)\}/gu)].length;
		const substantive =
			/\\begin\{(?:tikzpicture|table|tabular|theorem|definition|example|proof|algorithm|lstlisting)\}|\\includegraphics|\\\[|\\begin\{(?:equation|align|gather)/u.test(
				frame.body,
			);
		if (itemCount > 7) addIssue(issues, "DENSE_LIST", "major", `Frame has ${itemCount} list items`, frame.title);
		if (displayMath > 2)
			addIssue(issues, "DENSE_EQUATIONS", "major", `Frame has ${displayMath} displayed equations`, frame.title);
		if (newCommands > 5)
			addIssue(issues, "DENSE_NOTATION", "minor", `Frame introduces ${newCommands} commands`, frame.title);
		if (boxes > 2) addIssue(issues, "BOX_FATIGUE", "minor", `Frame has ${boxes} colored blocks`, frame.title);
		if (
			itemCount <= 3 &&
			!substantive &&
			frame.body.replace(/\\[A-Za-z]+(?:\[[^\]]*\])?\{[^}]*\}/gu, "").trim().length < 300
		) {
			addIssue(issues, "SPARSE_FRAME", "minor", "Frame may be too sparse for a lecture deck", frame.title);
		}
	}
	if (options.compileReceipt) {
		if (
			options.compileReceipt.deckId !== options.deck.deckId ||
			options.compileReceipt.deckRevision !== options.deck.revision ||
			options.compileReceipt.sourceHash !== options.deck.sourceHash
		) {
			addIssue(
				issues,
				"STALE_COMPILE_RECEIPT",
				"critical",
				"Compile receipt does not match the current deck revision",
			);
		}
		for (const diagnostic of options.compileReceipt.diagnostics) {
			addIssue(issues, `COMPILE_${diagnostic.code}`, diagnostic.severity, diagnostic.message);
		}
		if (!options.compileReceipt.succeeded)
			addIssue(issues, "COMPILE_REQUIRED", "critical", "The current deck did not compile successfully");
	} else {
		addIssue(issues, "COMPILE_RECEIPT_MISSING", "major", "No compile receipt was supplied for the current deck");
	}
	let score = 100;
	for (const issue of issues) score -= issue.severity === "critical" ? 20 : issue.severity === "major" ? 7 : 2;
	score = Math.max(0, score);
	const base = {
		projectId: options.project.projectId,
		deckId: options.deck.deckId,
		deckRevision: options.deck.revision,
		sourceHash: options.deck.sourceHash,
		compileReceiptId: options.compileReceipt?.receiptId ?? null,
		score,
		status:
			score >= 90 && !issues.some((item) => item.severity === "critical" || item.severity === "major")
				? ("pass" as const)
				: ("fail" as const),
		issues,
		createdAt,
	};
	return {
		reviewId: deterministicId("beamer-review", base, 40),
		...base,
		contentHash: contentHash({ reviewId: deterministicId("beamer-review", base, 40), ...base }),
	};
}
