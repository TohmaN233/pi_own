import { randomUUID } from "node:crypto";
import type { ResearchPlan, ResearchPlanInput } from "../../../packages/study-research-host/src/index.ts";
import type { StudyCodeCell } from "../../../packages/study-execution-host/src/code-cells.ts";
import type { ExecutionResourceRequest, ExecutionScopeQuota } from "../../../packages/study-execution-host/src/execution-queue.ts";
import type {
	ResearchCellExecutionRecord,
	ResearchCellRepair,
	ResearchExecutionInputBinding,
	ResearchExecutionScope,
	ResearchLearningPromotion,
} from "../../../packages/learning-harness/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { cancelStudyExecution, reconnectStudyExecutions, runResearchCodeCell, studyExecutionState } from "./study-execution-service";
import { studyExecutionResources, validateStudyExecutionResources } from "./study-execution-resources";
import { studyContext } from "./study-research-service";

export type ResearchPlanRequest = ResearchPlanInput;

type PublicResearchScope = Omit<ResearchExecutionScope, "sessionId" | "contentHash" | "grantId"> & { usableInCurrentSession: boolean };
type PublicResearchRun = Omit<ResearchCellExecutionRecord, "sessionId" | "contentHash" | "grantId">;
type PublicResearchPromotion = Omit<ResearchLearningPromotion, "sessionId" | "contentHash">;
type PublicResearchRepair = Omit<ResearchCellRepair, "sessionId" | "contentHash">;

function publicScope(scope: ResearchExecutionScope, currentSessionId: string): PublicResearchScope {
	const { sessionId: _sessionId, contentHash: _contentHash, grantId: _grantId, ...value } = scope;
	return { ...value, usableInCurrentSession: scope.sessionId === currentSessionId };
}

function publicRun(run: ResearchCellExecutionRecord): PublicResearchRun {
	const { sessionId: _sessionId, contentHash: _contentHash, grantId: _grantId, ...value } = run;
	return value;
}

function publicPromotion(promotion: ResearchLearningPromotion): PublicResearchPromotion {
	const { sessionId: _sessionId, contentHash: _contentHash, ...value } = promotion;
	return value;
}

function publicRepair(repair: ResearchCellRepair): PublicResearchRepair {
	const { sessionId: _sessionId, contentHash: _contentHash, ...value } = repair;
	return value;
}

function requireResearchPhase(phase: { phase: "study" | "research" }): void {
	if (phase.phase !== "research") throw new Error("Switch this conversation to Research before changing a scientific plan or scope");
}

function validateScopeQuota(quota: ExecutionScopeQuota, resources: ExecutionResourceRequest, expiresAt: string): ExecutionScopeQuota {
	if (quota.expiresAt !== expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())
		throw new Error("Research scope expiry must be a future timestamp and match its cumulative quota");
	for (const [name, value, maximum] of [
		["maxRuns", quota.maxRuns, 10_000],
		["maxCumulativeWallTimeMs", quota.maxCumulativeWallTimeMs, 31_536_000_000],
		["maxCumulativeDiskBytes", quota.maxCumulativeDiskBytes, Number.MAX_SAFE_INTEGER],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid Research scope ${name}`);
	}
	if (quota.maxCumulativeWallTimeMs < resources.wallTimeMs || quota.maxCumulativeDiskBytes < resources.diskBytes)
		throw new Error("Research cumulative quota must cover at least one approved run");
	return { ...quota };
}

function assertChangeText(value: string, label: string): string {
	if (!value.trim() || value.length > 6000) throw new Error(`${label} is required and must be at most 6000 characters`);
	return value.trim();
}

function assertPlanInput(plan: ResearchPlanRequest): ResearchPlanRequest {
	if (!plan || !["theory", "smoke", "formal", "exploration"].includes(plan.kind)) throw new Error("Research plan kind is invalid");
	if (!plan.detail || typeof plan.detail !== "object" || Array.isArray(plan.detail)) throw new Error("Research plan detail must be an object");
	if (!Array.isArray(plan.sourceVersionHashes) || plan.sourceVersionHashes.length > 128) throw new Error("Research plan sources are invalid");
	if (plan.sourceReferences && (!Array.isArray(plan.sourceReferences) || plan.sourceReferences.length > 128)) throw new Error("Research plan source references are invalid");
	return plan;
}

/** Browser-safe Research summary. It omits paths, user-event capabilities and private coordinator handles. */
export async function researchExecutionState(sessionId: string) {
	const { host, scope, phase, project } = await studyContext(sessionId);
	const harness = getLearningHarness();
	const execution = await studyExecutionState(sessionId);
	const records = harness.listResearchCellExecutions(scope);
	const jobs = new Map(execution.runs.map((run) => [run.taskId, run]));
	const researchTaskIds = new Set(records.map((record) => record.taskId));
	return {
		phase: phase.phase,
		phaseRevision: phase.revision,
		projectRevision: host.projectRevision(scope).revision,
		plans: host.listResearchPlans(scope),
		scopes: harness.listResearchExecutionScopes(scope).map((entry) => publicScope(entry, scope.sessionId)),
		runs: records.map((record) => ({ ...publicRun(record), job: jobs.get(record.taskId) ?? null })),
		learningRuns: execution.runs.filter((run) => !researchTaskIds.has(run.taskId) && run.mode === "study"),
		promotions: harness.listResearchLearningPromotions(scope).map(publicPromotion),
		repairs: harness.listResearchCellRepairs(scope).map(publicRepair),
		capacity: execution.capacity,
		capacityError: execution.capacityError,
		policy: execution.policy,
		project: { id: project.id, title: project.title },
	};
}

export async function createResearchPlanFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	plan: ResearchPlanRequest;
}) {
	const { host, scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	return host.createResearchPlan(scope, { expectedProjectRevision: input.expectedProjectRevision, plan: assertPlanInput(input.plan) });
}

export async function reviseResearchPlanFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	planId: string;
	expectedPlanRevision: number;
	plan: ResearchPlanRequest;
}) {
	const { host, scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	return host.reviseResearchPlan(scope, {
		planId: input.planId,
		expectedPlanRevision: input.expectedPlanRevision,
		expectedProjectRevision: input.expectedProjectRevision,
		plan: assertPlanInput(input.plan),
	});
}

/** Only the authenticated browser route calls this function; it mints the trusted user-event identity server-side. */
export async function grantResearchExecutionScopeFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	planId: string;
	expectedPlanRevision: number;
	expiresAt: string;
	allowedLanguages: Array<"python" | "r">;
	allowedInputs: ResearchExecutionInputBinding[];
	maxResources: ExecutionResourceRequest;
	quota: ExecutionScopeQuota;
	changeBoundary: string;
}) {
	const { scope, phase, project } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	const capacity = studyExecutionResources(project.cwd);
	const resources = validateStudyExecutionResources(input.maxResources, capacity);
	const quota = validateScopeQuota(input.quota, resources, input.expiresAt);
	const grant = getLearningHarness().grantResearchExecutionScope(scope, {
		planId: input.planId,
		expectedPlanRevision: input.expectedPlanRevision,
		userEventId: `ui-research-execution-scope:${randomUUID()}`,
		expiresAt: input.expiresAt,
		allowedLanguages: input.allowedLanguages,
		allowedInputs: input.allowedInputs,
		maxResources: resources,
		quota,
		changeBoundary: assertChangeText(input.changeBoundary, "Research change boundary"),
	});
	console.info("[research-execution] user scope approved", { projectId: scope.projectId, scopeId: grant.scopeId, planId: grant.planId, planRevision: grant.planRevision });
	return publicScope(grant, scope.sessionId);
}

export async function revokeResearchExecutionScopeFromUser(input: { sessionId: string; scopeId: string }) {
	const { scope } = await studyContext(input.sessionId);
	const revoked = getLearningHarness().revokeResearchExecutionScope(scope, input.scopeId);
	console.info("[research-execution] user scope revoked", { projectId: scope.projectId, scopeId: revoked.scopeId, grantId: revoked.grantId });
	return publicScope(revoked, scope.sessionId);
}

export async function runResearchCellWithinScope(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	cellId: string;
	expectedCellRevision: number;
	requestId: string;
	resources: ExecutionResourceRequest;
	rPackages: string[];
	planId: string;
	expectedPlanRevision: number;
	scopeId?: string;
	changeNote: string;
}, signal?: AbortSignal) {
	// Reconstruct the requested immutable intent before checking current phase/plan.
	// runResearchCodeCell replays an already committed job first, then strictly admits new work.
	const { scope } = await studyContext(input.sessionId);
	const changeNote = assertChangeText(input.changeNote, "Research run change note");
	let research: Parameters<typeof runResearchCodeCell>[0]["research"];
	let quota: ExecutionScopeQuota;
	if (!input.scopeId) {
		research = { mode: "smoke-learning", planId: input.planId, expectedPlanRevision: input.expectedPlanRevision, changeNote };
		quota = { maxRuns: Number.MAX_SAFE_INTEGER, maxCumulativeWallTimeMs: Number.MAX_SAFE_INTEGER,
			maxCumulativeDiskBytes: Number.MAX_SAFE_INTEGER, expiresAt: null };
	} else {
		if (!input.scopeId) throw new Error("Theory, formal, and exploration executions require an approved user scope");
		const executionScope = getLearningHarness().listResearchExecutionScopes(scope).find((candidate) => candidate.scopeId === input.scopeId);
		if (!executionScope || executionScope.sessionId !== scope.sessionId)
			throw new Error("Research execution scope was not found in this conversation");
		research = { mode: "grant", scopeId: executionScope.scopeId, planId: input.planId, grantId: executionScope.grantId,
			expectedPlanRevision: input.expectedPlanRevision, changeNote };
		quota = executionScope.quota;
	}
	return runResearchCodeCell({ ...input, research, quota }, signal);
}

/** Cancellation intentionally uses the current project binding, not an old phase revision. */
export async function cancelResearchCellFromUser(input: { sessionId: string; queueJobId: string }) {
	const { scope } = await studyContext(input.sessionId);
	const record = getLearningHarness().listResearchCellExecutions(scope).find((candidate) => candidate.queueJobId === input.queueJobId);
	if (!record) throw new Error("Research execution was not found in this project");
	return cancelStudyExecution({ sessionId: input.sessionId, expectedPhaseRevision: scope.expectedPhaseRevision, queueJobId: input.queueJobId });
}

export async function reconnectResearchExecutionsFromUser(sessionId: string) {
	await studyContext(sessionId);
	return reconnectStudyExecutions(sessionId);
}

export async function promoteLearningRunFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	sourceTaskId: string;
	plan: ResearchPlanRequest;
}) {
	const { scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	return getLearningHarness().promoteLearningCellRunToResearchPlan(scope, {
		sourceTaskId: input.sourceTaskId,
		expectedProjectRevision: input.expectedProjectRevision,
		plan: assertPlanInput(input.plan),
	});
}

export async function recordResearchRepairFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	failedTaskId: string;
	repairCellId: string;
	repairCellRevision: number;
	planId: string;
	expectedPlanRevision: number;
	changeReason: string;
}) {
	const { scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	return getLearningHarness().recordResearchCellRepair(scope, {
		...input,
		changeReason: assertChangeText(input.changeReason, "Repair change reason"),
	});
}

export type ResearchExecutionState = Awaited<ReturnType<typeof researchExecutionState>>;
export type ResearchExecutionCell = StudyCodeCell;
