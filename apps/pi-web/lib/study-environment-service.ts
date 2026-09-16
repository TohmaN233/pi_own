import { access } from "node:fs/promises";
import { join } from "node:path";
import {
	discoverProjectPythonEnvironment,
	discoverRGlobalLibraryEnvironment,
} from "../../../packages/study-execution-host/src/environments.ts";
import {
	environmentPackageIdentity,
	isExactEnvironmentPackageVersion,
	planEnvironmentPackageChanges,
	type EnvironmentPackageRequest,
} from "../../../packages/study-execution-host/src/environment-package-changes.ts";
import {
	type EnvironmentPackageOperationRecord,
	type EnvironmentPackagePlanRecord,
} from "../../../packages/learning-harness/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { launchStudyEnvironmentWorker } from "./study-environment-launcher";
import { studyContext } from "./study-research-service";
import { runStudyEnvironmentWorker as drainEnvironmentOperations } from "./study-environment-worker-service";

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

function normalizeRequests(
	language: "python" | "r",
	requests: readonly EnvironmentPackageRequest[],
): EnvironmentPackageRequest[] {
	if (!Array.isArray(requests) || requests.length < 1 || requests.length > 64) throw new Error("Choose one through 64 packages");
	const names = new Set<string>();
	return requests.map((request) => {
		const identity = request && typeof request.name === "string" ? environmentPackageIdentity(language, request.name) : null;
		if (!request || !PACKAGE_NAME.test(request.name) || !identity || names.has(identity)) throw new Error("Package names must be unique safe identifiers");
		if (
			request.version !== null &&
			(typeof request.version !== "string" || !isExactEnvironmentPackageVersion(request.version.trim()))
		)
			throw new Error("Package version is invalid");
		names.add(identity);
		return { name: request.name, version: request.version?.trim() || null };
	}).sort((left, right) => left.name.localeCompare(right.name));
}

async function existingPythonPackageEnvironment(projectDirectory: string) {
	const venvDirectory = join(projectDirectory, ".study-python-venv");
	try {
		await access(venvDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error("Prepare the project’s .study-python-venv with a Python cell before resolving package changes");
		throw error;
	}
	const environment = await discoverProjectPythonEnvironment({ projectDirectory, venvDirectory });
	return { executablePath: environment.environment.executablePath, environmentDirectory: environment.venvDirectory };
}

async function existingRPackageEnvironment() {
	const environment = await discoverRGlobalLibraryEnvironment();
	const environmentDirectory = environment.libraryPaths[0];
	if (!environmentDirectory) throw new Error("R has no existing user library path");
	return { executablePath: environment.rscriptExecutable, environmentDirectory };
}

function publicPlan(record: EnvironmentPackagePlanRecord) {
	const plan = record.plan;
	return {
		planId: record.planId, revision: record.revision, createdAt: record.createdAt,
		language: plan.language, requests: plan.requests,
		inventory: plan.inventory.map((entry) => ({ name: entry.name, version: entry.version })),
		inventoryHash: plan.inventoryHash, resolver: plan.resolver,
		packages: plan.packages.map((entry) => ({
			name: entry.name, version: entry.version,
			source: entry.source.startsWith("file:") || entry.source.startsWith("installed:") ? "[local package source]" : entry.source,
			sourceHash: entry.sourceHash, change: entry.change, direct: entry.direct,
		})),
		requiresExistingChangeConsent: plan.requiresExistingChangeConsent,
	};
}

function publicOperation(record: EnvironmentPackageOperationRecord) {
	return {
		operationId: record.operationId, planId: record.planId, planRevision: record.planRevision,
		requestId: record.requestId, consentedAt: record.consentedAt, status: record.status,
		attempts: record.attempts, diagnostic: record.diagnostic, createdAt: record.createdAt,
		updatedAt: record.updatedAt, startedAt: record.startedAt, completedAt: record.completedAt,
		recovery: {
			reconciledAt: record.reconciledAt,
			installer: record.installer === null ? null : {
				pid: record.installer.pid,
				startedAt: record.installer.startedAt,
				exitedAt: record.installerExitedAt,
			},
		},
		result: record.result === null ? null : {
			installed: record.result.installed.map(({ name, version, change, direct }) => ({ name, version, change, direct })),
			finalInventory: record.result.finalInventory.map(({ name, version }) => ({ name, version })),
			finalInventoryHash: record.result.finalInventoryHash, validatedAt: record.result.validatedAt,
		},
	};
}

export async function environmentPackageState(input: { sessionId: string }) {
	const { scope, phase, project } = await studyContext(input.sessionId);
	const harness = getLearningHarness();
	const drain = harness.environmentPackageDrainState(scope.projectId);
	// State polling is the watchdog for a worker that crashed after durable queueing but before its first claim.
	const worker = drain.runnable > 0 ? await launchStudyEnvironmentWorker(project.id) : null;
	return {
		phase,
		plans: harness.listEnvironmentPackagePlans(scope).map(publicPlan),
		operations: harness.listEnvironmentPackageOperations(scope).map(publicOperation),
		drain,
		worker,
	};
}

/** Resolving is an explicit browser action but never changes packages. Python requires the owned venv to already exist. */
export async function previewEnvironmentPackageChangesFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	language: "python" | "r";
	requests: readonly EnvironmentPackageRequest[];
}) {
	const requests = normalizeRequests(input.language, input.requests);
	const initial = await studyContext(input.sessionId, input.expectedPhaseRevision);
	const selected = input.language === "python"
		? await existingPythonPackageEnvironment(initial.project.cwd)
		: await existingRPackageEnvironment();
	const plan = await planEnvironmentPackageChanges({
		language: input.language,
		projectDirectory: initial.project.cwd,
		environmentDirectory: selected.environmentDirectory,
		executablePath: selected.executablePath,
		requests,
	});
	const current = await studyContext(input.sessionId, input.expectedPhaseRevision);
	if (current.scope.projectId !== initial.scope.projectId) throw new Error("Conversation changed project while resolving package changes");
	const record = getLearningHarness().saveEnvironmentPackagePlan(current.scope, plan);
	console.info("[study-environment] package plan persisted", {
		projectId: current.scope.projectId, planId: record.planId, language: plan.language,
		packageCount: plan.packages.length, requiresExistingChangeConsent: plan.requiresExistingChangeConsent,
	});
	return { plan: publicPlan(record) };
}

/** Queue first, then ask the root-owned detached launcher to process the durable operation. */
export async function installEnvironmentPackagePlanFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	planId: string;
	expectedPlanRevision: number;
	requestId: string;
	acceptExistingChanges: boolean;
}) {
	if (!/^[A-Za-z0-9-]{16,80}$/u.test(input.requestId)) throw new Error("Invalid package installation request ID");
	const { scope, project } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	const operation = getLearningHarness().queueEnvironmentPackageOperation(scope, {
		planId: input.planId,
		expectedPlanRevision: input.expectedPlanRevision,
		requestId: input.requestId,
		acceptExistingChanges: input.acceptExistingChanges,
	});
	const worker = await launchStudyEnvironmentWorker(project.id);
	console.info("[study-environment] package operation queued", {
		projectId: project.id, operationId: operation.operationId, planId: operation.planId,
		consented: operation.consentedAt !== null, workerRequested: worker.requested,
	});
	return { operation: publicOperation(operation), worker };
}

/** Explicit recovery never replays a plan; it only proves a fenced unknown operation is safe to unlock. */
export async function reconcileEnvironmentPackageOperationFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	operationId: string;
}) {
	const { scope, project } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	const harness = getLearningHarness();
	const operation = await harness.reconcileEnvironmentPackageOperation(scope, input.operationId);
	const drain = harness.environmentPackageDrainState(scope.projectId);
	const worker = drain.runnable > 0 ? await launchStudyEnvironmentWorker(project.id) : null;
	console.info("[study-environment] package operation reconciled", {
		projectId: project.id,
		operationId: operation.operationId,
		status: operation.status,
		workerRequested: worker?.requested ?? false,
	});
	return { operation: publicOperation(operation), drain, worker };
}

export async function runStudyEnvironmentWorker(input: { projectId: string; workerId: string }) {
	return drainEnvironmentOperations(getLearningHarness(), input);
}

export type StudyEnvironmentPackagePlan = ReturnType<typeof publicPlan>;
export type StudyEnvironmentPackageOperation = ReturnType<typeof publicOperation>;
