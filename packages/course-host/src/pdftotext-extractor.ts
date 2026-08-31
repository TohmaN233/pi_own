import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourseHostError, type PdfTextExtractor } from "./course-host.ts";

export const DEFAULT_PDF_EXTRACTION_LIMITS = {
	maxInputBytes: 64 * 1024 * 1024,
	maxOutputBytes: 32 * 1024 * 1024,
	timeoutMs: 15_000,
	maxSubprocessOutputBytes: 64 * 1024,
} as const;

export interface PdftotextExtractorOptions {
	command?: string;
	commandArguments?: readonly string[];
	maxInputBytes?: number;
	maxOutputBytes?: number;
	timeoutMs?: number;
	maxSubprocessOutputBytes?: number;
	env?: NodeJS.ProcessEnv;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new CourseHostError("PDF_EXTRACTOR_CONFIG", `${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

/** A bounded subprocess adapter. CourseHost still owns normalization and span generation. */
export class PdftotextExtractor implements PdfTextExtractor {
	private readonly command: string;
	private readonly commandArguments: readonly string[];
	private readonly maxInputBytes: number;
	private readonly maxOutputBytes: number;
	private readonly timeoutMs: number;
	private readonly maxSubprocessOutputBytes: number;
	private readonly env: NodeJS.ProcessEnv | undefined;

	constructor(commandOrOptions: string | PdftotextExtractorOptions = "pdftotext") {
		const options = typeof commandOrOptions === "string" ? { command: commandOrOptions } : commandOrOptions;
		if (!options.command?.trim()) throw new CourseHostError("PDF_EXTRACTOR_CONFIG", "pdftotext command is required");
		this.command = options.command;
		this.commandArguments = [...(options.commandArguments ?? [])];
		this.maxInputBytes = boundedInteger(
			options.maxInputBytes ?? DEFAULT_PDF_EXTRACTION_LIMITS.maxInputBytes,
			"maxInputBytes",
			1,
			512 * 1024 * 1024,
		);
		this.maxOutputBytes = boundedInteger(
			options.maxOutputBytes ?? DEFAULT_PDF_EXTRACTION_LIMITS.maxOutputBytes,
			"maxOutputBytes",
			1,
			256 * 1024 * 1024,
		);
		this.timeoutMs = boundedInteger(
			options.timeoutMs ?? DEFAULT_PDF_EXTRACTION_LIMITS.timeoutMs,
			"timeoutMs",
			100,
			120_000,
		);
		this.maxSubprocessOutputBytes = boundedInteger(
			options.maxSubprocessOutputBytes ?? DEFAULT_PDF_EXTRACTION_LIMITS.maxSubprocessOutputBytes,
			"maxSubprocessOutputBytes",
			1_024,
			1_024 * 1_024,
		);
		this.env = options.env;
	}

	async extract(bytes: Uint8Array, name: string): Promise<string> {
		if (bytes.byteLength > this.maxInputBytes) {
			throw new CourseHostError("PDF_INPUT_TOO_LARGE", `PDF ${name} exceeds ${this.maxInputBytes} input bytes`);
		}
		let directory: string | null = null;
		let failure: CourseHostError | null = null;
		let extracted: string | null = null;
		try {
			directory = await mkdtemp(join(tmpdir(), "pi-learning-pdf-"));
			const inputPath = join(directory, "input.pdf");
			await writeFile(inputPath, bytes);
			extracted = await this.extractToStdout(inputPath, name);
		} catch (error) {
			failure =
				error instanceof CourseHostError
					? error
					: new CourseHostError(
							"PDF_EXTRACTION_OPERATION_FAILED",
							`PDF extraction infrastructure failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
						);
		}
		if (directory) {
			try {
				await rm(directory, { recursive: true, force: true });
			} catch (cleanupError) {
				const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
				if (failure) {
					throw new CourseHostError(
						"PDF_EXTRACTION_OPERATION_FAILED",
						`PDF extraction failed (${failure.message}) and temporary-file cleanup also failed: ${detail}`,
					);
				}
				throw new CourseHostError(
					"PDF_EXTRACTION_OPERATION_FAILED",
					`PDF temporary-file cleanup failed: ${detail}`,
				);
			}
		}
		if (failure) throw failure;
		if (extracted === null)
			throw new CourseHostError("PDF_EXTRACTION_OPERATION_FAILED", `PDF extraction produced no result for ${name}`);
		return extracted;
	}

	private extractToStdout(inputPath: string, name: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const process = spawn(this.command, [...this.commandArguments, "-layout", "-enc", "UTF-8", inputPath, "-"], {
				env: this.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			const chunks: Buffer[] = [];
			let outputBytes = 0;
			let stderrBytes = 0;
			let settled = false;
			const settle = (error: CourseHostError | null, output?: string): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (error) {
					process.kill();
					reject(error);
					return;
				}
				resolve(output ?? "");
			};
			const timeout = setTimeout(() => {
				settle(
					new CourseHostError(
						"PDF_EXTRACTION_TIMEOUT",
						`PDF ${name} exceeded ${this.timeoutMs}ms extraction time`,
					),
				);
			}, this.timeoutMs);
			process.once("error", (error) => {
				settle(
					new CourseHostError("PDF_EXTRACTION_OPERATION_FAILED", `pdftotext failed for ${name}: ${error.message}`),
				);
			});
			process.stdout.on("data", (chunk: Buffer) => {
				outputBytes += chunk.byteLength;
				if (outputBytes > this.maxOutputBytes) {
					settle(
						new CourseHostError(
							"PDF_OUTPUT_TOO_LARGE",
							`PDF ${name} produced more than ${this.maxOutputBytes} output bytes`,
						),
					);
					return;
				}
				chunks.push(chunk);
			});
			process.stderr.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.byteLength;
				if (stderrBytes > this.maxSubprocessOutputBytes) {
					settle(
						new CourseHostError(
							"PDF_SUBPROCESS_OUTPUT_TOO_LARGE",
							`pdftotext exceeded ${this.maxSubprocessOutputBytes} stderr bytes for ${name}`,
						),
					);
				}
			});
			process.once("close", (code, signal) => {
				if (code !== 0) {
					settle(
						new CourseHostError(
							"PDF_EXTRACTION_OPERATION_FAILED",
							`pdftotext failed for ${name} with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
						),
					);
					return;
				}
				settle(null, Buffer.concat(chunks).toString("utf8"));
			});
		});
	}
}
