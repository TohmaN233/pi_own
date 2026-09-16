import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contentHash } from "../../harness-core/src/index.ts";

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MD5 = /^md5:[a-f0-9]{32}$/u;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 1_048_576;
const COMMAND_HEARTBEAT_MS = 30_000;

export type EnvironmentPackageLanguage = "python" | "r";
export type EnvironmentPackageChangeKind = "install" | "upgrade" | "downgrade" | "unchanged";

export interface EnvironmentPackageRequest {
	name: string;
	version: string | null;
}

/** Python follows PEP 503; R keeps its package spelling but treats casing consistently. */
export function environmentPackageIdentity(language: EnvironmentPackageLanguage, name: string): string {
	const lower = name.toLowerCase();
	return language === "python" ? lower.replace(/[-_.]+/gu, "-") : lower;
}

/** The browser version field denotes one exact version, never a requirement expression, URL, or marker. */
export function isExactEnvironmentPackageVersion(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,255}$/u.test(value);
}

export interface EnvironmentInstalledPackage {
	name: string;
	version: string;
	location: string;
}

export interface ResolvedEnvironmentPackage {
	name: string;
	version: string;
	source: string;
	/** Python plans require SHA-256; CRAN's resolver exposes the archive MD5. */
	sourceHash: string;
	change: EnvironmentPackageChangeKind;
	direct: boolean;
}

export interface EnvironmentPackagePlan {
	planId: string;
	language: EnvironmentPackageLanguage;
	projectDirectory: string;
	environmentDirectory: string;
	executablePath: string;
	requests: readonly EnvironmentPackageRequest[];
	inventory: readonly EnvironmentInstalledPackage[];
	inventoryHash: string;
	packages: readonly ResolvedEnvironmentPackage[];
	requiresExistingChangeConsent: boolean;
	resolver: "pip-report-v1" | "cran-available-packages-v1";
	createdAt: string;
	contentHash: string;
}

export interface EnvironmentPackageExecutionResult {
	installed: readonly ResolvedEnvironmentPackage[];
	finalInventory: readonly EnvironmentInstalledPackage[];
	finalInventoryHash: string;
	validatedAt: string;
}

/** A Windows process identity includes creation time so a recycled PID is never terminated. */
export interface EnvironmentPackageProcessIdentity {
	pid: number;
	startedAt: string;
	/** Exact Windows FILETIME creation value emitted by the supervisor, never a reusable PID. */
	processCreationIdentity?: string;
	/** A gated Windows supervisor owns the installer Job and all of its descendants. */
	supervisorExecutablePath?: string;
}

export type EnvironmentPackageProcessObservation = "running" | "exited" | "stale";

export class EnvironmentPackageChangeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EnvironmentPackageChangeError";
		this.code = code;
	}
}

export async function inspectEnvironmentPackages(input: {
	language: EnvironmentPackageLanguage;
	executablePath: string;
	environmentDirectory: string;
	onProgress?: () => void;
}): Promise<readonly EnvironmentInstalledPackage[]> {
	const executablePath = requiredAbsolutePath(input.executablePath, "package executable");
	const environmentDirectory = requiredAbsolutePath(input.environmentDirectory, "package environment directory");
	if (input.language === "r") {
		const result = await runTrustedCommand(
			executablePath,
			[
				"--vanilla",
				"--slave",
				"-e",
				"x<-installed.packages(fields=c('Package','Version','LibPath'));writeLines(paste(x[,'Package'],x[,'Version'],x[,'LibPath'],sep='\\t'))",
			],
			{ R_LIBS_USER: environmentDirectory },
			input.onProgress,
		);
		const rows = result.stdout
			.split(/\r?\n/u)
			.filter(Boolean)
			.map((line) => {
				const fields = line.split("\t");
				if (fields.length !== 3)
					throw new EnvironmentPackageChangeError(
						"PACKAGE_INVENTORY_INVALID",
						"R package inventory row is invalid",
					);
				return { name: fields[0], version: fields[1], location: fields[2] };
			});
		return normalizeInventory(rows, "r", environmentDirectory, false, true);
	}
	const result = await runTrustedCommand(
		executablePath,
		[
			"-I",
			"-c",
			"import importlib.metadata as m,json;print(json.dumps(sorted([{'name':d.metadata['Name'] or d.name,'version':d.version,'location':str(d.locate_file(''))} for d in m.distributions()],key=lambda x:x['name'].lower())))",
		],
		{},
		input.onProgress,
	);
	const value = parseJson(result.stdout, "package inventory");
	if (!Array.isArray(value))
		throw new EnvironmentPackageChangeError("PACKAGE_INVENTORY_INVALID", "package inventory is not an array");
	return normalizeInventory(value, "python", environmentDirectory, true, false);
}

/** Resolves only via the selected runtime's package manager; callers cannot inject a command, shell, or repository. */
export async function planEnvironmentPackageChanges(input: {
	language: EnvironmentPackageLanguage;
	projectDirectory: string;
	environmentDirectory: string;
	executablePath: string;
	requests: readonly EnvironmentPackageRequest[];
	/** Test-only offline resolver source. Production callers deliberately never expose this to a browser request. */
	localWheelDirectory?: string;
	/** Test-only offline CRAN source. It must stay inside the isolated R user library. */
	localRRepositoryDirectory?: string;
}): Promise<EnvironmentPackagePlan> {
	const projectDirectory = requiredAbsolutePath(input.projectDirectory, "project directory");
	const environmentDirectory = requiredAbsolutePath(input.environmentDirectory, "package environment directory");
	const executablePath = requiredAbsolutePath(input.executablePath, "package executable");
	assertEnvironmentWithinProject(input.language, projectDirectory, environmentDirectory);
	const localWheelDirectory =
		input.localWheelDirectory === undefined
			? null
			: requiredAbsolutePath(input.localWheelDirectory, "local wheel directory");
	const localRRepositoryDirectory =
		input.localRRepositoryDirectory === undefined
			? null
			: requiredAbsolutePath(input.localRRepositoryDirectory, "local R repository directory");
	if (
		localWheelDirectory !== null &&
		(input.language !== "python" || !isWithin(environmentDirectory, localWheelDirectory))
	)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_LOCAL_SOURCE_INVALID",
			"offline fixture wheels must remain inside the selected Python environment",
		);
	if (
		localRRepositoryDirectory !== null &&
		(input.language !== "r" || !isWithin(environmentDirectory, localRRepositoryDirectory))
	)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_LOCAL_SOURCE_INVALID",
			"offline fixture R repository must remain inside the selected R user library",
		);
	const requests = normalizeRequests(input.language, input.requests);
	const inventory = await inspectEnvironmentPackages({
		language: input.language,
		executablePath,
		environmentDirectory,
	});
	const packages =
		input.language === "python"
			? await resolvePythonPackages({ executablePath, requests, inventory, localWheelDirectory })
			: await resolveRPackages({
					context: {
						executablePath,
						environmentDirectory,
						requests,
						inventory,
					},
					repositoryUrl:
						localRRepositoryDirectory === null
							? "https://cloud.r-project.org"
							: pathToFileURL(localRRepositoryDirectory).href,
					localRepositoryDirectory: localRRepositoryDirectory,
				});
	const value = {
		planId: `environment-package-plan-${randomUUID()}`,
		language: input.language,
		projectDirectory,
		environmentDirectory,
		executablePath,
		requests,
		inventory,
		inventoryHash: inventoryHash(inventory),
		packages,
		requiresExistingChangeConsent: packages.some(
			(entry) => entry.change === "upgrade" || entry.change === "downgrade",
		),
		resolver: input.language === "python" ? ("pip-report-v1" as const) : ("cran-available-packages-v1" as const),
		createdAt: new Date().toISOString(),
	};
	return { ...value, contentHash: contentHash(value) };
}

/** Installs the previously resolved immutable plan and refuses inventory drift or unpinned Python sources. */
export async function executeEnvironmentPackagePlan(input: {
	plan: EnvironmentPackagePlan;
	workDirectory: string;
	/** Renews the durable worker lease during every trusted runtime command. */
	onProgress?: () => void;
	/** The worker persists this only around the one command that may mutate a package library. */
	onInstallerStarted?: (identity: EnvironmentPackageProcessIdentity) => void;
	onInstallerExited?: (identity: EnvironmentPackageProcessIdentity) => void;
}): Promise<EnvironmentPackageExecutionResult> {
	const plan = validatePlan(input.plan);
	const workDirectory = requiredAbsolutePath(input.workDirectory, "operation work directory");
	await mkdir(workDirectory, { recursive: true });
	input.onProgress?.();
	const current = await inspectEnvironmentPackages({ ...plan, onProgress: input.onProgress });
	if (inventoryHash(current) !== plan.inventoryHash) {
		throw new EnvironmentPackageChangeError(
			"PACKAGE_INVENTORY_STALE",
			"package inventory changed after planning; create a new plan before installing",
		);
	}
	const changed = plan.packages.filter((entry) => entry.change !== "unchanged");
	const processObserver: TrustedCommandProcessObserver | undefined =
		input.onInstallerStarted || input.onInstallerExited
			? {
					onStarted: input.onInstallerStarted,
					onExited: input.onInstallerExited,
					supervisorDirectory: workDirectory,
				}
			: undefined;
	if (changed.length > 0) {
		if (plan.language === "python")
			await installPythonPlan(plan, changed, workDirectory, input.onProgress, processObserver);
		else await installRPlan(plan, changed, workDirectory, input.onProgress, processObserver);
	}
	const finalInventory = await inspectEnvironmentPackages({ ...plan, onProgress: input.onProgress });
	validateFinalInventory(plan, finalInventory);
	return {
		installed: changed,
		finalInventory,
		finalInventoryHash: inventoryHash(finalInventory),
		validatedAt: new Date().toISOString(),
	};
}

function normalizeRequests(
	language: EnvironmentPackageLanguage,
	value: readonly EnvironmentPackageRequest[],
): EnvironmentPackageRequest[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 64)
		throw new EnvironmentPackageChangeError("PACKAGE_REQUEST_INVALID", "request one through 64 package names");
	const names = new Set<string>();
	return value
		.map((entry) => {
			const identity =
				entry && typeof entry.name === "string" ? environmentPackageIdentity(language, entry.name) : null;
			if (!entry || !PACKAGE_NAME.test(entry.name) || !identity || names.has(identity))
				throw new EnvironmentPackageChangeError(
					"PACKAGE_REQUEST_INVALID",
					"package names must be unique safe identifiers",
				);
			const version = entry.version === null || entry.version === undefined ? null : boundedVersion(entry.version);
			names.add(identity);
			return { name: entry.name, version };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function resolvePythonPackages(input: {
	executablePath: string;
	requests: readonly EnvironmentPackageRequest[];
	inventory: readonly EnvironmentInstalledPackage[];
	localWheelDirectory: string | null;
}): Promise<ResolvedEnvironmentPackage[]> {
	const report = await runTrustedCommand(input.executablePath, [
		"-I",
		"-m",
		"pip",
		"install",
		"--dry-run",
		"--report",
		"-",
		"--quiet",
		"--disable-pip-version-check",
		"--no-input",
		"--isolated",
		"--only-binary=:all:",
		...(input.localWheelDirectory === null
			? ["--index-url", "https://pypi.org/simple"]
			: ["--no-index", "--find-links", input.localWheelDirectory]),
		...input.requests.map(pythonRequirement),
	]);
	const value = parseJson(report.stdout, "pip resolution report") as Record<string, unknown>;
	if (!Array.isArray(value.install))
		throw new EnvironmentPackageChangeError("PYTHON_RESOLUTION_INVALID", "pip report has no install list");
	const requested = new Set(input.requests.map((entry) => environmentPackageIdentity("python", entry.name)));
	const installed = effectiveInstalledPackages("python", input.inventory, null);
	const resolved = value.install.map((raw) => {
		if (!raw || typeof raw !== "object")
			throw new EnvironmentPackageChangeError("PYTHON_RESOLUTION_INVALID", "pip report entry is invalid");
		const entry = raw as Record<string, unknown>;
		const metadata = entry.metadata as Record<string, unknown> | undefined;
		const download = entry.download_info as Record<string, unknown> | undefined;
		const archive = download?.archive_info as Record<string, unknown> | undefined;
		const hashes = archive?.hashes as Record<string, unknown> | undefined;
		const name = requiredPackageName(metadata?.name, "pip resolved package name");
		const version = boundedVersion(metadata?.version);
		const source = requiredText(download?.url, "pip resolved package source", 8_000);
		assertPythonSource(source, input.localWheelDirectory);
		const sha = typeof hashes?.sha256 === "string" ? `sha256:${hashes.sha256.toLowerCase()}` : null;
		if (!sha || !SHA256.test(sha))
			throw new EnvironmentPackageChangeError(
				"PYTHON_SOURCE_UNPINNED",
				`pip did not provide a SHA-256 source for ${name}`,
			);
		const prior = installed.get(environmentPackageIdentity("python", name)) ?? null;
		return {
			name,
			version,
			source,
			sourceHash: sha,
			change: changeFor(prior?.version ?? null, version),
			direct: requested.has(environmentPackageIdentity("python", name)),
		};
	});
	for (const request of input.requests) {
		if (
			resolved.some(
				(entry) =>
					environmentPackageIdentity("python", entry.name) === environmentPackageIdentity("python", request.name),
			)
		)
			continue;
		const prior = installed.get(environmentPackageIdentity("python", request.name));
		if (!prior)
			throw new EnvironmentPackageChangeError("PYTHON_RESOLUTION_INVALID", `pip did not resolve ${request.name}`);
		if (request.version !== null && request.version !== prior.version)
			throw new EnvironmentPackageChangeError(
				"PYTHON_RESOLUTION_INVALID",
				`pip did not resolve requested ${request.name} ${request.version}`,
			);
		resolved.push({
			name: prior.name,
			version: prior.version,
			source: `installed:${prior.location}`,
			sourceHash: contentHash({ name: prior.name, version: prior.version, location: prior.location }),
			change: "unchanged",
			direct: true,
		});
	}
	return resolved.sort(packageCompare);
}

async function resolveRPackages(input: {
	context: {
		executablePath: string;
		environmentDirectory: string;
		requests: readonly EnvironmentPackageRequest[];
		inventory: readonly EnvironmentInstalledPackage[];
	};
	repositoryUrl: string;
	localRepositoryDirectory: string | null;
}): Promise<ResolvedEnvironmentPackage[]> {
	const requestedPackages = input.context.requests.map((entry) => `${entry.name}\t${entry.version ?? ""}`).join("\n");
	const code =
		"raw<-strsplit(Sys.getenv('PI_STUDY_PACKAGE_REQUESTS'),'\\n',fixed=TRUE)[[1]];raw<-raw[nzchar(raw)];parts<-strsplit(raw,'\\t',fixed=TRUE);direct<-vapply(parts,`[[`,'',1);requested<-vapply(parts,function(x)if(length(x)>1)x[[2]]else'', '');repos<-Sys.getenv('PI_STUDY_R_REPOSITORY');if(!nzchar(repos))stop('fixed R source repository was not configured');ap<-available.packages(repos=repos,type='source');if(any(!(direct%in%rownames(ap))))stop(paste('unresolved package',paste(direct[!(direct%in%rownames(ap))],collapse=', ')));for(i in seq_along(direct)){if(nzchar(requested[[i]])&&ap[direct[[i]],'Version']!=requested[[i]])stop(paste('requested R version is unavailable from the fixed source repository',direct[[i]],requested[[i]]))};seen<-character();ordered<-character();visit<-function(n){if(n%in%seen)return(invisible(NULL));seen<<-c(seen,n);deps<-tools::package_dependencies(n,db=ap,which=c('Depends','Imports','LinkingTo'),recursive=FALSE)[[1]];for(d in deps)visit(d);ordered<<-c(ordered,n);invisible(NULL)};for(n in direct)visit(n);contrib<-contrib.url(repos,type='source');for(n in ordered){if(!(n%in%rownames(ap)))stop(paste('unresolved package',n));md5<-tolower(ap[n,'MD5sum']);if(is.na(md5)||!nzchar(md5))stop(paste('source MD5 is unavailable',n));writeLines(paste(n,ap[n,'Version'],paste0(contrib,'/',n,'_',ap[n,'Version'],'.tar.gz'),paste0('md5:',md5),ifelse(n%in%direct,'direct','transitive'),sep='\\t'))}";
	const response = await runTrustedCommand(input.context.executablePath, ["--vanilla", "--slave", "-e", code], {
		R_LIBS_USER: input.context.environmentDirectory,
		PI_STUDY_PACKAGE_REQUESTS: requestedPackages,
		PI_STUDY_R_REPOSITORY: input.repositoryUrl,
	});
	const installed = effectiveInstalledPackages("r", input.context.inventory, input.context.environmentDirectory);
	return response.stdout
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => {
			const fields = line.split("\t");
			if (fields.length !== 5)
				throw new EnvironmentPackageChangeError("R_RESOLUTION_INVALID", "R resolver row is invalid");
			const [rawName, rawVersion, rawSource, rawHash, kind] = fields;
			const name = requiredPackageName(rawName, "R resolved package name");
			const version = boundedVersion(rawVersion);
			const sourceHash = requiredText(rawHash, "R resolved package MD5", 80).toLowerCase();
			if (!MD5.test(sourceHash))
				throw new EnvironmentPackageChangeError("R_SOURCE_UNPINNED", `CRAN did not publish an MD5 for ${name}`);
			assertRSource(rawSource, input.repositoryUrl, input.localRepositoryDirectory);
			return {
				name,
				version,
				source: requiredText(rawSource, "R resolved package source", 8_000),
				sourceHash,
				change: changeFor(installed.get(environmentPackageIdentity("r", name))?.version ?? null, version),
				direct: kind === "direct",
			};
		});
}

async function installPythonPlan(
	plan: EnvironmentPackagePlan,
	changed: readonly ResolvedEnvironmentPackage[],
	workDirectory: string,
	onProgress?: () => void,
	processObserver?: TrustedCommandProcessObserver,
): Promise<void> {
	const requirementsPath = join(workDirectory, "python-requirements.txt");
	const contents = `${changed.map((entry) => `${entry.source} --hash=${entry.sourceHash}`).join("\n")}\n`;
	await writeFile(requirementsPath, contents, "utf8");
	await runTrustedCommand(
		plan.executablePath,
		[
			"-I",
			"-m",
			"pip",
			"install",
			"--no-deps",
			"--require-hashes",
			"--no-input",
			"--disable-pip-version-check",
			"--no-user",
			"--isolated",
			"-r",
			requirementsPath,
		],
		{},
		onProgress,
		undefined,
		processObserver,
	);
}

async function installRPlan(
	plan: EnvironmentPackagePlan,
	changed: readonly ResolvedEnvironmentPackage[],
	workDirectory: string,
	onProgress?: () => void,
	processObserver?: TrustedCommandProcessObserver,
): Promise<void> {
	const sourcePath = join(workDirectory, "r-sources.tsv");
	const rows = changed.map((entry) => [entry.name, entry.version, entry.source, entry.sourceHash].join("\t"));
	await writeFile(sourcePath, `${rows.join("\n")}\n`, "utf8");
	const code =
		"x<-read.delim(Sys.getenv('PI_STUDY_R_SOURCES'),sep='\\t',header=FALSE,stringsAsFactors=FALSE,quote='',comment.char='',col.names=c('name','version','source','sourceHash'));wd<-Sys.getenv('PI_STUDY_PACKAGE_WORK');dir.create(wd,recursive=TRUE,showWarnings=FALSE);for(i in seq_len(nrow(x))){p<-file.path(wd,paste0(x$name[i],'_',x$version[i],'.tar.gz'));download.file(x$source[i],p,mode='wb',quiet=TRUE);if(tolower(unname(tools::md5sum(p)))!=sub('^md5:','',x$sourceHash[i]))stop(paste('source hash mismatch',x$name[i]));install.packages(p,repos=NULL,type='source',lib=Sys.getenv('R_LIBS_USER'))}";
	await runTrustedCommand(
		plan.executablePath,
		["--vanilla", "--slave", "-e", code],
		{
			R_LIBS_USER: plan.environmentDirectory,
			PI_STUDY_R_SOURCES: sourcePath,
			PI_STUDY_PACKAGE_WORK: workDirectory,
		},
		onProgress,
		undefined,
		processObserver,
	);
}

export function validateFinalInventory(
	plan: EnvironmentPackagePlan,
	finalInventory: readonly EnvironmentInstalledPackage[],
): void {
	const finalByLocation = inventoryByIdentityAndLocation(plan.language, finalInventory, "final");
	const initialByLocation = inventoryByIdentityAndLocation(plan.language, plan.inventory, "initial");
	const planned = resolvedPackagesByIdentity(plan.language, plan.packages);
	const initialEffective = effectiveInstalledPackages(plan.language, plan.inventory, plan.environmentDirectory);
	const finalEffective = effectiveInstalledPackages(plan.language, finalInventory, plan.environmentDirectory);
	let expectedCount = initialByLocation.size;
	for (const [identity, expected] of planned) {
		if (expected.change === "unchanged") continue;
		const initial = initialEffective.get(identity);
		if (!initial || !isSameOrWithin(plan.environmentDirectory, initial.location)) expectedCount++;
	}
	if (finalByLocation.size !== expectedCount)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_FINAL_VALIDATION_FAILED",
			"final inventory contains unapproved package additions or removals",
		);
	for (const expected of plan.packages) {
		const identity = environmentPackageIdentity(plan.language, expected.name);
		const found = finalEffective.get(identity);
		if (!found || found.version !== expected.version)
			throw new EnvironmentPackageChangeError(
				"PACKAGE_FINAL_VALIDATION_FAILED",
				`final inventory does not contain ${expected.name} ${expected.version}`,
			);
		if (expected.change !== "unchanged" && !isSameOrWithin(plan.environmentDirectory, found.location))
			throw new EnvironmentPackageChangeError(
				"PACKAGE_FINAL_VALIDATION_FAILED",
				`final inventory did not place ${expected.name} in the selected package environment`,
			);
	}
	for (const [locationIdentity, expected] of initialByLocation) {
		const identity = environmentPackageIdentity(plan.language, expected.name);
		const plannedPackage = planned.get(identity);
		const mayChangeHere =
			plannedPackage !== undefined &&
			plannedPackage.change !== "unchanged" &&
			initialEffective.get(identity) === expected &&
			isSameOrWithin(plan.environmentDirectory, expected.location);
		if (mayChangeHere) continue;
		const found = finalByLocation.get(locationIdentity);
		if (!found || found.version !== expected.version || found.location !== expected.location)
			throw new EnvironmentPackageChangeError(
				"PACKAGE_FINAL_VALIDATION_FAILED",
				`final inventory changed unapproved package ${expected.name}`,
			);
	}
}

function inventoryByIdentityAndLocation(
	language: EnvironmentPackageLanguage,
	inventory: readonly EnvironmentInstalledPackage[],
	label: string,
): Map<string, EnvironmentInstalledPackage> {
	const entries = new Map<string, EnvironmentInstalledPackage>();
	for (const entry of inventory) {
		const key = `${environmentPackageIdentity(language, entry.name)}\u0000${resolve(entry.location).toLowerCase()}`;
		if (entries.has(key))
			throw new EnvironmentPackageChangeError(
				"PACKAGE_FINAL_VALIDATION_FAILED",
				`${label} inventory repeats ${entry.name} at one library location`,
			);
		entries.set(key, entry);
	}
	return entries;
}

function resolvedPackagesByIdentity(
	language: EnvironmentPackageLanguage,
	packages: readonly ResolvedEnvironmentPackage[],
): Map<string, ResolvedEnvironmentPackage> {
	const entries = new Map<string, ResolvedEnvironmentPackage>();
	for (const entry of packages) {
		const identity = environmentPackageIdentity(language, entry.name);
		if (entries.has(identity))
			throw new EnvironmentPackageChangeError(
				"PACKAGE_FINAL_VALIDATION_FAILED",
				`package plan repeats normalized package identity ${entry.name}`,
			);
		entries.set(identity, entry);
	}
	return entries;
}

function validatePlan(plan: EnvironmentPackagePlan): EnvironmentPackagePlan {
	if (!plan || typeof plan !== "object" || !SHA256.test(plan.contentHash))
		throw new EnvironmentPackageChangeError("PACKAGE_PLAN_INVALID", "package plan is invalid");
	const { contentHash: expectedHash, ...value } = plan;
	if (contentHash(value) !== expectedHash)
		throw new EnvironmentPackageChangeError("PACKAGE_PLAN_TAMPERED", "package plan content hash changed");
	if (!Array.isArray(plan.packages) || plan.packages.length < 1)
		throw new EnvironmentPackageChangeError("PACKAGE_PLAN_INVALID", "package plan has no resolved packages");
	return structuredClone(plan);
}

function normalizeInventory(
	value: readonly unknown[],
	language: EnvironmentPackageLanguage,
	environmentDirectory: string,
	requireEnvironmentBoundary: boolean,
	preserveRuntimeOrder: boolean,
): EnvironmentInstalledPackage[] {
	const packageLocations = new Set<string>();
	const packageNames = new Set<string>();
	const normalized = value.map((raw) => {
		if (!raw || typeof raw !== "object")
			throw new EnvironmentPackageChangeError("PACKAGE_INVENTORY_INVALID", "package inventory entry is invalid");
		const entry = raw as Record<string, unknown>;
		const name = requiredPackageName(entry.name, "installed package name");
		const location = requiredAbsolutePath(
			requiredText(entry.location, "installed package location", 32_000),
			"installed package location",
		);
		const packageIdentity = environmentPackageIdentity(language, name);
		const identity = `${packageIdentity}\u0000${location.toLowerCase()}`;
		if (packageLocations.has(identity))
			throw new EnvironmentPackageChangeError(
				"PACKAGE_INVENTORY_INVALID",
				"package inventory repeats a package identity and location",
			);
		if (language === "python" && packageNames.has(packageIdentity))
			throw new EnvironmentPackageChangeError(
				"PACKAGE_INVENTORY_INVALID",
				"Python package inventory repeats a normalized package identity",
			);
		packageLocations.add(identity);
		packageNames.add(packageIdentity);
		if (requireEnvironmentBoundary && !isWithin(environmentDirectory, location))
			throw new EnvironmentPackageChangeError(
				"PACKAGE_INVENTORY_BOUNDARY",
				"package inventory escaped selected environment",
			);
		return { name, version: boundedVersion(entry.version), location };
	});
	return preserveRuntimeOrder ? normalized : normalized.sort(packageCompare);
}

/** R may expose one package from each library; the isolated user library has precedence when present. */
function effectiveInstalledPackages(
	language: EnvironmentPackageLanguage,
	inventory: readonly EnvironmentInstalledPackage[],
	environmentDirectory: string | null,
): Map<string, EnvironmentInstalledPackage> {
	const effective = new Map<string, EnvironmentInstalledPackage>();
	for (const entry of inventory) {
		const identity = environmentPackageIdentity(language, entry.name);
		const prior = effective.get(identity);
		if (!prior) {
			effective.set(identity, entry);
			continue;
		}
		if (
			environmentDirectory !== null &&
			isSameOrWithin(environmentDirectory, entry.location) &&
			!isSameOrWithin(environmentDirectory, prior.location)
		)
			effective.set(identity, entry);
	}
	return effective;
}

function inventoryHash(value: readonly EnvironmentInstalledPackage[]): string {
	return contentHash(value.map((entry) => ({ name: entry.name, version: entry.version, location: entry.location })));
}

function changeFor(installed: string | null, resolved: string): EnvironmentPackageChangeKind {
	if (installed === null) return "install";
	if (installed === resolved) return "unchanged";
	return installed.localeCompare(resolved, undefined, { numeric: true }) < 0 ? "upgrade" : "downgrade";
}

function pythonRequirement(entry: EnvironmentPackageRequest): string {
	return entry.version ? `${entry.name}==${entry.version}` : entry.name;
}

/** Pip preview only reaches the fixed public wheel host, or a fixture wheel inside the isolated venv. */
function assertPythonSource(source: string, localWheelDirectory: string | null): void {
	let parsed: URL;
	try {
		parsed = new URL(source);
	} catch {
		throw new EnvironmentPackageChangeError("PYTHON_SOURCE_INVALID", "pip returned an invalid package source URL");
	}
	if (parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "files.pythonhosted.org") return;
	if (parsed.protocol === "file:" && localWheelDirectory !== null) {
		let filePath: string;
		try {
			filePath = fileURLToPath(parsed);
		} catch {
			throw new EnvironmentPackageChangeError(
				"PYTHON_SOURCE_INVALID",
				"pip returned an invalid local fixture source",
			);
		}
		if (isWithin(localWheelDirectory, filePath)) return;
	}
	throw new EnvironmentPackageChangeError("PYTHON_SOURCE_INVALID", "pip resolved a package from an unapproved source");
}

/** CRAN plans are either from the fixed public source tree or an isolated in-library fixture repository. */
function assertRSource(source: string, repositoryUrl: string, localRepositoryDirectory: string | null): void {
	let parsed: URL;
	try {
		parsed = new URL(source);
	} catch {
		throw new EnvironmentPackageChangeError("R_SOURCE_INVALID", "R resolved an invalid package source URL");
	}
	if (localRepositoryDirectory === null) {
		if (
			parsed.protocol === "https:" &&
			parsed.hostname.toLowerCase() === "cloud.r-project.org" &&
			parsed.pathname.startsWith("/src/contrib/")
		)
			return;
		throw new EnvironmentPackageChangeError(
			"R_SOURCE_INVALID",
			"R resolved a package outside the fixed CRAN source tree",
		);
	}
	if (parsed.protocol !== "file:")
		throw new EnvironmentPackageChangeError(
			"R_SOURCE_INVALID",
			"fixture R resolver did not return a local source archive",
		);
	let filePath: string;
	try {
		filePath = fileURLToPath(parsed);
	} catch {
		throw new EnvironmentPackageChangeError("R_SOURCE_INVALID", "R resolved an invalid local fixture source");
	}
	if (!isWithin(join(localRepositoryDirectory, "src", "contrib"), filePath))
		throw new EnvironmentPackageChangeError("R_SOURCE_INVALID", "fixture R source escaped the isolated repository");
	if (!repositoryUrl.startsWith("file:"))
		throw new EnvironmentPackageChangeError("R_SOURCE_INVALID", "fixture R resolver repository is not local");
}

function packageCompare(left: { name: string }, right: { name: string }): number {
	return left.name.localeCompare(right.name);
}

function requiredPackageName(value: unknown, label: string): string {
	const result = requiredText(value, label, 128);
	if (!PACKAGE_NAME.test(result))
		throw new EnvironmentPackageChangeError("PACKAGE_NAME_INVALID", `${label} is invalid`);
	return result;
}

function boundedVersion(value: unknown): string {
	const version = requiredText(value, "package version", 256);
	if (!isExactEnvironmentPackageVersion(version))
		throw new EnvironmentPackageChangeError(
			"PACKAGE_VALUE_INVALID",
			"package version must be one exact version, not a requirement expression or URL",
		);
	return version;
}

function requiredText(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
		throw new EnvironmentPackageChangeError("PACKAGE_VALUE_INVALID", `${label} is invalid`);
	return value.trim();
}

function requiredAbsolutePath(value: string, label: string): string {
	if (!isAbsolute(value)) throw new EnvironmentPackageChangeError("PACKAGE_PATH_INVALID", `${label} must be absolute`);
	return resolve(value);
}

function assertEnvironmentWithinProject(
	language: EnvironmentPackageLanguage,
	projectDirectory: string,
	environmentDirectory: string,
): void {
	if (language === "python" && resolve(projectDirectory, ".study-python-venv") !== environmentDirectory)
		throw new EnvironmentPackageChangeError(
			"PYTHON_ENVIRONMENT_INVALID",
			"Python packages may only target the project's .study-python-venv",
		);
}

function isWithin(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root).replace(/\\/gu, "/").toLowerCase();
	const normalizedCandidate = resolve(candidate).replace(/\\/gu, "/").toLowerCase();
	return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function isSameOrWithin(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root).replace(/\\/gu, "/").toLowerCase();
	const normalizedCandidate = resolve(candidate).replace(/\\/gu, "/").toLowerCase();
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new EnvironmentPackageChangeError("PACKAGE_RUNTIME_JSON_INVALID", `${label} is not JSON`);
	}
}

export async function runTrustedCommand(
	executablePath: string,
	args: readonly string[],
	environment: Record<string, string> = {},
	onProgress?: () => void,
	limits: { timeoutMs: number; outputLimitBytes: number; heartbeatMs: number } = {
		timeoutMs: COMMAND_TIMEOUT_MS,
		outputLimitBytes: COMMAND_OUTPUT_LIMIT_BYTES,
		heartbeatMs: COMMAND_HEARTBEAT_MS,
	},
	processObserver?: TrustedCommandProcessObserver,
) {
	for (const [key, maximum] of [
		["timeoutMs", COMMAND_TIMEOUT_MS],
		["outputLimitBytes", COMMAND_OUTPUT_LIMIT_BYTES],
		["heartbeatMs", COMMAND_HEARTBEAT_MS],
	] as const) {
		if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum)
			throw new EnvironmentPackageChangeError("PACKAGE_COMMAND_LIMIT_INVALID", `Invalid trusted command ${key}`);
	}
	try {
		onProgress?.();
	} catch (error) {
		throw new EnvironmentPackageChangeError(
			"PACKAGE_WORKER_LEASE_FAILED",
			error instanceof Error ? error.message : String(error),
		);
	}
	const gatedSupervisor = processObserver
		? await prepareGatedEnvironmentPackageSupervisor(processObserver, executablePath, args, limits.timeoutMs)
		: null;
	return await new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
		const child = spawn(gatedSupervisor?.executablePath ?? executablePath, gatedSupervisor?.args ?? [...args], {
			cwd: process.cwd(),
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			// The supervisor creates the installer with CreateProcess and therefore its
			// environment is the installer's environment. Keep package-manager inputs
			// such as R_LIBS_USER and the immutable source/work paths across the gate.
			env: { ...process.env, ...environment },
		});
		let processIdentity: EnvironmentPackageProcessIdentity | null = null;
		let stdout = "",
			stderr = "",
			terminalError: EnvironmentPackageChangeError | null = null,
			settled = false;
		let termination: Promise<void> | null = null;
		let supervisorReadyBuffer = "";
		let supervisorReleased = gatedSupervisor === null;
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(heartbeat);
			callback();
		};
		const terminate = (error: EnvironmentPackageChangeError) => {
			if (terminalError) return;
			terminalError = error;
			termination = (
				processIdentity?.supervisorExecutablePath
					? terminateEnvironmentPackageProcessTree(processIdentity)
					: terminateTrustedCommandTree(child)
			).then(
				() => undefined,
				(failure: unknown) => {
					terminalError = new EnvironmentPackageChangeError(
						"PACKAGE_COMMAND_TREE_TERMINATION_FAILED",
						`${error.code}: ${failure instanceof Error ? failure.message : String(failure)}`,
					);
					console.error("[study-environment] package process tree termination failed", {
						pid: child.pid,
						error: terminalError.message,
					});
				},
			);
		};
		const timer = setTimeout(
			() =>
				terminate(
					new EnvironmentPackageChangeError("PACKAGE_COMMAND_TIMEOUT", "trusted package command timed out"),
				),
			limits.timeoutMs,
		);
		const heartbeat = setInterval(() => {
			try {
				onProgress?.();
			} catch (error) {
				terminate(
					new EnvironmentPackageChangeError(
						"PACKAGE_WORKER_LEASE_FAILED",
						error instanceof Error ? error.message : String(error),
					),
				);
			}
		}, limits.heartbeatMs);
		const append = (current: "stdout" | "stderr", value: string | Buffer) => {
			if (terminalError) return;
			const text = String(value);
			if (
				Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") + Buffer.byteLength(text, "utf8") >
				limits.outputLimitBytes
			) {
				terminate(
					new EnvironmentPackageChangeError(
						"PACKAGE_COMMAND_OUTPUT_LIMIT",
						"trusted package command exceeded its 1 MiB output limit",
					),
				);
				return;
			}
			if (current === "stdout") stdout += text;
			else stderr += text;
		};
		const releaseGatedSupervisor = (
			remainingOutput: string,
			identity: Pick<EnvironmentPackageProcessIdentity, "startedAt" | "processCreationIdentity">,
		) => {
			if (!gatedSupervisor || supervisorReleased) return;
			try {
				if (!child.pid)
					throw new EnvironmentPackageChangeError(
						"PACKAGE_PROCESS_OBSERVATION_FAILED",
						"durable package supervisor disappeared before it was recorded",
					);
				processIdentity = { pid: child.pid, ...identity, supervisorExecutablePath: gatedSupervisor.executablePath };
				processObserver?.onStarted?.(processIdentity);
				writeFileSync(gatedSupervisor.releaseFile, gatedSupervisor.gateToken, { encoding: "utf8", flag: "wx" });
				supervisorReleased = true;
				if (remainingOutput) append("stdout", remainingOutput);
			} catch (error) {
				terminate(
					error instanceof EnvironmentPackageChangeError
						? error
						: new EnvironmentPackageChangeError(
								"PACKAGE_DURABLE_REGISTRATION_FAILED",
								error instanceof Error ? error.message : String(error),
							),
				);
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (value) => {
			if (!gatedSupervisor || supervisorReleased) {
				append("stdout", value);
				return;
			}
			supervisorReadyBuffer += String(value);
			const newline = supervisorReadyBuffer.indexOf("\n");
			if (newline < 0) {
				if (supervisorReadyBuffer.length > 1024)
					terminate(
						new EnvironmentPackageChangeError(
							"PACKAGE_SUPERVISOR_PROTOCOL_INVALID",
							"durable package supervisor did not emit a valid gate record",
						),
					);
				return;
			}
			const marker = supervisorReadyBuffer.slice(0, newline).replace(/\r$/u, "");
			const remaining = supervisorReadyBuffer.slice(newline + 1);
			supervisorReadyBuffer = "";
			const match = new RegExp(
				`^@pi-environment-supervisor-ready ${gatedSupervisor.gateToken} (\\S+) (\\d{17,20})$`,
				"u",
			).exec(marker);
			if (!match || !Number.isFinite(Date.parse(match[1]))) {
				terminate(
					new EnvironmentPackageChangeError(
						"PACKAGE_SUPERVISOR_PROTOCOL_INVALID",
						"durable package supervisor emitted an unexpected gate record",
					),
				);
				return;
			}
			releaseGatedSupervisor(remaining, { startedAt: match[1], processCreationIdentity: match[2] });
		});
		child.stderr.on("data", (value) => {
			append("stderr", value);
		});
		child.once("error", (error) =>
			settle(() => reject(new EnvironmentPackageChangeError("PACKAGE_COMMAND_FAILED", error.message))),
		);
		child.once("close", async (code) => {
			await termination;
			if (gatedSupervisor && !supervisorReleased && !terminalError)
				terminalError = new EnvironmentPackageChangeError(
					"PACKAGE_DURABLE_REGISTRATION_FAILED",
					`durable package supervisor exited before its registration gate was released: ${(stderr || stdout || `exit ${code}`).trim().slice(0, 2_000)}`,
				);
			if (processIdentity) {
				try {
					processObserver?.onExited?.(processIdentity);
				} catch (error) {
					console.error("[study-environment] package process exit could not be persisted", {
						pid: processIdentity.pid,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			settle(() => {
				if (terminalError) return reject(terminalError);
				if (code !== 0)
					return reject(
						new EnvironmentPackageChangeError(
							"PACKAGE_COMMAND_FAILED",
							(stderr || stdout || `exit ${code}`).trim().slice(0, 8_000),
						),
					);
				resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() });
			});
		});
	});
}

interface TrustedCommandProcessObserver {
	onStarted?: (identity: EnvironmentPackageProcessIdentity) => void;
	onExited?: (identity: EnvironmentPackageProcessIdentity) => void;
	/** An operation-private absolute directory that retains the supervisor binary and gate evidence. */
	supervisorDirectory?: string;
}

interface GatedEnvironmentPackageSupervisor {
	executablePath: string;
	readyFile: string;
	releaseFile: string;
	gateToken: string;
	args: string[];
}

async function prepareGatedEnvironmentPackageSupervisor(
	observer: TrustedCommandProcessObserver,
	executablePath: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<GatedEnvironmentPackageSupervisor> {
	if (process.platform !== "win32")
		throw new EnvironmentPackageChangeError(
			"PACKAGE_SUPERVISOR_PLATFORM_UNSUPPORTED",
			"durable package supervisor requires Windows",
		);
	if (!observer.onStarted || !observer.supervisorDirectory || !isAbsolute(observer.supervisorDirectory))
		throw new EnvironmentPackageChangeError(
			"PACKAGE_DURABLE_REGISTRATION_REQUIRED",
			"a mutating package command requires an absolute durable supervisor directory and registration callback",
		);
	if (!isAbsolute(executablePath))
		throw new EnvironmentPackageChangeError(
			"PACKAGE_SUPERVISOR_COMMAND_INVALID",
			"a gated package command requires an absolute executable path",
		);
	await mkdir(observer.supervisorDirectory, { recursive: true });
	const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "environment-package-supervisor.cs");
	const outputPath = join(observer.supervisorDirectory, "environment-package-supervisor.exe");
	const compilerPath = join(
		process.env.SystemRoot || "C:\\Windows",
		"Microsoft.NET",
		"Framework64",
		"v4.0.30319",
		"csc.exe",
	);
	if (!existsSync(compilerPath))
		throw new EnvironmentPackageChangeError(
			"PACKAGE_SUPERVISOR_COMPILER_MISSING",
			"the Windows C# compiler required for durable package supervision is unavailable",
		);
	const compiled = spawnSync(compilerPath, ["/nologo", "/target:exe", `/out:${outputPath}`, sourcePath], {
		encoding: "utf8",
		shell: false,
		windowsHide: true,
		timeout: 30_000,
	});
	if (compiled.error || compiled.status !== 0 || !existsSync(outputPath))
		throw new EnvironmentPackageChangeError(
			"PACKAGE_SUPERVISOR_COMPILE_FAILED",
			`could not build the durable package supervisor: ${(compiled.stderr || compiled.error?.message || `exit ${compiled.status}`).trim().slice(0, 2_000)}`,
		);
	const gateToken = randomUUID();
	// One operation owns one work directory. Keep gate names short enough for the
	// legacy Win32 MAX_PATH limit even when a project path is deeply nested.
	const readyFile = join(observer.supervisorDirectory, "supervisor.ready.json");
	const releaseFile = join(observer.supervisorDirectory, "supervisor.release");
	return {
		executablePath: outputPath,
		readyFile,
		releaseFile,
		gateToken,
		args: [
			"--ready-file",
			readyFile,
			"--release-file",
			releaseFile,
			"--gate-token",
			gateToken,
			"--cwd",
			process.cwd(),
			"--gate-timeout-ms",
			String(Math.min(Math.max(timeoutMs, 100), 30_000)),
			"--",
			executablePath,
			...args,
		],
	};
}

/**
 * Observes only a PID created by this module or stored from such a command. Windows
 * creation time is the fence against PID reuse; platforms without it must fail closed.
 */
export function inspectEnvironmentPackageProcess(
	identity: EnvironmentPackageProcessIdentity,
): EnvironmentPackageProcessObservation {
	if (identity.supervisorExecutablePath && identity.processCreationIdentity) {
		const observed = observeEnvironmentPackageSupervisorIdentity(identity);
		if (observed === null) return "exited";
		return observed === identity.processCreationIdentity ? "running" : "stale";
	}
	const observed = observeEnvironmentPackageProcessIdentity(identity.pid, true);
	if (observed === null) return "exited";
	return observed.startedAt === identity.startedAt ? "running" : "stale";
}

function observeEnvironmentPackageSupervisorIdentity(identity: EnvironmentPackageProcessIdentity): string | null {
	const result = spawnSync(identity.supervisorExecutablePath as string, ["--inspect", String(identity.pid)], {
		encoding: "utf8",
		shell: false,
		windowsHide: true,
		timeout: 5_000,
	});
	if (result.status === 3) return null;
	if (result.error || result.status !== 0)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			`could not inspect durable package supervisor ${identity.pid}: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 500)}`,
		);
	let value: unknown;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			"durable package supervisor observation was not JSON",
		);
	}
	if (
		!value ||
		typeof value !== "object" ||
		(value as { pid?: unknown }).pid !== identity.pid ||
		typeof (value as { processCreationIdentity?: unknown }).processCreationIdentity !== "string" ||
		!/^[0-9]{17,20}$/u.test((value as { processCreationIdentity: string }).processCreationIdentity)
	)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			"durable package supervisor identity is invalid",
		);
	return (value as { processCreationIdentity: string }).processCreationIdentity;
}

/** Reads one Windows process identity for the trusted worker before it persists that process. */
export function readEnvironmentPackageProcessIdentity(pid: number): EnvironmentPackageProcessIdentity {
	const identity = observeEnvironmentPackageProcessIdentity(pid);
	if (identity === null)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			"trusted package process disappeared before it was recorded",
		);
	return identity;
}

/** Terminates the exact recorded Windows package command tree and then proves its root is gone. */
export async function terminateEnvironmentPackageProcessTree(
	identity: EnvironmentPackageProcessIdentity,
): Promise<EnvironmentPackageProcessObservation> {
	const observation = inspectEnvironmentPackageProcess(identity);
	if (observation !== "running") return observation;
	if (
		!identity.supervisorExecutablePath ||
		!isAbsolute(identity.supervisorExecutablePath) ||
		!identity.processCreationIdentity ||
		!/^[0-9]{17,20}$/u.test(identity.processCreationIdentity)
	)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_SUPERVISOR_IDENTITY_REQUIRED",
			"recovery refuses to terminate a package process that lacks a durable supervisor identity",
		);
	try {
		const result = await terminateExactEnvironmentPackageSupervisor(identity);
		if (result === "stale") return "stale";
	} catch (error) {
		// A normal process exit can race the identity-safe handle open.
		if (inspectEnvironmentPackageProcess(identity) === "exited") return "exited";
		throw error;
	}
	const after = inspectEnvironmentPackageProcess(identity);
	if (after === "running")
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_TERMINATION_FAILED",
			"trusted package process remained alive after process-tree termination",
		);
	return after;
}

function observeEnvironmentPackageProcessIdentity(
	pid: number | undefined,
	allowMissing = false,
): EnvironmentPackageProcessIdentity | null {
	if (!Number.isSafeInteger(pid) || !pid || pid < 1)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			"trusted package command has no PID",
		);
	if (process.platform !== "win32")
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_UNAVAILABLE",
			"package recovery requires Windows process creation-time observation",
		);
	const powershell = join(
		process.env.SystemRoot || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const program = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -eq $p){exit 3};[pscustomobject]@{pid=[int]$p.ProcessId;startedAt=(Get-Date -Date $p.CreationDate -Format o)}|ConvertTo-Json -Compress`;
	const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", program], {
		encoding: "utf8",
		shell: false,
		windowsHide: true,
		timeout: 5_000,
	});
	if (result.status === 3 && allowMissing) return null;
	if (result.error || result.status !== 0)
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			`could not inspect trusted package process ${pid}: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 500)}`,
		);
	let value: unknown;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			"trusted package process observation was not JSON",
		);
	}
	if (!value || typeof value !== "object")
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			"trusted package process observation is invalid",
		);
	const record = value as { pid?: unknown; startedAt?: unknown };
	if (record.pid !== pid || typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt)))
		throw new EnvironmentPackageChangeError(
			"PACKAGE_PROCESS_OBSERVATION_FAILED",
			"trusted package process identity is invalid",
		);
	return { pid, startedAt: record.startedAt };
}

/** A held child-process handle is safe for a pre-registration failure; it closes the supervisor Job. */
async function terminateTrustedCommandTree(child: ReturnType<typeof spawn>): Promise<void> {
	if (!child.kill()) throw new Error("trusted package process could not be terminated through its held handle");
}

async function terminateExactEnvironmentPackageSupervisor(
	identity: EnvironmentPackageProcessIdentity,
): Promise<"terminated" | "exited" | "stale"> {
	return await new Promise((resolvePromise, reject) => {
		const killer = spawn(
			identity.supervisorExecutablePath as string,
			["--terminate", String(identity.pid), identity.processCreationIdentity as string, "10000"],
			{ shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		killer.stderr.setEncoding("utf8");
		killer.stderr.on("data", (value) => {
			stderr += String(value);
		});
		killer.once("error", reject);
		killer.once("close", (code) => {
			if (code === 0) resolvePromise("terminated");
			else if (code === 3) resolvePromise("exited");
			else if (code === 4) resolvePromise("stale");
			else
				reject(
					new Error(`identity-safe package supervisor termination exited ${code}: ${stderr.trim().slice(0, 500)}`),
				);
		});
	});
}
