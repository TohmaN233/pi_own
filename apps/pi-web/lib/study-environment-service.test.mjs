import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = resolve(".artifacts/study-research/environment-ownership/service-test-fixture");

test("environment package route rejects non-browser requests and the service enforces phase, plan CAS, and consent before any worker launch", async (t) => {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	const cwd = join(root, "project");
	mkdirSync(cwd);
	const environment = {
		PI_LEARNING_HARNESS_DIR: join(root, "harness"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_MODE_PACK_STORE_PATH: join(root, "mode-packs.json"),
	};
	const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, environment);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("environment package service fixture must not use the network");
	};
	t.after(() => {
		globalThis.__piLearningHarness?.close();
		globalThis.__piLearningHarness = undefined;
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const { POST } = await jiti.import("../app/api/study-research/environment/route.ts");
	const { getLearningHarness } = await jiti.import("./harness-server.ts");
	const { ModePackStore } = await jiti.import("./mode-pack-store.ts");
	const { createPersistedGenericSession } = await jiti.import("./rpc-manager.ts");
	const { contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
	const {
		environmentPackageState,
		installEnvironmentPackagePlanFromUser,
		previewEnvironmentPackageChangesFromUser,
	} = await jiti.import("./study-environment-service.ts");
	const { studyContext } = await jiti.import("./study-research-service.ts");
	const snapshot = (await new ModePackStore().resolve("study-research.study", cwd)).snapshot;
	const harness = getLearningHarness();
	const sessionId = createPersistedGenericSession(cwd, "Environment package fixture", snapshot);
	harness.projectWorkspaces.create({ id: "environment-service-project", title: "Environment package fixture", cwd, courseProjectId: null, defaults: snapshot });
	harness.projectWorkspaces.move(sessionId, "environment-service-project");
	const { scope, phase } = await studyContext(sessionId);
	const url = "http://127.0.0.1:30141/api/study-research/environment";
	const browserHeaders = {
		host: "127.0.0.1:30141",
		origin: "http://127.0.0.1:30141",
		"sec-fetch-site": "same-origin",
		"sec-fetch-mode": "cors",
		"content-type": "application/json",
	};

	const headerless = await POST(new Request(url, { method: "POST", body: "{}" }));
	assert.equal(headerless.status, 403);
	const invalidAction = await POST(new Request(url, {
		method: "POST",
		headers: browserHeaders,
		body: JSON.stringify({ action: "run-any-command", sessionId, expectedPhaseRevision: phase.revision }),
	}));
	assert.equal(invalidAction.status, 400);
	assert.match((await invalidAction.json()).error, /Unknown environment package action/);
	await assert.rejects(
		previewEnvironmentPackageChangesFromUser({
			sessionId,
			expectedPhaseRevision: phase.revision,
			language: "python",
			requests: [{ name: "study-fixture-package", version: ">=2.0.0" }],
		}),
		/Package version is invalid/,
	);

	const inventory = [{ name: "study-fixture-package", version: "1.0.0", location: join(cwd, ".study-python-venv") }];
	const planBody = {
		planId: "environment-package-service-consent-fixture",
		language: "python",
		projectDirectory: cwd,
		environmentDirectory: join(cwd, ".study-python-venv"),
		executablePath: join(cwd, ".study-python-venv", "Scripts", "python.exe"),
		requests: [{ name: "study-fixture-package", version: "2.0.0" }],
		inventory,
		inventoryHash: contentHash(inventory.map(({ name, version, location }) => ({ name, version, location }))),
		packages: [{
			name: "study-fixture-package",
			version: "2.0.0",
			source: `file:///${join(cwd, "fixture-wheels", "study_fixture_package-2.0.0-py3-none-any.whl").replaceAll("\\", "/")}`,
			sourceHash: `sha256:${"a".repeat(64)}`,
			change: "upgrade",
			direct: true,
		}],
		requiresExistingChangeConsent: true,
		resolver: "offline-service-fixture",
		createdAt: new Date().toISOString(),
	};
	const persisted = harness.saveEnvironmentPackagePlan(scope, { ...planBody, contentHash: contentHash(planBody) });
	const state = await environmentPackageState({ sessionId });
	assert.equal(state.plans.length, 1);
	assert.equal(state.plans[0].packages[0].source, "[local package source]");

	const validRequest = {
		sessionId,
		expectedPhaseRevision: phase.revision,
		planId: persisted.planId,
		expectedPlanRevision: persisted.revision,
		requestId: "environment-service-request-0001",
		acceptExistingChanges: false,
	};
	await assert.rejects(
		installEnvironmentPackagePlanFromUser({ ...validRequest, expectedPhaseRevision: phase.revision + 1 }),
		/phase revision conflict/,
	);
	await assert.rejects(
		installEnvironmentPackagePlanFromUser({ ...validRequest, expectedPlanRevision: persisted.revision + 1 }),
		/plan changed before installation was requested/,
	);
	await assert.rejects(installEnvironmentPackagePlanFromUser(validRequest), /requires exact browser approval/);
	assert.deepEqual((await environmentPackageState({ sessionId })).operations, [], "all rejected requests must precede durable queueing and worker launch");

	const { createProjectPythonEnvironment } = await jiti.import("../../../packages/study-execution-host/src/environments.ts");
	const { planEnvironmentPackageChanges } = await jiti.import("../../../packages/study-execution-host/src/environment-package-changes.ts");
	const python = await createProjectPythonEnvironment({ projectDirectory: cwd });
	const wheelDirectory = join(python.venvDirectory, "fixture-wheels");
	const wheelProgram = [
		"import pathlib, sys, zipfile",
		"root = pathlib.Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)",
		"target = root / 'watchdog_fixture-1.0.0-py3-none-any.whl'",
		"dist = 'watchdog_fixture-1.0.0.dist-info'",
		"with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:",
		" z.writestr('watchdog_fixture/__init__.py', \"VALUE = 'watchdog'\\n\")",
		" z.writestr(dist + '/METADATA', 'Metadata-Version: 2.1\\nName: watchdog-fixture\\nVersion: 1.0.0\\n')",
		" z.writestr(dist + '/WHEEL', 'Wheel-Version: 1.0\\nGenerator: study-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
		" z.writestr(dist + '/RECORD', '')",
	].join("\n");
	execFileSync("python", ["-I", "-c", wheelProgram, wheelDirectory], { windowsHide: true });
	const watchdogPlan = await planEnvironmentPackageChanges({
		language: "python",
		projectDirectory: cwd,
		environmentDirectory: python.venvDirectory,
		executablePath: python.environment.executablePath,
		requests: [{ name: "watchdog-fixture", version: "1.0.0" }],
		localWheelDirectory: wheelDirectory,
	});
	const persistedWatchdogPlan = harness.saveEnvironmentPackagePlan(scope, watchdogPlan);
	const queuedWatchdogOperation = harness.queueEnvironmentPackageOperation(scope, {
		planId: persistedWatchdogPlan.planId,
		expectedPlanRevision: persistedWatchdogPlan.revision,
		requestId: "environment-service-watchdog-request-0002",
		acceptExistingChanges: false,
	});
	// This models a detached worker that died before its first claim. State polling
	// must notice the durable runnable row and launch the packaged worker itself.
	const watchdogState = await environmentPackageState({ sessionId });
	assert.equal(watchdogState.worker?.requested, true, "state read must request a detached worker for a runnable durable operation");
	let completedWatchdogOperation;
	for (let retry = 0; retry < 150; retry++) {
		completedWatchdogOperation = harness.listEnvironmentPackageOperations(scope)
			.find((operation) => operation.operationId === queuedWatchdogOperation.operationId);
		if (["succeeded", "failed", "unknown"].includes(completedWatchdogOperation?.status)) break;
		await new Promise((ready) => setTimeout(ready, 200));
	}
	assert.equal(completedWatchdogOperation?.status, "succeeded", "packaged detached worker launched by state polling must validate the installed inventory");
	writeFileSync(resolve(".artifacts/study-research/environment-ownership/state-watchdog-launch-evidence.json"), JSON.stringify({
		worker: watchdogState.worker,
		operationId: queuedWatchdogOperation.operationId,
		status: completedWatchdogOperation.status,
		startedAt: completedWatchdogOperation.startedAt,
		completedAt: completedWatchdogOperation.completedAt,
		installer: completedWatchdogOperation.installer,
	}, null, 2) + "\n");
});
