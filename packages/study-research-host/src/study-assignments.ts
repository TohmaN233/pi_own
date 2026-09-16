import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type AssignmentDraft, parseAssignmentDraft } from "../../course-builder-host/src/index.ts";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import type { StudyResearchHost } from "./study-research-host.ts";
import type { PhaseBinding, Scope, StudyPhase } from "./types.ts";

const MAX_GOAL_CHARS = 20_000;
const MAX_DIFFICULTY_CHARS = 256;
const MAX_PURPOSE_CHARS = 6_000;
const MAX_SOURCES = 64;
const MAX_LOCATOR_CHARS = 4_000;
const MAX_QUESTIONS = 200;

export type StudyAssignmentStatus = "requested" | "draft";

/** A source identity is frozen when the browser asks for an Assignment. */
export interface StudyAssignmentSourceReference {
	sourceId: string;
	sourceHash: string;
	locator: string | null;
}

export interface StudyAssignmentRequestInput {
	goal: string;
	sourceRefs: readonly StudyAssignmentSourceReference[];
	count?: number | null;
	difficulty?: string | null;
	purpose?: string | null;
	expectedProjectRevision: number;
}

export interface StudyAssignmentRequest {
	requestId: string;
	projectId: string;
	sessionId: string;
	phase: StudyPhase;
	phaseRevision: number;
	projectRevision: number;
	goal: string;
	count: number | null;
	difficulty: string | null;
	purpose: string | null;
	revision: number;
	draftRevision: number;
	status: StudyAssignmentStatus;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface StudyAssignmentDraftRecord {
	requestId: string;
	projectId: string;
	sessionId: string;
	draftRevision: number;
	draft: AssignmentDraft;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface StudyAssignmentRecord {
	request: StudyAssignmentRequest;
	originSources: StudyAssignmentSourceReference[];
	draft: StudyAssignmentDraftRecord | null;
}

export interface StudyAssignmentSaveDraftInput {
	requestId: string;
	expectedRequestRevision: number;
	expectedDraftRevision: number;
	expectedProjectRevision: number;
	draft: unknown;
}

export interface StudyAssignmentHostOptions {
	clock?: () => Date;
}

interface PayloadRow {
	payload: string;
	payloadHash: string;
}

interface RequestRow extends PayloadRow {
	requestId: string;
	projectId: string;
	sessionId: string;
}

interface DraftRow extends PayloadRow {
	requestId: string;
	projectId: string;
	sessionId: string;
}

interface OriginRow extends PayloadRow {
	requestId: string;
	projectId: string;
	sessionId: string;
	originIndex: number;
}

export class StudyAssignmentError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StudyAssignmentError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function requiredText(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw new StudyAssignmentError("INVALID_INPUT", `${label} must be a non-empty string`);
	const result = value.trim();
	if (result.length > max) throw new StudyAssignmentError("INPUT_TOO_LARGE", `${label} exceeds ${max} characters`);
	return result;
}

function optionalText(value: unknown, label: string, max: number): string | null {
	if (value === undefined || value === null) return null;
	return requiredText(value, label, max);
}

function requiredInteger(value: unknown, label: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
		throw new StudyAssignmentError("INVALID_INPUT", `${label} must be an integer from ${min} to ${max}`);
	return value as number;
}

function requiredRevision(value: unknown, label: string, minimum = 0): number {
	return requiredInteger(value, label, minimum, Number.MAX_SAFE_INTEGER);
}

function requiredHash(value: unknown, label: string): string {
	const hash = requiredText(value, label, 80);
	if (!/^sha256:[a-f0-9]{64}$/u.test(hash))
		throw new StudyAssignmentError("INVALID_SOURCE", `${label} must be a sha256 hash`);
	return hash;
}

function withHash<T extends Record<string, unknown>>(body: T): T & { contentHash: string } {
	return { ...body, contentHash: contentHash(body) };
}

function decodeJson<T>(row: PayloadRow, label: string): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.payload) as unknown;
	} catch {
		throw new StudyAssignmentError("CORRUPT_STATE", `${label} is not valid JSON`);
	}
	if (!isRecord(parsed) || typeof parsed.contentHash !== "string")
		throw new StudyAssignmentError("CORRUPT_STATE", `${label} has an invalid shape`);
	const { contentHash: identity, ...body } = parsed;
	if (identity !== row.payloadHash || contentHash(body) !== identity)
		throw new StudyAssignmentError("CORRUPT_STATE", `${label} integrity check failed`);
	return parsed as T;
}

function validTimestamp(value: string, label: string): void {
	if (!Number.isFinite(Date.parse(value))) throw new StudyAssignmentError("CORRUPT_STATE", `${label} is invalid`);
}

function sourceIdentity(source: StudyAssignmentSourceReference): string {
	return `${source.sourceId}\0${source.sourceHash}`;
}

/**
 * Study's Assignment adapter deliberately depends on the Course Builder parser
 * only as a schema validator. It never calls CourseBuilderHost and never creates
 * course, lesson, session or material records.
 */
export class StudyAssignmentHost {
	private readonly database: DatabaseSync;
	private readonly studyResearch: StudyResearchHost;
	private readonly clock: () => Date;
	private transactionSequence = 0;

	constructor(database: DatabaseSync, studyResearch: StudyResearchHost, options: StudyAssignmentHostOptions = {}) {
		this.database = database;
		this.studyResearch = studyResearch;
		this.clock = options.clock ?? (() => new Date());
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS pi_study_assignment_request (
				request_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				phase TEXT NOT NULL,
				phase_revision INTEGER NOT NULL,
				project_revision INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				draft_revision INTEGER NOT NULL,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS pi_study_assignment_request_scope
				ON pi_study_assignment_request(project_id, session_id, updated_at, request_id);
			CREATE TABLE IF NOT EXISTS pi_study_assignment_origin (
				request_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				origin_index INTEGER NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL,
				PRIMARY KEY(request_id, origin_index)
			);
			CREATE TABLE IF NOT EXISTS pi_study_assignment_draft (
				request_id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				draft_revision INTEGER NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT NOT NULL
			);
		`);
	}

	/** Browser-only callers invoke this method after same-origin validation. */
	createRequestFromUser(scope: Scope, input: StudyAssignmentRequestInput): StudyAssignmentRecord {
		return this.transaction(() => {
			const phase = this.studyResearch.getPhase(scope);
			const projectRevision = this.requireCurrentProjectRevision(scope, input.expectedProjectRevision);
			const requestInput = this.validateRequestInput(input);
			const originSources = this.validateCurrentSources(scope, requestInput.sourceRefs);
			const createdAt = this.timestamp();
			const body = {
				requestId: `study-assignment-${randomUUID()}`,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
				phase: phase.phase,
				phaseRevision: phase.revision,
				projectRevision,
				goal: requestInput.goal,
				count: requestInput.count,
				difficulty: requestInput.difficulty,
				purpose: requestInput.purpose,
				revision: 1,
				draftRevision: 0,
				status: "requested" as const,
				createdAt,
				updatedAt: createdAt,
			};
			const request = withHash(body) as StudyAssignmentRequest;
			this.insertRequest(request);
			this.insertOrigins(request, originSources);
			return { request: clone(request), originSources: clone(originSources), draft: null };
		});
	}

	readRequest(scope: Scope, requestId: string): StudyAssignmentRecord {
		this.studyResearch.getPhase(scope);
		const id = requiredText(requestId, "requestId", 128);
		const request = this.readRequestForScope(scope, id);
		return this.readRecord(request);
	}

	list(scope: Scope): StudyAssignmentRecord[] {
		this.studyResearch.getPhase(scope);
		const rows = this.database
			.prepare(
				"SELECT request_id AS requestId, project_id AS projectId, session_id AS sessionId, payload, payload_hash AS payloadHash FROM pi_study_assignment_request WHERE project_id = ? AND session_id = ? ORDER BY updated_at DESC, request_id DESC",
			)
			.all(scope.projectId, scope.sessionId) as unknown as RequestRow[];
		return rows.map((row) => {
			const request = this.decodeRequest(row);
			return this.readRecord(request);
		});
	}

	/** Agent-owned draft construction; it accepts an existing browser request only. */
	saveDraft(scope: Scope, input: StudyAssignmentSaveDraftInput): StudyAssignmentRecord {
		return this.transaction(() => {
			this.studyResearch.getPhase(scope);
			const requestId = requiredText(input.requestId, "requestId", 128);
			const expectedRequestRevision = requiredRevision(input.expectedRequestRevision, "expectedRequestRevision", 1);
			const expectedDraftRevision = requiredRevision(input.expectedDraftRevision, "expectedDraftRevision", 0);
			const expectedProjectRevision = requiredRevision(input.expectedProjectRevision, "expectedProjectRevision", 0);
			const currentProjectRevision = this.requireCurrentProjectRevision(scope, expectedProjectRevision);
			const request = this.readRequestForScope(scope, requestId);
			if (request.revision !== expectedRequestRevision)
				throw new StudyAssignmentError(
					"REQUEST_REVISION_CONFLICT",
					`Expected Assignment request revision ${expectedRequestRevision}, actual ${request.revision}`,
				);
			if (request.projectRevision !== currentProjectRevision)
				throw new StudyAssignmentError(
					"REQUEST_STALE_PROJECT",
					"Assignment request was created against an older Study project revision",
				);
			this.assertRequestCurrent(scope, request);
			const currentDraft = this.readDraft(request);
			if ((currentDraft?.draftRevision ?? 0) !== expectedDraftRevision)
				throw new StudyAssignmentError(
					"DRAFT_REVISION_CONFLICT",
					`Expected Assignment draft revision ${expectedDraftRevision}, actual ${currentDraft?.draftRevision ?? 0}`,
				);
			const originSources = this.readOrigins(request);
			this.validateCurrentSources(scope, originSources);
			const draft = this.validateDraft(input.draft, request, originSources);
			const updatedAt = this.timestamp();
			const nextDraftBody = {
				requestId: request.requestId,
				projectId: request.projectId,
				sessionId: request.sessionId,
				draftRevision: expectedDraftRevision + 1,
				draft,
				createdAt: currentDraft?.createdAt ?? updatedAt,
				updatedAt,
			};
			const nextDraft = withHash(nextDraftBody) as StudyAssignmentDraftRecord;
			const nextRequest = withHash({
				...this.requestBody(request),
				revision: request.revision + 1,
				draftRevision: nextDraft.draftRevision,
				status: "draft" as const,
				updatedAt,
			}) as StudyAssignmentRequest;
			this.updateRequest(request, nextRequest);
			this.upsertDraft(nextDraft);
			return { request: clone(nextRequest), originSources: clone(originSources), draft: clone(nextDraft) };
		});
	}

	private validateRequestInput(input: StudyAssignmentRequestInput): {
		goal: string;
		sourceRefs: StudyAssignmentSourceReference[];
		count: number | null;
		difficulty: string | null;
		purpose: string | null;
	} {
		const goal = requiredText(input.goal, "goal", MAX_GOAL_CHARS);
		if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length < 1 || input.sourceRefs.length > MAX_SOURCES)
			throw new StudyAssignmentError("INVALID_SOURCE", `sourceRefs must contain 1..${MAX_SOURCES} entries`);
		const sourceRefs = input.sourceRefs.map((source, index) => {
			if (!isRecord(source))
				throw new StudyAssignmentError("INVALID_SOURCE", `sourceRefs[${index}] must be an object`);
			const sourceId = requiredText(source.sourceId, `sourceRefs[${index}].sourceId`, 128);
			const sourceHash = requiredHash(source.sourceHash ?? source.contentHash, `sourceRefs[${index}].sourceHash`);
			const locator =
				source.locator === undefined || source.locator === null
					? null
					: requiredText(source.locator, `sourceRefs[${index}].locator`, MAX_LOCATOR_CHARS);
			return { sourceId, sourceHash, locator };
		});
		const identities = new Set<string>();
		for (const source of sourceRefs) {
			const identity = sourceIdentity(source);
			if (identities.has(identity))
				throw new StudyAssignmentError("DUPLICATE_SOURCE", "sourceRefs contains duplicates");
			identities.add(identity);
		}
		const count =
			input.count === undefined || input.count === null
				? null
				: requiredInteger(input.count, "count", 1, MAX_QUESTIONS);
		return {
			goal,
			sourceRefs,
			count,
			difficulty: optionalText(input.difficulty, "difficulty", MAX_DIFFICULTY_CHARS),
			purpose: optionalText(input.purpose, "purpose", MAX_PURPOSE_CHARS),
		};
	}

	private validateCurrentSources(
		scope: Scope,
		requested: readonly StudyAssignmentSourceReference[],
	): StudyAssignmentSourceReference[] {
		const current = this.studyResearch.listSources(scope).filter((source) => source.current);
		const identities = new Set<string>();
		return requested.map((source) => {
			const candidate = current.find(
				(item) => item.sourceId === source.sourceId && item.contentHash === source.sourceHash,
			);
			if (!candidate)
				throw new StudyAssignmentError(
					"SOURCE_STALE",
					`Assignment source ${source.sourceId} is missing or no longer current at ${source.sourceHash}`,
				);
			if (identities.has(source.sourceId))
				throw new StudyAssignmentError(
					"DUPLICATE_SOURCE",
					`Assignment source ${source.sourceId} was selected more than once`,
				);
			identities.add(source.sourceId);
			return { sourceId: candidate.sourceId, sourceHash: candidate.contentHash, locator: source.locator };
		});
	}

	private validateDraft(
		value: unknown,
		request: StudyAssignmentRequest,
		originSources: readonly StudyAssignmentSourceReference[],
	): AssignmentDraft {
		const draft = parseAssignmentDraft(value);
		if (draft.tasks.length < 1)
			throw new StudyAssignmentError("INVALID_QUESTIONS", "Assignment draft must contain at least one question");
		if (request.count !== null && draft.tasks.length !== request.count)
			throw new StudyAssignmentError(
				"INVALID_QUESTIONS",
				`Assignment draft must contain exactly ${request.count} questions`,
			);
		if (draft.solutionNotes.length !== draft.tasks.length)
			throw new StudyAssignmentError("INVALID_QUESTIONS", "Assignment answers must align one-to-one with questions");
		if (draft.materialIds.length < 1)
			throw new StudyAssignmentError(
				"INVALID_QUESTIONS",
				"Assignment draft must identify at least one originating source",
			);
		const sourceIds = new Set(originSources.map((source) => source.sourceId));
		for (const materialId of draft.materialIds)
			if (!sourceIds.has(materialId))
				throw new StudyAssignmentError(
					"SOURCE_SCOPE_MISMATCH",
					`Assignment draft materialId ${materialId} is not one of the request's Study source IDs`,
				);
		return clone(draft);
	}

	private requestBody(request: StudyAssignmentRequest): Omit<StudyAssignmentRequest, "contentHash"> {
		const { contentHash: _identity, ...body } = request;
		return body;
	}

	private decodeRequest(row: RequestRow): StudyAssignmentRequest {
		const request = decodeJson<StudyAssignmentRequest>(row, "Assignment request");
		if (
			request.requestId !== row.requestId ||
			request.projectId !== row.projectId ||
			request.sessionId !== row.sessionId ||
			(request.phase !== "study" && request.phase !== "research") ||
			!Number.isSafeInteger(request.phaseRevision) ||
			!Number.isSafeInteger(request.projectRevision) ||
			!Number.isSafeInteger(request.revision) ||
			!Number.isSafeInteger(request.draftRevision) ||
			(request.status !== "requested" && request.status !== "draft") ||
			(request.status === "requested" && request.draftRevision !== 0) ||
			(request.status === "draft" && request.draftRevision < 1)
		)
			throw new StudyAssignmentError("CORRUPT_STATE", "Assignment request identity or revision is invalid");
		validTimestamp(request.createdAt, "Assignment request createdAt");
		validTimestamp(request.updatedAt, "Assignment request updatedAt");
		return request;
	}

	private decodeDraft(row: DraftRow): StudyAssignmentDraftRecord {
		const draft = decodeJson<StudyAssignmentDraftRecord>(row, "Assignment draft");
		if (
			draft.requestId !== row.requestId ||
			draft.projectId !== row.projectId ||
			draft.sessionId !== row.sessionId ||
			!Number.isSafeInteger(draft.draftRevision) ||
			draft.draftRevision < 1
		)
			throw new StudyAssignmentError("CORRUPT_STATE", "Assignment draft identity or revision is invalid");
		validTimestamp(draft.createdAt, "Assignment draft createdAt");
		validTimestamp(draft.updatedAt, "Assignment draft updatedAt");
		try {
			parseAssignmentDraft(draft.draft);
		} catch (error) {
			throw new StudyAssignmentError(
				"CORRUPT_STATE",
				`Assignment draft validation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return draft;
	}

	private decodeOrigin(row: OriginRow): StudyAssignmentSourceReference {
		const persisted = decodeJson<StudyAssignmentSourceReference & { contentHash: string }>(row, "Assignment origin");
		const { contentHash: _identity, ...origin } = persisted;
		if (!origin.sourceId || !origin.sourceHash)
			throw new StudyAssignmentError("CORRUPT_STATE", "Assignment origin has an invalid shape");
		return origin;
	}

	private readRequestForScope(scope: Scope, requestId: string): StudyAssignmentRequest {
		const row = this.database
			.prepare(
				"SELECT request_id AS requestId, project_id AS projectId, session_id AS sessionId, payload, payload_hash AS payloadHash FROM pi_study_assignment_request WHERE request_id = ? AND project_id = ?",
			)
			.get(requestId, scope.projectId) as unknown as RequestRow | undefined;
		if (!row)
			throw new StudyAssignmentError("REQUEST_NOT_FOUND", "Assignment request was not found in this Study project");
		const request = this.decodeRequest(row);
		if (request.sessionId !== scope.sessionId)
			throw new StudyAssignmentError(
				"REQUEST_SESSION_FORBIDDEN",
				"Assignment request belongs to another conversation",
			);
		return request;
	}

	private readRecord(request: StudyAssignmentRequest): StudyAssignmentRecord {
		return { request: clone(request), originSources: this.readOrigins(request), draft: this.readDraft(request) };
	}

	private readOrigins(request: StudyAssignmentRequest): StudyAssignmentSourceReference[] {
		const rows = this.database
			.prepare(
				"SELECT request_id AS requestId, project_id AS projectId, session_id AS sessionId, origin_index AS originIndex, payload, payload_hash AS payloadHash FROM pi_study_assignment_origin WHERE request_id = ? AND project_id = ? AND session_id = ? ORDER BY origin_index",
			)
			.all(request.requestId, request.projectId, request.sessionId) as unknown as OriginRow[];
		if (rows.length < 1 || rows.length > MAX_SOURCES)
			throw new StudyAssignmentError(
				"CORRUPT_STATE",
				"Assignment origin source references are missing or unbounded",
			);
		return rows.map((row) => {
			if (
				row.requestId !== request.requestId ||
				row.projectId !== request.projectId ||
				row.sessionId !== request.sessionId
			)
				throw new StudyAssignmentError("CORRUPT_STATE", "Assignment origin ownership is invalid");
			return this.decodeOrigin(row);
		});
	}

	private readDraft(request: StudyAssignmentRequest): StudyAssignmentDraftRecord | null {
		const row = this.database
			.prepare(
				"SELECT request_id AS requestId, project_id AS projectId, session_id AS sessionId, payload, payload_hash AS payloadHash FROM pi_study_assignment_draft WHERE request_id = ? AND project_id = ? AND session_id = ?",
			)
			.get(request.requestId, request.projectId, request.sessionId) as unknown as DraftRow | undefined;
		if (!row) {
			if (request.draftRevision !== 0)
				throw new StudyAssignmentError("CORRUPT_STATE", "Assignment request is missing its draft record");
			return null;
		}
		const draft = this.decodeDraft(row);
		if (draft.draftRevision !== request.draftRevision)
			throw new StudyAssignmentError("CORRUPT_STATE", "Assignment request and draft revisions differ");
		return clone(draft);
	}

	private assertRequestCurrent(scope: Scope, request: StudyAssignmentRequest): PhaseBinding {
		const phase = this.studyResearch.getPhase(scope);
		if (phase.revision !== request.phaseRevision || phase.phase !== request.phase)
			throw new StudyAssignmentError(
				"REQUEST_STALE_PHASE",
				"Assignment request belongs to an older Study phase revision",
			);
		const projectRevision = this.studyResearch.projectRevision(scope).revision;
		if (projectRevision !== request.projectRevision)
			throw new StudyAssignmentError(
				"REQUEST_STALE_PROJECT",
				"Assignment request belongs to an older Study project revision",
			);
		return phase;
	}

	private requireCurrentProjectRevision(scope: Scope, expected: number): number {
		const expectedRevision = requiredRevision(expected, "expectedProjectRevision", 0);
		const actual = this.studyResearch.projectRevision(scope).revision;
		if (actual !== expectedRevision)
			throw new StudyAssignmentError(
				"PROJECT_REVISION_CONFLICT",
				`Expected Study project revision ${expectedRevision}, actual ${actual}`,
			);
		return actual;
	}

	private insertRequest(request: StudyAssignmentRequest): void {
		const payload = stableStringify(request);
		this.database
			.prepare(
				"INSERT INTO pi_study_assignment_request(request_id, project_id, session_id, phase, phase_revision, project_revision, revision, draft_revision, status, created_at, updated_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				request.requestId,
				request.projectId,
				request.sessionId,
				request.phase,
				request.phaseRevision,
				request.projectRevision,
				request.revision,
				request.draftRevision,
				request.status,
				request.createdAt,
				request.updatedAt,
				payload,
				request.contentHash,
			);
	}

	private insertOrigins(request: StudyAssignmentRequest, origins: readonly StudyAssignmentSourceReference[]): void {
		const statement = this.database.prepare(
			"INSERT INTO pi_study_assignment_origin(request_id, project_id, session_id, origin_index, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const [index, origin] of origins.entries()) {
			const persisted = withHash({ ...origin });
			statement.run(
				request.requestId,
				request.projectId,
				request.sessionId,
				index,
				stableStringify(persisted),
				persisted.contentHash,
			);
		}
	}

	private updateRequest(previous: StudyAssignmentRequest, next: StudyAssignmentRequest): void {
		const payload = stableStringify(next);
		const result = this.database
			.prepare(
				"UPDATE pi_study_assignment_request SET phase = ?, phase_revision = ?, project_revision = ?, revision = ?, draft_revision = ?, status = ?, updated_at = ?, payload = ?, payload_hash = ? WHERE request_id = ? AND project_id = ? AND session_id = ? AND revision = ?",
			)
			.run(
				next.phase,
				next.phaseRevision,
				next.projectRevision,
				next.revision,
				next.draftRevision,
				next.status,
				next.updatedAt,
				payload,
				next.contentHash,
				previous.requestId,
				previous.projectId,
				previous.sessionId,
				previous.revision,
			);
		if (result.changes !== 1)
			throw new StudyAssignmentError("REQUEST_REVISION_CONFLICT", "Assignment request changed before saving");
	}

	private upsertDraft(draft: StudyAssignmentDraftRecord): void {
		const payload = stableStringify(draft);
		this.database
			.prepare(
				"INSERT INTO pi_study_assignment_draft(request_id, project_id, session_id, draft_revision, created_at, updated_at, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET project_id = excluded.project_id, session_id = excluded.session_id, draft_revision = excluded.draft_revision, created_at = excluded.created_at, updated_at = excluded.updated_at, payload = excluded.payload, payload_hash = excluded.payload_hash",
			)
			.run(
				draft.requestId,
				draft.projectId,
				draft.sessionId,
				draft.draftRevision,
				draft.createdAt,
				draft.updatedAt,
				payload,
				draft.contentHash,
			);
	}

	private timestamp(): string {
		const value = this.clock();
		if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
			throw new StudyAssignmentError("INVALID_CLOCK", "clock returned an invalid date");
		return value.toISOString();
	}

	private transaction<T>(work: () => T): T {
		const savepoint = `pi_study_assignment_${++this.transactionSequence}`;
		this.database.exec(`SAVEPOINT ${savepoint}`);
		try {
			const result = work();
			this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
			return result;
		} catch (error) {
			this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
			this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
			throw error;
		}
	}
}
