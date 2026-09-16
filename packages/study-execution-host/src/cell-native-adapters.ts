import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { cpus } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compileStudyCellProgram } from "./cell-program.ts";
import type {
	CoordinatorAdapterObservation,
	CoordinatorAdapterPreparation,
	StudyExecutionAdapter,
} from "./coordinator.ts";
import {
	PYTHON_PROJECT_VENV_ADAPTER,
	R_GLOBAL_LIBRARY_ADAPTER,
	verifyStudyExecutionEnvironment,
} from "./environments.ts";
import { decodeFrozenInput, executionSha256 } from "./execution-payloads.ts";
import type { PreparedExecutionHandle } from "./execution-queue.ts";
import {
	abandonIsolatedWindowsPreparation,
	abandonPreparedIsolatedWindowsRun,
	cancelIsolatedWindowsRun,
	type IsolatedWindowsPreparationAbandonment,
	type IsolatedWindowsRunHandle,
	type IsolatedWindowsRunStatus,
	launchPreparedIsolatedWindowsRun,
	prepareIsolatedWindowsRun,
	reconcileIsolatedWindowsRun,
} from "./windows-runner.ts";

const CELL_ADAPTER_KINDS = new Set([PYTHON_PROJECT_VENV_ADAPTER, R_GLOBAL_LIBRARY_ADAPTER]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "limit-reached"]);
const MAX_ARTIFACT_FILES = 256;
const MAX_ARTIFACT_BYTES = 64 * 1_024 * 1_024;
const RESERVED_LOG_NAMES = new Set(["stdout.log", "stderr.log"]);

export interface NativeWindowsCellAdaptersOptions {
	runRootDirectory: string;
	/** Additional trusted ceiling on the Windows Job percentage after queue milli-core conversion. */
	cpuRatePercent: number;
	/** Test-only staging mutation seam; snapshot binding must reject any mutation it performs. */
	afterMaterializeForTesting?: (input: {
		stagingDirectory: string;
		programFileName: string;
		inputFileNames: readonly string[];
	}) => Promise<void>;
	/** Test-only seam for replacing staged files after the runner has copied them. */
	beforeStagingCleanupForTesting?: (input: { stagingDirectory: string }) => Promise<void>;
}

export interface NativeCellOutputArtifactDescriptor {
	path: string;
	bytes: number;
	sha256: string;
	mediaType: string;
	contentDisposition: "inline" | "attachment";
}

export interface NativeCellOutputArtifact {
	descriptor: NativeCellOutputArtifactDescriptor;
	bytes: Uint8Array;
}

/**
 * A queue-private identity allocated before asynchronous preparation. It is the only
 * durable input used to choose a native runner directory and cancellation capability.
 */
export interface NativeCellPreparationIdentity {
	runId: string;
	cancelToken: string;
	runRootDirectory: string;
}

/** An intent-capable adapter; the base coordinator interface remains source-compatible. */
export interface NativeWindowsCellAdapter extends StudyExecutionAdapter {
	createPreparationIntent(input: CoordinatorAdapterPreparation): PreparedExecutionHandle;
	prepare(input: CoordinatorAdapterPreparation, intent?: PreparedExecutionHandle): Promise<PreparedExecutionHandle>;
	abandonPreparation(intent: PreparedExecutionHandle): Promise<CoordinatorAdapterObservation>;
}

export class NativeCellAdapterError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "NativeCellAdapterError";
		this.code = code;
	}
}

/**
 * Creates the two frozen-environment cell adapters. They intentionally have no ambient-runtime
 * fallback: adapter kind, language, executable, inventory and runner snapshot must all agree.
 */
export function createNativeWindowsCellAdapters(
	options: NativeWindowsCellAdaptersOptions,
): readonly NativeWindowsCellAdapter[] {
	const runRootDirectory = requiredDirectory(options.runRootDirectory, "runRootDirectory");
	if (!Number.isSafeInteger(options.cpuRatePercent) || options.cpuRatePercent < 1 || options.cpuRatePercent > 100) {
		throw new NativeCellAdapterError(
			"CELL_ADAPTER_CONFIG_INVALID",
			"cpuRatePercent must be an integer from 1 through 100",
		);
	}
	return [
		createCellAdapter({
			kind: PYTHON_PROJECT_VENV_ADAPTER,
			payloadLanguage: "python",
			runnerLanguage: "python",
			compilerLanguage: "python",
			runRootDirectory,
			cpuRatePercent: options.cpuRatePercent,
			afterMaterializeForTesting: options.afterMaterializeForTesting,
			beforeStagingCleanupForTesting: options.beforeStagingCleanupForTesting,
		}),
		createCellAdapter({
			kind: R_GLOBAL_LIBRARY_ADAPTER,
			payloadLanguage: "rscript",
			runnerLanguage: "rscript",
			compilerLanguage: "r",
			runRootDirectory,
			cpuRatePercent: options.cpuRatePercent,
			afterMaterializeForTesting: options.afterMaterializeForTesting,
			beforeStagingCleanupForTesting: options.beforeStagingCleanupForTesting,
		}),
	];
}

/**
 * Lists only relative, hash-addressed output metadata for a queue-private prepared handle.
 * A product API still needs Host authorization before it can obtain that private handle or bytes.
 */
export async function describeNativeCellOutputArtifacts(
	handle: PreparedExecutionHandle,
): Promise<readonly NativeCellOutputArtifactDescriptor[]> {
	const runner = cellRunnerHandle(handle);
	await assertTerminalOutputQuiescent(runner);
	return scanOutputArtifacts(runner);
}

/** Reads exactly one descriptor returned by describeNativeCellOutputArtifacts; arbitrary paths are never accepted. */
export async function readNativeCellOutputArtifact(
	handle: PreparedExecutionHandle,
	descriptor: NativeCellOutputArtifactDescriptor,
): Promise<NativeCellOutputArtifact> {
	const runner = cellRunnerHandle(handle);
	await assertTerminalOutputQuiescent(runner);
	if (!isPlainRecord(descriptor)) {
		throw new NativeCellAdapterError(
			"ARTIFACT_DESCRIPTOR_REJECTED",
			"artifact reads require a descriptor returned by the trusted list operation",
		);
	}
	const listed = await scanOutputArtifacts(runner);
	const expected = listed.find(
		(item) =>
			item.path === descriptor.path &&
			item.bytes === descriptor.bytes &&
			item.sha256 === descriptor.sha256 &&
			item.mediaType === descriptor.mediaType &&
			item.contentDisposition === descriptor.contentDisposition,
	);
	if (!expected) {
		throw new NativeCellAdapterError(
			"ARTIFACT_DESCRIPTOR_REJECTED",
			"artifact descriptor is stale, forged, or not readable",
		);
	}
	const bytes = await readExactArtifactBytes(runner, expected);
	return { descriptor: expected, bytes };
}

interface CellAdapterConfiguration {
	kind: string;
	payloadLanguage: "python" | "rscript";
	runnerLanguage: "python" | "rscript";
	compilerLanguage: "python" | "r";
	runRootDirectory: string;
	cpuRatePercent: number;
	afterMaterializeForTesting?: NativeWindowsCellAdaptersOptions["afterMaterializeForTesting"];
	beforeStagingCleanupForTesting?: NativeWindowsCellAdaptersOptions["beforeStagingCleanupForTesting"];
}

function createCellAdapter(configuration: CellAdapterConfiguration): NativeWindowsCellAdapter {
	return {
		kind: configuration.kind,
		createPreparationIntent(input) {
			assertCellPayload(input, configuration);
			return {
				kind: configuration.kind,
				version: 1,
				privateHandle: {
					preparationIdentity: {
						runId: randomUUID(),
						cancelToken: randomUUID(),
						runRootDirectory: configuration.runRootDirectory,
					},
				},
				publicSummary: { language: input.payload.language, preparationPending: true },
			};
		},
		async prepare(input, intent) {
			assertCellPayload(input, configuration);
			const preparationIdentity = intent ? cellPreparationIdentity(intent, configuration) : undefined;
			const environment = input.payload.environment;
			await verifyStudyExecutionEnvironment(environment);
			const cpuBinding = cellCpuBinding(input.job.resources.cpuMilliCores, configuration.cpuRatePercent);
			const compiled = compileFrozenCell(input, configuration);
			let staging: StagedCellPayload | null = null;
			let runner: IsolatedWindowsRunHandle | null = null;
			let prepared: PreparedExecutionHandle | null = null;
			let preparationFailure: unknown = null;
			let runnerAbandoned = false;
			try {
				const materializedStaging = await materializeCompiledCell({
					input,
					programFileName: compiled.fileName,
					compiledProgram: compiled.program,
					runRootDirectory: configuration.runRootDirectory,
					stagingIdentity: preparationIdentity?.runId ?? randomUUID(),
				});
				staging = materializedStaging;
				await configuration.afterMaterializeForTesting?.({
					stagingDirectory: materializedStaging.directory,
					programFileName: compiled.fileName,
					inputFileNames: input.payload.inputs.map((frozenInput, index) => inputFileName(frozenInput.name, index)),
				});
				runner = await prepareIsolatedWindowsRun({
					runRootDirectory: configuration.runRootDirectory,
					language: configuration.runnerLanguage,
					executablePath: environment.executablePath,
					programPath: join(materializedStaging.directory, compiled.fileName),
					inputPaths: input.payload.inputs.map((item, index) =>
						join(materializedStaging.directory, inputFileName(item.name, index)),
					),
					environment,
					...(preparationIdentity
						? {
								preparationIdentity: {
									runId: preparationIdentity.runId,
									cancelToken: preparationIdentity.cancelToken,
								},
							}
						: {}),
					limits: {
						memoryBytes: input.job.resources.memoryMiB * 1_024 * 1_024,
						cpuRatePercent: cpuBinding.actualCpuRatePercent,
						wallTimeMs: input.job.resources.wallTimeMs,
						outputLimitBytes: input.payload.outputLimitBytes,
					},
				});
				if (
					preparationIdentity &&
					(runner.runId !== preparationIdentity.runId || runner.cancelToken !== preparationIdentity.cancelToken)
				) {
					throw new NativeCellAdapterError(
						"CELL_PREPARATION_IDENTITY_MISMATCH",
						"runner did not preserve the queue-persisted native preparation identity",
					);
				}
				await verifyStudyExecutionEnvironment(environment);
				await verifyPreparedCellSnapshot(runner, input, compiled);
				prepared = {
					kind: configuration.kind,
					version: 1,
					privateHandle: {
						runner,
						...(preparationIdentity ? { preparationIdentity } : {}),
						payloadHash: input.payloadHash,
						compiledProgramHash: compiled.compiledProgramHash,
						compiledProgramProtocol: compiled.protocol,
						environmentDescriptorHash: environment.descriptorHash,
						cpuBinding,
					},
					publicSummary: {
						runId: runner.runId,
						language: input.payload.language,
						payloadHash: input.payloadHash,
						compiledProgramHash: compiled.compiledProgramHash,
						environmentDescriptorHash: environment.descriptorHash,
						cpuBinding,
					},
				};
			} catch (error) {
				preparationFailure = error;
				if (runner) {
					try {
						await abandonPreparedIsolatedWindowsRun(runner);
						runnerAbandoned = true;
					} catch (cleanupError) {
						preparationFailure = preparedRunnerCleanupFailure(error, cleanupError);
					}
				}
			}
			if (staging) {
				let cleanupTriggerFailure: unknown = null;
				try {
					await configuration.beforeStagingCleanupForTesting?.({ stagingDirectory: staging.directory });
				} catch (error) {
					cleanupTriggerFailure = error;
				}
				let cleanupFailure: unknown = null;
				try {
					await cleanupMaterializedCell(staging);
				} catch (error) {
					cleanupFailure = error;
				}
				if (cleanupTriggerFailure || cleanupFailure) {
					let runnerAbandonmentFailure: unknown = null;
					if (runner && !runnerAbandoned) {
						try {
							await abandonPreparedIsolatedWindowsRun(runner);
							runnerAbandoned = true;
						} catch (error) {
							runnerAbandonmentFailure = error;
						}
					}
					throw stagedCellCleanupFailure({
						staging,
						preparationFailure,
						cleanupTriggerFailure,
						cleanupFailure,
						runnerWasAbandoned: runnerAbandoned,
						runnerAbandonmentFailure,
					});
				}
			}
			if (preparationFailure) throw preparationFailure;
			if (!prepared) {
				throw new NativeCellAdapterError(
					"CELL_PREPARATION_INVALID",
					"native cell preparation completed without a prepared runner handle",
				);
			}
			return prepared;
		},
		async abandonPreparation(intent) {
			const preparationIdentity = cellPreparationIdentity(intent, configuration);
			return observePreparationAbandonment(
				await abandonIsolatedWindowsPreparation({
					runRootDirectory: preparationIdentity.runRootDirectory,
					preparationIdentity: {
						runId: preparationIdentity.runId,
						cancelToken: preparationIdentity.cancelToken,
					},
				}),
			);
		},
		async launch(handle) {
			const runner = cellRunnerHandle(handle);
			return observeNativeCellStatus(await launchPreparedIsolatedWindowsRun(runner), runner);
		},
		async poll(handle) {
			const runner = cellRunnerHandle(handle);
			return observeNativeCellStatus(await reconcileIsolatedWindowsRun(runner), runner);
		},
		async cancel(handle) {
			const runner = cellRunnerHandle(handle);
			return observeNativeCellStatus(await cancelIsolatedWindowsRun(runner), runner);
		},
		async abandonPrepared(handle) {
			const runner = cellRunnerHandle(handle);
			return observeNativeCellStatus(await abandonPreparedIsolatedWindowsRun(runner), runner);
		},
	};
}

function assertCellPayload(input: CoordinatorAdapterPreparation, configuration: CellAdapterConfiguration): void {
	const { payload } = input;
	if (payload.language !== configuration.payloadLanguage || payload.environment.adapterKind !== configuration.kind) {
		throw new NativeCellAdapterError(
			"CELL_ADAPTER_PAYLOAD_MISMATCH",
			`adapter ${configuration.kind} cannot execute ${payload.language}/${payload.environment.adapterKind}`,
		);
	}
	if (!CELL_ADAPTER_KINDS.has(payload.environment.adapterKind)) {
		throw new NativeCellAdapterError(
			"CELL_ADAPTER_PAYLOAD_MISMATCH",
			"payload does not name a supported native cell environment",
		);
	}
}

function compileFrozenCell(input: CoordinatorAdapterPreparation, configuration: CellAdapterConfiguration) {
	let parameters: unknown;
	try {
		parameters = JSON.parse(input.payload.parameters.canonicalJson);
	} catch {
		throw new NativeCellAdapterError("CELL_PARAMETERS_INVALID", "frozen canonical parameters are no longer readable");
	}
	if (!isPlainRecord(parameters)) {
		throw new NativeCellAdapterError("CELL_PARAMETERS_INVALID", "frozen canonical parameters must be an object");
	}
	return compileStudyCellProgram({
		language: configuration.compilerLanguage,
		code: input.payload.program.content,
		parameters,
		inputs: input.payload.inputs.map((item, index) => ({
			name: item.name,
			fileName: inputFileName(item.name, index),
		})),
	});
}

interface StagedCellPayload {
	directory: string;
	canonicalDirectory: string;
	directoryIdentity: Stats;
	canonicalPayloadRoot: string;
	payloadRootIdentity: Stats;
	files: Map<string, Stats>;
	stagingIdentity: string;
}

interface MaterializeCompiledCellInput {
	input: CoordinatorAdapterPreparation;
	programFileName: string;
	compiledProgram: string;
	runRootDirectory: string;
	stagingIdentity: string;
}

async function materializeCompiledCell(input: MaterializeCompiledCellInput): Promise<StagedCellPayload> {
	const queueJobId = privateStagingPathSegment(input.input.job.queueJobId, "queue job id");
	const payloadHash = privateStagingPayloadHash(input.input.payloadHash);
	const stagingIdentity = privateStagingPathSegment(input.stagingIdentity, "staging identity");
	const stagingRoot = join(input.runRootDirectory, "private-cell-payloads");
	const queueRoot = join(stagingRoot, queueJobId);
	const payloadRoot = join(queueRoot, payloadHash);
	const directory = join(payloadRoot, `run-${stagingIdentity}`);
	await mkdir(input.runRootDirectory, { recursive: true });
	const canonicalRunRoot = await canonicalStagingDirectory(input.runRootDirectory, "run root");
	if (resolve(stagingRoot) === resolve(canonicalRunRoot.path) || !isWithin(canonicalRunRoot.path, stagingRoot)) {
		throw new NativeCellAdapterError("CELL_STAGING_REJECTED", "private cell staging path escapes run root");
	}
	await mkdir(payloadRoot, { recursive: true });
	const canonicalPayloadRoot = await canonicalStagingDirectory(payloadRoot, "payload root");
	if (!isWithin(canonicalRunRoot.path, canonicalPayloadRoot.path)) {
		throw new NativeCellAdapterError("CELL_STAGING_REJECTED", "private cell payload root escapes run root");
	}
	try {
		await mkdir(directory);
	} catch (error) {
		if (isNodeError(error, "EEXIST")) {
			throw new NativeCellAdapterError(
				"CELL_STAGING_IDENTITY_BUSY",
				"a private cell staging identity is already materialized and requires fenced recovery",
			);
		}
		throw error;
	}
	let staged: StagedCellPayload | null = null;
	try {
		const canonicalDirectory = await canonicalStagingDirectory(directory, "staging directory");
		if (!isWithin(canonicalPayloadRoot.path, canonicalDirectory.path)) {
			throw new NativeCellAdapterError(
				"CELL_STAGING_REJECTED",
				"private cell staging directory escapes payload root",
			);
		}
		const files = new Map<string, Stats>();
		staged = {
			directory,
			canonicalDirectory: canonicalDirectory.path,
			directoryIdentity: canonicalDirectory.identity,
			canonicalPayloadRoot: canonicalPayloadRoot.path,
			payloadRootIdentity: canonicalPayloadRoot.identity,
			files,
			stagingIdentity,
		};
		await writeStagedCellFile(staged, input.programFileName, input.compiledProgram, "utf8");
		for (const [index, frozenInput] of input.input.payload.inputs.entries()) {
			await writeStagedCellFile(staged, inputFileName(frozenInput.name, index), decodeFrozenInput(frozenInput));
		}
		return staged;
	} catch (error) {
		if (!staged) throw error;
		try {
			await cleanupMaterializedCell(staged);
		} catch (cleanupError) {
			throw stagedCellCleanupFailure({
				staging: staged,
				preparationFailure: error,
				cleanupTriggerFailure: null,
				cleanupFailure: cleanupError,
				runnerWasAbandoned: false,
				runnerAbandonmentFailure: null,
			});
		}
		throw error;
	}
}

async function writeStagedCellFile(
	staging: StagedCellPayload,
	fileName: string,
	contents: string | Uint8Array,
	encoding?: BufferEncoding,
): Promise<void> {
	if (!isDirectStagingFileName(fileName)) {
		throw new NativeCellAdapterError("CELL_STAGING_REJECTED", "staged cell file name is invalid");
	}
	const path = join(staging.directory, fileName);
	const file = await open(path, "wx");
	try {
		let writeFailure: unknown = null;
		try {
			if (encoding) await file.writeFile(contents as string, encoding);
			else await file.writeFile(contents as Uint8Array);
		} catch (error) {
			writeFailure = error;
		}
		const identity = await file.stat();
		if (!identity.isFile()) {
			throw new NativeCellAdapterError("CELL_STAGING_REJECTED", "staged cell entry is not a regular file");
		}
		staging.files.set(fileName, identity);
		if (writeFailure) throw writeFailure;
	} finally {
		await file.close();
	}
}

async function cleanupMaterializedCell(staging: StagedCellPayload): Promise<void> {
	const payloadRoot = await canonicalStagingDirectory(staging.canonicalPayloadRoot, "payload root");
	if (!sameStagingIdentity(staging.payloadRootIdentity, payloadRoot.identity)) {
		throw new NativeCellAdapterError("CELL_STAGING_PATH_CHANGED", "private cell payload root changed before cleanup");
	}
	const directory = await canonicalStagingDirectory(staging.directory, "staging directory");
	if (
		directory.path !== staging.canonicalDirectory ||
		!sameStagingIdentity(staging.directoryIdentity, directory.identity) ||
		!isWithin(payloadRoot.path, directory.path)
	) {
		throw new NativeCellAdapterError(
			"CELL_STAGING_PATH_CHANGED",
			"private cell staging directory changed before cleanup",
		);
	}
	const entries = await readdir(directory.path, { withFileTypes: true });
	if (entries.length !== staging.files.size || entries.some((entry) => !staging.files.has(entry.name))) {
		throw new NativeCellAdapterError(
			"CELL_STAGING_CONTENT_CHANGED",
			"private cell staging directory contains an unexpected entry",
		);
	}
	for (const [fileName, expectedIdentity] of staging.files) {
		const path = join(directory.path, fileName);
		const before = await lstat(path);
		if (!before.isFile() || before.isSymbolicLink() || !sameStagingIdentity(expectedIdentity, before)) {
			throw new NativeCellAdapterError("CELL_STAGING_CONTENT_CHANGED", "private staged file changed before cleanup");
		}
		const canonicalPath = await realpath(path);
		if (!isWithin(directory.path, canonicalPath) || resolve(canonicalPath) !== resolve(path)) {
			throw new NativeCellAdapterError(
				"CELL_STAGING_REPARSE_REJECTED",
				"private staged file resolves outside staging",
			);
		}
		const after = await lstat(canonicalPath);
		if (!after.isFile() || after.isSymbolicLink() || !sameStagingIdentity(before, after)) {
			throw new NativeCellAdapterError("CELL_STAGING_PATH_CHANGED", "private staged file changed during cleanup");
		}
		await unlink(canonicalPath);
	}
	const beforeRemove = await lstat(directory.path);
	if (
		!beforeRemove.isDirectory() ||
		beforeRemove.isSymbolicLink() ||
		!sameStagingIdentity(staging.directoryIdentity, beforeRemove)
	) {
		throw new NativeCellAdapterError(
			"CELL_STAGING_PATH_CHANGED",
			"private cell staging directory changed during cleanup",
		);
	}
	await rmdir(directory.path);
}

function canonicalStagingDirectory(path: string, label: string): Promise<{ path: string; identity: Stats }> {
	return resolveStableStagingDirectory(path, label, "CELL_STAGING_REPARSE_REJECTED", "CELL_STAGING_PATH_CHANGED");
}

async function resolveStableStagingDirectory(
	path: string,
	label: string,
	reparseCode: string,
	changedCode: string,
): Promise<{ path: string; identity: Stats }> {
	const before = await lstat(path);
	if (!before.isDirectory() || before.isSymbolicLink()) {
		throw new NativeCellAdapterError(reparseCode, `${label} is not a concrete directory`);
	}
	const canonical = await realpath(path);
	const after = await lstat(canonical);
	if (!after.isDirectory() || after.isSymbolicLink() || !sameStagingIdentity(before, after)) {
		throw new NativeCellAdapterError(changedCode, `${label} changed while it was being resolved`);
	}
	return { path: canonical, identity: after };
}

function privateStagingPathSegment(value: string, label: string): string {
	if (!value || value.length > 255 || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
		throw new NativeCellAdapterError("CELL_STAGING_REJECTED", `${label} is not a safe private staging path segment`);
	}
	return value;
}

function privateStagingPayloadHash(value: string): string {
	if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
		throw new NativeCellAdapterError(
			"CELL_STAGING_REJECTED",
			"payload hash is not a SHA-256 private staging path segment",
		);
	}
	return value.slice("sha256:".length);
}

function isDirectStagingFileName(value: string): boolean {
	return !!value && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

async function verifyPreparedCellSnapshot(
	handle: IsolatedWindowsRunHandle,
	input: CoordinatorAdapterPreparation,
	compiled: ReturnType<typeof compileFrozenCell>,
): Promise<void> {
	const environment = input.payload.environment;
	const config = JSON.parse(await readFile(join(handle.controlDirectory, "config.json"), "utf8")) as unknown;
	if (!isPlainRecord(config) || config.ConfigBindingHash !== handle.configBindingHash) {
		throw new NativeCellAdapterError(
			"CELL_SNAPSHOT_BINDING_INVALID",
			"runner configuration is not bound to its private handle",
		);
	}
	if (
		config.EnvironmentAdapterKind !== environment.adapterKind ||
		config.EnvironmentDescriptorHash !== environment.descriptorHash
	) {
		throw new NativeCellAdapterError(
			"CELL_SNAPSHOT_ENVIRONMENT_MISMATCH",
			"runner configuration does not bind the frozen environment descriptor",
		);
	}
	if (!Array.isArray(config.Files) || config.Files.length < environment.files.length) {
		throw new NativeCellAdapterError(
			"CELL_SNAPSHOT_INVENTORY_INVALID",
			"runner snapshot does not contain a full file inventory",
		);
	}
	const snapshotFiles = new Map<string, string>();
	const runtimeHashes = new Map<string, number>();
	for (const item of config.Files) {
		if (
			!isPlainRecord(item) ||
			typeof item.path !== "string" ||
			typeof item.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/u.test(item.sha256)
		) {
			throw new NativeCellAdapterError(
				"CELL_SNAPSHOT_INVENTORY_INVALID",
				"runner snapshot contains an invalid file digest",
			);
		}
		const snapshotFile = resolve(item.path);
		if (!isWithin(handle.runDirectory, snapshotFile)) {
			throw new NativeCellAdapterError(
				"CELL_SNAPSHOT_PATH_REJECTED",
				"runner snapshot names a file outside its private run directory",
			);
		}
		const actualHash = bareSha256(await readFile(snapshotFile));
		if (actualHash !== item.sha256) {
			throw new NativeCellAdapterError(
				"CELL_SNAPSHOT_HASH_MISMATCH",
				`runner snapshot file changed: ${snapshotFile}`,
			);
		}
		if (snapshotFiles.has(snapshotFile)) {
			throw new NativeCellAdapterError(
				"CELL_SNAPSHOT_INVENTORY_INVALID",
				"runner snapshot contains a duplicate file path",
			);
		}
		snapshotFiles.set(snapshotFile, item.sha256);
		if (isWithin(join(handle.runDirectory, "runtime"), snapshotFile)) {
			runtimeHashes.set(item.sha256, (runtimeHashes.get(item.sha256) ?? 0) + 1);
		}
	}
	for (const file of environment.files) {
		const hash = file.sha256.slice("sha256:".length);
		const count = runtimeHashes.get(hash) ?? 0;
		if (count < 1) {
			throw new NativeCellAdapterError(
				"CELL_SNAPSHOT_INVENTORY_MISMATCH",
				`runner runtime snapshot lacks frozen environment byte hash ${file.sha256}`,
			);
		}
		runtimeHashes.set(hash, count - 1);
	}
	if (compiled.compiledProgramHash !== executionSha256(compiled.program)) {
		throw new NativeCellAdapterError(
			"CELL_COMPILED_PROGRAM_INVALID",
			"compiled cell program hash does not bind its wrapper bytes",
		);
	}
	const expectedProgramPath = join(handle.runDirectory, "input", `program${extname(compiled.fileName)}`);
	if (typeof config.ProgramPath !== "string" || resolve(config.ProgramPath) !== resolve(expectedProgramPath)) {
		throw new NativeCellAdapterError(
			"CELL_SNAPSHOT_INPUT_PATH_MISMATCH",
			"compiled program snapshot path is not the uniquely expected runner input path",
		);
	}
	await verifyFrozenSnapshotFile({
		label: "compiled program",
		snapshotFiles,
		expectedPath: expectedProgramPath,
		expectedHash: compiled.compiledProgramHash,
	});
	for (const [index, frozenInput] of input.payload.inputs.entries()) {
		await verifyFrozenSnapshotFile({
			label: `frozen input ${index}`,
			snapshotFiles,
			expectedPath: join(handle.runDirectory, "input", inputFileName(frozenInput.name, index)),
			expectedHash: frozenInput.sha256,
		});
	}
	if (environment.adapterKind === R_GLOBAL_LIBRARY_ADAPTER) await verifyRCompatibilitySnapshot(config, handle);
}

async function verifyFrozenSnapshotFile(input: {
	label: string;
	snapshotFiles: ReadonlyMap<string, string>;
	expectedPath: string;
	expectedHash: string;
}): Promise<void> {
	const snapshotPath = resolve(input.expectedPath);
	const expectedBareHash = input.expectedHash.slice("sha256:".length);
	if (
		!/^sha256:[a-f0-9]{64}$/u.test(input.expectedHash) ||
		input.snapshotFiles.get(snapshotPath) !== expectedBareHash
	) {
		throw new NativeCellAdapterError(
			"CELL_SNAPSHOT_INPUT_HASH_MISMATCH",
			`${input.label} snapshot configuration does not bind its frozen hash`,
		);
	}
	if (executionSha256(await readFile(snapshotPath)) !== input.expectedHash) {
		throw new NativeCellAdapterError(
			"CELL_SNAPSHOT_INPUT_HASH_MISMATCH",
			`${input.label} snapshot bytes do not match its frozen hash`,
		);
	}
}

async function verifyRCompatibilitySnapshot(
	config: Record<string, unknown>,
	handle: IsolatedWindowsRunHandle,
): Promise<void> {
	for (const [pathKey, hashKey] of [
		["CompatibilityAdapterPath", "CompatibilityAdapterHash"],
		["CompatibilityRDllPath", "CompatibilityRDllHash"],
	] as const) {
		const path = config[pathKey];
		const hash = config[hashKey];
		if (typeof path !== "string" || typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
			throw new NativeCellAdapterError(
				"CELL_R_COMPATIBILITY_INVALID",
				"R runner compatibility binding is incomplete",
			);
		}
		const snapshotFile = resolve(path);
		if (
			!isWithin(join(handle.runDirectory, "runtime"), snapshotFile) ||
			bareSha256(await readFile(snapshotFile)) !== hash
		) {
			throw new NativeCellAdapterError(
				"CELL_R_COMPATIBILITY_MISMATCH",
				"R compatibility snapshot file is not hash-bound",
			);
		}
	}
}

function preparedRunnerCleanupFailure(original: unknown, cleanupError: unknown): NativeCellAdapterError {
	return new NativeCellAdapterError(
		"CELL_PREPARE_CLEANUP_FAILED",
		`prepared snapshot verification failed (${errorText(original)}); runner abandonment also failed (${errorText(cleanupError)})`,
	);
}

function stagedCellCleanupFailure(input: {
	staging: StagedCellPayload;
	preparationFailure: unknown;
	cleanupTriggerFailure: unknown;
	cleanupFailure: unknown;
	runnerWasAbandoned: boolean;
	runnerAbandonmentFailure: unknown;
}): NativeCellAdapterError {
	const failures = [
		input.preparationFailure ? `preparation failed (${errorText(input.preparationFailure)})` : null,
		input.cleanupTriggerFailure ? `cleanup trigger failed (${errorText(input.cleanupTriggerFailure)})` : null,
		input.cleanupFailure ? `staging cleanup failed (${errorText(input.cleanupFailure)})` : null,
		input.runnerWasAbandoned ? "prepared runner was abandoned" : null,
		input.runnerAbandonmentFailure
			? `runner abandonment failed (${errorText(input.runnerAbandonmentFailure)})`
			: null,
	].filter((value): value is string => value !== null);
	return new NativeCellAdapterError(
		"CELL_STAGING_CLEANUP_FAILED",
		`private cell staging ${input.staging.stagingIdentity} could not be cleaned after snapshot preparation: ${failures.join("; ")}`,
	);
}

function cellPreparationIdentity(
	intent: PreparedExecutionHandle,
	configuration: CellAdapterConfiguration,
): NativeCellPreparationIdentity {
	if (
		intent.kind !== configuration.kind ||
		intent.version !== 1 ||
		!isPlainRecord(intent.privateHandle) ||
		!isPlainRecord(intent.publicSummary) ||
		!isPlainRecord(intent.privateHandle.preparationIdentity)
	) {
		throw new NativeCellAdapterError(
			"CELL_PREPARATION_INTENT_INVALID",
			"native cell preparation requires a matching durable preparation intent",
		);
	}
	const privateKeys = Object.keys(intent.privateHandle);
	if (privateKeys.length !== 1 || privateKeys[0] !== "preparationIdentity") {
		throw new NativeCellAdapterError(
			"CELL_PREPARATION_INTENT_INVALID",
			"a native cell preparation intent contains only its runner identity",
		);
	}
	const value = intent.privateHandle.preparationIdentity;
	const identityKeys = Object.keys(value).sort();
	if (
		identityKeys.length !== 3 ||
		identityKeys[0] !== "cancelToken" ||
		identityKeys[1] !== "runId" ||
		identityKeys[2] !== "runRootDirectory" ||
		typeof value.runId !== "string" ||
		typeof value.cancelToken !== "string" ||
		typeof value.runRootDirectory !== "string" ||
		!isUuid(value.runId) ||
		!isUuid(value.cancelToken) ||
		!isAbsolute(value.runRootDirectory) ||
		resolve(value.runRootDirectory) !== configuration.runRootDirectory
	) {
		throw new NativeCellAdapterError(
			"CELL_PREPARATION_INTENT_INVALID",
			"native cell preparation identity is malformed or belongs to another run root",
		);
	}
	return {
		runId: value.runId,
		cancelToken: value.cancelToken,
		runRootDirectory: configuration.runRootDirectory,
	};
}

function cellRunnerHandle(handle: PreparedExecutionHandle): IsolatedWindowsRunHandle {
	if (
		!CELL_ADAPTER_KINDS.has(handle.kind) ||
		!isPlainRecord(handle.privateHandle) ||
		!isPlainRecord(handle.privateHandle.runner)
	) {
		throw new NativeCellAdapterError("CELL_HANDLE_INVALID", "prepared handle is not a native cell run");
	}
	const runner = handle.privateHandle.runner;
	for (const key of [
		"runId",
		"runDirectory",
		"controlDirectory",
		"outputDirectory",
		"helperPath",
		"cancelToken",
		"configBindingHash",
	] as const) {
		if (typeof runner[key] !== "string" || !runner[key]) {
			throw new NativeCellAdapterError("CELL_HANDLE_INVALID", "private native cell runner handle is malformed");
		}
	}
	if (runner.version !== 1)
		throw new NativeCellAdapterError("CELL_HANDLE_INVALID", "native cell runner handle version is invalid");
	return runner as unknown as IsolatedWindowsRunHandle;
}

async function observeNativeCellStatus(
	status: IsolatedWindowsRunStatus,
	handle: IsolatedWindowsRunHandle,
): Promise<CoordinatorAdapterObservation> {
	const terminal = TERMINAL.has(status.status);
	return {
		status: status.status,
		usage: { wallTimeMs: status.wallTimeMs, diskBytes: status.outputBytes },
		processEvidence:
			status.processId > 0 && status.processCreationFileTime
				? `windows runner processId=${status.processId}; creation=${status.processCreationFileTime}; config=${status.configBindingHash}`
				: null,
		logs: terminal
			? {
					stdout: await readOptionalLog(handle.outputDirectory, "stdout.log"),
					stderr: await readOptionalLog(handle.outputDirectory, "stderr.log"),
					error: status.error,
				}
			: { stdout: null, stderr: null, error: status.error },
	};
}

function observePreparationAbandonment(
	abandonment: IsolatedWindowsPreparationAbandonment,
): CoordinatorAdapterObservation {
	return {
		status: abandonment.status,
		usage: { wallTimeMs: abandonment.wallTimeMs, diskBytes: abandonment.diskBytes },
		processEvidence: null,
		logs: { stdout: null, stderr: null, error: null },
	};
}

function cellCpuBinding(
	requestedCpuMilliCores: number,
	configuredMaximumPercent: number,
): {
	requestedCpuMilliCores: number;
	logicalCores: number;
	actualCpuRatePercent: number;
} {
	const logicalCores = cpus().length;
	if (!Number.isSafeInteger(logicalCores) || logicalCores < 1) {
		throw new NativeCellAdapterError("CELL_CPU_CAPACITY_UNAVAILABLE", "logical CPU capacity is unavailable");
	}
	const requestedPercent = Math.floor((requestedCpuMilliCores * 100) / (logicalCores * 1_000));
	if (requestedPercent < 1) {
		throw new NativeCellAdapterError(
			"CELL_CPU_GRANULARITY_UNSUPPORTED",
			`requested ${requestedCpuMilliCores}m is below Windows Job 1% granularity for ${logicalCores} logical cores`,
		);
	}
	return {
		requestedCpuMilliCores,
		logicalCores,
		actualCpuRatePercent: Math.min(requestedPercent, configuredMaximumPercent),
	};
}

async function scanOutputArtifacts(
	handle: IsolatedWindowsRunHandle,
): Promise<readonly NativeCellOutputArtifactDescriptor[]> {
	const root = await canonicalArtifactRoot(handle);
	const artifacts: NativeCellOutputArtifactDescriptor[] = [];
	await scanArtifactDirectory(root, root, artifacts);
	return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function scanArtifactDirectory(
	root: string,
	directory: string,
	artifacts: NativeCellOutputArtifactDescriptor[],
): Promise<void> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const candidate = resolve(directory, entry.name);
		const checked = await canonicalArtifactEntry(root, candidate);
		if (checked.isDirectory()) {
			await scanArtifactDirectory(root, checked.path, artifacts);
			continue;
		}
		if (!checked.isFile()) {
			throw new NativeCellAdapterError("ARTIFACT_ENTRY_REJECTED", "output contains a non-file entry");
		}
		if (artifacts.length >= MAX_ARTIFACT_FILES) {
			throw new NativeCellAdapterError("ARTIFACT_LIMIT_EXCEEDED", "too many output artifacts");
		}
		const rawRelativePath = relative(root, checked.path);
		if (isReservedLogAlias(rawRelativePath)) continue;
		const relativePath = artifactRelativePath(rawRelativePath);
		const bytes = await readBoundedRegularFile(checked.path, MAX_ARTIFACT_BYTES);
		artifacts.push({
			path: relativePath,
			bytes: bytes.byteLength,
			sha256: executionSha256(bytes),
			mediaType: mediaType(checked.path),
			contentDisposition: artifactContentDisposition(checked.path),
		});
	}
}

async function readExactArtifactBytes(
	handle: IsolatedWindowsRunHandle,
	descriptor: NativeCellOutputArtifactDescriptor,
): Promise<Uint8Array> {
	const root = await canonicalArtifactRoot(handle);
	const relativePath = artifactRelativePath(descriptor.path);
	const checked = await canonicalArtifactEntry(root, resolve(root, relativePath));
	if (!checked.isFile()) {
		throw new NativeCellAdapterError("ARTIFACT_UNAVAILABLE", "artifact is not a regular output file");
	}
	const bytes = await readBoundedRegularFile(checked.path, MAX_ARTIFACT_BYTES);
	if (bytes.byteLength !== descriptor.bytes || executionSha256(bytes) !== descriptor.sha256) {
		throw new NativeCellAdapterError(
			"ARTIFACT_CHANGED",
			"artifact bytes changed after trusted descriptor enumeration",
		);
	}
	return bytes;
}

async function canonicalArtifactRoot(handle: IsolatedWindowsRunHandle): Promise<string> {
	const runDirectory = await canonicalDirectory(handle.runDirectory, "run directory");
	const outputDirectory = await canonicalDirectory(handle.outputDirectory, "output directory");
	if (!isSameOrWithin(runDirectory, outputDirectory)) {
		throw new NativeCellAdapterError("ARTIFACT_PATH_REJECTED", "output directory escapes its private run directory");
	}
	return outputDirectory;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
	const before = await lstat(path);
	if (!before.isDirectory() || before.isSymbolicLink()) {
		throw new NativeCellAdapterError("ARTIFACT_REPARSE_REJECTED", `${label} is not a concrete directory`);
	}
	const canonical = await realpath(path);
	const after = await lstat(canonical);
	if (!after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(before, after)) {
		throw new NativeCellAdapterError("ARTIFACT_PATH_CHANGED", `${label} changed while it was being resolved`);
	}
	return canonical;
}

async function canonicalArtifactEntry(
	root: string,
	candidate: string,
): Promise<{ path: string; isDirectory(): boolean; isFile(): boolean }> {
	if (!isSameOrWithin(root, candidate)) {
		throw new NativeCellAdapterError("ARTIFACT_PATH_REJECTED", "artifact entry escapes its output directory");
	}
	const before = await lstat(candidate);
	if (before.isSymbolicLink()) {
		throw new NativeCellAdapterError("ARTIFACT_REPARSE_REJECTED", "output contains a symbolic link");
	}
	const canonical = await realpath(candidate);
	if (!isSameOrWithin(root, canonical)) {
		throw new NativeCellAdapterError("ARTIFACT_PATH_REJECTED", "artifact real path escapes its output directory");
	}
	const after = await lstat(canonical);
	if (after.isSymbolicLink() || !sameFileIdentity(before, after)) {
		throw new NativeCellAdapterError("ARTIFACT_PATH_CHANGED", "artifact entry changed while it was being resolved");
	}
	return { path: canonical, isDirectory: () => after.isDirectory(), isFile: () => after.isFile() };
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > maximumBytes) {
			throw new NativeCellAdapterError("ARTIFACT_LIMIT_EXCEEDED", "artifact is not a bounded regular output file");
		}
		const buffer = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const result = await handle.read(buffer, length, buffer.length - length, length);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		const after = await handle.stat();
		if (length !== before.size || !sameFileIdentity(before, after)) {
			throw new NativeCellAdapterError("ARTIFACT_CHANGED", "artifact changed while its bytes were being read");
		}
		return new Uint8Array(buffer.subarray(0, length));
	} finally {
		await handle.close();
	}
}

function inputFileName(originalName: string, index: number): string {
	return `input-${index}${extname(originalName) || ".bin"}`;
}

function requiredDirectory(value: string, label: string): string {
	if (!value || !value.trim() || !isAbsolute(value)) {
		throw new NativeCellAdapterError("CELL_ADAPTER_PATH_INVALID", `${label} must be an absolute path`);
	}
	return resolve(value);
}

function artifactRelativePath(value: string): string {
	if (
		!value ||
		value.length > 512 ||
		isAbsolute(value) ||
		value.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")
	) {
		throw new NativeCellAdapterError("ARTIFACT_PATH_REJECTED", "artifact path must be a bounded relative path");
	}
	const result = value.split(/[\\/]/u).join("/");
	if (isReservedLogAlias(result)) {
		throw new NativeCellAdapterError("ARTIFACT_PATH_REJECTED", "runner log files are not cell artifacts");
	}
	return result;
}

function isReservedLogAlias(path: string): boolean {
	return RESERVED_LOG_NAMES.has(path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "");
}

function isWithin(root: string, candidate: string): boolean {
	const difference = relative(resolve(root), resolve(candidate));
	return (
		difference !== "" &&
		!difference.startsWith("..") &&
		!isAbsolute(difference) &&
		!difference.split(sep).includes("..")
	);
}

function isSameOrWithin(root: string, candidate: string): boolean {
	return resolve(root) === resolve(candidate) || isWithin(root, candidate);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function sameStagingIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		!!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
	);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function bareSha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function mediaType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".pdf":
			return "application/pdf";
		case ".svg":
			return "image/svg+xml";
		case ".htm":
		case ".html":
			return "text/html";
		case ".json":
			return "application/json";
		case ".csv":
			return "text/csv";
		case ".txt":
			return "text/plain";
		default:
			return "application/octet-stream";
	}
}

function artifactContentDisposition(path: string): "inline" | "attachment" {
	switch (extname(path).toLowerCase()) {
		case ".png":
		case ".pdf":
		case ".json":
		case ".csv":
		case ".txt":
			return "inline";
		default:
			return "attachment";
	}
}

function errorText(error: unknown): string {
	if (error instanceof NativeCellAdapterError) return `${error.code}: ${error.message}`.slice(0, 2_000);
	return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

async function assertTerminalOutputQuiescent(handle: IsolatedWindowsRunHandle): Promise<void> {
	const status = await reconcileIsolatedWindowsRun(handle);
	if (!TERMINAL.has(status.status)) {
		throw new NativeCellAdapterError(
			"ARTIFACT_RUN_NOT_TERMINAL",
			"output artifacts are unavailable until the isolated run reaches a terminal receipt",
		);
	}
}

async function readOptionalLog(outputDirectory: string, name: string): Promise<string | null> {
	try {
		return await readFile(join(outputDirectory, name), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
