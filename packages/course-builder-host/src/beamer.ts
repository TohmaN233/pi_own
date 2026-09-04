import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { contentHash, deterministicId, sha256Hex } from "../../harness-core/src/index.ts";
import type {
	BeamerCompileReceipt,
	BeamerCompiledArtifact,
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
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 64 * 1024 * 1024;
const DANGEROUS_TEX = [
	/\\(?:immediate\s*)?write18\b/iu,
	/\\(?:openin|openout|read|write)\b/iu,
	/\\input\s*\|/iu,
	/\\include\s*\|/iu,
	/\\catcode\b/iu,
	/\\csname\s*(?:input|write18|openin|openout)\s*\\endcsname/iu,
	/\\usepackage\s*\{(?:shellesc|catchfile)\}/iu,
];

function isoTimestamp(value: string, field: string): string {
	if (!Number.isFinite(Date.parse(value))) throw new BeamerWorkflowError("INVALID_TIMESTAMP", `${field} must be ISO-8601`);
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

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	outputLimited: boolean;
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
				new BeamerWorkflowError("BEAMER_COMPILER_START_FAILED", `Unable to start ${options.command}: ${error.message}`),
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
	if (result.timedOut) diagnostics.push({ code: "COMPILE_TIMEOUT", severity: "critical", message: "XeLaTeX exceeded its execution budget" });
	if (result.outputLimited) diagnostics.push({ code: "COMPILE_OUTPUT_LIMIT", severity: "critical", message: "XeLaTeX exceeded its output budget" });
	if (result.exitCode !== 0) diagnostics.push({ code: "COMPILE_EXIT", severity: "critical", message: `XeLaTeX exited with code ${result.exitCode ?? "null"}` });
	if (/Undefined control sequence/iu.test(log)) diagnostics.push({ code: "UNDEFINED_CONTROL_SEQUENCE", severity: "critical", message: "The log contains an undefined control sequence" });
	if (/Citation [`'][^`']+[`'].*undefined|There were undefined citations/iu.test(log)) diagnostics.push({ code: "UNDEFINED_CITATION", severity: "critical", message: "The log contains unresolved citations" });
	if (/Reference [`'][^`']+[`'].*undefined|There were undefined references/iu.test(log)) diagnostics.push({ code: "UNDEFINED_REFERENCE", severity: "major", message: "The log contains unresolved references" });
	for (const match of log.matchAll(/Overfull \\hbox \((\d+(?:\.\d+)?)pt too wide\)/giu)) {
		const amount = Number(match[1] ?? 0);
		diagnostics.push({
			code: "OVERFULL_HBOX",
			severity: amount > 10 ? "critical" : "major",
			message: `Overfull hbox is ${amount}pt too wide`,
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
}

export async function compileBeamerDeck(options: CompileBeamerOptions): Promise<{
	receipt: BeamerCompileReceipt;
	artifact: BeamerCompiledArtifact | null;
	log: string;
}> {
	assertSafeBeamerSource(options.deck.source);
	if (options.deck.projectId !== options.project.projectId) {
		throw new BeamerWorkflowError("PROJECT_MISMATCH", "Deck belongs to another Course Builder project");
	}
	const compiler = options.compiler?.trim() || process.env.PI_XELATEX_PATH?.trim() || "xelatex";
	const passes = clampInteger(options.passes ?? 2, "passes", 1, 3);
	const timeoutMs = clampInteger(options.timeoutMs ?? 30_000, "timeoutMs", 1_000, 120_000);
	const maxOutputBytes = clampInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes", 4_096, 16 * 1024 * 1024);
	const maxPdfBytes = clampInteger(options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES, "maxPdfBytes", 4_096, 256 * 1024 * 1024);
	const createdAt = isoTimestamp(options.createdAt ?? new Date().toISOString(), "createdAt");
	const args = ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "deck.tex"];
	let directory: string | null = null;
	let log = "";
	let finalResult: ProcessResult = { exitCode: null, stdout: "", stderr: "", timedOut: false, outputLimited: false };
	let pdfBytes: Uint8Array | null = null;
	try {
		directory = await mkdtemp(join(tmpdir(), "pi-own-beamer-"));
		await writeFile(join(directory, "deck.tex"), options.deck.source, "utf8");
		for (let pass = 0; pass < passes; pass++) {
			finalResult = await runBoundedProcess({
				command: compiler,
				args,
				cwd: directory,
				timeoutMs,
				maxOutputBytes,
				...(options.env ? { env: options.env } : {}),
			});
			log += `\n=== pass ${pass + 1} ===\n${finalResult.stdout}\n${finalResult.stderr}`;
			if (finalResult.exitCode !== 0 || finalResult.timedOut || finalResult.outputLimited) break;
		}
		try {
			const candidate = await readFile(join(directory, "deck.pdf"));
			if (candidate.byteLength > maxPdfBytes) {
				throw new BeamerWorkflowError("BEAMER_PDF_TOO_LARGE", `Compiled PDF exceeds ${maxPdfBytes} bytes`);
			}
			pdfBytes = new Uint8Array(candidate);
		} catch (error) {
			if (error instanceof BeamerWorkflowError) throw error;
			pdfBytes = null;
		}
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true });
	}
	const diagnostics = compileDiagnostics(log, finalResult);
	const succeeded = finalResult.exitCode === 0 && !finalResult.timedOut && !finalResult.outputLimited && pdfBytes !== null && !diagnostics.some((item) => item.severity === "critical");
	const base = {
		projectId: options.project.projectId,
		deckId: options.deck.deckId,
		deckRevision: options.deck.revision,
		sourceHash: options.deck.sourceHash,
		compiler: basename(resolve(compiler)),
		arguments: args,
		succeeded,
		exitCode: finalResult.exitCode,
		pageCount: pageCountFromLog(log),
		pdfHash: pdfBytes ? `sha256:${sha256Hex(pdfBytes)}` : null,
		logHash: `sha256:${sha256Hex(log)}`,
		diagnostics,
		createdAt,
	};
	const receipt: BeamerCompileReceipt = {
		receiptId: deterministicId("beamer-compile", base, 40),
		...base,
		contentHash: contentHash(base),
	};
	return {
		receipt,
		artifact: pdfBytes ? { receiptId: receipt.receiptId, pdfBytes } : null,
		log,
	};
}

function addIssue(issues: DeckReviewIssue[], code: string, severity: DeckReviewIssue["severity"], message: string, location: string | null = null): void {
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
	const frames = frameSources(source);
	const profile: BeamerProfile = options.project.beamerProfile;
	if (frames.length === 0) addIssue(issues, "NO_FRAMES", "critical", "The Beamer deck has no frames");
	const aspectToken = profile.aspectRatio === "169" ? "aspectratio=169" : "aspectratio=43";
	if (!source.includes(aspectToken)) addIssue(issues, "ASPECT_RATIO_MISMATCH", "major", `Document class does not contain ${aspectToken}`);
	if (profile.overlayPolicy === "deny" && /\\(?:pause|only|onslide|uncover)\b/iu.test(source)) {
		addIssue(issues, "OVERLAY_DENIED", "major", "The project profile forbids Beamer overlays");
	}
	if (/\\tiny\b/u.test(source)) addIssue(issues, "TINY_TEXT", "major", "User-facing content uses \\tiny");
	if (/\[(?:TODO|XXX|name)\]/iu.test(source)) addIssue(issues, "PLACEHOLDER", "major", "The deck contains an unreplaced placeholder");
	if (profile.referencesPolicy === "required" && !/\\begin\{thebibliography\}|\\bibliography\{/u.test(source)) {
		addIssue(issues, "REFERENCES_REQUIRED", "major", "The Beamer profile requires a references section");
	}
	if (profile.backupSlides > 0 && !/\\appendix\b/u.test(source)) {
		addIssue(issues, "BACKUP_SLIDES_REQUIRED", "minor", "The project requests backup slides but the deck has no appendix");
	}
	for (const frame of frames) {
		const itemCount = [...frame.body.matchAll(/\\item\b/gu)].length;
		const displayMath = [...frame.body.matchAll(/\\\[|\\begin\{(?:equation\*?|align\*?|gather\*?)\}/gu)].length;
		const newCommands = [...frame.body.matchAll(/\\newcommand\b/gu)].length;
		const boxes = [...frame.body.matchAll(/\\begin\{(?:alertblock|exampleblock|block)\}/gu)].length;
		const substantive = /\\begin\{(?:tikzpicture|table|tabular|theorem|definition|example|proof|algorithm|lstlisting)\}|\\includegraphics|\\\[|\\begin\{(?:equation|align|gather)/u.test(frame.body);
		if (itemCount > 7) addIssue(issues, "DENSE_LIST", "major", `Frame has ${itemCount} list items`, frame.title);
		if (displayMath > 2) addIssue(issues, "DENSE_EQUATIONS", "major", `Frame has ${displayMath} displayed equations`, frame.title);
		if (newCommands > 5) addIssue(issues, "DENSE_NOTATION", "minor", `Frame introduces ${newCommands} commands`, frame.title);
		if (boxes > 2) addIssue(issues, "BOX_FATIGUE", "minor", `Frame has ${boxes} colored blocks`, frame.title);
		if (itemCount <= 3 && !substantive && frame.body.replace(/\\[A-Za-z]+(?:\[[^\]]*\])?\{[^}]*\}/gu, "").trim().length < 300) {
			addIssue(issues, "SPARSE_FRAME", "minor", "Frame may be too sparse for a lecture deck", frame.title);
		}
	}
	if (options.compileReceipt) {
		if (options.compileReceipt.deckId !== options.deck.deckId || options.compileReceipt.deckRevision !== options.deck.revision || options.compileReceipt.sourceHash !== options.deck.sourceHash) {
			addIssue(issues, "STALE_COMPILE_RECEIPT", "critical", "Compile receipt does not match the current deck revision");
		}
		for (const diagnostic of options.compileReceipt.diagnostics) {
			addIssue(issues, `COMPILE_${diagnostic.code}`, diagnostic.severity, diagnostic.message);
		}
		if (!options.compileReceipt.succeeded) addIssue(issues, "COMPILE_REQUIRED", "critical", "The current deck did not compile successfully");
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
		status: score >= 90 && !issues.some((item) => item.severity === "critical" || item.severity === "major") ? "pass" as const : "fail" as const,
		issues,
		createdAt,
	};
	return {
		reviewId: deterministicId("beamer-review", base, 40),
		...base,
		contentHash: contentHash(base),
	};
}
