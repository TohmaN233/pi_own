import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PYTHON_PROJECT_VENV_ADAPTER,
	R_GLOBAL_LIBRARY_ADAPTER,
	type StudyExecutionEnvironment,
	verifyStudyExecutionEnvironment,
} from "./environments.ts";
import { MAX_EXECUTION_INPUT_BYTES } from "./execution-payloads.ts";

const CSC_PATH = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const RTOOLS_GCC_PATH = "C:\\rtools45\\x86_64-w64-mingw32.static.posix\\bin\\gcc.exe";
const RTOOLS_BIN_DIRECTORY = "C:\\rtools45\\x86_64-w64-mingw32.static.posix\\bin";
const MAX_RUNTIME_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_INPUT_SNAPSHOT_BYTES = MAX_EXECUTION_INPUT_BYTES;
const MAX_CONTROL_WAIT_MS = 10_000;
// Cancellation is durable before the native helper starts.  The helper must
// re-hash its bounded private snapshot before it may consume that request;
// a Python venv can contain thousands of files, so this wait cannot share the
// short status-observation timeout used by normal polling.
const MAX_CANCELLATION_TERMINAL_WAIT_MS = 120_000;
const MAX_WALL_TIME_MS = 24 * 60 * 60 * 1_000;
const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_MEMORY_BYTES = Math.min(1024 * 1024 * 1024 * 1024, Math.floor(totalmem() / 2));
// The helper copies a bounded Python/R runtime after the coordinator has
// materialized it under the caller's artifact root.  That tree can legitimately
// contain package paths beyond MAX_PATH.  This is a process-wide Windows/.NET
// capability declaration, rather than a path-shortening workaround for one
// coordinator directory name.
const RUNNER_HELPER_MANIFEST = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings xmlns:ws2="http://schemas.microsoft.com/SMI/2016/WindowsSettings">
      <ws2:longPathAware>true</ws2:longPathAware>
    </windowsSettings>
  </application>
</assembly>
`;
const RUNNER_HELPER_APP_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <runtime>
    <AppContextSwitchOverrides value="Switch.System.IO.UseLegacyPathHandling=false;Switch.System.IO.BlockLongPaths=false" />
  </runtime>
</configuration>
`;

export type IsolatedWindowsLanguage = "node" | "python" | "rscript";

export interface IsolatedWindowsRunRequest {
	runRootDirectory: string;
	language: IsolatedWindowsLanguage;
	executablePath: string;
	programPath: string;
	inputPaths?: string[];
	/** Exact coordinator-approved runtime bytes. Python and R reject ambient runtime discovery when supplied. */
	environment?: StudyExecutionEnvironment;
	/** Durable queue-private identity persisted before snapshot materialization. */
	preparationIdentity?: IsolatedWindowsPreparationIdentity;
	limits?: Partial<IsolatedWindowsRunLimits>;
}

export interface IsolatedWindowsPreparationIdentity {
	runId: string;
	cancelToken: string;
}

export interface IsolatedWindowsPreparedRunLocator {
	runRootDirectory: string;
	preparationIdentity: IsolatedWindowsPreparationIdentity;
}

/** Usage released by cancelling a durable preparation before any worker starts. */
export interface IsolatedWindowsPreparationAbandonment {
	version: 1;
	runId: string;
	status: "cancelled";
	/** Preparation never starts a worker, so process wall time is always zero. */
	wallTimeMs: 0;
	/** Bytes removed from the private runtime and input snapshots. */
	diskBytes: number;
	preparedCleanup: PreparedRunCleanup;
}

export interface IsolatedWindowsRunLimits {
	memoryBytes: number;
	cpuRatePercent: number;
	wallTimeMs: number;
	outputLimitBytes: number;
}

export interface IsolatedWindowsRunHandle {
	version: 1;
	runId: string;
	runDirectory: string;
	controlDirectory: string;
	outputDirectory: string;
	helperPath: string;
	cancelToken: string;
	configBindingHash: string;
}

export interface IsolatedWindowsRootExitJobMember {
	processId: number;
	isRoot: boolean;
	parentProcessId: number;
	imageName: string | null;
	creationFileTime: string | null;
	liveness: "alive" | "exited" | "exited-root-signaled" | "uninspectable";
	inspectionError: string | null;
}

export interface IsolatedWindowsRootExitToolhelpCandidate {
	processId: number;
	isRoot: boolean;
	parentProcessId: number;
	imageName: string | null;
	creationFileTime: string | null;
	liveness: "alive" | "exited" | "uninspectable";
	acceptedAsDescendant: boolean;
	rejectionReason: string | null;
	inspectionError: string | null;
}

export interface IsolatedWindowsRootExitObservation {
	observedAt: string;
	rootProcessId: number;
	totalProcesses: number;
	activeProcesses: number;
	totalTerminatedProcesses: number;
	jobMembers: IsolatedWindowsRootExitJobMember[];
	toolhelpCandidates: IsolatedWindowsRootExitToolhelpCandidate[];
	hasLiveToolhelpDescendant: boolean;
	diagnosticError: string | null;
}

export interface IsolatedWindowsRunStatus {
	version: 1;
	runId: string;
	status: "launching" | "running" | "succeeded" | "failed" | "cancelled" | "limit-reached";
	configBindingHash: string;
	processId: number;
	processCreationFileTime: string | null;
	exitCode: number | null;
	error: string | null;
	appContainerCleanup: string | null;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	outputBytes: number;
	outputFiles: number;
	wallTimeMs: number;
	rootExitDiagnostics: IsolatedWindowsRootExitObservation[];
	preparedCleanup: PreparedRunCleanup | null;
}

export interface PreparedRunCleanup {
	runtimeFiles: number;
	runtimeBytes: number;
	inputFiles: number;
	inputBytes: number;
}

interface FileDigest {
	path: string;
	sha256: string;
}

interface RunnerConfig {
	Version: 1;
	RunId: string;
	Language: IsolatedWindowsLanguage;
	RunDirectory: string;
	ControlDirectory: string;
	RuntimeDirectory: string;
	RuntimeBinDirectory: string;
	RuntimeEnvironmentRoot: string;
	InputDirectory: string;
	OutputDirectory: string;
	ExecutablePath: string;
	ProgramPath: string;
	MemoryBytes: number;
	CpuRatePercent: number;
	WallTimeMs: number;
	OutputLimitBytes: number;
	CancelTokenHash: string;
	ConfigBindingHash: string;
	CompatibilityAdapterPath?: string;
	CompatibilityAdapterHash?: string;
	CompatibilityRDllPath?: string;
	CompatibilityRDllHash?: string;
	EnvironmentAdapterKind?: string;
	EnvironmentDescriptorHash?: string;
	PythonSitePackagesDirectory?: string;
	PythonLibraryBinDirectory?: string;
	RLibraryDirectories?: string[];
	Files: FileDigest[];
}

interface DurableCancelRequest {
	version: 1;
	runId: string;
	configBindingHash: string;
	cancelTokenHash: string;
}

interface RunnerReceipt {
	Version: 1;
	RunId: string;
	Status: IsolatedWindowsRunStatus["status"];
	ConfigBindingHash: string;
	CancelTokenHash: string;
	ProcessId?: number;
	ProcessCreationFileTime?: string;
	ExitCode?: number;
	Error?: string;
	AppContainerCleanup?: string;
	StdoutBytes?: number;
	StderrBytes?: number;
	StdoutTruncated?: boolean;
	StderrTruncated?: boolean;
	OutputBytes?: number;
	OutputFiles?: number;
	WallTimeMs?: number;
	RootExitDiagnostics?: unknown;
	PreparedCleanup?: PreparedRunCleanup;
}

interface PreparedRuntime {
	executablePath: string;
	runtimeBinDirectory: string;
	runtimeEnvironmentRoot: string;
	files: string[];
	compatibilityAdapterPath?: string;
	compatibilityAdapterHash?: string;
	compatibilityRDllPath?: string;
	compatibilityRDllHash?: string;
	environmentAdapterKind?: string;
	environmentDescriptorHash?: string;
	pythonSitePackagesDirectory?: string;
	pythonLibraryBinDirectory?: string;
	rLibraryDirectories?: string[];
}

interface PreparationJournal {
	version: 1;
	runId: string;
	cancelTokenHash: string;
	ownerPid: number;
	ownerProcessCreationFileTime: string;
	state: "materializing" | "prepared" | "failed" | "abandoned";
}

export class StudyWindowsRunnerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StudyWindowsRunnerError";
		this.code = code;
	}
}

export async function startIsolatedWindowsRun(request: IsolatedWindowsRunRequest): Promise<IsolatedWindowsRunHandle> {
	const handle = await prepareIsolatedWindowsRun(request);
	await launchPreparedIsolatedWindowsRun(handle);
	return handle;
}

export async function prepareIsolatedWindowsRun(request: IsolatedWindowsRunRequest): Promise<IsolatedWindowsRunHandle> {
	if (process.platform !== "win32")
		throw new StudyWindowsRunnerError("WINDOWS_REQUIRED", "Windows isolation requires Windows.");
	const limits = normalizeLimits(request.limits);
	const runRootDirectory = resolve(request.runRootDirectory);
	await mkdir(runRootDirectory, { recursive: true });
	const helperPath = await compileRunnerHelper(runRootDirectory);
	const preparationIdentity = normalizePreparationIdentity(request.preparationIdentity);
	const runId = preparationIdentity.runId;
	const cancelToken = preparationIdentity.cancelToken;
	const { runDirectory, controlDirectory, runtimeDirectory, inputDirectory, outputDirectory } = preparationPaths(
		runRootDirectory,
		runId,
	);
	const journal: PreparationJournal = {
		version: 1,
		runId,
		cancelTokenHash: sha256(cancelToken),
		ownerPid: process.pid,
		ownerProcessCreationFileTime: currentProcessCreationFileTime(),
		state: "materializing",
	};
	const published = await publishInitialRunDirectory(runRootDirectory, runDirectory, journal);
	if (!published) {
		const existing = await completeHandleFromDirectory({ runRootDirectory, preparationIdentity }, helperPath);
		if (existing) return existing;
		const journal = await readPreparationJournal(controlDirectory);
		assertJournalIdentity(journal, preparationIdentity);
		if (journal.state === "abandoned")
			throw new StudyWindowsRunnerError(
				"PREPARATION_ABANDONED",
				`Preparation ${runId} was cancelled before launch and cannot be recreated with the same durable identity.`,
			);
		if (journal.state === "materializing" && journalOwnerIsAlive(journal))
			throw new StudyWindowsRunnerError(
				"PREPARATION_BUSY",
				`Preparation ${runId} is still owned by process ${journal.ownerPid}.`,
			);
		throw new StudyWindowsRunnerError(
			"PREPARATION_INCOMPLETE",
			`Preparation ${runId} is incomplete and must be abandoned by its durable owner before it can be recreated.`,
		);
	}
	const journalPath = join(controlDirectory, "preparation.json");
	try {
		for (const directory of [runtimeDirectory, inputDirectory, outputDirectory]) {
			await mkdir(directory, { recursive: true });
		}
		const runtime = request.environment
			? await snapshotDeclaredRuntime(
					request.language,
					request.executablePath,
					request.environment,
					runtimeDirectory,
					runRootDirectory,
				)
			: await snapshotRuntime(request.language, request.executablePath, runtimeDirectory, runRootDirectory);
		if (request.environment) await verifyStudyExecutionEnvironment(request.environment);
		await assertRuntimeSnapshotBound(runtime.files);
		const programPath = await snapshotInput(request.programPath, inputDirectory, "program");
		const inputPaths = await Promise.all(
			(request.inputPaths ?? []).map((inputPath, index) =>
				snapshotInput(inputPath, inputDirectory, `input-${index}`),
			),
		);
		const files = await fileDigests([...runtime.files, programPath, ...inputPaths]);
		const draft: Omit<RunnerConfig, "ConfigBindingHash"> = {
			Version: 1,
			RunId: runId,
			Language: request.language,
			RunDirectory: runDirectory,
			ControlDirectory: controlDirectory,
			RuntimeDirectory: runtimeDirectory,
			RuntimeBinDirectory: runtime.runtimeBinDirectory,
			RuntimeEnvironmentRoot: runtime.runtimeEnvironmentRoot,
			InputDirectory: inputDirectory,
			OutputDirectory: outputDirectory,
			ExecutablePath: runtime.executablePath,
			ProgramPath: programPath,
			MemoryBytes: limits.memoryBytes,
			CpuRatePercent: limits.cpuRatePercent,
			WallTimeMs: limits.wallTimeMs,
			OutputLimitBytes: limits.outputLimitBytes,
			CancelTokenHash: sha256(cancelToken),
			CompatibilityAdapterPath: runtime.compatibilityAdapterPath,
			CompatibilityAdapterHash: runtime.compatibilityAdapterHash,
			CompatibilityRDllPath: runtime.compatibilityRDllPath,
			CompatibilityRDllHash: runtime.compatibilityRDllHash,
			EnvironmentAdapterKind: runtime.environmentAdapterKind,
			EnvironmentDescriptorHash: runtime.environmentDescriptorHash,
			PythonSitePackagesDirectory: runtime.pythonSitePackagesDirectory,
			PythonLibraryBinDirectory: runtime.pythonLibraryBinDirectory,
			RLibraryDirectories: runtime.rLibraryDirectories,
			Files: files,
		};
		const config: RunnerConfig = { ...draft, ConfigBindingHash: bindingHash(draft) };
		const configPath = join(controlDirectory, "config.json");
		await writeAtomicFile(configPath, `${JSON.stringify(config)}\n`);
		await writeAtomicFile(journalPath, `${JSON.stringify({ ...journal, state: "prepared" })}\n`);

		return {
			version: 1,
			runId,
			runDirectory,
			controlDirectory,
			outputDirectory,
			helperPath,
			cancelToken,
			configBindingHash: config.ConfigBindingHash,
		};
	} catch (error) {
		await writeAtomicFile(journalPath, `${JSON.stringify({ ...journal, state: "failed" })}\n`).catch(() => undefined);
		throw error;
	}
}

export async function launchPreparedIsolatedWindowsRun(
	handle: IsolatedWindowsRunHandle,
): Promise<IsolatedWindowsRunStatus> {
	validateHandle(handle);
	await validatePreparedConfig(handle);
	const claimPath = join(handle.controlDirectory, "launch.claim");
	const claimed = await claimRun(claimPath, handle, "launch");
	if (!claimed) {
		const existing = await readClaim(claimPath);
		if (existing?.disposition === "abandoned")
			return waitForTerminalStatus(
				handle.controlDirectory,
				handle.runId,
				handle.configBindingHash,
				MAX_CONTROL_WAIT_MS,
			);
		return reconcileIsolatedWindowsRun(handle);
	}
	await writeLaunchingReceipt(handle);
	await startSupervisor(handle);
	return waitForStatus(handle.controlDirectory, handle.runId, handle.configBindingHash, MAX_CONTROL_WAIT_MS);
}

export async function getIsolatedWindowsRunStatus(handle: IsolatedWindowsRunHandle): Promise<IsolatedWindowsRunStatus> {
	return waitForStatus(handle.controlDirectory, handle.runId, handle.configBindingHash, 250);
}

export async function reconcileIsolatedWindowsRun(handle: IsolatedWindowsRunHandle): Promise<IsolatedWindowsRunStatus> {
	validateHandle(handle);
	await validatePreparedConfig(handle);
	const claim = await readClaim(join(handle.controlDirectory, "launch.claim"));
	if (claim?.disposition === "abandoned") {
		return waitForTerminalStatus(
			handle.controlDirectory,
			handle.runId,
			handle.configBindingHash,
			MAX_CONTROL_WAIT_MS,
		);
	}
	if (claim === null) return launchPreparedIsolatedWindowsRun(handle);
	if (claim?.disposition !== "launch")
		throw new StudyWindowsRunnerError("PREPARATION_CLAIM_INVALID", "Launch claim is malformed.");
	const current = await readRunStatusIfPresent(handle);
	if (current && current.status !== "launching" && current.status !== "running") return current;
	if (
		current?.processId &&
		current.processCreationFileTime &&
		processCreationFileTime(current.processId) === current.processCreationFileTime
	) {
		// Normal polling only reads the receipt. The original supervisor still owns
		// the worker and its FileShare.None lock; starting another EXE each poll adds
		// needless Windows process churn without improving reconciliation.
		return current;
	}
	// A crash between launch.claim and the detached supervisor leaves either no
	// receipt or Node's ProcessId=0 launching receipt. Running this same helper is
	// safe: its FileShare.None lock and positive persisted process identity fence
	// prevent a second worker from being created.
	await startSupervisor(handle);
	return waitForStatus(handle.controlDirectory, handle.runId, handle.configBindingHash, MAX_CONTROL_WAIT_MS);
}

async function startSupervisor(handle: IsolatedWindowsRunHandle): Promise<void> {
	try {
		const supervisor = spawn(
			helperPathFromHandle(handle),
			["--supervise", join(handle.controlDirectory, "config.json")],
			{
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			},
		);
		supervisor.once("error", (error) => {
			void writeFailedLaunchReceipt(handle, errorMessage(error));
		});
		supervisor.unref();
	} catch (error) {
		await writeFailedLaunchReceipt(handle, errorMessage(error));
	}
}

async function readRunStatusIfPresent(handle: IsolatedWindowsRunHandle): Promise<IsolatedWindowsRunStatus | null> {
	try {
		return await waitForStatus(handle.controlDirectory, handle.runId, handle.configBindingHash, 250);
	} catch (error) {
		if (error instanceof StudyWindowsRunnerError && error.code === "RUNNER_STATUS_UNAVAILABLE") return null;
		throw error;
	}
}

/**
 * Reopens a completed durable preparation without materializing another snapshot.
 * It deliberately does not launch a worker.
 */
export async function recoverPreparedIsolatedWindowsRun(
	locator: IsolatedWindowsPreparedRunLocator,
): Promise<IsolatedWindowsRunHandle> {
	const runRootDirectory = resolve(locator.runRootDirectory);
	const preparationIdentity = normalizePreparationIdentity(locator.preparationIdentity);
	const helperPath = await compileRunnerHelper(runRootDirectory);
	const handle = await completeHandleFromDirectory({ runRootDirectory, preparationIdentity }, helperPath);
	if (handle) return handle;
	throw new StudyWindowsRunnerError(
		"PREPARATION_INCOMPLETE",
		`Preparation ${preparationIdentity.runId} has no complete immutable runner configuration.`,
	);
}

/**
 * Cancels a durable preparation by its persisted identity. It never starts a
 * process: a launch claim is a hard fence and is reported for reconciliation.
 */
export async function abandonIsolatedWindowsPreparation(
	locator: IsolatedWindowsPreparedRunLocator,
): Promise<IsolatedWindowsPreparationAbandonment> {
	const runRootDirectory = resolve(locator.runRootDirectory);
	const preparationIdentity = normalizePreparationIdentity(locator.preparationIdentity);
	await mkdir(runRootDirectory, { recursive: true });
	const paths = preparationPaths(runRootDirectory, preparationIdentity.runId);
	const neverMaterialized = await abandonNeverMaterializedPreparation(paths, preparationIdentity);
	if (neverMaterialized) return neverMaterialized;
	const journal = await readPreparationJournal(paths.controlDirectory);
	assertJournalIdentity(journal, preparationIdentity);
	if (journal.state === "abandoned") {
		const prior = await readPreparationAbandonment(paths.controlDirectory, preparationIdentity);
		if (prior) return prior;
		const claimed = await claimPreparationAbandonment(join(paths.controlDirectory, "launch.claim"), journal);
		if (!claimed) {
			const claim = await readClaim(join(paths.controlDirectory, "launch.claim"));
			if (claim?.disposition !== "abandoned") {
				throw new StudyWindowsRunnerError(
					"PREPARED_RUN_ALREADY_LAUNCHED",
					`Preparation ${preparationIdentity.runId} has a launch claim and must be reconciled.`,
				);
			}
		}
		return finishIncompletePreparationAbandonment(paths, preparationIdentity, journal);
	}
	const helperPath = join(runRootDirectory, "helper", "study-windows-runner.exe");
	const complete = await completeHandleFromDirectory({ runRootDirectory, preparationIdentity }, helperPath);
	if (complete) {
		const status = await abandonPreparedIsolatedWindowsRun(complete);
		const cleanup = status.preparedCleanup;
		if (status.status !== "cancelled" || !cleanup) {
			throw new StudyWindowsRunnerError(
				"PREPARATION_ABANDONMENT_UNCONFIRMED",
				`Prepared run ${complete.runId} did not publish its expected cancellation receipt.`,
			);
		}
		return preparationAbandonment(complete.runId, cleanup);
	}
	if (journal.state === "materializing" && journalOwnerIsAlive(journal)) {
		throw new StudyWindowsRunnerError(
			"PREPARATION_BUSY",
			`Preparation ${preparationIdentity.runId} is still owned by process ${journal.ownerPid}.`,
		);
	}
	const claimPath = join(paths.controlDirectory, "launch.claim");
	const claimed = await claimPreparationAbandonment(claimPath, journal);
	if (!claimed) {
		const claim = await readClaim(claimPath);
		if (claim?.disposition === "launch") {
			throw new StudyWindowsRunnerError(
				"PREPARED_RUN_ALREADY_LAUNCHED",
				`Preparation ${preparationIdentity.runId} has a launch claim and must be reconciled.`,
			);
		}
		if (claim?.disposition === "abandoned") {
			const prior = await readPreparationAbandonment(paths.controlDirectory, preparationIdentity);
			if (prior) return prior;
			return finishIncompletePreparationAbandonment(paths, preparationIdentity, journal);
		}
		throw new StudyWindowsRunnerError("PREPARATION_CLAIM_INVALID", "Preparation launch claim is malformed.");
	}
	return finishIncompletePreparationAbandonment(paths, preparationIdentity, journal);
}

/** Claims and removes only an unlaunched run's immutable runtime and input snapshots. */
export async function abandonPreparedIsolatedWindowsRun(
	handle: IsolatedWindowsRunHandle,
): Promise<IsolatedWindowsRunStatus> {
	validateHandle(handle);
	const config = await validatePreparedConfig(handle);
	const claimPath = join(handle.controlDirectory, "launch.claim");
	const claimed = await claimRun(claimPath, handle, "abandoned");
	if (!claimed) {
		const existing = await readClaim(claimPath);
		if (existing?.disposition === "abandoned")
			return waitForTerminalStatus(
				handle.controlDirectory,
				handle.runId,
				handle.configBindingHash,
				MAX_CONTROL_WAIT_MS,
			);
		throw new StudyWindowsRunnerError(
			"PREPARED_RUN_ALREADY_LAUNCHED",
			"A prepared run with a persisted launch claim must be reconciled or cancelled, not deleted.",
		);
	}
	try {
		const cleanup = await deletePreparedSnapshots(handle, config);
		await writeReceipt(handle.controlDirectory, {
			Version: 1,
			RunId: handle.runId,
			Status: "cancelled",
			ConfigBindingHash: handle.configBindingHash,
			CancelTokenHash: sha256(handle.cancelToken),
			AppContainerCleanup: "not-started;runtime-input-deleted",
			PreparedCleanup: cleanup,
			WallTimeMs: 0,
		});
		return getIsolatedWindowsRunStatus(handle);
	} catch (error) {
		await writeFailedLaunchReceipt(handle, `prepared snapshot cleanup failed: ${errorMessage(error)}`);
		throw error;
	}
}

export async function cancelIsolatedWindowsRun(handle: IsolatedWindowsRunHandle): Promise<IsolatedWindowsRunStatus> {
	validateHandle(handle);
	await validatePreparedConfig(handle);
	const claim = await readClaim(join(handle.controlDirectory, "launch.claim"));
	if (claim === null) return abandonPreparedIsolatedWindowsRun(handle);
	if (claim.disposition === "abandoned") {
		return waitForTerminalStatus(
			handle.controlDirectory,
			handle.runId,
			handle.configBindingHash,
			MAX_CONTROL_WAIT_MS,
		);
	}
	if (claim.disposition !== "launch")
		throw new StudyWindowsRunnerError("PREPARATION_CLAIM_INVALID", "Launch claim is malformed.");
	await writeDurableCancelRequest(handle);
	// Reconciliation starts the same lock-fenced supervisor if a coordinator
	// crashed after launch.claim. The C# helper checks cancel.request before it
	// resumes its suspended worker.
	await reconcileIsolatedWindowsRun(handle);
	return waitForTerminalStatus(
		handle.controlDirectory,
		handle.runId,
		handle.configBindingHash,
		MAX_CANCELLATION_TERMINAL_WAIT_MS,
	);
}

async function writeDurableCancelRequest(handle: IsolatedWindowsRunHandle): Promise<void> {
	const requestPath = join(handle.controlDirectory, "cancel.request");
	const request: DurableCancelRequest = {
		version: 1,
		runId: handle.runId,
		configBindingHash: handle.configBindingHash,
		cancelTokenHash: sha256(handle.cancelToken),
	};
	const contents = `${JSON.stringify(request)}\n`;
	const published = await publishNoClobberFile(requestPath, contents);
	if (published) return;
	let existing: unknown;
	try {
		existing = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
	} catch (error) {
		throw new StudyWindowsRunnerError("CANCEL_REQUEST_BINDING_INVALID", errorMessage(error));
	}
	if (
		!isRecord(existing) ||
		existing.version !== request.version ||
		existing.runId !== request.runId ||
		existing.configBindingHash !== request.configBindingHash ||
		existing.cancelTokenHash !== request.cancelTokenHash
	) {
		throw new StudyWindowsRunnerError(
			"CANCEL_REQUEST_BINDING_INVALID",
			"Existing cancellation request does not match this immutable prepared run.",
		);
	}
}

async function validatePreparedConfig(handle: IsolatedWindowsRunHandle): Promise<RunnerConfig> {
	const configPath = join(handle.controlDirectory, "config.json");
	const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
	if (
		!isRunnerConfig(raw) ||
		raw.RunId !== handle.runId ||
		resolve(raw.RunDirectory) !== resolve(handle.runDirectory) ||
		resolve(raw.ControlDirectory) !== resolve(handle.controlDirectory) ||
		resolve(raw.OutputDirectory) !== resolve(handle.outputDirectory) ||
		raw.ConfigBindingHash !== handle.configBindingHash ||
		raw.CancelTokenHash !== sha256(handle.cancelToken) ||
		raw.ConfigBindingHash !== bindingHash(raw)
	) {
		throw new StudyWindowsRunnerError(
			"PREPARED_RUN_BINDING_INVALID",
			"Prepared runner configuration does not match its handle.",
		);
	}
	return raw;
}

async function claimRun(
	claimPath: string,
	handle: IsolatedWindowsRunHandle,
	disposition: "launch" | "abandoned",
): Promise<boolean> {
	return publishNoClobberFile(
		claimPath,
		`${JSON.stringify({ runId: handle.runId, configBindingHash: handle.configBindingHash, disposition })}\n`,
	);
}

async function claimPreparationAbandonment(claimPath: string, journal: PreparationJournal): Promise<boolean> {
	return publishNoClobberFile(
		claimPath,
		`${JSON.stringify({
			runId: journal.runId,
			cancelTokenHash: journal.cancelTokenHash,
			disposition: "abandoned",
		})}\n`,
	);
}

async function readClaim(claimPath: string): Promise<{ disposition?: unknown } | null> {
	try {
		const value = JSON.parse(await readFile(claimPath, "utf8")) as unknown;
		return isRecord(value) ? value : null;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function deletePreparedSnapshots(
	handle: IsolatedWindowsRunHandle,
	config: RunnerConfig,
): Promise<PreparedRunCleanup> {
	const expectedRuntime = join(resolve(handle.runDirectory), "runtime");
	const expectedInput = join(resolve(handle.runDirectory), "input");
	if (resolve(config.RuntimeDirectory) !== expectedRuntime || resolve(config.InputDirectory) !== expectedInput) {
		throw new StudyWindowsRunnerError(
			"PREPARED_CLEANUP_TARGET_INVALID",
			"Prepared cleanup only accepts the immutable runtime and input snapshot paths.",
		);
	}
	const runtime = await directoryUsage(expectedRuntime);
	const input = await directoryUsage(expectedInput);
	await rm(expectedRuntime, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
	await rm(expectedInput, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
	return {
		runtimeFiles: runtime.files,
		runtimeBytes: runtime.bytes,
		inputFiles: input.files,
		inputBytes: input.bytes,
	};
}

async function deleteIncompletePreparedSnapshots(
	paths: ReturnType<typeof preparationPaths>,
): Promise<PreparedRunCleanup> {
	const runtime = await directoryUsageIfPresent(paths.runtimeDirectory);
	const input = await directoryUsageIfPresent(paths.inputDirectory);
	await removePrivateSnapshotDirectory(paths.runDirectory, paths.runtimeDirectory);
	await removePrivateSnapshotDirectory(paths.runDirectory, paths.inputDirectory);
	return {
		runtimeFiles: runtime.files,
		runtimeBytes: runtime.bytes,
		inputFiles: input.files,
		inputBytes: input.bytes,
	};
}

function preparationAbandonment(
	runId: string,
	preparedCleanup: PreparedRunCleanup,
): IsolatedWindowsPreparationAbandonment {
	return {
		version: 1,
		runId,
		status: "cancelled",
		wallTimeMs: 0,
		diskBytes: preparedCleanup.runtimeBytes + preparedCleanup.inputBytes,
		preparedCleanup,
	};
}

function emptyPreparedCleanup(): PreparedRunCleanup {
	return { runtimeFiles: 0, runtimeBytes: 0, inputFiles: 0, inputBytes: 0 };
}

async function abandonNeverMaterializedPreparation(
	paths: ReturnType<typeof preparationPaths>,
	identity: IsolatedWindowsPreparationIdentity,
): Promise<IsolatedWindowsPreparationAbandonment | null> {
	const journal: PreparationJournal = {
		version: 1,
		runId: identity.runId,
		cancelTokenHash: sha256(identity.cancelToken),
		ownerPid: process.pid,
		ownerProcessCreationFileTime: currentProcessCreationFileTime(),
		state: "abandoned",
	};
	const published = await publishInitialRunDirectory(dirname(paths.runDirectory), paths.runDirectory, journal);
	if (!published) return null;
	const claimed = await claimPreparationAbandonment(join(paths.controlDirectory, "launch.claim"), journal);
	if (!claimed) {
		throw new StudyWindowsRunnerError(
			"PREPARATION_CLAIM_INVALID",
			"A new durable preparation unexpectedly already had a launch claim.",
		);
	}
	const result = preparationAbandonment(identity.runId, emptyPreparedCleanup());
	await writePreparationAbandonment(paths.controlDirectory, result, journal.cancelTokenHash);
	return result;
}

async function writePreparationAbandonment(
	controlDirectory: string,
	result: IsolatedWindowsPreparationAbandonment,
	cancelTokenHash: string,
): Promise<void> {
	await writeAtomicFile(
		join(controlDirectory, "preparation-abandoned.json"),
		`${JSON.stringify({ ...result, cancelTokenHash })}\n`,
	);
}

interface PreparationCleanupLease {
	path: string;
	file: Awaited<ReturnType<typeof open>>;
}

async function finishIncompletePreparationAbandonment(
	paths: ReturnType<typeof preparationPaths>,
	identity: IsolatedWindowsPreparationIdentity,
	journal: PreparationJournal,
): Promise<IsolatedWindowsPreparationAbandonment> {
	const lease = await acquirePreparationCleanupLease(paths.controlDirectory);
	try {
		const prior = await readPreparationAbandonment(paths.controlDirectory, identity);
		if (prior) return prior;
		const cleanup = await deleteIncompletePreparedSnapshots(paths);
		const result = preparationAbandonment(identity.runId, cleanup);
		await writePreparationAbandonment(paths.controlDirectory, result, journal.cancelTokenHash);
		return result;
	} catch (error) {
		if (error instanceof StudyWindowsRunnerError) throw error;
		throw new StudyWindowsRunnerError(
			"PREPARATION_CLEANUP_FAILED",
			`Preparation ${identity.runId} was fenced from launch but private snapshot cleanup failed: ${errorMessage(error)}`,
		);
	} finally {
		await releasePreparationCleanupLease(lease);
	}
}

async function acquirePreparationCleanupLease(controlDirectory: string): Promise<PreparationCleanupLease> {
	const path = join(controlDirectory, "preparation-cleanup.lock");
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const file = await open(path, "wx");
			try {
				const owner: PreparationJournal = {
					version: 1,
					runId: "cleanup-lease",
					cancelTokenHash: "0".repeat(64),
					ownerPid: process.pid,
					ownerProcessCreationFileTime: currentProcessCreationFileTime(),
					state: "materializing",
				};
				await file.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
				return { path, file };
			} catch (error) {
				await file.close();
				throw error;
			}
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;
			const existing = await readCleanupLease(path);
			if (!existing || journalOwnerIsAlive(existing)) {
				throw new StudyWindowsRunnerError(
					"PREPARATION_BUSY",
					"Another coordinator is still finalizing private preparation cleanup.",
				);
			}
			await rm(path, { force: false, maxRetries: 2, retryDelay: 50 });
		}
	}
	throw new StudyWindowsRunnerError(
		"PREPARATION_BUSY",
		"Could not acquire the preparation cleanup lease after reclaiming a dead owner.",
	);
}

async function readCleanupLease(path: string): Promise<PreparationJournal | null> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return isPreparationJournal(value) ? value : null;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function releasePreparationCleanupLease(lease: PreparationCleanupLease): Promise<void> {
	try {
		await lease.file.close();
	} finally {
		await rm(lease.path, { force: false, maxRetries: 2, retryDelay: 50 }).catch((error: unknown) => {
			if (!isNodeError(error, "ENOENT")) throw error;
		});
	}
}

async function readPreparationAbandonment(
	controlDirectory: string,
	identity: IsolatedWindowsPreparationIdentity,
): Promise<IsolatedWindowsPreparationAbandonment | null> {
	try {
		const value = JSON.parse(await readFile(join(controlDirectory, "preparation-abandoned.json"), "utf8")) as unknown;
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			value.runId !== identity.runId ||
			value.status !== "cancelled" ||
			value.wallTimeMs !== 0 ||
			typeof value.diskBytes !== "number" ||
			!Number.isSafeInteger(value.diskBytes) ||
			value.diskBytes < 0 ||
			value.cancelTokenHash !== sha256(identity.cancelToken) ||
			!isPreparedRunCleanup(value.preparedCleanup)
		) {
			throw new StudyWindowsRunnerError(
				"PREPARATION_ABANDONMENT_INVALID",
				"Preparation cancellation receipt did not match the requested durable identity.",
			);
		}
		return {
			version: 1,
			runId: identity.runId,
			status: "cancelled",
			wallTimeMs: 0,
			diskBytes: value.diskBytes,
			preparedCleanup: value.preparedCleanup,
		};
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function directoryUsageIfPresent(directory: string): Promise<{ files: number; bytes: number }> {
	try {
		return await directoryUsage(directory);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return { files: 0, bytes: 0 };
		throw error;
	}
}

async function removePrivateSnapshotDirectory(runDirectory: string, directory: string): Promise<void> {
	const expected = resolve(runDirectory, basename(directory));
	if (resolve(directory) !== expected || !isWithinPath(runDirectory, directory)) {
		throw new StudyWindowsRunnerError(
			"PREPARED_CLEANUP_TARGET_INVALID",
			"Preparation cleanup only removes the direct private runtime and input directories.",
		);
	}
	try {
		await rm(directory, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
	}
}

async function directoryUsage(directory: string): Promise<{ files: number; bytes: number }> {
	const root = resolve(directory);
	const entries = await readdir(root, { withFileTypes: true });
	let files = 0;
	let bytes = 0;
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink()) {
			throw new StudyWindowsRunnerError(
				"PREPARED_CLEANUP_REPARSE_POINT",
				`Prepared snapshot contains a symbolic link: ${path}`,
			);
		}
		if (entry.isDirectory()) {
			const child = await directoryUsage(path);
			files += child.files;
			bytes += child.bytes;
		} else if (entry.isFile()) {
			files += 1;
			bytes += (await stat(path)).size;
		} else {
			throw new StudyWindowsRunnerError(
				"PREPARED_CLEANUP_ENTRY_INVALID",
				`Prepared snapshot has an unsupported entry: ${path}`,
			);
		}
	}
	return { files, bytes };
}

async function writeLaunchingReceipt(handle: IsolatedWindowsRunHandle): Promise<void> {
	const receipt: RunnerReceipt = {
		Version: 1,
		RunId: handle.runId,
		Status: "launching",
		ConfigBindingHash: handle.configBindingHash,
		CancelTokenHash: sha256(handle.cancelToken),
		ProcessId: 0,
	};
	await writeReceipt(handle.controlDirectory, receipt);
}

async function writeFailedLaunchReceipt(handle: IsolatedWindowsRunHandle, error: string): Promise<void> {
	const receipt: RunnerReceipt = {
		Version: 1,
		RunId: handle.runId,
		Status: "failed",
		ConfigBindingHash: handle.configBindingHash,
		CancelTokenHash: sha256(handle.cancelToken),
		Error: `Node launcher: ${error}`,
	};
	await writeReceipt(handle.controlDirectory, receipt);
}

async function writeReceipt(controlDirectory: string, receipt: RunnerReceipt): Promise<void> {
	const path = join(controlDirectory, "status.json");
	await writeAtomicFile(path, `${JSON.stringify(receipt)}\n`);
}

async function writeAtomicFile(path: string, contents: string): Promise<void> {
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	await writeFile(temporary, contents, "utf8");
	await rename(temporary, path);
}

/**
 * The canonical run directory does not exist until its complete ownership
 * journal is synced. A crash can leave only a randomly named staging directory,
 * which never blocks the durable run id from recovery or cancellation.
 */
async function publishInitialRunDirectory(
	runRootDirectory: string,
	runDirectory: string,
	journal: PreparationJournal,
): Promise<boolean> {
	const root = resolve(runRootDirectory);
	const stagingDirectory = resolve(root, `.run-${journal.runId}.preparing-${randomUUID()}`);
	if (!isWithinPath(root, stagingDirectory) || dirname(stagingDirectory) !== root) {
		throw new StudyWindowsRunnerError(
			"PREPARATION_STAGING_INVALID",
			"Preparation staging directory escaped its run root.",
		);
	}
	const stagingControlDirectory = join(stagingDirectory, "control");
	let published = false;
	try {
		await mkdir(stagingDirectory);
		await mkdir(stagingControlDirectory);
		await writeInitialPreparationJournal(join(stagingControlDirectory, "preparation.json"), journal);
		try {
			await rename(stagingDirectory, runDirectory);
			published = true;
			return true;
		} catch (error) {
			if (isNodeError(error, "EEXIST") || isNodeError(error, "EPERM")) return false;
			throw error;
		}
	} finally {
		if (!published) {
			await rm(stagingDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(
				(error: unknown) => {
					if (!isNodeError(error, "ENOENT")) throw error;
				},
			);
		}
	}
}

async function writeInitialPreparationJournal(path: string, journal: PreparationJournal): Promise<void> {
	const published = await publishNoClobberFile(path, `${JSON.stringify(journal)}\n`);
	if (!published) {
		throw new StudyWindowsRunnerError(
			"PREPARATION_JOURNAL_EXISTS",
			"Preparation journal already exists; refusing to take over its durable identity.",
		);
	}
}

/**
 * Creates a fully-written, synced temporary file and then publishes it by hard
 * link. Link fails when a contender has already won, without ever exposing an
 * empty or partially-written canonical control file.
 */
async function publishNoClobberFile(path: string, contents: string): Promise<boolean> {
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let file: Awaited<ReturnType<typeof open>> | null = null;
	try {
		file = await open(temporary, "wx");
		await file.writeFile(contents, "utf8");
		await file.sync();
		await file.close();
		file = null;
		if (process.env.STUDY_WINDOWS_RUNNER_TEST_FAULT === "after-sync-before-link") process.abort();
		try {
			await link(temporary, path);
			if (process.env.STUDY_WINDOWS_RUNNER_TEST_FAULT === "after-link") process.abort();
			return true;
		} catch (error) {
			if (isNodeError(error, "EEXIST")) return false;
			throw error;
		}
	} finally {
		if (file) await file.close();
		await rm(temporary, { force: true }).catch((error: unknown) => {
			if (!isNodeError(error, "ENOENT")) throw error;
		});
	}
}

function helperPathFromHandle(handle: IsolatedWindowsRunHandle): string {
	if (!isAbsolute(handle.helperPath)) {
		throw new StudyWindowsRunnerError("INVALID_RUN_HANDLE", "Helper path must be absolute.");
	}
	return resolve(handle.helperPath);
}

async function compileRunnerHelper(runRootDirectory: string): Promise<string> {
	const sourcePath = fileURLToPath(new URL("./windows-runner.cs", import.meta.url));
	const helperDirectory = join(runRootDirectory, "helper");
	const helperPath = join(helperDirectory, "study-windows-runner.exe");
	const manifestPath = join(helperDirectory, "study-windows-runner.manifest");
	const appConfigPath = `${helperPath}.config`;
	await mkdir(helperDirectory, { recursive: true });
	const helperSettingsChanged =
		(await readFile(manifestPath, "utf8").catch(() => null)) !== RUNNER_HELPER_MANIFEST ||
		(await readFile(appConfigPath, "utf8").catch(() => null)) !== RUNNER_HELPER_APP_CONFIG;
	if (helperSettingsChanged) {
		await writeFile(manifestPath, RUNNER_HELPER_MANIFEST, "utf8");
		await writeFile(appConfigPath, RUNNER_HELPER_APP_CONFIG, "utf8");
	}
	const source = await stat(sourcePath);
	const helper = await stat(helperPath).catch(() => null);
	if (helper && helper.mtimeMs >= source.mtimeMs && !helperSettingsChanged) return helperPath;
	const compile = spawnSync(
		CSC_PATH,
		[
			"/nologo",
			"/target:exe",
			"/platform:x64",
			`/win32manifest:${manifestPath}`,
			`/out:${helperPath}`,
			"/r:System.Web.Extensions.dll",
			sourcePath,
		],
		{ encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 30_000 },
	);
	if (compile.status !== 0) {
		throw new StudyWindowsRunnerError(
			"RUNNER_COMPILE_FAILED",
			String(compile.stderr || compile.stdout || compile.error?.message || "csc.exe failed").trim(),
		);
	}
	return helperPath;
}

async function snapshotRuntime(
	language: IsolatedWindowsLanguage,
	executablePath: string,
	runtimeDirectory: string,
	runRootDirectory: string,
): Promise<PreparedRuntime> {
	const sourceExecutable = resolveExistingFile(executablePath, "executable");
	if (language === "node") {
		const snapshotExecutable = join(runtimeDirectory, "node.exe");
		await copyFile(sourceExecutable, snapshotExecutable);
		return {
			executablePath: snapshotExecutable,
			runtimeBinDirectory: runtimeDirectory,
			runtimeEnvironmentRoot: runtimeDirectory,
			files: [snapshotExecutable],
		};
	}
	if (language === "rscript") {
		const sourceRoot = dirname(dirname(sourceExecutable));
		const destinationRoot = join(runtimeDirectory, "R");
		const files = await copyTreeBounded(sourceRoot, destinationRoot, MAX_RUNTIME_SNAPSHOT_BYTES);
		const adapterPath = await compileRCompatibilityAdapter(runRootDirectory);
		const snapshotAdapter = join(destinationRoot, "bin", "x64", "study-r-appcontainer-launcher.exe");
		const snapshotRDll = join(destinationRoot, "bin", "x64", "R.dll");
		await stat(snapshotRDll);
		await copyFile(adapterPath, snapshotAdapter);
		files.push(snapshotAdapter);
		return {
			executablePath: snapshotAdapter,
			runtimeBinDirectory: dirname(snapshotAdapter),
			runtimeEnvironmentRoot: destinationRoot,
			files,
			compatibilityAdapterPath: snapshotAdapter,
			compatibilityAdapterHash: await sha256File(snapshotAdapter),
			compatibilityRDllPath: snapshotRDll,
			compatibilityRDllHash: await sha256File(snapshotRDll),
		};
	}
	const sourceRoot = dirname(sourceExecutable);
	const destinationRoot = join(runtimeDirectory, "python");
	await mkdir(destinationRoot, { recursive: true });
	const binaryFiles: string[] = [];
	const binaryNames = ["python.exe"];
	for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) binaryNames.push(entry.name);
	}
	for (const name of binaryNames) {
		const destination = join(destinationRoot, name);
		await copyFile(join(sourceRoot, name), destination);
		binaryFiles.push(destination);
	}
	const extensionFiles = await copyTreeBounded(
		join(sourceRoot, "DLLs"),
		join(destinationRoot, "DLLs"),
		MAX_RUNTIME_SNAPSHOT_BYTES,
	);
	const standardLibraryFiles = await copyTreeBounded(
		join(sourceRoot, "Lib"),
		join(destinationRoot, "Lib"),
		MAX_RUNTIME_SNAPSHOT_BYTES,
		["site-packages"],
	);
	return {
		executablePath: join(destinationRoot, "python.exe"),
		runtimeBinDirectory: destinationRoot,
		runtimeEnvironmentRoot: destinationRoot,
		files: [...binaryFiles, ...extensionFiles, ...standardLibraryFiles],
	};
}

async function snapshotDeclaredRuntime(
	language: IsolatedWindowsLanguage,
	executablePath: string,
	environment: StudyExecutionEnvironment,
	runtimeDirectory: string,
	runRootDirectory: string,
): Promise<PreparedRuntime> {
	await verifyStudyExecutionEnvironment(environment);
	const sourceExecutable = resolveExistingFile(executablePath, "executable");
	if (!sameWindowsPath(sourceExecutable, environment.executablePath)) {
		throw new StudyWindowsRunnerError(
			"ENVIRONMENT_EXECUTABLE_MISMATCH",
			"Run executable must exactly match the verified environment executable.",
		);
	}
	if (language === "python" && environment.adapterKind === PYTHON_PROJECT_VENV_ADAPTER) {
		return snapshotDeclaredPythonRuntime(environment, runtimeDirectory);
	}
	if (language === "rscript" && environment.adapterKind === R_GLOBAL_LIBRARY_ADAPTER) {
		return snapshotDeclaredRRuntime(environment, runtimeDirectory, runRootDirectory);
	}
	throw new StudyWindowsRunnerError(
		"ENVIRONMENT_ADAPTER_LANGUAGE_MISMATCH",
		`Environment adapter ${environment.adapterKind} cannot run ${language}.`,
	);
}

async function snapshotDeclaredPythonRuntime(
	environment: StudyExecutionEnvironment,
	runtimeDirectory: string,
): Promise<PreparedRuntime> {
	const venvExecutable = resolveExistingFile(environment.executablePath, "venv Python executable");
	const venvRoot = dirname(dirname(venvExecutable));
	const pyvenvConfig = join(venvRoot, "pyvenv.cfg");
	const pyvenvText = await readFile(pyvenvConfig, "utf8").catch((error: unknown) => {
		throw new StudyWindowsRunnerError("PYTHON_VENV_CONFIG_MISSING", errorMessage(error));
	});
	const home = /^home\s*=\s*(.+)$/imu.exec(pyvenvText)?.[1]?.trim();
	if (!home || !isAbsolute(home)) {
		throw new StudyWindowsRunnerError(
			"PYTHON_VENV_CONFIG_INVALID",
			"pyvenv.cfg has no absolute base interpreter home.",
		);
	}
	const baseRoot = resolve(home);
	const baseExecutable = join(baseRoot, "python.exe");
	const sitePackages = join(venvRoot, "Lib", "site-packages");
	const expectedFiles = new Set(
		environment.files.map((file) => resolveExistingFile(file.absolutePath, "environment file")),
	);
	if (
		!expectedFiles.has(venvExecutable) ||
		!expectedFiles.has(resolveExistingFile(pyvenvConfig, "pyvenv.cfg")) ||
		!expectedFiles.has(resolveExistingFile(baseExecutable, "base Python executable"))
	) {
		throw new StudyWindowsRunnerError(
			"PYTHON_VENV_INVENTORY_INCOMPLETE",
			"Python environment does not bind its venv, config, and base interpreter bytes.",
		);
	}
	const destinationBase = join(runtimeDirectory, "python-base");
	const destinationVenv = join(runtimeDirectory, "python-venv");
	const files: string[] = [];
	for (const sourcePath of [...expectedFiles].sort()) {
		let destination: string;
		if (isWithinPath(baseRoot, sourcePath)) {
			destination = join(destinationBase, relative(baseRoot, sourcePath));
		} else if (
			sameWindowsPath(sourcePath, venvExecutable) ||
			sameWindowsPath(sourcePath, pyvenvConfig) ||
			isWithinPath(sitePackages, sourcePath)
		) {
			destination = join(destinationVenv, relative(venvRoot, sourcePath));
		} else {
			throw new StudyWindowsRunnerError(
				"PYTHON_VENV_INVENTORY_INVALID",
				`Python environment file is not a base-runtime or selected-site-packages file: ${sourcePath}`,
			);
		}
		files.push(await copyDeclaredFile(sourcePath, destination));
	}
	await mkdir(join(destinationVenv, "Lib", "site-packages"), { recursive: true });
	return {
		executablePath: join(destinationBase, "python.exe"),
		runtimeBinDirectory: destinationBase,
		runtimeEnvironmentRoot: destinationBase,
		pythonSitePackagesDirectory: join(destinationVenv, "Lib", "site-packages"),
		pythonLibraryBinDirectory: join(destinationBase, "Library", "bin"),
		environmentAdapterKind: environment.adapterKind,
		environmentDescriptorHash: environment.descriptorHash,
		files,
	};
}

async function snapshotDeclaredRRuntime(
	environment: StudyExecutionEnvironment,
	runtimeDirectory: string,
	runRootDirectory: string,
): Promise<PreparedRuntime> {
	const sourceExecutable = resolveExistingFile(environment.executablePath, "Rscript executable");
	const sourceRoot = await findRRuntimeRoot(sourceExecutable);
	const sourceFiles = environment.files.map((file) => resolveExistingFile(file.absolutePath, "environment file"));
	if (!sourceFiles.some((path) => sameWindowsPath(path, sourceExecutable))) {
		throw new StudyWindowsRunnerError(
			"R_ENVIRONMENT_EXECUTABLE_UNBOUND",
			"R environment does not bind its Rscript bytes.",
		);
	}
	const externalPackageRoots = sourceFiles
		.filter((path) => !isWithinPath(sourceRoot, path) && basename(path).toLowerCase() === "description")
		.map((path) => dirname(path))
		.sort();
	for (const sourcePath of sourceFiles) {
		if (isWithinPath(sourceRoot, sourcePath)) continue;
		if (!externalPackageRoots.some((packageRoot) => isWithinPath(packageRoot, sourcePath))) {
			throw new StudyWindowsRunnerError(
				"R_ENVIRONMENT_INVENTORY_INVALID",
				`R external environment file is outside a selected package directory: ${sourcePath}`,
			);
		}
	}
	const destinationRoot = join(runtimeDirectory, "R");
	const libraryRoots = [...new Set(externalPackageRoots.map((root) => dirname(root)))].sort();
	const destinationLibraries = libraryRoots.map((_, index) => join(runtimeDirectory, "R-libraries", String(index)));
	const files: string[] = [];
	for (const sourcePath of sourceFiles.sort()) {
		let destination: string;
		if (isWithinPath(sourceRoot, sourcePath)) {
			destination = join(destinationRoot, relative(sourceRoot, sourcePath));
		} else {
			const libraryIndex = libraryRoots.findIndex((root) => isWithinPath(root, sourcePath));
			if (libraryIndex < 0)
				throw new StudyWindowsRunnerError("R_ENVIRONMENT_INVENTORY_INVALID", "R library root is unbound.");
			destination = join(destinationLibraries[libraryIndex], relative(libraryRoots[libraryIndex], sourcePath));
		}
		files.push(await copyDeclaredFile(sourcePath, destination));
	}
	const adapterPath = await compileRCompatibilityAdapter(runRootDirectory);
	const snapshotAdapter = join(destinationRoot, "bin", "x64", "study-r-appcontainer-launcher.exe");
	const snapshotRDll = join(destinationRoot, "bin", "x64", "R.dll");
	await stat(snapshotRDll);
	await copyFile(adapterPath, snapshotAdapter);
	files.push(snapshotAdapter);
	return {
		executablePath: snapshotAdapter,
		runtimeBinDirectory: dirname(snapshotAdapter),
		runtimeEnvironmentRoot: destinationRoot,
		compatibilityAdapterPath: snapshotAdapter,
		compatibilityAdapterHash: await sha256File(snapshotAdapter),
		compatibilityRDllPath: snapshotRDll,
		compatibilityRDllHash: await sha256File(snapshotRDll),
		rLibraryDirectories: destinationLibraries,
		environmentAdapterKind: environment.adapterKind,
		environmentDescriptorHash: environment.descriptorHash,
		files,
	};
}

async function copyDeclaredFile(sourcePath: string, destinationPath: string): Promise<string> {
	if (!isWithinPath(dirname(destinationPath), destinationPath)) {
		throw new StudyWindowsRunnerError(
			"ENVIRONMENT_DESTINATION_INVALID",
			`Environment destination is invalid: ${destinationPath}`,
		);
	}
	await mkdir(dirname(destinationPath), { recursive: true });
	await copyFile(sourcePath, destinationPath);
	return destinationPath;
}

async function findRRuntimeRoot(executablePath: string): Promise<string> {
	let current = dirname(executablePath);
	for (let index = 0; index < 5; index += 1) {
		const library = await stat(join(current, "library")).catch(() => null);
		const bin = await stat(join(current, "bin")).catch(() => null);
		if (library?.isDirectory() && bin?.isDirectory()) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new StudyWindowsRunnerError("R_HOME_UNRESOLVED", `Could not derive R_HOME from ${executablePath}.`);
}

function isWithinPath(root: string, candidate: string): boolean {
	const value = relative(resolve(root), resolve(candidate));
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function sameWindowsPath(left: string, right: string): boolean {
	return resolve(left).replace(/\\/gu, "/").toLowerCase() === resolve(right).replace(/\\/gu, "/").toLowerCase();
}

async function compileRCompatibilityAdapter(runRootDirectory: string): Promise<string> {
	const sourcePath = fileURLToPath(new URL("./r-appcontainer-launcher.c", import.meta.url));
	const helperDirectory = join(runRootDirectory, "r-compat-helper");
	const helperPath = join(helperDirectory, "study-r-appcontainer-launcher.exe");
	await mkdir(helperDirectory, { recursive: true });
	const source = await stat(sourcePath);
	const helper = await stat(helperPath).catch(() => null);
	if (helper && helper.mtimeMs >= source.mtimeMs) return helperPath;
	const compiler = await stat(RTOOLS_GCC_PATH).catch(() => null);
	if (!compiler) {
		throw new StudyWindowsRunnerError(
			"R_COMPAT_COMPILER_UNAVAILABLE",
			`Expected Rtools GCC was not found at ${RTOOLS_GCC_PATH}.`,
		);
	}
	const compile = spawnSync(
		RTOOLS_GCC_PATH,
		["-std=c11", "-Wall", "-Wextra", "-Werror", "-municode", "-O2", "-o", helperPath, sourcePath],
		{
			encoding: "utf8",
			stdio: "pipe",
			windowsHide: true,
			timeout: 30_000,
			env: { ...process.env, PATH: `${RTOOLS_BIN_DIRECTORY};${process.env.PATH ?? ""}` },
		},
	);
	if (compile.status !== 0) {
		throw new StudyWindowsRunnerError(
			"R_COMPAT_COMPILE_FAILED",
			String(
				compile.stderr || compile.stdout || compile.error?.message || "R compatibility launcher compilation failed",
			).trim(),
		);
	}
	return helperPath;
}

async function snapshotInput(sourcePath: string, inputDirectory: string, name: string): Promise<string> {
	const source = resolveExistingFile(sourcePath, name);
	const sourceStat = await stat(source);
	if (sourceStat.size > MAX_INPUT_SNAPSHOT_BYTES) {
		throw new StudyWindowsRunnerError(
			"INPUT_SNAPSHOT_TOO_LARGE",
			`${name} exceeds the ${MAX_INPUT_SNAPSHOT_BYTES}-byte input limit.`,
		);
	}
	const destination = join(inputDirectory, `${name}${extensionOf(source)}`);
	await copyFile(source, destination);
	return destination;
}

async function copyTreeBounded(
	sourceDirectory: string,
	destinationDirectory: string,
	maximumBytes: number,
	excludedTopLevelDirectories: readonly string[] = [],
): Promise<string[]> {
	let copiedBytes = 0;
	const entries = await collectFiles(sourceDirectory, new Set(excludedTopLevelDirectories));
	const destinations: string[] = [];
	for (const sourcePath of entries) {
		const file = await stat(sourcePath);
		copiedBytes += file.size;
		if (copiedBytes > maximumBytes) {
			throw new StudyWindowsRunnerError(
				"RUNTIME_SNAPSHOT_TOO_LARGE",
				`${sourceDirectory} exceeds the ${maximumBytes}-byte runtime snapshot limit.`,
			);
		}
		const destinationPath = join(destinationDirectory, relative(sourceDirectory, sourcePath));
		await mkdir(dirname(destinationPath), { recursive: true });
		await copyFile(sourcePath, destinationPath);
		destinations.push(destinationPath);
	}
	return destinations;
}

async function assertRuntimeSnapshotBound(paths: readonly string[]): Promise<void> {
	let bytes = 0;
	for (const path of paths) {
		bytes += (await stat(path)).size;
		if (bytes > MAX_RUNTIME_SNAPSHOT_BYTES) {
			throw new StudyWindowsRunnerError(
				"RUNTIME_SNAPSHOT_TOO_LARGE",
				`Runtime snapshot exceeds the ${MAX_RUNTIME_SNAPSHOT_BYTES}-byte limit.`,
			);
		}
	}
}

async function collectFiles(
	directory: string,
	excludedTopLevelDirectories: ReadonlySet<string>,
	rootDirectory = directory,
): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new StudyWindowsRunnerError(
				"RUNTIME_REPARSE_POINT_REJECTED",
				`Runtime snapshot rejects reparse point ${path}.`,
			);
		}
		if (entry.isDirectory() && directory === rootDirectory && excludedTopLevelDirectories.has(entry.name)) continue;
		if (entry.isDirectory()) files.push(...(await collectFiles(path, excludedTopLevelDirectories, rootDirectory)));
		else if (entry.isFile()) files.push(path);
		else throw new StudyWindowsRunnerError("RUNTIME_ENTRY_REJECTED", `Runtime snapshot rejects ${path}.`);
	}
	return files;
}

async function fileDigests(paths: string[]): Promise<FileDigest[]> {
	return Promise.all(paths.sort().map(async (path) => ({ path, sha256: await sha256File(path) })));
}

async function waitForStatus(
	controlDirectory: string,
	runId: string,
	configBindingHash: string,
	timeoutMs: number,
): Promise<IsolatedWindowsRunStatus> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "status receipt was not created";
	while (Date.now() < deadline) {
		try {
			const receipt = JSON.parse(await readFile(join(controlDirectory, "status.json"), "utf8")) as unknown;
			const status = parseReceipt(receipt, runId, configBindingHash);
			if (status) return status;
			lastError = "status receipt did not match the requested run";
		} catch (error) {
			lastError = errorMessage(error);
		}
		await pause(25);
	}
	throw new StudyWindowsRunnerError("RUNNER_STATUS_UNAVAILABLE", lastError);
}

async function waitForTerminalStatus(
	controlDirectory: string,
	runId: string,
	configBindingHash: string,
	timeoutMs: number,
): Promise<IsolatedWindowsRunStatus> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await waitForStatus(controlDirectory, runId, configBindingHash, 250);
		if (status.status !== "launching" && status.status !== "running") return status;
		await pause(25);
	}
	throw new StudyWindowsRunnerError("RUNNER_TERMINAL_TIMEOUT", "Runner did not publish a terminal receipt.");
}

function parseReceipt(value: unknown, runId: string, configBindingHash: string): IsolatedWindowsRunStatus | null {
	if (
		!isRecord(value) ||
		value.Version !== 1 ||
		value.RunId !== runId ||
		value.ConfigBindingHash !== configBindingHash
	)
		return null;
	if (!isRunStatus(value.Status)) return null;
	return {
		version: 1,
		runId,
		status: value.Status,
		configBindingHash,
		processId: typeof value.ProcessId === "number" ? value.ProcessId : 0,
		processCreationFileTime: typeof value.ProcessCreationFileTime === "string" ? value.ProcessCreationFileTime : null,
		exitCode: typeof value.ExitCode === "number" ? value.ExitCode : null,
		error: typeof value.Error === "string" ? value.Error : null,
		appContainerCleanup: typeof value.AppContainerCleanup === "string" ? value.AppContainerCleanup : null,
		stdoutBytes: typeof value.StdoutBytes === "number" ? value.StdoutBytes : 0,
		stderrBytes: typeof value.StderrBytes === "number" ? value.StderrBytes : 0,
		stdoutTruncated: value.StdoutTruncated === true,
		stderrTruncated: value.StderrTruncated === true,
		outputBytes: typeof value.OutputBytes === "number" ? value.OutputBytes : 0,
		outputFiles: typeof value.OutputFiles === "number" ? value.OutputFiles : 0,
		wallTimeMs: typeof value.WallTimeMs === "number" && value.WallTimeMs >= 0 ? value.WallTimeMs : 0,
		rootExitDiagnostics: parseRootExitDiagnostics(value.RootExitDiagnostics),
		preparedCleanup: isPreparedRunCleanup(value.PreparedCleanup) ? value.PreparedCleanup : null,
	};
}

function parseRootExitDiagnostics(value: unknown): IsolatedWindowsRootExitObservation[] {
	if (!Array.isArray(value)) return [];
	const observations: IsolatedWindowsRootExitObservation[] = [];
	for (const item of value) {
		if (!isRecord(item) || !Array.isArray(item.JobMembers) || !Array.isArray(item.ToolhelpCandidates)) return [];
		if (
			typeof item.ObservedAt !== "string" ||
			!isNonNegativeSafeInteger(item.RootProcessId) ||
			!isNonNegativeSafeInteger(item.TotalProcesses) ||
			!isNonNegativeSafeInteger(item.ActiveProcesses) ||
			!isNonNegativeSafeInteger(item.TotalTerminatedProcesses) ||
			(item.DiagnosticError !== null &&
				item.DiagnosticError !== undefined &&
				typeof item.DiagnosticError !== "string")
		)
			return [];
		const jobMembers: IsolatedWindowsRootExitJobMember[] = [];
		for (const member of item.JobMembers) {
			if (
				!isRecord(member) ||
				!isNonNegativeSafeInteger(member.ProcessId) ||
				typeof member.IsRoot !== "boolean" ||
				!isNonNegativeSafeInteger(member.ParentProcessId) ||
				(member.ImageName !== null && member.ImageName !== undefined && typeof member.ImageName !== "string") ||
				(member.CreationFileTime !== null &&
					member.CreationFileTime !== undefined &&
					typeof member.CreationFileTime !== "string") ||
				(member.Liveness !== "alive" &&
					member.Liveness !== "exited" &&
					member.Liveness !== "exited-root-signaled" &&
					member.Liveness !== "uninspectable") ||
				(member.InspectionError !== null &&
					member.InspectionError !== undefined &&
					typeof member.InspectionError !== "string")
			)
				return [];
			jobMembers.push({
				processId: member.ProcessId,
				isRoot: member.IsRoot,
				parentProcessId: member.ParentProcessId,
				imageName: typeof member.ImageName === "string" ? member.ImageName : null,
				creationFileTime: typeof member.CreationFileTime === "string" ? member.CreationFileTime : null,
				liveness: member.Liveness,
				inspectionError: typeof member.InspectionError === "string" ? member.InspectionError : null,
			});
		}
		const toolhelpCandidates: IsolatedWindowsRootExitToolhelpCandidate[] = [];
		for (const candidate of item.ToolhelpCandidates) {
			if (
				!isRecord(candidate) ||
				!isNonNegativeSafeInteger(candidate.ProcessId) ||
				typeof candidate.IsRoot !== "boolean" ||
				!isNonNegativeSafeInteger(candidate.ParentProcessId) ||
				(candidate.ImageName !== null &&
					candidate.ImageName !== undefined &&
					typeof candidate.ImageName !== "string") ||
				(candidate.CreationFileTime !== null &&
					candidate.CreationFileTime !== undefined &&
					typeof candidate.CreationFileTime !== "string") ||
				(candidate.Liveness !== "alive" &&
					candidate.Liveness !== "exited" &&
					candidate.Liveness !== "uninspectable") ||
				typeof candidate.AcceptedAsDescendant !== "boolean" ||
				(candidate.RejectionReason !== null &&
					candidate.RejectionReason !== undefined &&
					typeof candidate.RejectionReason !== "string") ||
				(candidate.InspectionError !== null &&
					candidate.InspectionError !== undefined &&
					typeof candidate.InspectionError !== "string")
			)
				return [];
			toolhelpCandidates.push({
				processId: candidate.ProcessId,
				isRoot: candidate.IsRoot,
				parentProcessId: candidate.ParentProcessId,
				imageName: typeof candidate.ImageName === "string" ? candidate.ImageName : null,
				creationFileTime: typeof candidate.CreationFileTime === "string" ? candidate.CreationFileTime : null,
				liveness: candidate.Liveness,
				acceptedAsDescendant: candidate.AcceptedAsDescendant,
				rejectionReason: typeof candidate.RejectionReason === "string" ? candidate.RejectionReason : null,
				inspectionError: typeof candidate.InspectionError === "string" ? candidate.InspectionError : null,
			});
		}
		if (typeof item.HasLiveToolhelpDescendant !== "boolean") return [];
		observations.push({
			observedAt: item.ObservedAt,
			rootProcessId: item.RootProcessId,
			totalProcesses: item.TotalProcesses,
			activeProcesses: item.ActiveProcesses,
			totalTerminatedProcesses: item.TotalTerminatedProcesses,
			jobMembers,
			toolhelpCandidates,
			hasLiveToolhelpDescendant: item.HasLiveToolhelpDescendant,
			diagnosticError: typeof item.DiagnosticError === "string" ? item.DiagnosticError : null,
		});
	}
	return observations;
}

function isPreparedRunCleanup(value: unknown): value is PreparedRunCleanup {
	return (
		isRecord(value) &&
		typeof value.runtimeFiles === "number" &&
		Number.isSafeInteger(value.runtimeFiles) &&
		value.runtimeFiles >= 0 &&
		typeof value.runtimeBytes === "number" &&
		Number.isSafeInteger(value.runtimeBytes) &&
		value.runtimeBytes >= 0 &&
		typeof value.inputFiles === "number" &&
		Number.isSafeInteger(value.inputFiles) &&
		value.inputFiles >= 0 &&
		typeof value.inputBytes === "number" &&
		Number.isSafeInteger(value.inputBytes) &&
		value.inputBytes >= 0
	);
}

function normalizeLimits(limits: Partial<IsolatedWindowsRunLimits> | undefined): IsolatedWindowsRunLimits {
	const normalized = {
		memoryBytes: limits?.memoryBytes ?? 512 * 1024 * 1024,
		cpuRatePercent: limits?.cpuRatePercent ?? 25,
		wallTimeMs: limits?.wallTimeMs ?? 60_000,
		outputLimitBytes: limits?.outputLimitBytes ?? 16 * 1024 * 1024,
	};
	if (
		!Number.isSafeInteger(normalized.memoryBytes) ||
		normalized.memoryBytes < 64 * 1024 * 1024 ||
		normalized.memoryBytes > MAX_MEMORY_BYTES ||
		!Number.isSafeInteger(normalized.cpuRatePercent) ||
		normalized.cpuRatePercent < 1 ||
		normalized.cpuRatePercent > 100 ||
		!Number.isSafeInteger(normalized.wallTimeMs) ||
		normalized.wallTimeMs < 100 ||
		normalized.wallTimeMs > MAX_WALL_TIME_MS ||
		!Number.isSafeInteger(normalized.outputLimitBytes) ||
		normalized.outputLimitBytes < 1024 ||
		normalized.outputLimitBytes > MAX_OUTPUT_LIMIT_BYTES
	) {
		throw new StudyWindowsRunnerError(
			"INVALID_RUN_LIMITS",
			"Run limits are outside the bounded Windows runner range.",
		);
	}
	return normalized;
}

function resolveExistingFile(path: string, name: string): string {
	if (!isAbsolute(path))
		throw new StudyWindowsRunnerError("ABSOLUTE_PATH_REQUIRED", `${name} must be an absolute path.`);
	return resolve(path);
}

function validateHandle(handle: IsolatedWindowsRunHandle): void {
	if (handle.version !== 1 || !handle.configBindingHash) {
		throw new StudyWindowsRunnerError("INVALID_RUN_HANDLE", "Run handle is incomplete.");
	}
	normalizePreparationIdentity({ runId: handle.runId, cancelToken: handle.cancelToken });
	const runDirectory = resolve(handle.runDirectory);
	if (basename(runDirectory) !== `run-${handle.runId}`) {
		throw new StudyWindowsRunnerError("INVALID_RUN_HANDLE", "Run directory does not match its immutable run id.");
	}
	if (!resolve(handle.controlDirectory).startsWith(`${runDirectory}${sep}`)) {
		throw new StudyWindowsRunnerError("INVALID_RUN_HANDLE", "Control directory escapes run directory.");
	}
}

function normalizePreparationIdentity(
	identity: IsolatedWindowsPreparationIdentity | undefined,
): IsolatedWindowsPreparationIdentity {
	const value = identity ?? { runId: randomUUID(), cancelToken: randomUUID() };
	if (
		typeof value.runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value.runId) ||
		typeof value.cancelToken !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{15,511}$/u.test(value.cancelToken)
	) {
		throw new StudyWindowsRunnerError(
			"INVALID_PREPARATION_IDENTITY",
			"Preparation run id and cancellation token must be opaque safe identifiers.",
		);
	}
	return { runId: value.runId, cancelToken: value.cancelToken };
}

function preparationPaths(
	runRootDirectory: string,
	runId: string,
): {
	runDirectory: string;
	controlDirectory: string;
	runtimeDirectory: string;
	inputDirectory: string;
	outputDirectory: string;
} {
	const root = resolve(runRootDirectory);
	const runDirectory = resolve(root, `run-${runId}`);
	if (!isWithinPath(root, runDirectory) || dirname(runDirectory) !== root) {
		throw new StudyWindowsRunnerError("INVALID_PREPARATION_IDENTITY", "Preparation run directory escaped its root.");
	}
	return {
		runDirectory,
		controlDirectory: join(runDirectory, "control"),
		runtimeDirectory: join(runDirectory, "runtime"),
		inputDirectory: join(runDirectory, "input"),
		outputDirectory: join(runDirectory, "output"),
	};
}

async function completeHandleFromDirectory(
	locator: IsolatedWindowsPreparedRunLocator,
	helperPath: string,
): Promise<IsolatedWindowsRunHandle | null> {
	const preparationIdentity = normalizePreparationIdentity(locator.preparationIdentity);
	const paths = preparationPaths(resolve(locator.runRootDirectory), preparationIdentity.runId);
	const journal = await readPreparationJournal(paths.controlDirectory);
	assertJournalIdentity(journal, preparationIdentity);
	if (journal.state !== "prepared") return null;
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(join(paths.controlDirectory, "config.json"), "utf8")) as unknown;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw new StudyWindowsRunnerError("PREPARED_RUN_CONFIG_INVALID", errorMessage(error));
	}
	if (!isRunnerConfig(raw)) {
		throw new StudyWindowsRunnerError("PREPARED_RUN_CONFIG_INVALID", "Prepared runner configuration is invalid.");
	}
	const handle: IsolatedWindowsRunHandle = {
		version: 1,
		runId: preparationIdentity.runId,
		runDirectory: paths.runDirectory,
		controlDirectory: paths.controlDirectory,
		outputDirectory: paths.outputDirectory,
		helperPath,
		cancelToken: preparationIdentity.cancelToken,
		configBindingHash: raw.ConfigBindingHash,
	};
	await validatePreparedConfig(handle);
	return handle;
}

async function readPreparationJournal(controlDirectory: string): Promise<PreparationJournal> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(controlDirectory, "preparation.json"), "utf8")) as unknown;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			throw new StudyWindowsRunnerError(
				"PREPARATION_JOURNAL_MISSING",
				"Preparation ownership journal is missing; refusing destructive recovery.",
			);
		}
		throw new StudyWindowsRunnerError("PREPARATION_JOURNAL_INVALID", errorMessage(error));
	}
	if (!isPreparationJournal(value)) {
		throw new StudyWindowsRunnerError("PREPARATION_JOURNAL_INVALID", "Preparation ownership journal is invalid.");
	}
	return value;
}

function assertJournalIdentity(journal: PreparationJournal, identity: IsolatedWindowsPreparationIdentity): void {
	if (journal.runId !== identity.runId || journal.cancelTokenHash !== sha256(identity.cancelToken)) {
		throw new StudyWindowsRunnerError(
			"PREPARATION_IDENTITY_MISMATCH",
			"Preparation journal does not belong to the requested durable identity.",
		);
	}
}

function isPreparationJournal(value: unknown): value is PreparationJournal {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.runId === "string" &&
		typeof value.cancelTokenHash === "string" &&
		isSha256(value.cancelTokenHash) &&
		typeof value.ownerPid === "number" &&
		Number.isSafeInteger(value.ownerPid) &&
		value.ownerPid > 0 &&
		typeof value.ownerProcessCreationFileTime === "string" &&
		/^\d+$/u.test(value.ownerProcessCreationFileTime) &&
		(value.state === "materializing" ||
			value.state === "prepared" ||
			value.state === "failed" ||
			value.state === "abandoned")
	);
}

function currentProcessCreationFileTime(): string {
	const value = processCreationFileTime(process.pid);
	if (!value) {
		throw new StudyWindowsRunnerError(
			"PREPARATION_OWNER_IDENTITY_UNAVAILABLE",
			"Could not record the current preparation process creation identity.",
		);
	}
	return value;
}

function journalOwnerIsAlive(journal: PreparationJournal): boolean {
	const value = processCreationFileTime(journal.ownerPid);
	// If Windows refuses process inspection, leave the snapshot untouched. A
	// durable coordinator can retry after the owner is observable or gone.
	return value === null || value === journal.ownerProcessCreationFileTime;
}

function processCreationFileTime(processId: number): string | null {
	if (!Number.isSafeInteger(processId) || processId <= 0) return null;
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$ErrorActionPreference = 'Stop'; [Console]::Write((Get-Process -Id ${processId}).StartTime.ToFileTimeUtc().ToString())`,
		],
		{ encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 5_000 },
	);
	const value = String(result.stdout ?? "").trim();
	return result.status === 0 && /^\d+$/u.test(value) ? value : null;
}

function bindingHash(config: Omit<RunnerConfig, "ConfigBindingHash">): string {
	const fields = [
		config.RunId,
		config.Language,
		config.RunDirectory,
		config.ControlDirectory,
		config.RuntimeDirectory,
		config.RuntimeBinDirectory,
		config.RuntimeEnvironmentRoot,
		config.InputDirectory,
		config.OutputDirectory,
		config.ExecutablePath,
		config.ProgramPath,
		String(config.MemoryBytes),
		String(config.CpuRatePercent),
		String(config.WallTimeMs),
		String(config.OutputLimitBytes),
		config.CancelTokenHash,
		config.CompatibilityAdapterPath ?? "",
		config.CompatibilityAdapterHash ?? "",
		config.CompatibilityRDllPath ?? "",
		config.CompatibilityRDllHash ?? "",
		config.EnvironmentAdapterKind ?? "",
		config.EnvironmentDescriptorHash ?? "",
		config.PythonSitePackagesDirectory ?? "",
		config.PythonLibraryBinDirectory ?? "",
		...(config.RLibraryDirectories ?? []),
		...config.Files.flatMap((file) => [file.path, file.sha256]),
	];
	return sha256(fields.join("|"));
}

function extensionOf(path: string): string {
	const filename = path.slice(path.lastIndexOf(sep) + 1);
	const dot = filename.lastIndexOf(".");
	return dot > 0 ? filename.slice(dot) : "";
}

async function sha256File(path: string): Promise<string> {
	const file = await open(path, "r");
	try {
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		while (true) {
			const read = await file.read(buffer, 0, buffer.length, position);
			if (read.bytesRead === 0) break;
			hash.update(buffer.subarray(0, read.bytesRead));
			position += read.bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(value: unknown, code: string): boolean {
	return isRecord(value) && value.code === code;
}

function isRunStatus(value: unknown): value is IsolatedWindowsRunStatus["status"] {
	return (
		value === "launching" ||
		value === "running" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "limit-reached"
	);
}

function isRunnerConfig(value: unknown): value is RunnerConfig {
	if (!isRecord(value) || value.Version !== 1 || !isIsolatedWindowsLanguage(value.Language)) return false;
	const stringFields = [
		"RunId",
		"RunDirectory",
		"ControlDirectory",
		"RuntimeDirectory",
		"RuntimeBinDirectory",
		"RuntimeEnvironmentRoot",
		"InputDirectory",
		"OutputDirectory",
		"ExecutablePath",
		"ProgramPath",
		"CancelTokenHash",
		"ConfigBindingHash",
	] as const;
	if (stringFields.some((field) => typeof value[field] !== "string" || value[field].length === 0)) return false;
	const hashFields = ["CancelTokenHash", "ConfigBindingHash"] as const;
	if (hashFields.some((field) => !isSha256(value[field]))) return false;
	if (
		!isBoundedInteger(value.MemoryBytes, 64 * 1024 * 1024, MAX_MEMORY_BYTES) ||
		!isBoundedInteger(value.CpuRatePercent, 1, 100) ||
		!isBoundedInteger(value.WallTimeMs, 100, MAX_WALL_TIME_MS) ||
		!isBoundedInteger(value.OutputLimitBytes, 1024, MAX_OUTPUT_LIMIT_BYTES) ||
		!Array.isArray(value.Files) ||
		value.Files.length === 0
	)
		return false;
	if (!value.Files.every(isFileDigest)) return false;
	const compatibilityFields = [
		"CompatibilityAdapterPath",
		"CompatibilityAdapterHash",
		"CompatibilityRDllPath",
		"CompatibilityRDllHash",
	] as const;
	const environmentFields = [
		"EnvironmentAdapterKind",
		"EnvironmentDescriptorHash",
		"PythonSitePackagesDirectory",
		"PythonLibraryBinDirectory",
	] as const;
	return (
		compatibilityFields.every((field) => value[field] === undefined || typeof value[field] === "string") &&
		environmentFields.every((field) => value[field] === undefined || typeof value[field] === "string") &&
		(value.RLibraryDirectories === undefined ||
			(Array.isArray(value.RLibraryDirectories) &&
				value.RLibraryDirectories.every((directory) => typeof directory === "string" && isAbsolute(directory))))
	);
}

function isIsolatedWindowsLanguage(value: unknown): value is IsolatedWindowsLanguage {
	return value === "node" || value === "python" || value === "rscript";
}

function isFileDigest(value: unknown): value is FileDigest {
	return isRecord(value) && typeof value.path === "string" && isAbsolute(value.path) && isSha256(value.sha256);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pause(milliseconds: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
