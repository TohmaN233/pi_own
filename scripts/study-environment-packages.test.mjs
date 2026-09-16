import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { contentHash } from "../packages/harness-core/src/index.ts";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import {
	EnvironmentPackageChangeError,
	executeEnvironmentPackagePlan,
	inspectEnvironmentPackages,
	inspectEnvironmentPackageProcess,
	planEnvironmentPackageChanges,
	readEnvironmentPackageProcessIdentity,
	runTrustedCommand,
	validateFinalInventory,
} from "../packages/study-execution-host/src/environment-package-changes.ts";
import { createProjectPythonEnvironment } from "../packages/study-execution-host/src/environments.ts";
import { runStudyEnvironmentWorker } from "../apps/pi-web/lib/study-environment-worker-service.ts";

const execFileAsync = promisify(execFile);
const root = resolve(".artifacts/study-research/environment-packages/test-fixture");
const recoveryRoot = resolve(".artifacts/study-research/environment-recovery/test-fixture");
const ownershipRoot = resolve(".artifacts/study-research/environment-ownership/test-fixture");

async function buildFixtureWheel(directory) {
	const program = [
		"import pathlib, sys, zipfile",
		"root = pathlib.Path(sys.argv[1])",
		"root.mkdir(parents=True, exist_ok=True)",
		"def wheel(name, version, module, requires=()):",
		" dist = f'{name.replace(\"-\", \"_\")}-{version}.dist-info'",
		" target = root / f'{name.replace(\"-\", \"_\")}-{version}-py3-none-any.whl'",
		" metadata = 'Metadata-Version: 2.1\\nName: ' + name + '\\nVersion: ' + version + '\\n' + ''.join('Requires-Dist: ' + item + '\\n' for item in requires)",
		" with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:",
		"  z.writestr(module + '/__init__.py', \"VALUE = 'fixture'\\n\")",
		"  z.writestr(dist + '/METADATA', metadata)",
		"  z.writestr(dist + '/WHEEL', 'Wheel-Version: 1.0\\nGenerator: study-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
		"  z.writestr(dist + '/RECORD', '')",
		"wheel('study-fixture-package', '1.0.0', 'study_fixture_package')",
		"wheel('study-fixture-package', '2.0.0', 'study_fixture_package')",
		"wheel('study-parent-package', '1.0.0', 'study_parent_package', ('study-fixture-package == 2.0.0',))",
	].join("\n");
	await execFileAsync("python", ["-I", "-c", program, directory], { windowsHide: true });
}

async function buildRFixtureRepository(rLibrary, rscript) {
	const repository = join(rLibrary, "cran-repository");
	const contributionDirectory = join(repository, "src", "contrib");
	await mkdir(contributionDirectory, { recursive: true });
	for (const name of ["fixtureDep", "fixtureParent"]) {
		const source = join(rLibrary, "fixture-source", name);
		await mkdir(join(source, "R"), { recursive: true });
		await writeFile(join(source, "DESCRIPTION"), [
			`Package: ${name}`, "Type: Package", "Title: Isolated Study fixture", "Version: 1.0.0",
			"Authors@R: person('Fixture', 'Runner', email = 'fixture@example.invalid', role = c('aut', 'cre'))",
			"Description: Local engineering fixture for pinned package installation.", "License: MIT", "Encoding: UTF-8",
			...(name === "fixtureParent" ? ["Imports: fixtureDep (>= 1.0.0)"] : []), "",
		].join("\n"));
		await writeFile(join(source, "NAMESPACE"), "export(fixture_value)\n");
		await writeFile(join(source, "R", "value.R"), `fixture_value <- function() ${name === "fixtureParent" ? "fixtureDep::fixture_value() + 1" : "1"}\n`);
		await execFileAsync(join(dirname(rscript), "R.exe"), ["CMD", "build", "--no-build-vignettes", "--no-manual", source], { cwd: contributionDirectory, windowsHide: true, env: { ...process.env, R_LIBS_USER: rLibrary } });
	}
	await execFileAsync(rscript, ["--vanilla", "-e", "tools::write_PACKAGES(Sys.getenv('PI_FIXTURE_CONTRIB'), type='source')"], { windowsHide: true, env: { ...process.env, PI_FIXTURE_CONTRIB: contributionDirectory } });
	return repository;
}

async function buildRUserLibraryShadow(rscript, rLibrary) {
	const source = join(rLibrary, "shadow-source", "MASS");
	await rm(join(rLibrary, "base"), { recursive: true, force: true });
	await mkdir(join(source, "R"), { recursive: true });
	await writeFile(
		join(source, "DESCRIPTION"),
		[
			"Package: MASS",
			"Type: Package",
			"Title: Isolated library shadow fixture",
			"Version: 9.9.9",
			"Authors@R: person('Fixture', 'Runner', email = 'fixture@example.invalid', role = c('aut', 'cre'))",
			"Description: A test-only package used to verify duplicate R package names across library paths.",
			"License: MIT",
			"Encoding: UTF-8",
		].join("\n") + "\n",
		"utf8",
	);
	await writeFile(join(source, "NAMESPACE"), "export(fixture_shadow)\n", "utf8");
	await writeFile(join(source, "R", "fixture_shadow.R"), "fixture_shadow <- function() 'fixture'\n", "utf8");
	await execFileAsync(join(dirname(rscript), "R.exe"), ["CMD", "INSTALL", "--no-multiarch", "--library", rLibrary, source], {
		windowsHide: true,
		env: { ...process.env, R_LIBS_USER: rLibrary },
	});
}

function setupHarness(projectDirectory) {
	const harness = new LearningHarness({ databasePath: join(root, "environment-packages.sqlite") });
	harness.projectWorkspaces.create({ id: "environment-project", title: "Environment fixture", cwd: projectDirectory, courseProjectId: null, defaults: null });
	harness.projectWorkspaces.move("environment-session-a", "environment-project");
	harness.projectWorkspaces.move("environment-session-b", "environment-project");
	const phaseA = harness.studyResearch.bindSession("environment-project", "environment-session-a", "study");
	const phaseB = harness.studyResearch.bindSession("environment-project", "environment-session-b", "study");
	return {
		harness,
		scopeA: { projectId: "environment-project", sessionId: "environment-session-a", expectedPhaseRevision: phaseA.revision },
		scopeB: { projectId: "environment-project", sessionId: "environment-session-b", expectedPhaseRevision: phaseB.revision },
	};
}

function setupExecutionFenceHarness(projectDirectory) {
	const projectId = "environment-fence-project";
	const sessionId = "environment-fence-session";
	const harness = new LearningHarness({ databasePath: join(root, "environment-execution-fence.sqlite") });
	harness.projectWorkspaces.create({ id: projectId, title: "Environment execution fence fixture", cwd: projectDirectory, courseProjectId: null, defaults: null });
	harness.projectWorkspaces.move(sessionId, projectId);
	const phase = harness.studyResearch.bindSession(projectId, sessionId, "study");
	harness.studyExecution.configureTrustedPolicy(
		{ maxConcurrentRuns: 1, maxCpuMilliCores: 1_000, maxMemoryMiB: 256, leaseDurationMs: 30_000 },
		0,
	);
	return {
		harness,
		scope: { projectId, sessionId, expectedPhaseRevision: phase.revision },
	};
}

function enqueueFenceExecution(fixture) {
	const producer = fixture.harness.studyResearch.registerTrustedRunnerContext(
		fixture.scope,
		"environment-package-execution-fence-fixture",
	);
	return fixture.harness.studyExecution.enqueueStudy(fixture.scope, {
		dispatchKey: "environment-package-execution-fence-dispatch-0001",
		kind: "execution",
		manifest: {
			codeHash: contentHash("environment package execution fence fixture"),
			parameterHash: contentHash("{}"),
			inputHashes: {},
			environmentHash: contentHash("environment package execution fence environment"),
		},
		admission: {
			purpose: "Verify that package installation and native execution cannot mutate one environment concurrently.",
			language: "python",
			maxWallSeconds: 30,
			maxMemoryMiB: 128,
		},
		producerContextId: producer.contextId,
		resources: { cpuMilliCores: 100, memoryMiB: 128, wallTimeMs: 1_000, diskBytes: 4_096 },
		quota: { maxRuns: 2, maxCumulativeWallTimeMs: 2_000, maxCumulativeDiskBytes: 8_192, expiresAt: null },
	}).job;
}

test("offline fixture package plan is pinned, consent-gated, durably claimed, and final-inventory validated", { concurrency: false }, async () => {
	if (process.platform !== "win32") return;
	await rm(root, { recursive: true, force: true });
	const projectDirectory = join(root, "project");
	await mkdir(projectDirectory, { recursive: true });
	const python = await createProjectPythonEnvironment({ projectDirectory });
	const wheelDirectory = join(python.venvDirectory, "fixture-wheels");
	await buildFixtureWheel(wheelDirectory);
	const plan = await planEnvironmentPackageChanges({
		language: "python", projectDirectory, environmentDirectory: python.venvDirectory,
		executablePath: python.environment.executablePath, requests: [{ name: "study-fixture-package", version: "1.0.0" }],
		localWheelDirectory: wheelDirectory,
	});
	assert.equal(plan.requiresExistingChangeConsent, false);
	assert.deepEqual(plan.packages.map((item) => [item.name, item.version, item.change, item.direct]), [["study-fixture-package", "1.0.0", "install", true]]);
	assert.match(plan.packages[0].sourceHash, /^sha256:[a-f0-9]{64}$/u);

	const fixture = setupHarness(projectDirectory);
	try {
		const persisted = fixture.harness.saveEnvironmentPackagePlan(fixture.scopeA, plan);
		const first = fixture.harness.queueEnvironmentPackageOperation(fixture.scopeA, {
			planId: persisted.planId, expectedPlanRevision: persisted.revision, requestId: "environment-package-request-0001", acceptExistingChanges: false,
		});
		const replay = fixture.harness.queueEnvironmentPackageOperation(fixture.scopeA, {
			planId: persisted.planId, expectedPlanRevision: persisted.revision, requestId: "environment-package-request-0001", acceptExistingChanges: false,
		});
		assert.equal(replay.operationId, first.operationId);
		assert.deepEqual(fixture.harness.listEnvironmentPackagePlans(fixture.scopeB), [], "another conversation can list its own empty package state");
		assert.deepEqual(fixture.harness.listEnvironmentPackageOperations(fixture.scopeB), [], "foreign conversation operations do not poison listing");
		assert.equal(fixture.harness.listEnvironmentPackagePlans(fixture.scopeA).length, 1);
		assert.equal(fixture.harness.listEnvironmentPackageOperations(fixture.scopeA).length, 1);
		await assert.rejects(
			async () => fixture.harness.queueEnvironmentPackageOperation(fixture.scopeB, {
				planId: persisted.planId, expectedPlanRevision: persisted.revision, requestId: "environment-package-request-0002", acceptExistingChanges: false,
			}),
			(error) => error?.code === "PACKAGE_PLAN_SESSION_CONFLICT",
		);
		const claim = fixture.harness.claimEnvironmentPackageOperation("environment-project", "environment-worker-0001");
		assert.ok(claim);
		assert.equal(claim.operation.operationId, first.operationId);
		const result = await executeEnvironmentPackagePlan({ plan: claim.plan.plan, workDirectory: join(root, "operation-work") });
		assert.equal(result.installed.length, 1);
		fixture.harness.finishEnvironmentPackageOperation({ projectId: "environment-project", operationId: first.operationId, workerId: "environment-worker-0001", result });
		const final = await inspectEnvironmentPackages({ language: "python", executablePath: python.environment.executablePath, environmentDirectory: python.venvDirectory });
		assert.equal(final.find((item) => item.name.toLowerCase() === "study-fixture-package")?.version, "1.0.0");
		await assert.rejects(
			() => executeEnvironmentPackagePlan({ plan, workDirectory: join(root, "stale-plan-work") }),
			(error) => error instanceof EnvironmentPackageChangeError && error.code === "PACKAGE_INVENTORY_STALE",
		);
		const aliasPlan = await planEnvironmentPackageChanges({
			language: "python", projectDirectory, environmentDirectory: python.venvDirectory,
			executablePath: python.environment.executablePath, requests: [{ name: "study_fixture.package", version: "2.0.0" }],
			localWheelDirectory: wheelDirectory,
		});
		assert.equal(aliasPlan.requiresExistingChangeConsent, true, "PEP 503 spelling aliases must retain existing-package consent");
		assert.deepEqual(aliasPlan.packages.map((item) => [item.name, item.change, item.direct]), [["study-fixture-package", "upgrade", true]]);
		await assert.rejects(
			planEnvironmentPackageChanges({
				language: "python", projectDirectory, environmentDirectory: python.venvDirectory,
				executablePath: python.environment.executablePath,
				requests: [{ name: "study-fixture-package", version: null }, { name: "study_fixture.package", version: null }],
				localWheelDirectory: wheelDirectory,
			}),
			(error) => error instanceof EnvironmentPackageChangeError && error.code === "PACKAGE_REQUEST_INVALID",
		);
		await assert.rejects(
			planEnvironmentPackageChanges({
				language: "python", projectDirectory, environmentDirectory: python.venvDirectory,
				executablePath: python.environment.executablePath, requests: [{ name: "study-fixture-package", version: ">=2.0.0" }],
				localWheelDirectory: wheelDirectory,
			}),
			(error) => error instanceof EnvironmentPackageChangeError && error.code === "PACKAGE_VALUE_INVALID",
		);

		const consentPlan = await planEnvironmentPackageChanges({
			language: "python", projectDirectory, environmentDirectory: python.venvDirectory,
			executablePath: python.environment.executablePath, requests: [{ name: "study-parent-package", version: "1.0.0" }],
			localWheelDirectory: wheelDirectory,
		});
		assert.equal(consentPlan.requiresExistingChangeConsent, true);
		assert.equal(consentPlan.packages.find((item) => item.name === "study-fixture-package")?.change, "upgrade");
		assert.equal(consentPlan.packages.find((item) => item.name === "study-fixture-package")?.direct, false);
		const persistedConsent = fixture.harness.saveEnvironmentPackagePlan(fixture.scopeA, consentPlan);
		await assert.rejects(
			async () => fixture.harness.queueEnvironmentPackageOperation(fixture.scopeA, {
				planId: persistedConsent.planId, expectedPlanRevision: persistedConsent.revision, requestId: "environment-package-request-0001", acceptExistingChanges: true,
			}),
			(error) => error?.code === "PACKAGE_REQUEST_CONFLICT",
		);
		await assert.rejects(
			async () => fixture.harness.queueEnvironmentPackageOperation(fixture.scopeA, {
				planId: persistedConsent.planId, expectedPlanRevision: persistedConsent.revision, requestId: "environment-package-request-0003", acceptExistingChanges: false,
			}),
			(error) => error?.code === "PACKAGE_CONSENT_REQUIRED",
		);
		const consented = fixture.harness.queueEnvironmentPackageOperation(fixture.scopeA, {
			planId: persistedConsent.planId, expectedPlanRevision: persistedConsent.revision, requestId: "environment-package-request-0003", acceptExistingChanges: true,
		});
		const waiting = fixture.harness.queueEnvironmentPackageOperation(fixture.scopeA, {
			planId: persistedConsent.planId, expectedPlanRevision: persistedConsent.revision, requestId: "environment-package-request-0004", acceptExistingChanges: true,
		});
		const consentClaim = fixture.harness.claimEnvironmentPackageOperation("environment-project", "environment-worker-0002");
		assert.ok(consentClaim);
		assert.deepEqual(fixture.harness.environmentPackageDrainState("environment-project"), {
			queued: 1, runnable: 0, waiting: 1, needsInput: 0, activeExecutionJobs: 0, blockingOperationIds: [consented.operationId],
		});
		fixture.harness.renewEnvironmentPackageOperationLease({ projectId: "environment-project", operationId: consented.operationId, workerId: "environment-worker-0002" });
		assert.ok((fixture.harness.listEnvironmentPackageOperations(fixture.scopeA).find((item) => item.operationId === consented.operationId)?.leaseExpiresAt ?? "") > new Date().toISOString());
		fixture.harness.failEnvironmentPackageOperation({
			projectId: "environment-project", operationId: consented.operationId, workerId: "environment-worker-0002", status: "unknown",
			diagnostic: "fixture simulates worker loss after an installer may have mutated the environment",
		});
		const operations = fixture.harness.listEnvironmentPackageOperations(fixture.scopeA);
		assert.equal(operations.find((item) => item.operationId === first.operationId)?.status, "succeeded");
		assert.equal(operations.find((item) => item.operationId === consented.operationId)?.status, "unknown");
		assert.equal(operations.find((item) => item.operationId === waiting.operationId)?.status, "queued");
		assert.deepEqual(fixture.harness.environmentPackageDrainState("environment-project"), {
			queued: 1, runnable: 0, waiting: 0, needsInput: 1, activeExecutionJobs: 0, blockingOperationIds: [consented.operationId],
		});
		const { contentHash: _consentHash, ...blockedBody } = consentPlan;
		const blockedPlanBody = { ...blockedBody, planId: "environment-package-plan-blocked" };
		const blockedPlan = { ...blockedPlanBody, contentHash: contentHash(blockedPlanBody) };
		fixture.harness.projectWorkspaces.create({ id: "environment-project-other", title: "Other environment fixture", cwd: projectDirectory, courseProjectId: null, defaults: null });
		fixture.harness.projectWorkspaces.move("environment-session-c", "environment-project-other");
		const phaseC = fixture.harness.studyResearch.bindSession("environment-project-other", "environment-session-c", "study");
		await assert.rejects(
			async () => fixture.harness.saveEnvironmentPackagePlan({ projectId: "environment-project-other", sessionId: "environment-session-c", expectedPhaseRevision: phaseC.revision }, blockedPlan),
			(error) => error?.code === "PACKAGE_ENVIRONMENT_BUSY",
		);

		const executionFence = setupExecutionFenceHarness(projectDirectory);
		try {
			const fencePlan = executionFence.harness.saveEnvironmentPackagePlan(executionFence.scope, consentPlan);
			const fenceOperation = executionFence.harness.queueEnvironmentPackageOperation(executionFence.scope, {
				planId: fencePlan.planId,
				expectedPlanRevision: fencePlan.revision,
				requestId: "environment-execution-fence-package-request-0001",
				acceptExistingChanges: true,
			});
			const fenceClaim = executionFence.harness.claimEnvironmentPackageOperation(
				executionFence.scope.projectId,
				"environment-execution-fence-package-worker-0001",
			);
			assert.ok(fenceClaim, "package operation must claim its global environment lock before an execution is enqueued");
			const queuedExecution = enqueueFenceExecution(executionFence);
			assert.equal(
				executionFence.harness.studyExecution.claimNext("environment-execution-fence-coordinator-0001"),
				null,
				"a queued execution must remain queued while a package operation holds any environment lock",
			);
			executionFence.harness.failEnvironmentPackageOperation({
				projectId: executionFence.scope.projectId,
				operationId: fenceOperation.operationId,
				workerId: "environment-execution-fence-package-worker-0001",
				status: "failed",
				diagnostic: "fixture fails before starting any package-manager command",
			});
			const executionClaim = executionFence.harness.studyExecution.claimNext(
				"environment-execution-fence-coordinator-0001",
			);
			assert.equal(executionClaim?.job.queueJobId, queuedExecution.queueJobId, "a pre-mutation package failure must release the execution fence");

			const { contentHash: _fencePlanHash, ...fencePlanBody } = consentPlan;
			const afterExecutionPlanBody = {
				...fencePlanBody,
				planId: "environment-package-plan-after-active-execution-fixture",
				createdAt: new Date().toISOString(),
			};
			const afterExecutionPlan = { ...afterExecutionPlanBody, contentHash: contentHash(afterExecutionPlanBody) };
			const persistedAfterExecution = executionFence.harness.saveEnvironmentPackagePlan(executionFence.scope, afterExecutionPlan);
			executionFence.harness.queueEnvironmentPackageOperation(executionFence.scope, {
				planId: persistedAfterExecution.planId,
				expectedPlanRevision: persistedAfterExecution.revision,
				requestId: "environment-execution-fence-package-request-0002",
				acceptExistingChanges: true,
			});
			assert.equal(
				executionFence.harness.claimEnvironmentPackageOperation(
					executionFence.scope.projectId,
					"environment-execution-fence-package-worker-0002",
				),
				null,
				"an admitted native execution must prevent a package operation from claiming mutation",
			);
			assert.deepEqual(executionFence.harness.environmentPackageDrainState(executionFence.scope.projectId), {
				queued: 1,
				runnable: 0,
				waiting: 1,
				needsInput: 0,
				activeExecutionJobs: 1,
				blockingOperationIds: [],
			});
		} finally {
			executionFence.harness.close();
		}
		await writeFile(join(root, "latest-evidence.json"), JSON.stringify({
			plan: { planId: plan.planId, inventoryHash: plan.inventoryHash, packages: plan.packages },
			result: { installed: result.installed, finalInventoryHash: result.finalInventoryHash },
			operations: operations.map((item) => ({ operationId: item.operationId, status: item.status, attempts: item.attempts })),
		}, null, 2) + "\n", "utf8");
	} finally {
		fixture.harness.close();
	}
});

test("R inventory and no-op final validation use the fixed Rscript with an isolated user library", { concurrency: false }, async () => {
	if (process.platform !== "win32") return;
	const rscript = process.env.STUDY_RSCRIPT_EXE ?? "C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe";
	await access(rscript);
	const rLibrary = join(root, "r-user-library");
	assert.equal(dirname(rLibrary), root);
	await rm(rLibrary, { recursive: true, force: true });
	await mkdir(rLibrary, { recursive: true });
	await buildRUserLibraryShadow(rscript, rLibrary);
	const inventory = await inspectEnvironmentPackages({ language: "r", executablePath: rscript, environmentDirectory: rLibrary });
	const massPackages = inventory.filter((entry) => entry.name === "MASS");
	assert.equal(massPackages.length, 2, "R inventory must preserve a temporary user-library shadow and the system-library package");
	const mass = massPackages.find((entry) => entry.location === rLibrary);
	assert.equal(mass?.version, "9.9.9", "R resolution must choose the user-library copy ahead of the system copy");
	assert.ok(massPackages.some((entry) => entry.location !== rLibrary), "R system MASS copy must remain represented");
	const value = {
		planId: "environment-package-plan-r-noop-fixture",
		language: "r",
		projectDirectory: join(root, "r-project"),
		environmentDirectory: rLibrary,
		executablePath: rscript,
		requests: [{ name: "MASS", version: mass.version }],
		inventory,
		inventoryHash: contentHash(inventory.map(({ name, version, location }) => ({ name, version, location }))),
		packages: [{ name: "MASS", version: mass.version, source: `installed:${mass.location}`, sourceHash: "md5:00000000000000000000000000000000", change: "unchanged", direct: true }],
		requiresExistingChangeConsent: false,
		resolver: "cran-available-packages-v1",
		createdAt: new Date().toISOString(),
	};
	const plan = { ...value, contentHash: contentHash(value) };
	const result = await executeEnvironmentPackagePlan({ plan, workDirectory: join(root, "r-noop-work") });
	assert.equal(result.installed.length, 0);
	assert.equal(result.finalInventoryHash, plan.inventoryHash);
	assert.throws(() => validateFinalInventory(plan, [...inventory, {name:"UnexpectedFixture",version:"1.0",location:rLibrary}]), /unapproved package additions/);
	assert.throws(() => validateFinalInventory(plan, inventory.slice(1)), /unapproved package additions or removals/);
	assert.throws(() => validateFinalInventory(plan, inventory.map((entry) => entry.name === "MASS" && entry.location !== rLibrary ? {...entry,version:"0.0.1"} : entry)), /changed unapproved package MASS/);
	const rProject = join(root, "r-project");
	await mkdir(rProject, { recursive: true });
	const rRepository = await buildRFixtureRepository(rLibrary, rscript);
	const dependencyPlan = await planEnvironmentPackageChanges({
		language: "r",
		projectDirectory: rProject,
		environmentDirectory: rLibrary,
		executablePath: rscript,
		requests: [{ name: "fixtureParent", version: null }],
		localRRepositoryDirectory: rRepository,
	});
	assert.deepEqual(
		dependencyPlan.packages.map((entry) => [entry.name, entry.version, entry.direct]),
		[
			["fixtureDep", "1.0.0", false],
			["fixtureParent", "1.0.0", true],
		],
		"R resolver must emit direct dependencies before their dependants so install.packages sees the required order",
	);
	await assert.rejects(
		planEnvironmentPackageChanges({
			language: "r",
			projectDirectory: rProject,
			environmentDirectory: rLibrary,
			executablePath: rscript,
			requests: [{ name: "fixtureParent", version: "9.9.9" }],
			localRRepositoryDirectory: rRepository,
		}),
		(error) => error instanceof EnvironmentPackageChangeError && error.code === "PACKAGE_COMMAND_FAILED" && /requested R version is unavailable/u.test(error.message),
	);
	const afterResolverInventory = await inspectEnvironmentPackages({ language: "r", executablePath: rscript, environmentDirectory: rLibrary });
	assert.deepEqual(afterResolverInventory, inventory, "offline R planning must not modify the isolated user library");
	assert.ok(dependencyPlan.packages.every((entry) => /^md5:[a-f0-9]{32}$/.test(entry.sourceHash)));
	const rChangedWork = join(root, "r-changed-work");
	await rm(rChangedWork, { recursive: true, force: true });
	const supervisedInstallers = [];
	const exitedInstallers = [];
	const installedR = await executeEnvironmentPackagePlan({
		plan: dependencyPlan,
		workDirectory: rChangedWork,
		onInstallerStarted(identity) { supervisedInstallers.push(identity); },
		onInstallerExited(identity) { exitedInstallers.push(identity); },
	});
	assert.equal(installedR.installed.length, 2);
	assert.equal(supervisedInstallers.length, 1, "the isolated R mutation must pass through one durable supervisor");
	assert.deepEqual(exitedInstallers, supervisedInstallers, "the durable R supervisor must report the recorded exit identity");
	assert.match(supervisedInstallers[0].processCreationIdentity, /^[0-9]{17,20}$/u);
	assert.ok(supervisedInstallers[0].supervisorExecutablePath.startsWith(root));
	const evaluatedR = await execFileAsync(rscript, ["--vanilla","-e","stopifnot(fixtureParent::fixture_value()==2);cat('dependency-result=2')"], {windowsHide:true,env:{...process.env,R_LIBS_USER:rLibrary}});
	assert.match(evaluatedR.stdout,/dependency-result=2/);
	await writeFile(join(root, "r-inventory-evidence.json"), JSON.stringify({
		rscript, rLibrary, mass: { name: mass.name, version: mass.version }, inventoryHash: result.finalInventoryHash,
		dependencyOrder: dependencyPlan.packages.map((entry) => entry.name),
		changedPlanInstalled: installedR.installed, finalInventoryHash: installedR.finalInventoryHash, dependencyResult: 2,
		supervisedInstallers,
	}, null, 2) + "\n", "utf8");
});

test("unknown package recovery fences a live process, proves inventory, rejects stale PIDs, and a replacement worker drains a pre-claim crash", { concurrency: false, timeout: 60000 }, async () => {
	if (process.platform !== "win32") return;
	await rm(recoveryRoot, { recursive: true, force: true });
	const projectDirectory = join(recoveryRoot, "project");
	await mkdir(projectDirectory, { recursive: true });
	const python = await createProjectPythonEnvironment({ projectDirectory });
	const wheelDirectory = join(python.venvDirectory, "fixture-wheels");
	await buildFixtureWheel(wheelDirectory);
	const plan = await planEnvironmentPackageChanges({
		language: "python",
		projectDirectory,
		environmentDirectory: python.venvDirectory,
		executablePath: python.environment.executablePath,
		requests: [{ name: "study-fixture-package", version: "1.0.0" }],
		localWheelDirectory: wheelDirectory,
	});
	const databasePath = join(recoveryRoot, "learning-harness.sqlite");
	const harness = new LearningHarness({ databasePath });
	harness.projectWorkspaces.create({ id: "environment-recovery-project", title: "Environment recovery fixture", cwd: projectDirectory, courseProjectId: null, defaults: null });
	harness.projectWorkspaces.move("environment-recovery-session", "environment-recovery-project");
	const phase = harness.studyResearch.bindSession("environment-recovery-project", "environment-recovery-session", "study");
	const scope = { projectId: "environment-recovery-project", sessionId: "environment-recovery-session", expectedPhaseRevision: phase.revision };
	const persisted = harness.saveEnvironmentPackagePlan(scope, plan);
	const orphan = harness.queueEnvironmentPackageOperation(scope, {
		planId: persisted.planId, expectedPlanRevision: persisted.revision, requestId: "environment-recovery-request-0001", acceptExistingChanges: false,
	});
	const workerId = "00000000-0000-4000-8000-000000000101";
	const claim = harness.claimEnvironmentPackageOperation(scope.projectId, workerId);
	assert.ok(claim);
	const installerFixture = join(recoveryRoot, "orphan-installer.mjs");
	await writeFile(installerFixture, "setInterval(() => {}, 1000);\n", "utf8");
	let installerIdentity;
	let registered;
	const registration = new Promise((ready, reject) => { registered = { ready, reject }; });
	const runningInstaller = runTrustedCommand(
		process.execPath,
		[installerFixture],
		{},
		undefined,
		{ timeoutMs: 30000, outputLimitBytes: 8192, heartbeatMs: 100 },
		{
			supervisorDirectory: recoveryRoot,
			onStarted(identity) {
				try {
					installerIdentity = identity;
					harness.recordEnvironmentPackageInstallerStarted({ projectId: scope.projectId, operationId: orphan.operationId, workerId, installer: identity });
					harness.failEnvironmentPackageOperation({ projectId: scope.projectId, operationId: orphan.operationId, workerId, status: "unknown", diagnostic: "fixture worker disappeared after durable supervisor registration" });
					registered.ready();
				} catch (error) { registered.reject(error); }
			},
		},
	);
	const installerOutcome = runningInstaller.then(
		() => null,
		(error) => error,
	);
	await registration;
	const reconciled = await harness.reconcileEnvironmentPackageOperation(scope, orphan.operationId);
	const installerError = await installerOutcome;
	assert.equal(installerError?.code, "PACKAGE_COMMAND_FAILED");
	assert.equal(inspectEnvironmentPackageProcess(installerIdentity), "exited", "reconciliation must await package-tree termination before unlocking");
	assert.equal(reconciled.status, "reconciled");
	assert.equal(reconciled.result, null, "reconciliation must not relabel an unrun operation as success");

	const queued = harness.queueEnvironmentPackageOperation(scope, {
		planId: persisted.planId, expectedPlanRevision: persisted.revision, requestId: "environment-recovery-request-0002", acceptExistingChanges: false,
	});
	harness.close();
	const crashWorker = spawn(process.execPath, [resolve("scripts/study-environment-worker.mjs"), "--project-id", scope.projectId, "--worker-id", "00000000-0000-4000-8000-000000000102"], {
		windowsHide: true, stdio: "ignore", env: { ...process.env, PI_LEARNING_HARNESS_DIR: recoveryRoot, PI_STUDY_ENVIRONMENT_WORKER_TEST_PAUSE_BEFORE_CLAIM_MS: "5000" },
	});
	await new Promise((ready, reject) => { crashWorker.once("spawn", ready); crashWorker.once("error", reject); });
	await new Promise((ready) => setTimeout(ready, 250));
	const crashed = new Promise((ready) => crashWorker.once("close", ready));
	crashWorker.kill();
	await crashed;
	const recoveredWorker = await execFileAsync(process.execPath, [resolve("scripts/study-environment-worker.mjs"), "--project-id", scope.projectId, "--worker-id", "00000000-0000-4000-8000-000000000103"], {
		windowsHide: true, timeout: 45000, env: { ...process.env, PI_LEARNING_HARNESS_DIR: recoveryRoot },
	});
	assert.match(recoveredWorker.stdout, /completed: 1/u);
	const reopened = new LearningHarness({ databasePath });
	try {
		const operation = reopened.listEnvironmentPackageOperations(scope).find((item) => item.operationId === queued.operationId);
		assert.equal(operation?.status, "succeeded", "a new worker must drain the queue after the first worker crashes before claim");
		const stale = reopened.queueEnvironmentPackageOperation(scope, {
			planId: persisted.planId, expectedPlanRevision: persisted.revision, requestId: "environment-recovery-request-0003", acceptExistingChanges: false,
		});
		const staleClaim = reopened.claimEnvironmentPackageOperation(scope.projectId, "00000000-0000-4000-8000-000000000104");
		assert.ok(staleClaim);
		reopened.recordEnvironmentPackageInstallerStarted({
			projectId: scope.projectId,
			operationId: stale.operationId,
			workerId: "00000000-0000-4000-8000-000000000104",
			installer: {
				pid: process.pid,
				startedAt: "2000-01-01T00:00:00.000Z",
				processCreationIdentity: "123456789012345678",
				supervisorExecutablePath: join(recoveryRoot, "environment-package-supervisor.exe"),
			},
		});
		reopened.failEnvironmentPackageOperation({ projectId: scope.projectId, operationId: stale.operationId, workerId: "00000000-0000-4000-8000-000000000104", status: "unknown", diagnostic: "fixture stale PID" });
		await assert.rejects(
			() => reopened.reconcileEnvironmentPackageOperation(scope, stale.operationId),
			(error) => error?.code === "PACKAGE_PROCESS_IDENTITY_STALE",
		);
		const replaceUnknownInstaller = (installer, installerExitedAt) => {
			const row = reopened.database
				.prepare("SELECT payload FROM pi_study_environment_package_operation WHERE operation_id = ?")
				.get(stale.operationId);
			assert.ok(row, "fixture must retain the unknown operation to model a readable legacy record");
			const current = JSON.parse(row.payload);
			const { contentHash: _currentHash, ...body } = current;
			const replacementBody = {
				...body,
				installer,
				installerExitedAt,
				updatedAt: new Date().toISOString(),
			};
			const replacement = { ...replacementBody, contentHash: contentHash(replacementBody) };
			reopened.database
				.prepare("UPDATE pi_study_environment_package_operation SET payload = ?, payload_hash = ?, updated_at = ? WHERE operation_id = ?")
				.run(JSON.stringify(replacement), contentHash(replacement), replacement.updatedAt, stale.operationId);
		};
		for (const legacy of [
			{
				label: "missing FILETIME identity",
				installer: { pid: 999_999, startedAt: "2000-01-01T00:00:00.000Z", supervisorExecutablePath: join(recoveryRoot, "environment-package-supervisor.exe") },
				installerExitedAt: null,
			},
			{
				label: "missing supervisor helper path",
				installer: { pid: 999_998, startedAt: "2000-01-01T00:00:00.000Z", processCreationIdentity: "123456789012345678" },
				// This proves the check is before every recovery unlock, including the
				// historical installerExitedAt fast path that would skip observation.
				installerExitedAt: "2000-01-01T00:00:01.000Z",
			},
		]) {
			replaceUnknownInstaller(legacy.installer, legacy.installerExitedAt);
			await assert.rejects(
				() => reopened.reconcileEnvironmentPackageOperation(scope, stale.operationId),
				(error) => error?.code === "PACKAGE_RECOVERY_SUPERVISOR_UNPROVEN",
				`${legacy.label} must remain a readable, locked unknown record`,
			);
			assert.equal(
				reopened.listEnvironmentPackageOperations(scope).find((operation) => operation.operationId === stale.operationId)?.status,
				"unknown",
				`${legacy.label} must not unlock the environment`,
			);
		}
		const { contentHash: _planHash, ...lockedPlanBody } = plan;
		const lockedPlanValue = { ...lockedPlanBody, planId: "environment-recovery-locked-plan", createdAt: new Date().toISOString() };
		assert.throws(() => reopened.saveEnvironmentPackagePlan(scope, { ...lockedPlanValue, contentHash: contentHash(lockedPlanValue) }), /locked by a running or unreconciled operation/u);
	} finally {
		reopened.close();
	}
});

test("state polling fences a sole crashed claim and the worker drains a later runnable environment", { concurrency: false, timeout: 60000 }, async () => {
	if (process.platform !== "win32") return;
	await rm(ownershipRoot, { recursive: true, force: true });
	const projectDirectory = join(ownershipRoot, "project");
	await mkdir(projectDirectory, { recursive: true });
	const databasePath = join(ownershipRoot, "learning-harness.sqlite");
	const harness = new LearningHarness({ databasePath });
	const projectId = "environment-ownership-project";
	const sessionId = "environment-ownership-session";
	const scope = (() => {
		harness.projectWorkspaces.create({ id: projectId, title: "Environment ownership fixture", cwd: projectDirectory, courseProjectId: null, defaults: null });
		harness.projectWorkspaces.move(sessionId, projectId);
		const phase = harness.studyResearch.bindSession(projectId, sessionId, "study");
		return { projectId, sessionId, expectedPhaseRevision: phase.revision };
	})();
	const makeBlockedPlan = (planId) => {
		const body = {
			planId,
			language: "python",
			projectDirectory,
			environmentDirectory: join(projectDirectory, "blocked-environment"),
			executablePath: process.execPath,
			requests: [{ name: "blocked-fixture", version: "1.0.0" }],
			inventory: [],
			inventoryHash: contentHash([]),
			packages: [{ name: "blocked-fixture", version: "1.0.0", source: "file:///blocked-fixture.whl", sourceHash: `sha256:${"b".repeat(64)}`, change: "install", direct: true }],
			requiresExistingChangeConsent: false,
			resolver: "pip-report-v1",
			createdAt: new Date().toISOString(),
		};
		return { ...body, contentHash: contentHash(body) };
	};
	let crashWorker;
	try {
		const blockedPlan = harness.saveEnvironmentPackagePlan(scope, makeBlockedPlan("environment-ownership-blocked-plan"));
		const crashedOperation = harness.queueEnvironmentPackageOperation(scope, {
			planId: blockedPlan.planId,
			expectedPlanRevision: blockedPlan.revision,
			requestId: "environment-ownership-crashed-request-0001",
			acceptExistingChanges: false,
		});
		const harnessModule = pathToFileURL(resolve("packages/learning-harness/src/index.ts")).href;
		const workerProgram = [
			`import { LearningHarness } from ${JSON.stringify(harnessModule)};`,
			"const harness = new LearningHarness({ databasePath: process.env.OWNERSHIP_DATABASE_PATH });",
			"const claim = harness.claimEnvironmentPackageOperation(process.env.OWNERSHIP_PROJECT_ID, process.env.OWNERSHIP_WORKER_ID);",
			"process.stdout.write(JSON.stringify({ claimed: Boolean(claim), operationId: claim && claim.operation.operationId }) + '\\n');",
			"setInterval(() => {}, 1000);",
		].join("\n");
		crashWorker = spawn(process.execPath, ["--input-type=module", "--eval", workerProgram], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				OWNERSHIP_DATABASE_PATH: databasePath,
				OWNERSHIP_PROJECT_ID: projectId,
				OWNERSHIP_WORKER_ID: "environment-ownership-crash-worker",
			},
		});
		await new Promise((ready, reject) => {
			let output = "";
			crashWorker.once("error", reject);
			crashWorker.stdout.on("data", (chunk) => {
				output += String(chunk);
				if (output.includes(`\"operationId\":\"${crashedOperation.operationId}\"`)) ready();
			});
		});
		const closed = new Promise((ready) => crashWorker.once("close", ready));
		crashWorker.kill();
		await closed;

		// The fixture advances the persisted deadline instead of waiting fifteen minutes.
		const database = harness.database;
		const stored = database.prepare("SELECT payload FROM pi_study_environment_package_operation WHERE operation_id = ?").get(crashedOperation.operationId);
		const expired = JSON.parse(stored.payload);
		const now = new Date(Date.now() - 1_000).toISOString();
		expired.leaseExpiresAt = now;
		expired.updatedAt = now;
		const { contentHash: _oldHash, ...expiredBody } = expired;
		expired.contentHash = contentHash(expiredBody);
		database.prepare("UPDATE pi_study_environment_package_operation SET lease_expires_at = ?, updated_at = ?, payload = ?, payload_hash = ? WHERE operation_id = ?")
			.run(expired.leaseExpiresAt, expired.updatedAt, JSON.stringify(expired), contentHash(expired), crashedOperation.operationId);

		// No later claim occurs here: this is the ordinary state-read watchdog path.
		harness.environmentPackageDrainState(projectId);
		assert.equal(
			harness.listEnvironmentPackageOperations(scope).find((operation) => operation.operationId === crashedOperation.operationId)?.status,
			"unknown",
			"a sole crashed running operation must become unknown during normal state polling",
		);

		const blockedQueued = harness.queueEnvironmentPackageOperation(scope, {
			planId: blockedPlan.planId,
			expectedPlanRevision: blockedPlan.revision,
			requestId: "environment-ownership-blocked-request-0002",
			acceptExistingChanges: false,
		});
		const python = await createProjectPythonEnvironment({ projectDirectory });
		const wheelDirectory = join(python.venvDirectory, "fixture-wheels");
		await buildFixtureWheel(wheelDirectory);
		const runnablePlan = await planEnvironmentPackageChanges({
			language: "python",
			projectDirectory,
			environmentDirectory: python.venvDirectory,
			executablePath: python.environment.executablePath,
			requests: [{ name: "study-fixture-package", version: "1.0.0" }],
			localWheelDirectory: wheelDirectory,
		});
		const persistedRunnable = harness.saveEnvironmentPackagePlan(scope, runnablePlan);
		const runnableOperation = harness.queueEnvironmentPackageOperation(scope, {
			planId: persistedRunnable.planId,
			expectedPlanRevision: persistedRunnable.revision,
			requestId: "environment-ownership-runnable-request-0003",
			acceptExistingChanges: false,
		});
		const beforeDrain = harness.environmentPackageDrainState(projectId);
		assert.equal(beforeDrain.needsInput, 1);
		assert.equal(beforeDrain.runnable, 1, "unknown environment A must not hide runnable environment B");
		const result = await runStudyEnvironmentWorker(harness, { projectId, workerId: "environment-ownership-drain-worker" });
		assert.equal(result.completed, 1, "worker must continue after an unknown locked environment when another environment is runnable");
		assert.equal(result.needsInput, 1);
		const operations = harness.listEnvironmentPackageOperations(scope);
		assert.equal(operations.find((operation) => operation.operationId === blockedQueued.operationId)?.status, "queued");
		assert.equal(operations.find((operation) => operation.operationId === runnableOperation.operationId)?.status, "succeeded");
		await writeFile(join(ownershipRoot, "state-watchdog-evidence.json"), JSON.stringify({
			crashedOperationId: crashedOperation.operationId,
			blockedQueuedOperationId: blockedQueued.operationId,
			runnableOperationId: runnableOperation.operationId,
			beforeDrain,
			workerResult: result,
			operations: operations.map(({ operationId, status, installer }) => ({ operationId, status, installer })),
		}, null, 2) + "\n", "utf8");
	} finally {
		if (crashWorker && crashWorker.exitCode === null && crashWorker.signalCode === null) crashWorker.kill();
		harness.close();
	}
});
