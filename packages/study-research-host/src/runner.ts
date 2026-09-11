import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeRun, parseExperiment, StudyError } from "./contracts.ts";

export const STUDY_OUTPUT_LIMIT = 256 * 1024;
/** Trusted local code only, NOT an OS sandbox. Only the human API invokes this. */
export async function runStudyCode(
	value: unknown,
	options: { trusted: boolean; signal?: AbortSignal; python?: string; node?: string },
): Promise<Pick<CodeRun, "status" | "exitCode" | "stdout" | "stderr" | "durationMs">> {
	if (!options.trusted)
		throw new StudyError(
			"CODE_DISABLED",
			"Local code execution is disabled. Review code and set PI_STUDY_TRUSTED_CODE=1 before starting the app.",
		);
	if (options.signal?.aborted) throw new StudyError("ABORTED", "Execution cancelled");
	const plan = parseExperiment(value);
	const cwd = await mkdtemp(join(tmpdir(), "pi-study-run-"));
	const filename = join(cwd, plan.language === "python" ? "lesson.py" : "lesson.mjs");
	const started = Date.now();
	try {
		await writeFile(filename, plan.code, { flag: "wx", mode: 0o600 });
		return await new Promise((resolve, reject) => {
			const command = plan.language === "python" ? options.python || "python3" : options.node || process.execPath;
			const args = plan.language === "python" ? ["-I", "-u", filename] : [filename];
			const env: NodeJS.ProcessEnv = {
				NODE_ENV: "production",
				PATH: process.env.PATH,
				SYSTEMROOT: process.env.SYSTEMROOT,
				WINDIR: process.env.WINDIR,
				TEMP: cwd,
				TMP: cwd,
				TMPDIR: cwd,
				HOME: cwd,
				USERPROFILE: cwd,
				PYTHONIOENCODING: "utf-8",
			};
			// No shell parsing, lifecycle installs, inherited provider keys, or research scheduler.
			const child = spawn(command, args, {
				cwd,
				env,
				shell: false,
				windowsHide: true,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
			let status: CodeRun["status"] | null = null;
			let total = 0;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let complete = false;
			const stop = (why: CodeRun["status"]) => {
				status ??= why;
				try {
					if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
					else if (child.pid) {
						const systemRoot = process.env.SYSTEMROOT || process.env.WINDIR || "C:\\Windows";
						const killer = spawn(
							join(systemRoot, "System32", "taskkill.exe"),
							["/PID", String(child.pid), "/T", "/F"],
							{ windowsHide: true, stdio: "ignore" },
						);
						killer.on("error", () => {
							child.kill("SIGKILL");
						});
					} else child.kill("SIGKILL");
				} catch {
					/* Process can already have exited. */
				}
			};
			const abort = () => stop("aborted");
			options.signal?.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(() => stop("timed-out"), plan.timeoutSeconds * 1000);
			if (options.signal?.aborted) abort();
			const cleanup = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
			};
			const append = (target: Buffer[], bytes: Buffer) => {
				const remaining = Math.max(0, STUDY_OUTPUT_LIMIT - total);
				if (remaining) target.push(bytes.subarray(0, remaining));
				total += bytes.length;
				if (total > STUDY_OUTPUT_LIMIT) stop("output-limit");
			};
			child.stdout.on("data", (bytes: Buffer) => append(stdout, bytes));
			child.stderr.on("data", (bytes: Buffer) => append(stderr, bytes));
			child.on("error", (error) => {
				if (!complete) {
					complete = true;
					cleanup();
					reject(error);
				}
			});
			child.on("close", (exitCode) => {
				if (complete) return;
				complete = true;
				cleanup();
				resolve({
					status: status ?? (exitCode === 0 ? "succeeded" : "failed"),
					exitCode,
					stdout: Buffer.concat(stdout).toString("utf8").replace(/\0/gu, "�"),
					stderr: Buffer.concat(stderr).toString("utf8").replace(/\0/gu, "�"),
					durationMs: Date.now() - started,
				});
			});
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}
