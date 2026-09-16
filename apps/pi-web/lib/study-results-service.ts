import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import type { ResearchAnalysisDraft } from "../../../packages/study-research-host/src/index.ts";
import { createNativeWindowsNodeAdapter } from "../../../packages/study-execution-host/src/coordinator.ts";
import { createNativeWindowsCellAdapters } from "../../../packages/study-execution-host/src/cell-native-adapters.ts";
import { getLearningHarness } from "./harness-server";
import { studyContext } from "./study-research-service";

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "limit-reached"]);

function researchResultsCoordinatorOptions() {
	const dataDirectory = resolve(process.env.PI_LEARNING_HARNESS_DIR || join(getAgentDir(), "learning-harness"));
	const paths = {
		runRootDirectory: join(dataDirectory, "study-executions"),
		artifactDirectory: join(dataDirectory, "study-execution-observations"),
	};
	return {
		...paths,
		adapters: [
			createNativeWindowsNodeAdapter({ ...paths, cpuRatePercent: 100 }),
			...createNativeWindowsCellAdapters({ ...paths, cpuRatePercent: 100 }),
		],
	};
}

export type ResearchAnalysisDraftInput = ResearchAnalysisDraft;

function requireResearchPhase(phase: { phase: "study" | "research" }): void {
	if (phase.phase !== "research") {
		throw new Error("Switch this conversation to Research before saving or confirming an analysis");
	}
}

function validateDraft(value: ResearchAnalysisDraftInput): ResearchAnalysisDraftInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Analysis draft must be an object");
	if (!(["positive", "negative", "inconclusive"] as const).includes(value.classification)) {
		throw new Error("Analysis classification is invalid");
	}
	if (typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 200_000) {
		throw new Error("Analysis summary is required and must be bounded");
	}
	for (const [label, entries] of [["limitations", value.limitations], ["claims", value.claims]] as const) {
		if (!Array.isArray(entries) || entries.length > 1_000 || entries.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 20_000)) {
			throw new Error(`Analysis ${label} must be bounded non-empty text entries`);
		}
	}
	return {
		classification: value.classification,
		summary: value.summary.trim(),
		limitations: value.limitations.map((entry) => entry.trim()),
		claims: value.claims.map((entry) => entry.trim()),
	};
}

/** Browser and model-safe result state. The frozen terminal packet exposes code/output, never private queue handles. */
export async function studyResearchResultsState(sessionId: string) {
	const { host, scope, phase, project } = await studyContext(sessionId);
	const harness = getLearningHarness();
	const coordinator = harness.createStudyExecutionCoordinator(researchResultsCoordinatorOptions());
	const terminalRuns = harness.listResearchCellExecutions(scope).flatMap((record) => {
		const task = host.readTaskForCoordinator(record.taskId);
		if (task.projectId !== scope.projectId || !terminalStatuses.has(task.status)) return [];
		const queueJob = harness.studyExecution.getJob(record.queueJobId);
		const snapshot = harness.studyCells.readRun(scope, record.taskId);
		if (queueJob.taskId !== task.taskId || queueJob.status !== task.status) {
			throw new Error("Research terminal run queue receipt differs from its Host task");
		}
		return [{
			taskId: task.taskId,
			taskRevision: task.revision,
			terminalStatus: task.status,
			queueJobId: record.queueJobId,
			planSnapshot: record.planSnapshot,
			cell: snapshot.cell,
			manifest: record.manifest,
			output: coordinator.getPublicResult(record.queueJobId),
			createdAt: record.createdAt,
			changeNote: record.changeNote,
			canCreateAnalysis: record.sessionId === scope.sessionId,
		}];
	});
	return {
		phase: phase.phase,
		phaseRevision: phase.revision,
		projectRevision: host.projectRevision(scope).revision,
		project: { id: project.id, title: project.title },
		results: host.listResults(scope),
		terminalRuns,
		theoryPlans: host.listResearchPlans(scope).filter((plan) => plan.kind === "theory"),
	};
}

/** Terminal-run writes go through the Harness so no web client can invent code/output or a successful process. */
export async function saveResearchAnalysisFromTerminalRun(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	taskId: string;
	expectedTaskRevision: number;
	draft: ResearchAnalysisDraftInput;
}) {
	const { scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	return getLearningHarness().saveResearchAnalysisFromTerminalRun(scope, {
		taskId: input.taskId,
		expectedTaskRevision: input.expectedTaskRevision,
		expectedProjectRevision: input.expectedProjectRevision,
		draft: validateDraft(input.draft),
		coordinatorOptions: researchResultsCoordinatorOptions(),
	});
}

/** Theory has no invented task: the Host freezes the exact current TheoryPlan revision as the origin. */
export async function saveResearchAnalysisFromTheoryPlan(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	planId: string;
	expectedPlanRevision: number;
	draft: ResearchAnalysisDraftInput;
}) {
	const { host, scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	const plan = host.getResearchPlan(scope, input.planId);
	if (plan.kind !== "theory" || plan.revision !== input.expectedPlanRevision) {
		throw new Error("Theory plan changed before the analysis draft was saved");
	}
	return host.createResearchAnalysisDraft(scope, {
		expectedProjectRevision: input.expectedProjectRevision,
		origin: { kind: "theory-plan", planSnapshot: plan },
		draft: validateDraft(input.draft),
	});
}

export async function editResearchAnalysisDraft(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	resultId: string;
	expectedResultRevision: number;
	draft: ResearchAnalysisDraftInput;
}) {
	const { host, scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	return host.editResearchAnalysisDraft(scope, {
		resultId: input.resultId,
		expectedResultRevision: input.expectedResultRevision,
		expectedProjectRevision: input.expectedProjectRevision,
		draft: validateDraft(input.draft),
	});
}

/** This path is intentionally browser-only; the event identity is minted server-side and a model tool cannot call it. */
export async function confirmResearchAnalysisFromUser(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	resultId: string;
	expectedResultRevision: number;
}) {
	const { host, scope, phase } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	requireResearchPhase(phase);
	const result = host.confirmResultFromTrustedUserEvent(
		scope,
		input.resultId,
		input.expectedResultRevision,
		`ui-research-result-confirm:${randomUUID()}`,
	);
	console.info("[study-research-results] user confirmation recorded", {
		projectId: scope.projectId,
		resultId: result.resultId,
		revision: result.revision,
	});
	return result;
}
