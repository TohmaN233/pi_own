import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statfsSync, statSync } from "node:fs";
import { arch, availableParallelism, cpus, freemem, platform, release, totalmem } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type CapabilityStatus = "available" | "unavailable" | "unknown";

export interface StudyCapability {
	status: CapabilityStatus;
	detail: string;
}

export interface DetectedExecutable {
	name: "node" | "python" | "rscript";
	capability: StudyCapability;
	executablePath: string | null;
	version: string | null;
	diagnostics: string[];
	pythonEnvironment?: {
		prefix: string;
		basePrefix: string;
		kind: "venv" | "conda" | "base";
		intendedProjectEnvironment: string | null;
		isProjectEnvironment: boolean;
	};
	rLibraryPaths?: string[];
}

export interface CpuObservation {
	logicalCores: number;
	availableParallelism: number;
	loadPercent: number | null;
	loadCapability: StudyCapability;
}

export interface MemoryObservation {
	totalBytes: number;
	availableBytes: number;
}

export interface GpuObservation {
	capability: StudyCapability;
	adapters: Array<{
		name: string;
		adapterMemoryBytes: number | null;
		memorySource: "nvidia-smi" | "unavailable";
		memoryDiagnostic: string;
	}>;
}

export interface DiskObservation {
	capability: StudyCapability;
	path: string;
	totalBytes: number | null;
	availableBytes: number | null;
}

export interface StudyPlatformReport {
	version: 1;
	detectedAt: string;
	operatingSystem: {
		platform: NodeJS.Platform;
		release: string;
		architecture: string;
	};
	executables: {
		node: DetectedExecutable;
		python: DetectedExecutable;
		rscript: DetectedExecutable;
	};
	resources: {
		cpu: CpuObservation;
		memory: MemoryObservation;
		gpu: GpuObservation;
		disk: DiskObservation;
	};
}

export interface StudyResourceSuggestion {
	version: 1;
	mode: "p0-conservative-serial";
	initialConcurrentRuns: 1;
	taskCpuLimit: null;
	taskMemoryLimitBytes: null;
	taskWallTimeLimitMs: null;
	gpuScheduling: "disabled-until-hard-limit-is-verified";
	diskReservation: "observation-only";
	requiresAdmissionBeforeIncrease: true;
	rationale: string[];
}

interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error: string | null;
	timedOut: boolean;
}

const COMMAND_TIMEOUT_MS = 5_000;

export interface StudyPlatformOptions {
	pythonExecutable?: string;
	projectPythonEnvironment?: string;
}

export function detectStudyPlatform(
	workspaceDirectory = process.cwd(),
	options: StudyPlatformOptions = {},
): StudyPlatformReport {
	const resolvedWorkspaceDirectory = resolve(workspaceDirectory);
	return {
		version: 1,
		detectedAt: new Date().toISOString(),
		operatingSystem: {
			platform: platform(),
			release: release(),
			architecture: arch(),
		},
		executables: {
			node: detectNode(),
			python: detectPython(options),
			rscript: detectRscript(),
		},
		resources: {
			cpu: detectCpu(),
			memory: {
				totalBytes: totalmem(),
				availableBytes: freemem(),
			},
			gpu: detectGpu(),
			disk: detectDisk(resolvedWorkspaceDirectory),
		},
	};
}

export function suggestStudyResources(report: StudyPlatformReport): StudyResourceSuggestion {
	const rationale = [
		"P0 uses one initial concurrent run so the future scheduler can reserve and observe host resources before raising concurrency.",
		"No task CPU, memory, or wall-time number is suggested because this report has no verified hard per-process limiter.",
		"GPU work remains disabled until a GPU limiter is separately verified; detecting an adapter or VRAM is not a limiter.",
		`Observed memory is ${report.resources.memory.availableBytes} bytes available of ${report.resources.memory.totalBytes} bytes total and is telemetry, not an execution reservation.`,
	];
	if (report.resources.disk.capability.status !== "available") {
		rationale.push(`Disk observation is unavailable: ${report.resources.disk.capability.detail}`);
	}
	return {
		version: 1,
		mode: "p0-conservative-serial",
		initialConcurrentRuns: 1,
		taskCpuLimit: null,
		taskMemoryLimitBytes: null,
		taskWallTimeLimitMs: null,
		gpuScheduling: "disabled-until-hard-limit-is-verified",
		diskReservation: "observation-only",
		requiresAdmissionBeforeIncrease: true,
		rationale,
	};
}

function detectNode(): DetectedExecutable {
	return {
		name: "node",
		capability: { status: "available", detail: "Current Node runtime is available." },
		executablePath: process.execPath,
		version: process.version,
		diagnostics: [],
	};
}

function detectPython(options: StudyPlatformOptions): DetectedExecutable {
	const executablePath = options.pythonExecutable
		? resolve(options.pythonExecutable)
		: findExecutable(["python.exe", "python3.exe"]);
	if (!executablePath) return unavailableExecutable("python", "python.exe/python3.exe was not found on PATH.");
	const version = runReadOnlyCommand(executablePath, ["--version"]);
	if (version.exitCode !== 0) {
		return unavailableExecutable("python", commandFailure("Python version check failed", version), executablePath);
	}
	const environment = runReadOnlyCommand(executablePath, [
		"-I",
		"-c",
		"import sys; print(sys.prefix); print(sys.base_prefix)",
	]);
	const prefixes = lines(environment.stdout);
	const diagnostics = diagnosticsFor(environment, "Python environment inspection");
	let pythonEnvironment: DetectedExecutable["pythonEnvironment"];
	if (environment.exitCode === 0 && prefixes.length === 2) {
		try {
			const canonical = (path: string) => {
				const value = realpathSync(path);
				return process.platform === "win32" ? value.toLowerCase() : value;
			};
			pythonEnvironment = classifyStudyPythonEnvironment({
				prefix: canonical(prefixes[0]),
				basePrefix: canonical(prefixes[1]),
				executablePath: canonical(executablePath),
				intendedProjectEnvironment: options.projectPythonEnvironment
					? canonical(options.projectPythonEnvironment)
					: null,
				condaMetadataPresent: existsSync(resolve(prefixes[0], "conda-meta")),
			});
		} catch (error) {
			diagnostics.push(`Python environment identity could not be verified: ${errorMessage(error)}`);
		}
	}
	return {
		name: "python",
		capability: {
			status: pythonEnvironment ? "available" : "unknown",
			detail: pythonEnvironment
				? "Python interpreter and its active environment were detected."
				: "Python interpreter was detected, but its active environment could not be inspected.",
		},
		executablePath,
		version: commandOutput(version),
		diagnostics,
		pythonEnvironment,
	};
}

/** Canonical detection inputs: environment type never implies project ownership. */
export function classifyStudyPythonEnvironment(input: {
	prefix: string;
	basePrefix: string;
	executablePath: string;
	intendedProjectEnvironment: string | null;
	condaMetadataPresent: boolean;
}): NonNullable<DetectedExecutable["pythonEnvironment"]> {
	const executableRelative = relative(input.prefix, input.executablePath);
	const interpreterInside =
		executableRelative !== ".." && !executableRelative.startsWith(`..${sep}`) && !isAbsolute(executableRelative);
	return {
		prefix: input.prefix,
		basePrefix: input.basePrefix,
		kind: input.condaMetadataPresent ? "conda" : input.prefix !== input.basePrefix ? "venv" : "base",
		intendedProjectEnvironment: input.intendedProjectEnvironment,
		isProjectEnvironment:
			input.intendedProjectEnvironment !== null &&
			input.prefix === input.intendedProjectEnvironment &&
			interpreterInside,
	};
}

function detectRscript(): DetectedExecutable {
	const executablePath = findRscriptExecutable();
	if (!executablePath) {
		return unavailableExecutable(
			"rscript",
			"Rscript.exe was not found on PATH or in the bounded standard/per-user R locations.",
		);
	}
	const version = runReadOnlyCommand(executablePath, ["--version"]);
	if (version.exitCode !== 0) {
		return unavailableExecutable("rscript", commandFailure("Rscript version check failed", version), executablePath);
	}
	const libraries = runReadOnlyCommand(executablePath, ["--vanilla", "-e", "cat(paste(.libPaths(), collapse='\\n'))"]);
	const libraryPaths = lines(libraries.stdout);
	const diagnostics = diagnosticsFor(libraries, "R library-path inspection");
	return {
		name: "rscript",
		capability: {
			status: libraries.exitCode === 0 ? "available" : "unknown",
			detail:
				libraries.exitCode === 0
					? "Rscript and the current global library paths were detected read-only."
					: "Rscript was detected, but current global library paths could not be inspected.",
		},
		executablePath,
		version: commandOutput(version),
		diagnostics,
		rLibraryPaths: libraries.exitCode === 0 ? libraryPaths : undefined,
	};
}

function detectCpu(): CpuObservation {
	const logicalCores = cpus().length;
	if (process.platform !== "win32") {
		return {
			logicalCores,
			availableParallelism: availableParallelism(),
			loadPercent: null,
			loadCapability: {
				status: "unavailable",
				detail: "P0 CPU-load discovery currently uses the Windows CIM provider.",
			},
		};
	}
	const command = runReadOnlyCommand("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$values = @(Get-CimInstance Win32_Processor | ForEach-Object { $_.LoadPercentage }); if ($values.Count -eq 0) { exit 2 }; [Console]::WriteLine(($values | Measure-Object -Average).Average)",
	]);
	const load = Number(commandOutput(command));
	return {
		logicalCores,
		availableParallelism: availableParallelism(),
		loadPercent: command.exitCode === 0 && Number.isFinite(load) ? load : null,
		loadCapability:
			command.exitCode === 0 && Number.isFinite(load)
				? { status: "available", detail: "CPU load was observed through Win32_Processor.LoadPercentage." }
				: { status: "unknown", detail: commandFailure("CPU-load discovery failed", command) },
	};
}

function detectGpu(): GpuObservation {
	if (process.platform !== "win32") {
		return {
			capability: { status: "unavailable", detail: "P0 GPU discovery currently uses the Windows CIM provider." },
			adapters: [],
		};
	}
	const command = runReadOnlyCommand("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		'$controllers = @(Get-CimInstance Win32_VideoController); foreach ($controller in $controllers) { $name = $controller.Name -replace "[\\r\\n\\t]", " "; [Console]::WriteLine("$name`t$($controller.AdapterRAM)") }',
	]);
	if (command.exitCode !== 0) {
		return {
			capability: { status: "unknown", detail: commandFailure("GPU discovery failed", command) },
			adapters: [],
		};
	}
	const smiPath = findExecutable(["nvidia-smi.exe"]);
	const smi = smiPath
		? runReadOnlyCommand(smiPath, ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
		: null;
	const memoryByName = new Map<string, number>();
	if (smi?.exitCode === 0)
		for (const row of lines(smi.stdout)) {
			const delimiter = row.lastIndexOf(",");
			const mib = Number(row.slice(delimiter + 1).trim());
			if (delimiter > 0 && Number.isFinite(mib) && mib > 0 && Number.isSafeInteger(mib * 1024 * 1024)) {
				memoryByName.set(row.slice(0, delimiter).trim(), mib * 1024 * 1024);
			}
		}
	const adapters = lines(command.stdout).flatMap((line) => {
		const separator = line.lastIndexOf("\t");
		if (separator < 1) return [];
		const name = line.slice(0, separator).trim();
		const memory = memoryByName.get(name);
		return [
			{
				name,
				adapterMemoryBytes: memory ?? null,
				memorySource: memory !== undefined ? ("nvidia-smi" as const) : ("unavailable" as const),
				memoryDiagnostic:
					memory !== undefined
						? "Driver-reported total memory from nvidia-smi (MiB converted to bytes), not a scheduling reservation."
						: "Dedicated VRAM is unknown. WMI AdapterRAM is not reliable VRAM evidence; integrated adapters may use shared memory.",
			},
		];
	});
	return {
		capability:
			adapters.length > 0
				? { status: "available", detail: "GPU adapters were observed through Win32_VideoController." }
				: { status: "unknown", detail: "Win32_VideoController returned no adapters." },
		adapters,
	};
}

function detectDisk(workspaceDirectory: string): DiskObservation {
	try {
		const filesystem = statfsSync(workspaceDirectory);
		const totalBytes = filesystem.blocks * filesystem.bsize;
		const availableBytes = filesystem.bavail * filesystem.bsize;
		if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) {
			return {
				capability: { status: "unknown", detail: "Disk byte counters exceed JavaScript safe-integer precision." },
				path: workspaceDirectory,
				totalBytes: null,
				availableBytes: null,
			};
		}
		return {
			capability: { status: "available", detail: "Disk capacity was observed using the workspace filesystem." },
			path: workspaceDirectory,
			totalBytes,
			availableBytes,
		};
	} catch (error) {
		return {
			capability: { status: "unknown", detail: `Disk discovery failed: ${errorMessage(error)}` },
			path: workspaceDirectory,
			totalBytes: null,
			availableBytes: null,
		};
	}
}

function findExecutable(candidates: string[]): string | null {
	if (process.platform !== "win32") return null;
	for (const candidate of candidates) {
		const result = runReadOnlyCommand("where.exe", [candidate]);
		if (result.exitCode !== 0) continue;
		const executablePath = lines(result.stdout)[0];
		if (executablePath) return executablePath;
	}
	return null;
}

function findRscriptExecutable(): string | null {
	const onPath = findExecutable(["Rscript.exe"]);
	if (onPath) return onPath;
	if (process.platform !== "win32") return null;
	for (const directory of standardRscriptDirectories()) {
		for (const relativePath of ["Rscript.exe", "x64\\Rscript.exe"]) {
			const candidate = resolve(directory, relativePath);
			if (isFile(candidate)) return candidate;
		}
	}
	return null;
}

function standardRscriptDirectories(): string[] {
	const directories = ["C:\\Program Files\\R", "C:\\Program Files (x86)\\R"];
	for (const root of directories) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.isDirectory()) directories.push(resolve(root, entry.name, "bin"));
		}
	}
	const userProfile = process.env.USERPROFILE;
	if (!userProfile) return directories;
	return [
		...directories,
		resolve(userProfile, "AppData", "Local", "Programs", "R", "bin"),
		resolve(userProfile, "scoop", "apps", "r", "current", "bin"),
		resolve(userProfile, "Miniconda3", "Scripts"),
		resolve(userProfile, "miniconda3", "Scripts"),
		resolve(userProfile, "anaconda3", "Scripts"),
	];
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function unavailableExecutable(
	name: DetectedExecutable["name"],
	detail: string,
	executablePath: string | null = null,
): DetectedExecutable {
	return {
		name,
		capability: { status: "unavailable", detail },
		executablePath,
		version: null,
		diagnostics: [detail],
	};
}

function runReadOnlyCommand(command: string, args: string[]): CommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: "pipe",
		windowsHide: true,
		timeout: COMMAND_TIMEOUT_MS,
	});
	return {
		exitCode: result.status,
		stdout: String(result.stdout ?? "").trim(),
		stderr: String(result.stderr ?? "").trim(),
		error: result.error ? result.error.message : null,
		timedOut: errorHasCode(result.error, "ETIMEDOUT"),
	};
}

function diagnosticsFor(result: CommandResult, operation: string): string[] {
	if (result.exitCode !== 0) return [commandFailure(`${operation} failed`, result)];
	return result.stderr ? [`${operation} emitted stderr: ${result.stderr}`] : [];
}

function commandFailure(prefix: string, result: CommandResult): string {
	const detail = result.error ?? (result.stderr || result.stdout || `exit code ${result.exitCode}`);
	return `${prefix}: ${detail}${result.timedOut ? " (timed out)" : ""}`;
}

function commandOutput(result: CommandResult): string {
	return result.stdout || result.stderr;
}

function lines(value: string): string[] {
	return value
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorHasCode(error: Error | undefined, code: string): boolean {
	return error !== undefined && "code" in error && error.code === code;
}
