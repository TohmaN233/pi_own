import type { AssignmentDraft } from "../../../packages/course-builder-host/src/index.ts";
import type {
	StudyAssignmentRecord,
	StudyAssignmentSourceReference,
} from "../../../packages/study-research-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { studyContext } from "./study-research-service";

export interface StudyAssignmentBrowserSourceReference {
	sourceId: string;
	sourceHash: string;
	locator?: string | null;
}

export interface StudyAssignmentRequestFromUserInput {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	goal: string;
	sourceRefs: readonly StudyAssignmentBrowserSourceReference[];
	count?: number | null;
	difficulty?: string | null;
	purpose?: string | null;
}

function originSources(input: readonly StudyAssignmentBrowserSourceReference[]): StudyAssignmentSourceReference[] {
	return input.map((source) => ({
		sourceId: source.sourceId,
		sourceHash: source.sourceHash,
		locator: source.locator ?? null,
	}));
}

function sourceView(source: {
	sourceId: string;
	contentHash: string;
	kind: string;
	relativePath: string;
	version: number;
}) {
	return {
		sourceId: source.sourceId,
		sourceHash: source.contentHash,
		kind: source.kind,
		relativePath: source.relativePath,
		version: source.version,
	};
}

export async function studyAssignmentState(sessionId: string) {
	const { host, scope, phase } = await studyContext(sessionId);
	const harness = getLearningHarness();
	const sources = host.listSources(scope).filter((source) => source.current).map(sourceView);
	return {
		phase,
		projectRevision: host.projectRevision(scope).revision,
		sources,
		assignments: harness.studyAssignments.list(scope),
	};
}

/** Only the same-origin browser request route calls this function. */
export async function requestStudyAssignmentFromUser(input: StudyAssignmentRequestFromUserInput): Promise<StudyAssignmentRecord> {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return getLearningHarness().studyAssignments.createRequestFromUser(scope, {
		goal: input.goal,
		sourceRefs: originSources(input.sourceRefs),
		count: input.count,
		difficulty: input.difficulty,
		purpose: input.purpose,
		expectedProjectRevision: input.expectedProjectRevision,
	});
}

export async function readStudyAssignmentRequest(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	requestId: string;
}): Promise<StudyAssignmentRecord> {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return getLearningHarness().studyAssignments.readRequest(scope, input.requestId);
}

export async function saveStudyAssignmentDraft(input: {
	sessionId: string;
	expectedPhaseRevision: number;
	expectedProjectRevision: number;
	requestId: string;
	expectedRequestRevision: number;
	expectedDraftRevision: number;
	draft: AssignmentDraft;
}): Promise<StudyAssignmentRecord> {
	const { scope } = await studyContext(input.sessionId, input.expectedPhaseRevision);
	return getLearningHarness().studyAssignments.saveDraft(scope, {
		requestId: input.requestId,
		expectedRequestRevision: input.expectedRequestRevision,
		expectedDraftRevision: input.expectedDraftRevision,
		expectedProjectRevision: input.expectedProjectRevision,
		draft: input.draft,
	});
}
