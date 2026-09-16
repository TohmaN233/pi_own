import { contentHash } from "../../../packages/harness-core/src/index.ts";
import type { ResearchResult } from "../../../packages/study-research-host/src/index.ts";
import { studyContext } from "./study-research-service";
import { studyResearchResultsState } from "./study-results-service";

/** Model-facing result reads are deliberately smaller than the browser result packet. */
export const MAX_STUDY_RESULT_FIELD_CHARS = 8_000;
const MODEL_STATE_PAGE_SIZE = 5;
const MODEL_EXCERPT_CHARS = 480;

export type StudyResultField = "code" | "parameters" | "plan" | "stdout" | "stderr" | "error" | "analysis";

export type ReadStudyResultFieldInput = {
	sessionId: string;
	expectedPhaseRevision?: number;
	resultId?: string;
	expectedResultRevision?: number;
	taskId?: string;
	expectedTaskRevision?: number;
	field: StudyResultField;
	textOffset?: number;
	textLimit?: number;
	fieldHash?: string;
};

type State = Awaited<ReturnType<typeof studyResearchResultsState>>;
type StateResult = State["results"][number];
type StateTerminalRun = State["terminalRuns"][number];
type StateTheoryPlan = State["theoryPlans"][number];

export type StudyResultFieldRead = {
	available: boolean;
	identity: {
		projectId: string;
		kind: "result" | "terminal-run";
		resultId?: string;
		resultRevision?: number;
		taskId?: string;
		taskRevision?: number;
	};
	field: StudyResultField;
	content: string | null;
	total: number;
	offset: number;
	nextOffset: number | null;
	contentHash: string | null;
	textLimit: number;
	reason?: string;
};

type ReadFromStateInput = Omit<ReadStudyResultFieldInput, "sessionId" | "expectedPhaseRevision">;

type ResultMetadata = {
	resultId: string;
	projectId: string;
	taskId: string | null;
	revision: number;
	classification: ResearchResult["classification"];
	state: ResearchResult["state"];
	summary: string;
	limitations: string[];
	claims: string[];
	contentHash: string;
	createdAt: string;
	updatedAt: string;
	origin: ResearchResult["origin"];
};

function isInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function requireNonNegativeInteger(value: number | undefined, label: string, fallback: number): number {
	const resolved = value ?? fallback;
	if (!isInteger(resolved) || resolved < 0) throw new Error(`${label} must be a non-negative integer`);
	return resolved;
}

function readLimit(value: number | undefined): number {
	const resolved = value ?? MAX_STUDY_RESULT_FIELD_CHARS;
	if (!isInteger(resolved) || resolved < 1 || resolved > MAX_STUDY_RESULT_FIELD_CHARS) {
		throw new Error(`textLimit must be an integer between 1 and ${MAX_STUDY_RESULT_FIELD_CHARS}`);
	}
	return resolved;
}

function safeTextBoundary(value: string, offset: number): number {
	if (offset <= 0 || offset >= value.length) return Math.max(0, Math.min(offset, value.length));
	return isLowSurrogate(value.charCodeAt(offset)) ? offset - 1 : offset;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function safeExcerpt(value: string | null | undefined, max = MODEL_EXCERPT_CHARS): string | null {
	if (value === null || value === undefined) return null;
	if (value.length <= max) return value;
	let end = Math.max(0, max - 1);
	if (isLowSurrogate(value.charCodeAt(end))) end -= 1;
	return `${value.slice(0, end)}…`;
}

function serializeFrozenField(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function resultMetadata(value: StateResult): ResultMetadata {
	return value as unknown as ResultMetadata;
}

function terminalOutput(run: StateTerminalRun): { stdout?: string | null; stderr?: string | null; error?: string | null } {
	const logs = run.output?.logs;
	return {
		stdout: logs?.stdout,
		stderr: logs?.stderr,
		error: logs?.error,
	};
}

function analysisText(result: ResultMetadata | undefined): string | undefined {
	if (!result) return undefined;
	return JSON.stringify({
		resultId: result.resultId,
		projectId: result.projectId,
		taskId: result.taskId,
		revision: result.revision,
		state: result.state,
		classification: result.classification,
		summary: result.summary,
		limitations: result.limitations,
		claims: result.claims,
		contentHash: result.contentHash,
		updatedAt: result.updatedAt,
	});
}

function selectedFieldForResult(result: ResultMetadata, field: StudyResultField): string | undefined {
	if (field === "analysis") return analysisText(result);
	if (result.origin.kind === "theory-plan") {
		return field === "plan" ? serializeFrozenField(result.origin.planSnapshot.detail) : undefined;
	}
	if (result.origin.kind === "terminal-run") {
		if (field === "plan") return serializeFrozenField(result.origin.planSnapshot.detail);
		if (field === "code") return result.origin.cell.code;
		if (field === "parameters") return serializeFrozenField(result.origin.cell.parameters);
		if (field === "stdout") return result.origin.output.stdout ?? undefined;
		if (field === "stderr") return result.origin.output.stderr ?? undefined;
		if (field === "error") return result.origin.output.error ?? undefined;
	}
	return undefined;
}

function selectedFieldForRun(run: StateTerminalRun, state: State, field: StudyResultField): string | undefined {
	if (field === "plan") return serializeFrozenField(run.planSnapshot.detail);
	if (field === "code") return run.cell.code;
	if (field === "parameters") return serializeFrozenField(run.cell.parameters);
	if (field === "stdout" || field === "stderr" || field === "error") return terminalOutput(run)[field] ?? undefined;
	if (field === "analysis") {
		const result = state.results.find((candidate) =>
			candidate.origin.kind === "terminal-run" &&
			candidate.origin.taskId === run.taskId &&
			candidate.origin.taskRevision === run.taskRevision,
		);
		return analysisText(result ? resultMetadata(result) : undefined);
	}
	return undefined;
}

function validateIdentity(input: ReadFromStateInput): void {
	const byResult = input.resultId !== undefined;
	const byTask = input.taskId !== undefined;
	if (byResult === byTask) throw new Error("Provide exactly one resultId or taskId identity");
	if (byResult && (input.expectedResultRevision === undefined || !isInteger(input.expectedResultRevision) || input.expectedResultRevision < 1)) {
		throw new Error("expectedResultRevision is required for a result read");
	}
	if (byTask && (input.expectedTaskRevision === undefined || !isInteger(input.expectedTaskRevision) || input.expectedTaskRevision < 1)) {
		throw new Error("expectedTaskRevision is required for a terminal run read");
	}
	if (input.expectedResultRevision !== undefined && (!isInteger(input.expectedResultRevision) || input.expectedResultRevision < 1)) {
		throw new Error("expectedResultRevision must be a positive integer");
	}
	if (input.expectedTaskRevision !== undefined && (!isInteger(input.expectedTaskRevision) || input.expectedTaskRevision < 1)) {
		throw new Error("expectedTaskRevision must be a positive integer");
	}
}

function missingField(input: ReadFromStateInput, identity: StudyResultFieldRead["identity"], textLimit: number, reason: string): StudyResultFieldRead {
	return {
		available: false,
		identity,
		field: input.field,
		content: null,
		total: 0,
		offset: 0,
		nextOffset: null,
		contentHash: null,
		textLimit,
		reason,
	};
}

function pageField(value: string, identity: StudyResultFieldRead["identity"], field: StudyResultField, offset: number, textLimit: number, fieldHash?: string): StudyResultFieldRead {
	const completeHash = contentHash(value);
	if (fieldHash !== undefined && fieldHash !== completeHash) throw new Error("Frozen result field hash changed before the requested page was read");
	if (offset > value.length) throw new Error("textOffset is beyond the frozen result field");
	const start = safeTextBoundary(value, offset);
	let end = Math.min(value.length, start + textLimit);
	if (end < value.length && end > start && isLowSurrogate(value.charCodeAt(end))) end -= 1;
	if (end === start && start < value.length) {
		// A surrogate pair is indivisible. This can exceed a caller's tiny limit by one code unit,
		// but remains within the capability's global 8000-code-unit bound.
		end = Math.min(value.length, start + 2);
	}
	return {
		available: true,
		identity,
		field,
		content: value.slice(start, end),
		total: value.length,
		offset: start,
		nextOffset: end < value.length ? end : null,
		contentHash: completeHash,
		textLimit,
	};
}

function findResult(state: State, projectId: string, input: ReadFromStateInput): { result?: ResultMetadata; identity: StudyResultFieldRead["identity"] } {
	const result = state.results.find((candidate) => candidate.resultId === input.resultId && candidate.projectId === projectId);
	if (!result) {
		if (state.results.some((candidate) => candidate.resultId === input.resultId)) throw new Error("Result identity belongs to a different project");
		return {
			identity: { projectId, kind: "result", resultId: input.resultId, resultRevision: input.expectedResultRevision },
		};
	}
	const metadata = resultMetadata(result);
	if (metadata.revision !== input.expectedResultRevision) throw new Error("Frozen result revision changed before the requested field was read");
	return {
		result: metadata,
		identity: { projectId, kind: "result", resultId: metadata.resultId, resultRevision: metadata.revision, taskId: metadata.taskId ?? undefined },
	};
}

function findTerminalRun(state: State, projectId: string, input: ReadFromStateInput): { run?: StateTerminalRun; identity: StudyResultFieldRead["identity"] } {
	const run = state.terminalRuns.find((candidate) => candidate.taskId === input.taskId);
	if (!run) return { identity: { projectId, kind: "terminal-run", taskId: input.taskId, taskRevision: input.expectedTaskRevision } };
	if (run.taskRevision !== input.expectedTaskRevision) throw new Error("Frozen terminal task revision changed before the requested field was read");
	return { run, identity: { projectId, kind: "terminal-run", taskId: run.taskId, taskRevision: run.taskRevision } };
}

/**
 * Read one bounded immutable field from a state packet. This pure entry point
 * keeps tests and callers from ever serializing the full result origin.
 */
export function readStudyResultFieldFromState(state: State, projectId: string, input: ReadFromStateInput): StudyResultFieldRead {
	if (state.project.id !== projectId) throw new Error("Study project changed while reading the frozen result state");
	validateIdentity(input);
	if (!["code", "parameters", "plan", "stdout", "stderr", "error", "analysis"].includes(input.field)) {
		throw new Error("Result field is not allowed");
	}
	const offset = requireNonNegativeInteger(input.textOffset, "textOffset", 0);
	const textLimit = readLimit(input.textLimit);
	if (offset > 0 && !input.fieldHash) throw new Error("fieldHash from the first page is required when textOffset is non-zero");

	if (input.resultId !== undefined) {
		const located = findResult(state, projectId, input);
		const identity = located.identity;
		if (!located.result) return missingField(input, identity, textLimit, "Frozen result was not found in this project");
		const value = selectedFieldForResult(located.result, input.field);
		if (value === undefined) return missingField(input, identity, textLimit, `Field ${input.field} is unavailable for this result origin`);
		return pageField(value, identity, input.field, offset, textLimit, input.fieldHash);
	}

	const located = findTerminalRun(state, projectId, input);
	const identity = located.identity;
	if (!located.run) return missingField(input, identity, textLimit, "Frozen terminal run was not found in this project");
	const value = selectedFieldForRun(located.run, state, input.field);
	if (value === undefined) return missingField(input, identity, textLimit, `Field ${input.field} is unavailable for this terminal run`);
	return pageField(value, identity, input.field, offset, textLimit, input.fieldHash);
}

/** Resolve the current Study/Research project before consulting the frozen result packet. */
export async function readStudyResultField(input: ReadStudyResultFieldInput): Promise<StudyResultFieldRead> {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	const state = await studyResearchResultsState(input.sessionId);
	if (state.project.id !== scope.projectId) throw new Error("Study project changed while reading the frozen result state");
	return readStudyResultFieldFromState(state, scope.projectId, input);
}

function availableResultFields(result: ResultMetadata): StudyResultField[] {
	const fields: StudyResultField[] = ["analysis"];
	if (result.origin.kind === "theory-plan") fields.push("plan");
	if (result.origin.kind === "terminal-run") {
		fields.push("plan", "code", "parameters");
		if (result.origin.output.stdout !== null) fields.push("stdout");
		if (result.origin.output.stderr !== null) fields.push("stderr");
		if (result.origin.output.error !== null) fields.push("error");
	}
	return fields;
}

function compactResult(value: StateResult) {
	const result = resultMetadata(value);
	return {
		resultId: result.resultId,
		projectId: result.projectId,
		taskId: result.taskId,
		revision: result.revision,
		classification: result.classification,
		state: result.state,
		summaryExcerpt: safeExcerpt(result.summary),
		contentHash: result.contentHash,
		createdAt: result.createdAt,
		updatedAt: result.updatedAt,
		originKind: result.origin.kind,
		originTaskId: result.origin.kind === "terminal-run" || result.origin.kind === "legacy-execution" ? result.origin.taskId : undefined,
		originTaskRevision: result.origin.kind === "terminal-run" ? result.origin.taskRevision : undefined,
		originPlanId: result.origin.kind === "theory-plan" ? result.origin.planSnapshot.planId : undefined,
		originPlanRevision: result.origin.kind === "theory-plan" ? result.origin.planSnapshot.revision : undefined,
		availableFields: availableResultFields(result),
	};
}

function compactTerminalRun(value: StateTerminalRun) {
	const logs = value.output?.logs;
	const availableFields: StudyResultField[] = ["plan", "code", "parameters", "analysis"];
	if (logs?.stdout !== null && logs?.stdout !== undefined) availableFields.push("stdout");
	if (logs?.stderr !== null && logs?.stderr !== undefined) availableFields.push("stderr");
	if (logs?.error !== null && logs?.error !== undefined) availableFields.push("error");
	return {
		taskId: value.taskId,
		taskRevision: value.taskRevision,
		terminalStatus: value.terminalStatus,
		title: safeExcerpt(value.cell.title),
		language: value.cell.language,
		cellRevision: value.cell.revision,
		planRevision: value.planSnapshot.revision,
		changeNoteExcerpt: safeExcerpt(value.changeNote),
		createdAt: value.createdAt,
		canCreateAnalysis: value.canCreateAnalysis,
		availableFields,
	};
}

function compactTheoryPlan(value: StateTheoryPlan) {
	return {
		planId: value.planId,
		projectId: value.projectId,
		revision: value.revision,
		kind: value.kind,
		questionExcerpt: safeExcerpt(value.detail.question),
		semanticDigest: value.semanticDigest,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		sourceReferenceCount: value.sourceReferences?.length ?? 0,
	};
}

function page<T>(values: readonly T[], offset: number): { values: T[]; nextOffset: number | null } {
	const valuesInPage = values.slice(offset, offset + MODEL_STATE_PAGE_SIZE);
	return { values: valuesInPage, nextOffset: offset + valuesInPage.length < values.length ? offset + valuesInPage.length : null };
}

/** Compact model-facing state while leaving the browser API's full state untouched. */
export function compactStudyResearchResultsState(state: State, offset = 0) {
	const safeOffset = requireNonNegativeInteger(offset, "offset", 0);
	const results = page(state.results, safeOffset);
	const terminalRuns = page(state.terminalRuns, safeOffset);
	const theoryPlans = page(state.theoryPlans, safeOffset);
	return {
		phase: state.phase,
		phaseRevision: state.phaseRevision,
		projectRevision: state.projectRevision,
		project: state.project,
		pageSize: MODEL_STATE_PAGE_SIZE,
		offset: safeOffset,
		results: results.values.map(compactResult),
		resultsNextOffset: results.nextOffset,
		terminalRuns: terminalRuns.values.map(compactTerminalRun),
		terminalRunsNextOffset: terminalRuns.nextOffset,
		theoryPlans: theoryPlans.values.map(compactTheoryPlan),
		theoryPlansNextOffset: theoryPlans.nextOffset,
	};
}

/** Save responses retain identity and review state without echoing the frozen origin. */
export function compactSavedResearchResult(value: ResearchResult) {
	return {
		resultId: value.resultId,
		projectId: value.projectId,
		taskId: value.taskId,
		revision: value.revision,
		state: value.state,
		classification: value.classification,
		summaryExcerpt: safeExcerpt(value.summary),
		contentHash: value.contentHash,
		updatedAt: value.updatedAt,
		originKind: value.origin.kind,
		originTaskId: value.origin.kind === "terminal-run" || value.origin.kind === "legacy-execution" ? value.origin.taskId : undefined,
		originTaskRevision: value.origin.kind === "terminal-run" ? value.origin.taskRevision : undefined,
		originPlanId: value.origin.kind === "theory-plan" ? value.origin.planSnapshot.planId : undefined,
		originPlanRevision: value.origin.kind === "theory-plan" ? value.origin.planSnapshot.revision : undefined,
	};
}
