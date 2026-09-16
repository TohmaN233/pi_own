import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type FrozenEnvironmentFile,
	type FrozenExecutionEnvironment,
	frozenEnvironmentDescriptorHash,
} from "./execution-payloads.ts";
import { detectStudyPlatform } from "./platform.ts";

const EXECUTION_HASH = /^sha256:[a-f0-9]{64}$/u;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const COMMAND_TIMEOUT_MS = 30_000;

export const PYTHON_PROJECT_VENV_ADAPTER = "native-windows-python-project-venv-v1";
export const R_GLOBAL_LIBRARY_ADAPTER = "native-windows-r-global-library-v1";

/** Exact byte inventory accepted by the coordinator and copied by the native runner. */
export type StudyExecutionEnvironment = FrozenExecutionEnvironment;

export interface ProjectPythonEnvironmentOptions {
	/** Existing project root; a venv outside this canonical root is never accepted. */
	projectDirectory: string;
	/** Existing selected venv directory. Supply this to discover rather than create. */
	venvDirectory: string;
}

export interface CreateProjectPythonEnvironmentOptions {
	projectDirectory: string;
	/** Relative to projectDirectory, or an absolute path canonically inside it. */
	venvDirectory?: string;
	/** Optional existing base interpreter. Omit to use the read-only platform detector. */
	pythonExecutable?: string;
}

export interface PythonEnvironmentDiscovery {
	environment: StudyExecutionEnvironment;
	projectDirectory: string;
	venvDirectory: string;
	basePythonDirectory: string;
	sitePackagesDirectory: string;
	packages: readonly InstalledDependency[];
}

export interface RGlobalLibraryEnvironmentOptions {
	/** Optional existing Rscript. Omit to use the read-only platform detector. */
	rscriptExecutable?: string;
	/**
	 * External packages to freeze from the currently selected `.libPaths()`. Base and
	 * recommended R packages inside R_HOME are already included. This is deliberately
	 * an explicit selection, not a dependency resolver.
	 */
	packageNames?: readonly string[];
}

export interface RGlobalLibraryEnvironmentDiscovery {
	environment: StudyExecutionEnvironment;
	rscriptExecutable: string;
	rHomeDirectory: string;
	libraryPaths: readonly string[];
	packages: readonly InstalledDependency[];
	selectedExternalPackages: readonly string[];
}

export interface InstalledDependency {
	name: string;
	version: string;
	location: string;
}

export interface RequestedDependency {
	name: string;
	version?: string;
}

export interface DependencyChangePlan {
	resolver: "not-a-transitive-resolver";
	items: Array<{
		name: string;
		requestedVersion: string | null;
		installedVersion: string | null;
		status: "already-installed" | "missing" | "version-change-requested";
	}>;
	transitiveDependencies: "unknown-until-a-consented-resolver-runs";
}

export class StudyExecutionEnvironmentError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StudyExecutionEnvironmentError";
		this.code = code;
	}
}

/** Creates an isolated project venv with an existing interpreter; it never installs packages from a network. */
export async function createProjectPythonEnvironment(
	options: CreateProjectPythonEnvironmentOptions,
): Promise<PythonEnvironmentDiscovery> {
	assertWindows();
	const projectDirectory = await canonicalExistingDirectory(options.projectDirectory, "project directory");
	const requestedVenv = resolve(projectDirectory, options.venvDirectory ?? ".study-python-venv");
	assertLexicallyWithin(projectDirectory, requestedVenv, "venv directory");
	if (await exists(requestedVenv)) {
		throw new StudyExecutionEnvironmentError(
			"VENV_ALREADY_EXISTS",
			`Refusing to reuse or alter existing venv directory ${requestedVenv}. Discover it explicitly instead.`,
		);
	}
	const parent = await canonicalExistingDirectory(dirname(requestedVenv), "venv parent directory");
	if (!isWithin(projectDirectory, parent)) {
		throw new StudyExecutionEnvironmentError(
			"PROJECT_BOUNDARY_VIOLATION",
			"venv parent directory escapes project directory.",
		);
	}
	const pythonExecutable = options.pythonExecutable
		? await canonicalExistingFile(options.pythonExecutable, "base Python executable")
		: await detectedExecutable("python");
	const created = spawnSync(pythonExecutable, ["-I", "-m", "venv", requestedVenv], {
		encoding: "utf8",
		stdio: "pipe",
		windowsHide: true,
		timeout: COMMAND_TIMEOUT_MS,
	});
	if (created.status !== 0) {
		throw new StudyExecutionEnvironmentError(
			"VENV_CREATION_FAILED",
			commandFailure("Creating the project venv failed", created),
		);
	}
	return discoverProjectPythonEnvironment({ projectDirectory, venvDirectory: requestedVenv });
}

/** Discovers a selected project venv and inventories only its private site-packages plus the base runtime. */
export async function discoverProjectPythonEnvironment(
	options: ProjectPythonEnvironmentOptions,
): Promise<PythonEnvironmentDiscovery> {
	assertWindows();
	const projectDirectory = await canonicalExistingDirectory(options.projectDirectory, "project directory");
	const venvDirectory = await canonicalExistingDirectory(options.venvDirectory, "venv directory");
	assertCanonicalWithin(projectDirectory, venvDirectory, "venv directory");
	const venvExecutable = await canonicalExistingFile(
		join(venvDirectory, "Scripts", "python.exe"),
		"venv Python executable",
	);
	const pyvenvConfig = await canonicalExistingFile(join(venvDirectory, "pyvenv.cfg"), "venv configuration");
	const identity = runJson(venvExecutable, [
		"-I",
		"-c",
		"import json,sys; print(json.dumps({'prefix':sys.prefix,'base_prefix':sys.base_prefix,'executable':sys.executable}))",
	]);
	const prefix = await canonicalExistingDirectory(textField(identity, "prefix"), "Python prefix");
	const basePrefix = await canonicalExistingDirectory(textField(identity, "base_prefix"), "Python base prefix");
	if (!samePath(prefix, venvDirectory) || samePath(prefix, basePrefix)) {
		throw new StudyExecutionEnvironmentError(
			"PROJECT_VENV_REQUIRED",
			"Selected Python executable is not an independently identified project venv.",
		);
	}
	const baseExecutable = await canonicalExistingFile(join(basePrefix, "python.exe"), "base Python executable");
	const sitePackagesDirectory = join(venvDirectory, "Lib", "site-packages");
	if (await exists(sitePackagesDirectory)) await assertDirectoryTreeSafe(sitePackagesDirectory, "venv site-packages");
	const sourceFiles = new Set<string>([venvExecutable, pyvenvConfig, baseExecutable]);
	for (const file of await filesAtDirectoryRoot(basePrefix, (name) => name.toLowerCase().endsWith(".dll")))
		sourceFiles.add(file);
	for (const file of await collectTreeFiles(join(basePrefix, "DLLs"), "Python DLLs", { optional: true }))
		sourceFiles.add(file);
	for (const file of await collectTreeFiles(join(basePrefix, "Lib"), "Python standard library", {
		excludeRootDirectories: new Set(["site-packages"]),
	}))
		sourceFiles.add(file);
	// Conda packages frequently need DLLs from this directory. It is still copied read-only and is bounded by runner limits.
	for (const file of await collectTreeFiles(join(basePrefix, "Library", "bin"), "Python native library directory", {
		optional: true,
	}))
		sourceFiles.add(file);
	for (const file of await collectTreeFiles(sitePackagesDirectory, "venv site-packages", { optional: true }))
		sourceFiles.add(file);
	const files = await exactInventory(sourceFiles);
	const environment = makeEnvironment(PYTHON_PROJECT_VENV_ADAPTER, venvExecutable, files);
	const packages = await inspectPythonProjectPackages(venvExecutable, venvDirectory);
	return {
		environment,
		projectDirectory,
		venvDirectory,
		basePythonDirectory: basePrefix,
		sitePackagesDirectory,
		packages,
	};
}

/** Reads package metadata from a selected venv without invoking pip or a package index. */
export async function inspectPythonProjectPackages(
	pythonExecutable: string,
	venvDirectory: string,
): Promise<readonly InstalledDependency[]> {
	const executable = await canonicalExistingFile(pythonExecutable, "Python executable");
	const venv = await canonicalExistingDirectory(venvDirectory, "venv directory");
	if (!samePath(venv, dirname(dirname(executable)))) {
		throw new StudyExecutionEnvironmentError(
			"PROJECT_BOUNDARY_VIOLATION",
			"Python executable does not belong to the selected venv.",
		);
	}
	const result = runJson(executable, [
		"-I",
		"-c",
		"import importlib.metadata as m,json; print(json.dumps(sorted([{'name':d.metadata['Name'] or d.name,'version':d.version,'location':str(d.locate_file(''))} for d in m.distributions()], key=lambda x:x['name'].lower())))",
	]);
	if (!Array.isArray(result))
		throw new StudyExecutionEnvironmentError(
			"PYTHON_PACKAGE_INVENTORY_INVALID",
			"Python package inventory was not an array.",
		);
	return result.map((item, index) => installedDependency(item, `Python package ${index}`));
}

/** Discovers R_HOME and the current `.libPaths()` read-only; external packages are included only when named explicitly. */
export async function discoverRGlobalLibraryEnvironment(
	options: RGlobalLibraryEnvironmentOptions = {},
): Promise<RGlobalLibraryEnvironmentDiscovery> {
	assertWindows();
	const rscriptExecutable = options.rscriptExecutable
		? await canonicalExistingFile(options.rscriptExecutable, "Rscript executable")
		: await detectedExecutable("rscript");
	const rHomeDirectory = await findRHome(rscriptExecutable);
	const libraryPaths = await discoverRLibraryPaths(rscriptExecutable);
	const sourceFiles = new Set(await collectTreeFiles(rHomeDirectory, "R installation"));
	const packages = await inspectRGlobalPackages(rscriptExecutable);
	const selectedExternalPackages: string[] = [];
	const pending = [...(options.packageNames ?? [])];
	const resolvedPackages = new Set<string>();
	while (pending.length > 0) {
		const name = pending.shift();
		if (!name) continue;
		if (!PACKAGE_NAME.test(name)) {
			throw new StudyExecutionEnvironmentError("R_PACKAGE_NAME_INVALID", `R package name is invalid: ${name}`);
		}
		if (resolvedPackages.has(name.toLowerCase())) continue;
		const packageDirectory = await findRPackageDirectory(name, libraryPaths);
		if (!packageDirectory) {
			throw new StudyExecutionEnvironmentError(
				"R_PACKAGE_DEPENDENCY_MISSING",
				`R package ${name} is absent from current .libPaths().`,
			);
		}
		resolvedPackages.add(name.toLowerCase());
		const dependencies = await rPackageDependencies(packageDirectory);
		for (const dependency of dependencies) pending.push(dependency);
		if (!isWithin(rHomeDirectory, packageDirectory)) {
			for (const file of await collectTreeFiles(packageDirectory, `R package ${name}`)) sourceFiles.add(file);
			selectedExternalPackages.push(name);
		}
	}
	const files = await exactInventory(sourceFiles);
	return {
		environment: makeEnvironment(R_GLOBAL_LIBRARY_ADAPTER, rscriptExecutable, files),
		rscriptExecutable,
		rHomeDirectory,
		libraryPaths,
		packages,
		selectedExternalPackages,
	};
}

/** Reads installed R package metadata only. It makes no change to R libraries or package state. */
export async function inspectRGlobalPackages(rscriptExecutable: string): Promise<readonly InstalledDependency[]> {
	const executable = await canonicalExistingFile(rscriptExecutable, "Rscript executable");
	const output = runText(executable, [
		"--vanilla",
		"--slave",
		"-e",
		"x<-installed.packages(fields=c('Package','Version','LibPath'));writeLines(paste(x[,'Package'],x[,'Version'],x[,'LibPath'],sep='\\t'))",
	]);
	return output
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line, index) => {
			const fields = line.split("\t");
			if (fields.length !== 3 || fields.some((field) => !field)) {
				throw new StudyExecutionEnvironmentError("R_PACKAGE_INVENTORY_INVALID", `Invalid R package row ${index}.`);
			}
			return { name: fields[0], version: fields[1], location: fields[2] };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

/** A change request classifier, deliberately not a transitive dependency resolver or installer. */
export function planDependencyChanges(
	installed: readonly InstalledDependency[],
	requested: readonly RequestedDependency[],
): DependencyChangePlan {
	const byName = new Map(installed.map((item) => [item.name.toLowerCase(), item]));
	const names = new Set<string>();
	const items: DependencyChangePlan["items"] = requested.map((item) => {
		if (!PACKAGE_NAME.test(item.name) || names.has(item.name.toLowerCase())) {
			throw new StudyExecutionEnvironmentError(
				"DEPENDENCY_REQUEST_INVALID",
				`Dependency request is invalid or duplicated: ${item.name}`,
			);
		}
		names.add(item.name.toLowerCase());
		const found = byName.get(item.name.toLowerCase()) ?? null;
		const requestedVersion = item.version?.trim() || null;
		const status: DependencyChangePlan["items"][number]["status"] =
			found === null
				? "missing"
				: requestedVersion !== null && requestedVersion !== found.version
					? "version-change-requested"
					: "already-installed";
		return {
			name: item.name,
			requestedVersion,
			installedVersion: found?.version ?? null,
			status,
		};
	});
	return {
		resolver: "not-a-transitive-resolver",
		items,
		transitiveDependencies: "unknown-until-a-consented-resolver-runs",
	};
}

/** Re-hashes every declared byte and validates that its descriptor still has the coordinator's identity. */
export async function verifyStudyExecutionEnvironment(environment: StudyExecutionEnvironment): Promise<void> {
	if (!environment || !EXECUTION_HASH.test(environment.descriptorHash)) {
		throw new StudyExecutionEnvironmentError(
			"ENVIRONMENT_DESCRIPTOR_INVALID",
			"Environment descriptor hash is invalid.",
		);
	}
	if (environment.descriptorHash !== frozenEnvironmentDescriptorHash(environment)) {
		throw new StudyExecutionEnvironmentError(
			"ENVIRONMENT_DESCRIPTOR_HASH_MISMATCH",
			"Environment descriptor hash does not match its ordered inventory.",
		);
	}
	if (!isAbsolute(environment.executablePath) || !environment.files.length) {
		throw new StudyExecutionEnvironmentError(
			"ENVIRONMENT_DESCRIPTOR_INVALID",
			"Environment executable and files are required.",
		);
	}
	let previous = "";
	for (const file of environment.files) {
		if (
			!isAbsolute(file.absolutePath) ||
			!EXECUTION_HASH.test(file.sha256) ||
			previous.localeCompare(file.absolutePath) >= 0
		) {
			throw new StudyExecutionEnvironmentError(
				"ENVIRONMENT_INVENTORY_INVALID",
				"Environment files must be absolute, hashed, and strictly ordered.",
			);
		}
		await assertRegularFileSafe(file.absolutePath, "environment file");
		if ((await executionSha256File(file.absolutePath)) !== file.sha256) {
			throw new StudyExecutionEnvironmentError(
				"ENVIRONMENT_SOURCE_CHANGED",
				`Environment file changed: ${file.absolutePath}`,
			);
		}
		previous = file.absolutePath;
	}
	if (!environment.files.some((file) => samePath(file.absolutePath, environment.executablePath))) {
		throw new StudyExecutionEnvironmentError(
			"ENVIRONMENT_EXECUTABLE_UNBOUND",
			"Environment inventory does not include its executable.",
		);
	}
}

async function exactInventory(paths: ReadonlySet<string>): Promise<FrozenEnvironmentFile[]> {
	const files = [...paths].sort(pathCompare);
	const result: FrozenEnvironmentFile[] = [];
	for (const file of files) {
		await assertRegularFileSafe(file, "environment file");
		result.push({ absolutePath: file, sha256: await executionSha256File(file) });
	}
	return result;
}

function makeEnvironment(
	adapterKind: string,
	executablePath: string,
	files: readonly FrozenEnvironmentFile[],
): StudyExecutionEnvironment {
	const partial = { adapterKind, executablePath, files };
	return { ...partial, descriptorHash: frozenEnvironmentDescriptorHash(partial) };
}

async function collectTreeFiles(
	directory: string,
	label: string,
	options: { optional?: boolean; excludeRootDirectories?: ReadonlySet<string> } = {},
	root = directory,
): Promise<string[]> {
	if (!(await exists(directory))) {
		if (options.optional) return [];
		throw new StudyExecutionEnvironmentError("ENVIRONMENT_PATH_MISSING", `${label} does not exist: ${directory}`);
	}
	const canonicalRoot = await canonicalExistingDirectory(root, label);
	const canonicalDirectory = await canonicalExistingDirectory(directory, label);
	if (!isWithin(canonicalRoot, canonicalDirectory)) {
		throw new StudyExecutionEnvironmentError("PROJECT_BOUNDARY_VIOLATION", `${label} escapes its canonical root.`);
	}
	const entries = await readdir(canonicalDirectory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(canonicalDirectory, entry.name);
		if (entry.isSymbolicLink())
			throw new StudyExecutionEnvironmentError("ENVIRONMENT_REPARSE_POINT", `${label} has a reparse point: ${path}`);
		if (entry.isDirectory()) {
			if (canonicalDirectory === canonicalRoot && options.excludeRootDirectories?.has(entry.name)) continue;
			files.push(...(await collectTreeFiles(path, label, options, canonicalRoot)));
		} else if (entry.isFile()) {
			await assertRegularFileSafe(path, label);
			files.push(path);
		} else {
			throw new StudyExecutionEnvironmentError(
				"ENVIRONMENT_ENTRY_UNSUPPORTED",
				`${label} has unsupported entry: ${path}`,
			);
		}
	}
	return files;
}

async function filesAtDirectoryRoot(directory: string, include: (name: string) => boolean): Promise<string[]> {
	const root = await canonicalExistingDirectory(directory, "runtime directory");
	const result: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink())
			throw new StudyExecutionEnvironmentError("ENVIRONMENT_REPARSE_POINT", `Runtime has a reparse point: ${path}`);
		if (entry.isFile() && include(entry.name)) {
			await assertRegularFileSafe(path, "runtime file");
			result.push(path);
		}
	}
	return result;
}

async function assertDirectoryTreeSafe(directory: string, label: string): Promise<void> {
	await collectTreeFiles(directory, label);
}

async function findRHome(rscriptExecutable: string): Promise<string> {
	let current = dirname(rscriptExecutable);
	for (let index = 0; index < 5; index += 1) {
		if ((await exists(join(current, "library"))) && (await exists(join(current, "bin")))) {
			return canonicalExistingDirectory(current, "R_HOME");
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new StudyExecutionEnvironmentError("R_HOME_UNRESOLVED", `Could not derive R_HOME from ${rscriptExecutable}.`);
}

async function discoverRLibraryPaths(rscriptExecutable: string): Promise<string[]> {
	const output = runText(rscriptExecutable, ["--vanilla", "--slave", "-e", "cat(.libPaths(),sep='\\n')"]);
	const paths: string[] = [];
	for (const value of output.split(/\r?\n/u).filter(Boolean)) {
		paths.push(await canonicalExistingDirectory(value, "R library path"));
	}
	const unique = new Map<string, string>();
	for (const path of paths) unique.set(windowsKey(path), path);
	return [...unique.values()];
}

async function findRPackageDirectory(name: string, libraryPaths: readonly string[]): Promise<string | null> {
	for (const libraryPath of libraryPaths) {
		const candidate = join(libraryPath, name);
		if (!(await exists(candidate))) continue;
		const packageDirectory = await canonicalExistingDirectory(candidate, `R package ${name}`);
		await canonicalExistingFile(join(packageDirectory, "DESCRIPTION"), `R package ${name} DESCRIPTION`);
		return packageDirectory;
	}
	return null;
}

/** DESCRIPTION's local dependency declarations form a frozen installed-package closure; this is not a package solver. */
async function rPackageDependencies(packageDirectory: string): Promise<string[]> {
	const description = await readFile(join(packageDirectory, "DESCRIPTION"), "utf8");
	const fields = new Map<string, string>();
	let activeField: string | null = null;
	for (const line of description.split(/\r?\n/u)) {
		const field = /^([A-Za-z][A-Za-z0-9._-]*):\s*(.*)$/u.exec(line);
		if (field) {
			activeField = field[1];
			fields.set(activeField, field[2]);
		} else if (/^\s+/u.test(line) && activeField) {
			fields.set(activeField, `${fields.get(activeField) ?? ""} ${line.trim()}`);
		} else {
			activeField = null;
		}
	}
	const names = new Set<string>();
	for (const field of ["Depends", "Imports", "LinkingTo"]) {
		for (const item of (fields.get(field) ?? "").split(",")) {
			const name = /^\s*([A-Za-z][A-Za-z0-9._-]*)/u.exec(item)?.[1];
			if (name && name !== "R") names.add(name);
		}
	}
	return [...names].sort((left, right) => left.localeCompare(right));
}

async function detectedExecutable(name: "python" | "rscript"): Promise<string> {
	const report = detectStudyPlatform(process.cwd());
	const detected = report.executables[name];
	if (detected.capability.status !== "available" || !detected.executablePath) {
		throw new StudyExecutionEnvironmentError(
			"RUNTIME_UNAVAILABLE",
			`${name} discovery failed: ${detected.diagnostics.join(" ") || detected.capability.detail}`,
		);
	}
	return canonicalExistingFile(detected.executablePath, `${name} executable`);
}

function runJson(executable: string, args: string[]): unknown {
	const result = runText(executable, args);
	try {
		return JSON.parse(result);
	} catch (error) {
		throw new StudyExecutionEnvironmentError(
			"RUNTIME_JSON_INVALID",
			`Runtime emitted invalid JSON: ${errorMessage(error)}`,
		);
	}
}

function runText(executable: string, args: string[]): string {
	const result = spawnSync(executable, args, {
		encoding: "utf8",
		stdio: "pipe",
		windowsHide: true,
		timeout: COMMAND_TIMEOUT_MS,
	});
	if (result.status !== 0)
		throw new StudyExecutionEnvironmentError(
			"RUNTIME_INSPECTION_FAILED",
			commandFailure("Runtime inspection failed", result),
		);
	return String(result.stdout ?? "").trim();
}

async function canonicalExistingFile(path: string, label: string): Promise<string> {
	if (!isAbsolute(path))
		throw new StudyExecutionEnvironmentError("ABSOLUTE_PATH_REQUIRED", `${label} must be an absolute path.`);
	await assertRegularFileSafe(path, label);
	return realpath(path);
}

async function canonicalExistingDirectory(path: string, label: string): Promise<string> {
	if (!isAbsolute(path))
		throw new StudyExecutionEnvironmentError("ABSOLUTE_PATH_REQUIRED", `${label} must be an absolute path.`);
	const item = await lstat(path).catch((error: unknown) => failPath(label, path, error));
	if (item.isSymbolicLink())
		throw new StudyExecutionEnvironmentError("ENVIRONMENT_REPARSE_POINT", `${label} is a reparse point: ${path}`);
	if (!item.isDirectory())
		throw new StudyExecutionEnvironmentError(
			"ENVIRONMENT_DIRECTORY_REQUIRED",
			`${label} is not a directory: ${path}`,
		);
	return realpath(path);
}

async function assertRegularFileSafe(path: string, label: string): Promise<void> {
	const item = await lstat(path).catch((error: unknown) => failPath(label, path, error));
	if (item.isSymbolicLink())
		throw new StudyExecutionEnvironmentError("ENVIRONMENT_REPARSE_POINT", `${label} is a reparse point: ${path}`);
	if (!item.isFile())
		throw new StudyExecutionEnvironmentError("ENVIRONMENT_FILE_REQUIRED", `${label} is not a regular file: ${path}`);
	const canonical = await realpath(path);
	if (!samePath(canonical, path))
		throw new StudyExecutionEnvironmentError(
			"ENVIRONMENT_CANONICAL_PATH_REQUIRED",
			`${label} is not canonical: ${path}`,
		);
}

function assertLexicallyWithin(root: string, candidate: string, label: string): void {
	const value = relative(root, candidate);
	if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
		throw new StudyExecutionEnvironmentError(
			"PROJECT_BOUNDARY_VIOLATION",
			`${label} escapes or equals project directory.`,
		);
	}
}

function assertCanonicalWithin(root: string, candidate: string, label: string): void {
	if (!isWithin(root, candidate) || samePath(root, candidate)) {
		throw new StudyExecutionEnvironmentError(
			"PROJECT_BOUNDARY_VIOLATION",
			`${label} escapes or equals its required root.`,
		);
	}
}

function isWithin(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function samePath(left: string, right: string): boolean {
	return windowsKey(left) === windowsKey(right);
}

function windowsKey(path: string): string {
	return resolve(path).replace(/\\/gu, "/").toLowerCase();
}

function pathCompare(left: string, right: string): number {
	return left.localeCompare(right);
}

async function executionSha256File(path: string): Promise<string> {
	const bytes = await readFile(path);
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function installedDependency(value: unknown, label: string): InstalledDependency {
	if (!value || typeof value !== "object")
		throw new StudyExecutionEnvironmentError("PACKAGE_INVENTORY_INVALID", `${label} is invalid.`);
	const record = value as Record<string, unknown>;
	return {
		name: textField(record, "name"),
		version: textField(record, "version"),
		location: textField(record, "location"),
	};
}

function textField(value: unknown, field: string): string {
	if (
		!value ||
		typeof value !== "object" ||
		typeof (value as Record<string, unknown>)[field] !== "string" ||
		!(value as Record<string, string>)[field].trim()
	) {
		throw new StudyExecutionEnvironmentError(
			"RUNTIME_IDENTITY_INVALID",
			`Runtime identity field ${field} is missing.`,
		);
	}
	return (value as Record<string, string>)[field];
}

function assertWindows(): void {
	if (process.platform !== "win32")
		throw new StudyExecutionEnvironmentError("WINDOWS_REQUIRED", "Windows environment discovery requires Windows.");
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function commandFailure(label: string, result: ReturnType<typeof spawnSync>): string {
	return `${label}: ${String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()}`;
}

function failPath(label: string, path: string, error: unknown): never {
	throw new StudyExecutionEnvironmentError(
		"ENVIRONMENT_PATH_MISSING",
		`${label} is unavailable at ${path}: ${errorMessage(error)}`,
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
