import { readFile } from "node:fs/promises";
import { createNativeWindowsNodeAdapter } from "../../../packages/study-execution-host/src/coordinator.ts";
import { executionSha256, frozenEnvironmentDescriptorHash } from "../../../packages/study-execution-host/src/execution-payloads.ts";
import type { ExecutionResourceRequest } from "../../../packages/study-execution-host/src/execution-queue.ts";
import type { VisualValidationSpecification } from "../../../packages/study-research-host/src/visual-validation.ts";
import type {
	VisualValidationExecutionRecord,
	VisualValidationExecutionView,
	VisualValidationSpecificationRecord,
	VisualValidationTargetReference,
} from "../../../packages/learning-harness/src/index.ts";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { reconnectStudyExecutions, terminalStudyExecution } from "./study-execution-service";
import { studyExecutionResources, validateStudyExecutionResources } from "./study-execution-resources";
import { publicStudyError } from "./study-api-request";
import { studyContext } from "./study-research-service";

type PublicVisualValidationSpecification = Omit<VisualValidationSpecificationRecord, "sessionId" | "contentHash">;
type PublicVisualValidationRun = Omit<VisualValidationExecutionView, "sessionId" | "contentHash" | "outputKey">;

function publicSpecification(value: VisualValidationSpecificationRecord): PublicVisualValidationSpecification {
	const { sessionId: _sessionId, contentHash: _contentHash, ...record } = value;
	return record;
}

function publicRun(value: VisualValidationExecutionView): PublicVisualValidationRun {
	const { sessionId: _sessionId, contentHash: _contentHash, outputKey: _outputKey, ...record } = value;
	return record;
}

/** The detached worker uses the shared packaged coordinator; this local instance only freezes or reads queue data. */
function coordinatorOptions(projectDirectory: string) {
	return {
		coordinatorId: "study-visual-validation-service",
		adapters: [createNativeWindowsNodeAdapter({ runRootDirectory: projectDirectory, cpuRatePercent: 100 })],
		artifactDirectory: projectDirectory,
	};
}

function validateRequestId(value: string): void {
	if (!/^[a-zA-Z0-9-]{16,80}$/u.test(value)) throw new Error("Invalid visual validation request ID");
}

function unlimitedValidationQuota() {
	return {
		maxRuns: Number.MAX_SAFE_INTEGER,
		maxCumulativeWallTimeMs: Number.MAX_SAFE_INTEGER,
		maxCumulativeDiskBytes: Number.MAX_SAFE_INTEGER,
		expiresAt: null,
	};
}

async function isolatedNodeEnvironment() {
	const executablePath = process.execPath;
	const executableBytes = await readFile(executablePath);
	const body = {
		adapterKind: "native-windows-node-v1",
		executablePath,
		files: [{ absolutePath: executablePath, sha256: executionSha256(executableBytes) }],
	};
	return { ...body, descriptorHash: frozenEnvironmentDescriptorHash(body) };
}

function configureQueueForVisualValidation(input: { projectDirectory: string; resources: ExecutionResourceRequest }) {
	const harness = getLearningHarness();
	const capacity = studyExecutionResources(input.projectDirectory);
	const resources = validateStudyExecutionResources(input.resources, capacity);
	if (!harness.studyExecution.getPolicy()) {
		harness.studyExecution.configureTrustedPolicy(
			{
				maxConcurrentRuns: 1,
				maxCpuMilliCores: capacity.maximum.cpuMilliCores,
				maxMemoryMiB: capacity.maximum.memoryMiB,
				leaseDurationMs: 60_000,
			},
			0,
		);
	}
	const policy = harness.studyExecution.getPolicy();
	if (!policy || resources.cpuMilliCores > policy.maxCpuMilliCores || resources.memoryMiB > policy.maxMemoryMiB)
		throw new Error("Requested resources exceed the configured shared execution capacity");
	return { capacity, resources, policy };
}

/** Browser-facing state removes receipt correlation and all local execution locations. */
export async function visualValidationState(input: { sessionId: string; visualizationId: string }) {
	const { host, scope, project, phase } = await studyContext(input.sessionId);
	const visualization = host.getVisualizationDraft(scope, input.visualizationId);
	const harness = getLearningHarness();
	const options = coordinatorOptions(project.cwd);
	const runs = harness.listVisualValidationExecutions(scope, { visualizationId: visualization.visualizationId, coordinatorOptions: options }).map(publicRun);
	const worker = runs.some(run => !terminalStudyExecution(run.queueStatus)) ? await reconnectStudyExecutions(input.sessionId) : null;
	let capacity: ReturnType<typeof studyExecutionResources> | null = null;
	let capacityError: string | null = null;
	try {
		capacity = studyExecutionResources(project.cwd);
	} catch (error) {
		console.error("[study-visual-validation] capacity discovery failed", error);
		capacityError = publicStudyError(error);
	}
	return {
		phase: phase.phase,
		phaseRevision: phase.revision,
		projectRevision: host.projectRevision(scope).revision,
		visualization: {
			visualizationId: visualization.visualizationId,
			revision: visualization.revision,
			contentHash: visualization.contentHash,
			codeHash: visualization.codeHash,
			inputHash: visualization.inputHash,
			environmentHash: visualization.environmentHash,
		},
		specifications: harness.listVisualValidationSpecifications(scope, visualization.visualizationId).map(publicSpecification),
		runs,
		worker,
		capacity,
		capacityError,
		policy: harness.studyExecution.getPolicy(),
	};
}

export async function saveVisualValidationSpecificationFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	specificationId?: string;
	expectedSpecificationRevision?: number;
	target: Pick<VisualValidationTargetReference, "visualizationId" | "visualizationRevision" | "visualizationHash">;
	specification: VisualValidationSpecification;
}) {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return publicSpecification(getLearningHarness().saveVisualValidationSpecification(scope, {
		specificationId: input.specificationId,
		expectedSpecificationRevision: input.expectedSpecificationRevision,
		target: input.target,
		specification: input.specification,
	}));
}

/** A lost browser response may replay after a mode transition; only a new reservation checks the supplied phase revision. */
export async function startVisualValidationFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	specificationId: string;
	expectedSpecificationRevision: number;
	requestId: string;
	resources: ExecutionResourceRequest;
}, signal?: AbortSignal) {
	signal?.throwIfAborted();
	validateRequestId(input.requestId);
	const dispatchKey = `visual-validation:${input.requestId}`;
	const intentHash = contentHash({
		specificationId: input.specificationId,
		specificationRevision: input.expectedSpecificationRevision,
		resources: input.resources,
		phaseRevision: input.expectedPhaseRevision,
	});
	const harness = getLearningHarness();
	const current = await studyContext(input.sessionId);
	const replay = harness.replayVisualValidationExecution(current.scope, dispatchKey, intentHash);
	if (replay) {
		return {
			job: replay.job,
			replay: true,
			run: publicRun(harness.reconcileVisualValidationExecution(current.scope, replay.run.runId, coordinatorOptions(current.project.cwd))),
			worker: terminalStudyExecution(replay.job.status) ? null : await reconnectStudyExecutions(input.sessionId),
		};
	}
	const { scope, project } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	const { resources } = configureQueueForVisualValidation({ projectDirectory: project.cwd, resources: input.resources });
	signal?.throwIfAborted();
	const environment = await isolatedNodeEnvironment();
	signal?.throwIfAborted();
	const admitted = harness.admitVisualValidationExecution(scope, {
		specificationId: input.specificationId,
		expectedSpecificationRevision: input.expectedSpecificationRevision,
		dispatchKey,
		intentHash,
		resources,
		quota: unlimitedValidationQuota(),
		environment,
		coordinatorOptions: coordinatorOptions(project.cwd),
	});
	console.info("[study-visual-validation] validation admitted", {
		projectId: scope.projectId,
		queueJobId: admitted.job.queueJobId,
		taskId: admitted.job.taskId,
		specificationId: input.specificationId,
		specificationRevision: input.expectedSpecificationRevision,
		environmentHash: environment.descriptorHash,
	});
	return {
		job: admitted.job,
		replay: admitted.replay,
		run: publicRun(harness.reconcileVisualValidationExecution(scope, admitted.run.runId, coordinatorOptions(project.cwd))),
		worker: await reconnectStudyExecutions(input.sessionId),
	};
}

/** Cancellation uses the current scope so a phase change never strands an already-visible queued run. */
export async function cancelVisualValidationFromUser(input: { sessionId: string; queueJobId: string }) {
	const { scope, project } = await studyContext(input.sessionId);
	const harness = getLearningHarness();
	const run = harness.listVisualValidationExecutions(scope, { coordinatorOptions: coordinatorOptions(project.cwd) })
		.find((candidate) => candidate.queueJobId === input.queueJobId);
	if (!run) throw new Error("Visual validation execution was not found in this project");
	const job = harness.studyExecution.requestCancellation(input.queueJobId);
	return { job, worker: terminalStudyExecution(job.status) ? null : await reconnectStudyExecutions(input.sessionId) };
}

export async function reconnectVisualValidationsFromUser(sessionId: string) {
	await studyContext(sessionId);
	return reconnectStudyExecutions(sessionId);
}

export type VisualValidationState = Awaited<ReturnType<typeof visualValidationState>>;
export type VisualValidationRun = PublicVisualValidationRun;
export type VisualValidationSpec = PublicVisualValidationSpecification;
export type VisualValidationPrivateRun = VisualValidationExecutionRecord;
