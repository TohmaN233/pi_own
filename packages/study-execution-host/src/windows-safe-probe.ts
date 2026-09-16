import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CapabilityStatus, StudyCapability } from "./platform.ts";

const PROBE_TIMEOUT_MS = 5_000;
const HEARTBEAT_OBSERVATION_MS = 200;

export interface WindowsExecutionProbeOptions {
	artifactDirectory: string;
}

export interface WindowsExecutionProbeReport {
	version: 1;
	startedAt: string;
	finishedAt: string;
	artifactDirectory: string | null;
	backgroundProcessSurvival: StudyCapability;
	processTreeCancellation: StudyCapability;
	controllerWallTimeCancellation: StudyCapability;
	hardCpuLimit: StudyCapability;
	hardMemoryLimit: StudyCapability;
	hardWallTimeLimit: StudyCapability;
	fileSystemIsolation: StudyCapability;
	processes: {
		launcherExited: boolean;
		workerPid: number | null;
		grandchildPid: number | null;
		heartbeatAdvancedAfterLauncherExit: boolean;
		survivingPidsAfterCancellation: number[];
	};
	diagnostics: string[];
}

interface ProbeReady {
	version: 1;
	token: string;
	workerPid: number;
	grandchildPid: number;
}

interface LaunchResult {
	workerPid: number;
	launcherExited: boolean;
}

export class StudyExecutionProbeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StudyExecutionProbeError";
		this.code = code;
	}
}

export async function probeWindowsExecutionCapabilities(
	options: WindowsExecutionProbeOptions,
): Promise<WindowsExecutionProbeReport> {
	if (!options.artifactDirectory.trim()) {
		throw new StudyExecutionProbeError("PROBE_ARTIFACT_DIRECTORY_REQUIRED", "artifactDirectory is required");
	}
	if (process.platform !== "win32") return unavailableWindowsProbe();

	const startedAt = new Date().toISOString();
	const token = randomUUID();
	const artifactDirectory = resolve(options.artifactDirectory, `safe-windows-probe-${token}`);
	const diagnostics: string[] = [];
	let workerPid: number | null = null;
	let grandchildPid: number | null = null;
	let launcherExited = false;
	let heartbeatAdvancedAfterLauncherExit = false;
	let survivingPidsAfterCancellation: number[] = [];
	let backgroundProcessSurvival: StudyCapability = unprobed("Background process survival was not reached.");
	let processTreeCancellation: StudyCapability = unprobed("Process-tree cancellation was not reached.");
	let controllerWallTimeCancellation: StudyCapability = unprobed("Controller wall-time cancellation was not reached.");

	await mkdir(artifactDirectory, { recursive: true });
	try {
		const launcher = await launchProbeWorker(artifactDirectory, token);
		workerPid = launcher.workerPid;
		launcherExited = launcher.launcherExited;
		const ready = await waitForProbeReady(resolve(artifactDirectory, "ready.json"), token);
		if (ready.workerPid !== workerPid) {
			throw new StudyExecutionProbeError(
				"PROBE_WORKER_PID_MISMATCH",
				`Launcher reported ${workerPid}, while worker reported ${ready.workerPid}.`,
			);
		}
		grandchildPid = ready.grandchildPid;
		const heartbeatPath = resolve(artifactDirectory, "heartbeat.txt");
		const firstHeartbeat = await stat(heartbeatPath);
		await pause(HEARTBEAT_OBSERVATION_MS);
		const secondHeartbeat = await stat(heartbeatPath);
		heartbeatAdvancedAfterLauncherExit = secondHeartbeat.mtimeMs > firstHeartbeat.mtimeMs;
		const workerAlive = isProcessAlive(workerPid);
		const grandchildAlive = isProcessAlive(grandchildPid);
		backgroundProcessSurvival = capability(
			launcherExited && workerAlive && grandchildAlive && heartbeatAdvancedAfterLauncherExit
				? "available"
				: "unavailable",
			launcherExited && workerAlive && grandchildAlive && heartbeatAdvancedAfterLauncherExit
				? "A hidden detached worker and its child continued after the launcher exited; its heartbeat advanced."
				: "The detached probe did not demonstrate survival after the launcher exited.",
		);

		const cancellation = cancelProcessTree(workerPid);
		survivingPidsAfterCancellation = await waitForExit([workerPid, grandchildPid]);
		processTreeCancellation = capability(
			cancellation.exitCode === 0 && survivingPidsAfterCancellation.length === 0 ? "available" : "unavailable",
			cancellation.exitCode === 0 && survivingPidsAfterCancellation.length === 0
				? "taskkill /pid <worker> /t /f terminated the worker and its observed child."
				: `taskkill did not prove complete tree cancellation: ${cancellation.detail}`,
		);
		controllerWallTimeCancellation = capability(
			processTreeCancellation.status === "available" ? "available" : "unavailable",
			processTreeCancellation.status === "available"
				? `A ${HEARTBEAT_OBSERVATION_MS} ms controller observation ended by explicit process-tree cancellation.`
				: "The controller could not demonstrate timed process-tree cancellation.",
		);
	} catch (error) {
		diagnostics.push(errorMessage(error));
		backgroundProcessSurvival = capability("unavailable", `Probe failed: ${errorMessage(error)}`);
		processTreeCancellation = capability(
			"unavailable",
			"Probe failure prevented a complete cancellation demonstration.",
		);
		controllerWallTimeCancellation = capability(
			"unavailable",
			"Probe failure prevented a controller-time cancellation demonstration.",
		);
	} finally {
		if (workerPid !== null && isProcessAlive(workerPid)) {
			const cleanup = cancelProcessTree(workerPid);
			if (cleanup.exitCode !== 0) diagnostics.push(`Probe cleanup failed: ${cleanup.detail}`);
		}
		if (workerPid !== null || grandchildPid !== null) {
			survivingPidsAfterCancellation = await waitForExit(
				[workerPid, grandchildPid].filter((pid): pid is number => pid !== null),
			);
		}
	}

	const report: WindowsExecutionProbeReport = {
		version: 1,
		startedAt,
		finishedAt: new Date().toISOString(),
		artifactDirectory,
		backgroundProcessSurvival,
		processTreeCancellation,
		controllerWallTimeCancellation,
		hardCpuLimit: capability(
			"unavailable",
			"P0 has not configured or enforced a CPU-rate policy for an assigned Windows Job Object.",
		),
		hardMemoryLimit: capability(
			"unavailable",
			"This probe does not configure or validate a hard memory limit on an assigned worker.",
		),
		hardWallTimeLimit: capability(
			"unavailable",
			"Controller cancellation is not a hard wall-time limit and does not survive controller failure.",
		),
		fileSystemIsolation: capability(
			"unavailable",
			"A dedicated artifact directory is output organization, not Windows filesystem isolation.",
		),
		processes: {
			launcherExited,
			workerPid,
			grandchildPid,
			heartbeatAdvancedAfterLauncherExit,
			survivingPidsAfterCancellation,
		},
		diagnostics,
	};
	await writeFile(resolve(artifactDirectory, "execution-probe.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	return report;
}

function unavailableWindowsProbe(): WindowsExecutionProbeReport {
	const unavailable = capability("unavailable", "This probe requires Windows.");
	return {
		version: 1,
		startedAt: new Date().toISOString(),
		finishedAt: new Date().toISOString(),
		artifactDirectory: null,
		backgroundProcessSurvival: unavailable,
		processTreeCancellation: unavailable,
		controllerWallTimeCancellation: unavailable,
		hardCpuLimit: unavailable,
		hardMemoryLimit: unavailable,
		hardWallTimeLimit: unavailable,
		fileSystemIsolation: unavailable,
		processes: {
			launcherExited: false,
			workerPid: null,
			grandchildPid: null,
			heartbeatAdvancedAfterLauncherExit: false,
			survivingPidsAfterCancellation: [],
		},
		diagnostics: ["Windows-only probe was not launched."],
	};
}

async function launchProbeWorker(artifactDirectory: string, token: string): Promise<LaunchResult> {
	const workerPath = fileURLToPath(new URL("./probe-worker.mjs", import.meta.url));
	const child = spawn(
		process.execPath,
		["--max-old-space-size=32", workerPath, "launcher", artifactDirectory, token],
		{
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exit = await waitForChildExit(child, PROBE_TIMEOUT_MS);
	if (exit.code !== 0) {
		throw new StudyExecutionProbeError(
			"PROBE_LAUNCH_FAILED",
			`Probe launcher exited with code ${exit.code}: ${stderr || stdout || "no output"}`,
		);
	}
	const value = parseJson(stdout, "PROBE_LAUNCH_OUTPUT_INVALID");
	if (!isRecord(value) || value.token !== token || !isPositiveInteger(value.workerPid)) {
		throw new StudyExecutionProbeError(
			"PROBE_LAUNCH_OUTPUT_INVALID",
			"Probe launcher returned an invalid worker PID.",
		);
	}
	return { workerPid: value.workerPid, launcherExited: true };
}

async function waitForProbeReady(readyPath: string, token: string): Promise<ProbeReady> {
	const deadline = Date.now() + PROBE_TIMEOUT_MS;
	let lastFailure = "ready file was not created";
	while (Date.now() < deadline) {
		try {
			const value = parseJson(await readFile(readyPath, "utf8"), "PROBE_READY_INVALID");
			if (
				isRecord(value) &&
				value.version === 1 &&
				value.token === token &&
				isPositiveInteger(value.workerPid) &&
				isPositiveInteger(value.grandchildPid)
			) {
				return {
					version: 1,
					token,
					workerPid: value.workerPid,
					grandchildPid: value.grandchildPid,
				};
			}
			lastFailure = "ready file had an unexpected shape";
		} catch (error) {
			lastFailure = errorMessage(error);
		}
		await pause(25);
	}
	throw new StudyExecutionProbeError("PROBE_READY_TIMEOUT", `Probe readiness timed out: ${lastFailure}`);
}

function cancelProcessTree(pid: number): { exitCode: number | null; detail: string } {
	const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
		stdio: "pipe",
		windowsHide: true,
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
	});
	return {
		exitCode: result.status,
		detail: result.error?.message ?? String(result.stderr || result.stdout || "taskkill returned no output").trim(),
	};
}

async function waitForExit(pids: number[]): Promise<number[]> {
	const deadline = Date.now() + PROBE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const survivors = pids.filter((pid) => isProcessAlive(pid));
		if (survivors.length === 0) return [];
		await pause(25);
	}
	return pids.filter((pid) => isProcessAlive(pid));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (hasCode(error, "ESRCH")) return false;
		throw error;
	}
}

function waitForChildExit(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			child.kill();
			reject(new StudyExecutionProbeError("PROBE_LAUNCH_TIMEOUT", `Probe launcher exceeded ${timeoutMs} ms.`));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal });
		});
	});
}

function capability(status: CapabilityStatus, detail: string): StudyCapability {
	return { status, detail };
}

function unprobed(detail: string): StudyCapability {
	return capability("unknown", detail);
}

function parseJson(value: string, code: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new StudyExecutionProbeError(code, `Invalid JSON: ${errorMessage(error)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pause(milliseconds: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
