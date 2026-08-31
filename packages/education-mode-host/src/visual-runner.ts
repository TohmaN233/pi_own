import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ComputationReceipt, VisualActivitySpec } from "./index.ts";
import { EducationModeError, verifyComputationReceipt, verifyVisualActivitySpec } from "./index.ts";

const WORKER_PATH = fileURLToPath(new URL("./visual-worker.mjs", import.meta.url));
const MAX_STDOUT_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 16_000;
const DEFAULT_TIMEOUT_MS = 2_000;

export interface VisualWorkerResult {
	result: unknown;
	receipt: ComputationReceipt;
}

export interface RunVisualWorkerOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function runVisualWorker(
	spec: VisualActivitySpec,
	options: RunVisualWorkerOptions = {},
): Promise<VisualWorkerResult> {
	verifyVisualActivitySpec(spec);
	if (spec.kind !== "matrix-transform" && spec.kind !== "algorithm-trace") {
		throw new EducationModeError("VISUAL_WORKER_KIND_UNAVAILABLE", spec.kind);
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) {
		throw new EducationModeError("INVALID_VISUAL_TIMEOUT", String(timeoutMs));
	}

	return new Promise<VisualWorkerResult>((resolve, reject) => {
		const child = spawn(process.execPath, [WORKER_PATH], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: {
				NODE_ENV: "production",
				PATH: process.env.PATH ?? "",
			},
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (error?: Error, value?: VisualWorkerResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (!child.killed) child.kill("SIGKILL");
			if (error) reject(error);
			else resolve(value as VisualWorkerResult);
		};

		const abort = (): void => finish(new EducationModeError("VISUAL_WORKER_ABORTED", "aborted"));
		if (options.signal?.aborted) return abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(
			() => finish(new EducationModeError("VISUAL_WORKER_TIMEOUT", `${timeoutMs}ms`)),
			timeoutMs,
		);

		child.on("error", (error) => finish(error));
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
				finish(new EducationModeError("VISUAL_WORKER_STDOUT_BUDGET", String(MAX_STDOUT_BYTES)));
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
				finish(new EducationModeError("VISUAL_WORKER_STDERR_BUDGET", String(MAX_STDERR_BYTES)));
			}
		});
		child.on("close", (code) => {
			if (settled) return;
			if (code !== 0) {
				finish(new EducationModeError("VISUAL_WORKER_FAILED", stderr.trim() || stdout.trim() || `exit ${code}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout.trim()) as {
					ok?: unknown;
					result?: unknown;
					receipt?: ComputationReceipt;
				};
				if (parsed.ok !== true || !parsed.receipt) throw new Error("Malformed visual worker response");
				verifyComputationReceipt(spec, parsed.receipt);
				finish(undefined, { result: parsed.result, receipt: parsed.receipt });
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		child.stdin.end(JSON.stringify(spec));
	});
}
