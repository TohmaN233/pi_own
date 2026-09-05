import type { DatabaseSync } from "node:sqlite";
import { type JsonValue, parseVisualizationSpec } from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";
import { VisualHost } from "../../visual-host/src/index.ts";
import { assertSafeBeamerSource } from "./beamer.ts";
import type {
	BeamerAsset,
	BeamerCompiledArtifact,
	BeamerCompileReceipt,
	BeamerDeck,
	BeamerDeckDraft,
	BeamerProfile,
	CourseBuilderMaterial,
	CourseBuilderMaterialInput,
	CourseBuilderProject,
	CourseBuilderProjectInput,
	CourseBuilderSnapshot,
	CourseBuilderState,
	CourseBuilderVisual,
	DeckReview,
	LessonPlan,
	LessonPlanDraft,
	MaterialAnalysis,
	ReviewDecision,
	SemesterPlan,
	SemesterPlanDraft,
	SessionProjectBinding,
	TeacherReview,
} from "./types.ts";

export class CourseBuilderError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CourseBuilderError";
		this.code = code;
	}
}

const STATE_KEY = "course-builder-v1";
const MAX_PROJECTS = 256;
const MAX_MATERIALS_PER_PROJECT = 512;
const MAX_MATERIAL_TEXT_CHARACTERS = 8_000_000;
const MAX_MATERIAL_INPUT_BYTES = 64 * 1024 * 1024;
const APPROVAL_FIELDS = new Set([
	"approved",
	"approvedAt",
	"accepted",
	"acceptedAt",
	"acceptedReceiptId",
	"review",
	"reviewedAt",
	"reviewer",
	"status",
	"targetHash",
	"targetRevision",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) throw new CourseBuilderError("INVALID_INPUT", `${path} must be an object`);
	return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const set = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!set.has(key)) throw new CourseBuilderError("UNKNOWN_FIELD", `${path}.${key} is not allowed`);
	}
}

function stringValue(value: unknown, path: string, max = 20_000): string {
	if (typeof value !== "string" || !value.trim())
		throw new CourseBuilderError("INVALID_INPUT", `${path} must be a non-empty string`);
	const result = value.trim();
	if (result.length > max) throw new CourseBuilderError("INPUT_TOO_LARGE", `${path} exceeds ${max} characters`);
	return result;
}

// Attribution is optional: do not invent an author or institution to satisfy a form.
function attributionValue(value: unknown, path: string): string {
	if (typeof value !== "string") throw new CourseBuilderError("INVALID_INPUT", `${path} must be a string`);
	const result = value.trim();
	if (result.length > 256) throw new CourseBuilderError("INPUT_TOO_LARGE", `${path} exceeds 256 characters`);
	return result;
}

function nullableString(value: unknown, path: string, max = 20_000): string | null {
	if (value === null) return null;
	return stringValue(value, path, max);
}

function integerValue(value: unknown, path: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new CourseBuilderError("INVALID_INPUT", `${path} must be an integer from ${min} to ${max}`);
	}
	return value as number;
}

function timestamp(value: string, path: string): string {
	if (!Number.isFinite(Date.parse(value)))
		throw new CourseBuilderError("INVALID_TIMESTAMP", `${path} must be ISO-8601`);
	return value;
}

function stringArray(value: unknown, path: string, maxItems = 512): string[] {
	if (!Array.isArray(value) || value.length > maxItems)
		throw new CourseBuilderError("INVALID_INPUT", `${path} must be an array of at most ${maxItems} strings`);
	return value.map((item, index) => stringValue(item, `${path}[${index}]`, 20_000));
}

function jsonRecord(value: unknown, path: string): Record<string, JsonValue> {
	if (value === undefined) return {};
	const record = requireRecord(value, path);
	const encoded = stableStringify(record);
	if (encoded.length > 200_000)
		throw new CourseBuilderError("INPUT_TOO_LARGE", `${path} exceeds 200000 serialized characters`);
	return JSON.parse(encoded) as Record<string, JsonValue>;
}

function unique(values: readonly string[], path: string): string[] {
	if (new Set(values).size !== values.length)
		throw new CourseBuilderError("DUPLICATE_VALUE", `${path} contains duplicate values`);
	return [...values];
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

export function assertNoAgentApprovalFields(value: unknown, path = "draft"): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			assertNoAgentApprovalFields(item, `${path}[${index}]`);
		});
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (APPROVAL_FIELDS.has(key)) {
			throw new CourseBuilderError("APPROVAL_FIELD_FORBIDDEN", `${path}.${key} is controlled by the teacher UI`);
		}
		assertNoAgentApprovalFields(child, `${path}.${key}`);
	}
}

function parseBeamerProfile(value: unknown): BeamerProfile {
	const input = requireRecord(value, "beamerProfile");
	exactKeys(
		input,
		[
			"aspectRatio",
			"fontSize",
			"theme",
			"author",
			"institute",
			"language",
			"overlayPolicy",
			"referencesPolicy",
			"backupSlides",
			"speakerNotes",
			"preamble",
		],
		"beamerProfile",
	);
	if (input.aspectRatio !== "169" && input.aspectRatio !== "43")
		throw new CourseBuilderError("INVALID_INPUT", "beamerProfile.aspectRatio must be 169 or 43");
	if (input.overlayPolicy !== "allow" && input.overlayPolicy !== "deny")
		throw new CourseBuilderError("INVALID_INPUT", "beamerProfile.overlayPolicy is invalid");
	if (input.referencesPolicy !== "required" && input.referencesPolicy !== "optional")
		throw new CourseBuilderError("INVALID_INPUT", "beamerProfile.referencesPolicy is invalid");
	if (typeof input.speakerNotes !== "boolean")
		throw new CourseBuilderError("INVALID_INPUT", "beamerProfile.speakerNotes must be boolean");
	return {
		aspectRatio: input.aspectRatio,
		fontSize: integerValue(input.fontSize, "beamerProfile.fontSize", 8, 14),
		theme: stringValue(input.theme, "beamerProfile.theme", 128),
		author: attributionValue(input.author, "beamerProfile.author"),
		institute: attributionValue(input.institute, "beamerProfile.institute"),
		language: stringValue(input.language, "beamerProfile.language", 64),
		overlayPolicy: input.overlayPolicy,
		referencesPolicy: input.referencesPolicy,
		backupSlides: integerValue(input.backupSlides, "beamerProfile.backupSlides", 0, 20),
		speakerNotes: input.speakerNotes,
		preamble: input.preamble === null ? null : stringValue(input.preamble, "beamerProfile.preamble", 200_000),
	};
}

export function parseCourseBuilderProjectInput(value: unknown): CourseBuilderProjectInput {
	const input = requireRecord(value, "project");
	exactKeys(
		input,
		[
			"courseId",
			"title",
			"weeks",
			"sessionsPerWeek",
			"minutesPerSession",
			"audience",
			"language",
			"goals",
			"beamerProfile",
		],
		"project",
	);
	const courseId = stringValue(input.courseId, "project.courseId", 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(courseId))
		throw new CourseBuilderError("INVALID_COURSE_ID", "project.courseId contains unsupported characters");
	return {
		courseId,
		title: stringValue(input.title, "project.title", 512),
		weeks: integerValue(input.weeks, "project.weeks", 1, 60),
		sessionsPerWeek: integerValue(input.sessionsPerWeek, "project.sessionsPerWeek", 1, 14),
		minutesPerSession: integerValue(input.minutesPerSession, "project.minutesPerSession", 10, 360),
		audience: stringValue(input.audience, "project.audience", 2_000),
		language: stringValue(input.language, "project.language", 64),
		goals: unique(stringArray(input.goals, "project.goals", 100), "project.goals"),
		beamerProfile: parseBeamerProfile(input.beamerProfile),
	};
}

function parseSpiralRevisit(value: unknown, path: string) {
	const input = requireRecord(value, path);
	exactKeys(input, ["conceptId", "progression", "note"], path);
	const allowed = new Set([
		"complexity",
		"relationship",
		"abstraction",
		"formalization",
		"representation",
		"transfer",
		"boundary",
	]);
	if (typeof input.progression !== "string" || !allowed.has(input.progression))
		throw new CourseBuilderError("INVALID_INPUT", `${path}.progression is invalid`);
	return {
		conceptId: stringValue(input.conceptId, `${path}.conceptId`, 256),
		progression: input.progression as
			| "complexity"
			| "relationship"
			| "abstraction"
			| "formalization"
			| "representation"
			| "transfer"
			| "boundary",
		note: stringValue(input.note, `${path}.note`, 4_000),
	};
}

export function parseSemesterPlanDraft(value: unknown): SemesterPlanDraft {
	assertNoAgentApprovalFields(value);
	const input = requireRecord(value, "semesterPlan");
	exactKeys(input, ["title", "rationale", "sessions"], "semesterPlan");
	if (!Array.isArray(input.sessions) || input.sessions.length === 0 || input.sessions.length > 840)
		throw new CourseBuilderError("INVALID_INPUT", "semesterPlan.sessions must have 1..840 entries");
	return {
		title: stringValue(input.title, "semesterPlan.title", 512),
		rationale: stringValue(input.rationale, "semesterPlan.rationale", 50_000),
		sessions: input.sessions.map((value, index) => {
			const path = `semesterPlan.sessions[${index}]`;
			const session = requireRecord(value, path);
			exactKeys(
				session,
				[
					"week",
					"session",
					"title",
					"objectives",
					"prerequisites",
					"topics",
					"materialIds",
					"activities",
					"understandingEvidence",
					"assessment",
					"homework",
					"courseGoalsCovered",
					"revisits",
					"visualOpportunities",
				],
				path,
			);
			if (!Array.isArray(session.revisits))
				throw new CourseBuilderError("INVALID_INPUT", `${path}.revisits must be an array`);
			return {
				week: integerValue(session.week, `${path}.week`, 1, 60),
				session: integerValue(session.session, `${path}.session`, 1, 14),
				title: stringValue(session.title, `${path}.title`, 512),
				objectives: unique(stringArray(session.objectives, `${path}.objectives`, 50), `${path}.objectives`),
				prerequisites: unique(
					stringArray(session.prerequisites, `${path}.prerequisites`, 50),
					`${path}.prerequisites`,
				),
				topics: unique(stringArray(session.topics, `${path}.topics`, 50), `${path}.topics`),
				materialIds: unique(stringArray(session.materialIds, `${path}.materialIds`, 100), `${path}.materialIds`),
				activities: stringArray(session.activities, `${path}.activities`, 100),
				understandingEvidence: stringArray(session.understandingEvidence, `${path}.understandingEvidence`, 100),
				assessment: nullableString(session.assessment, `${path}.assessment`, 10_000),
				homework: nullableString(session.homework, `${path}.homework`, 10_000),
				courseGoalsCovered: unique(
					stringArray(session.courseGoalsCovered, `${path}.courseGoalsCovered`, 100),
					`${path}.courseGoalsCovered`,
				),
				revisits: session.revisits.map((item, revisitIndex) =>
					parseSpiralRevisit(item, `${path}.revisits[${revisitIndex}]`),
				),
				visualOpportunities: stringArray(session.visualOpportunities, `${path}.visualOpportunities`, 100),
			};
		}),
	};
}

export function parseLessonPlanDraft(value: unknown): LessonPlanDraft {
	assertNoAgentApprovalFields(value);
	const input = requireRecord(value, "lessonPlan");
	exactKeys(
		input,
		[
			"week",
			"session",
			"title",
			"objectives",
			"prerequisites",
			"misconceptions",
			"segments",
			"examples",
			"exercises",
			"materialIds",
			"visualRequests",
			"notes",
		],
		"lessonPlan",
	);
	if (!Array.isArray(input.segments) || input.segments.length === 0 || input.segments.length > 100)
		throw new CourseBuilderError("INVALID_INPUT", "lessonPlan.segments must have 1..100 entries");
	return {
		week: integerValue(input.week, "lessonPlan.week", 1, 60),
		session: integerValue(input.session, "lessonPlan.session", 1, 14),
		title: stringValue(input.title, "lessonPlan.title", 512),
		objectives: unique(stringArray(input.objectives, "lessonPlan.objectives", 50), "lessonPlan.objectives"),
		prerequisites: unique(
			stringArray(input.prerequisites, "lessonPlan.prerequisites", 50),
			"lessonPlan.prerequisites",
		),
		misconceptions: stringArray(input.misconceptions, "lessonPlan.misconceptions", 100),
		segments: input.segments.map((value, index) => {
			const path = `lessonPlan.segments[${index}]`;
			const segment = requireRecord(value, path);
			exactKeys(segment, ["minutes", "title", "teacherAction", "learnerAction", "checkForUnderstanding"], path);
			return {
				minutes: integerValue(segment.minutes, `${path}.minutes`, 1, 360),
				title: stringValue(segment.title, `${path}.title`, 512),
				teacherAction: stringValue(segment.teacherAction, `${path}.teacherAction`, 10_000),
				learnerAction: stringValue(segment.learnerAction, `${path}.learnerAction`, 10_000),
				checkForUnderstanding: nullableString(
					segment.checkForUnderstanding,
					`${path}.checkForUnderstanding`,
					10_000,
				),
			};
		}),
		examples: stringArray(input.examples, "lessonPlan.examples", 100),
		exercises: stringArray(input.exercises, "lessonPlan.exercises", 100),
		materialIds: unique(stringArray(input.materialIds, "lessonPlan.materialIds", 100), "lessonPlan.materialIds"),
		visualRequests: stringArray(input.visualRequests, "lessonPlan.visualRequests", 100),
		notes: stringArray(input.notes, "lessonPlan.notes", 100),
	};
}

export function parseBeamerDeckDraft(value: unknown): BeamerDeckDraft {
	assertNoAgentApprovalFields(value);
	const input = requireRecord(value, "beamerDeck");
	exactKeys(input, ["lessonPlanId", "title", "source", "frameOutline", "assetMaterialIds"], "beamerDeck");
	const source = stringValue(input.source, "beamerDeck.source", 2_000_000);
	assertSafeBeamerSource(source);
	return {
		lessonPlanId: stringValue(input.lessonPlanId, "beamerDeck.lessonPlanId", 256),
		title: stringValue(input.title, "beamerDeck.title", 512),
		source,
		frameOutline: stringArray(input.frameOutline, "beamerDeck.frameOutline", 500),
		assetMaterialIds: unique(
			stringArray(input.assetMaterialIds, "beamerDeck.assetMaterialIds", 500),
			"beamerDeck.assetMaterialIds",
		),
	};
}

export function parseMaterialAnalysis(
	value: unknown,
): Omit<MaterialAnalysis, "projectId" | "materialIds" | "createdAt" | "contentHash"> {
	assertNoAgentApprovalFields(value, "materialAnalysis");
	const input = requireRecord(value, "materialAnalysis");
	exactKeys(
		input,
		[
			"topicChains",
			"prerequisiteGaps",
			"duplicates",
			"sequenceGaps",
			"terminologyConflicts",
			"practiceOpportunities",
			"visualOpportunities",
		],
		"materialAnalysis",
	);
	return {
		topicChains: stringArray(input.topicChains, "materialAnalysis.topicChains", 500),
		prerequisiteGaps: stringArray(input.prerequisiteGaps, "materialAnalysis.prerequisiteGaps", 500),
		duplicates: stringArray(input.duplicates, "materialAnalysis.duplicates", 500),
		sequenceGaps: stringArray(input.sequenceGaps, "materialAnalysis.sequenceGaps", 500),
		terminologyConflicts: stringArray(input.terminologyConflicts, "materialAnalysis.terminologyConflicts", 500),
		practiceOpportunities: stringArray(input.practiceOpportunities, "materialAnalysis.practiceOpportunities", 500),
		visualOpportunities: stringArray(input.visualOpportunities, "materialAnalysis.visualOpportunities", 500),
	};
}

function withoutHash<T extends { contentHash: string }>(value: T): Omit<T, "contentHash"> {
	const { contentHash: _hash, ...payload } = value;
	return payload;
}

function assertHash(value: { contentHash: string }, payload: unknown, label: string): void {
	if (value.contentHash !== contentHash(payload))
		throw new CourseBuilderError("CORRUPT_STATE", `${label} has an invalid content hash`);
}

function currentByRevision<T extends { revision: number }>(items: readonly T[]): T | null {
	return [...items].sort((left, right) => right.revision - left.revision)[0] ?? null;
}

export class CourseBuilderHost {
	private readonly database: DatabaseSync;
	private persistedState: string | null = null;
	private readonly visualHost = new VisualHost();
	private projects = new Map<string, CourseBuilderProject>();
	private bindings = new Map<string, SessionProjectBinding>();
	private materials = new Map<string, CourseBuilderMaterial>();
	private materialAnalyses = new Map<string, MaterialAnalysis>();
	private semesterPlans = new Map<string, SemesterPlan[]>();
	private lessonPlans = new Map<string, LessonPlan[]>();
	private decks = new Map<string, BeamerDeck[]>();
	private compileReceipts = new Map<string, BeamerCompileReceipt>();
	private deckReviews = new Map<string, DeckReview>();
	private visuals = new Map<string, CourseBuilderVisual>();

	constructor(database: DatabaseSync) {
		this.database = database;
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS course_builder_state (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS course_builder_source (
                material_id TEXT PRIMARY KEY, bytes BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS course_builder_log (
                receipt_id TEXT PRIMARY KEY, value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS course_builder_audit (
                sequence INTEGER PRIMARY KEY, before_hash TEXT, after_hash TEXT NOT NULL, created_at TEXT NOT NULL
            );
			CREATE TABLE IF NOT EXISTS course_builder_pdf (
				receipt_id TEXT PRIMARY KEY,
				bytes BLOB NOT NULL
			);
		`);
		this.restore();
	}

	createProject(value: unknown, createdAt = new Date().toISOString()): CourseBuilderProject {
		this.refresh();
		const input = parseCourseBuilderProjectInput(value);
		timestamp(createdAt, "createdAt");
		if (this.projects.size >= MAX_PROJECTS)
			throw new CourseBuilderError("PROJECT_LIMIT", `Course Builder supports at most ${MAX_PROJECTS} projects`);
		const projectId = deterministicId("course-project", { courseId: input.courseId, createdAt }, 40);
		if (this.projects.has(projectId)) return clone(this.requireProject(projectId));
		const base: Omit<CourseBuilderProject, "contentHash"> = {
			...input,
			projectId,
			revision: 1,
			createdAt,
			updatedAt: createdAt,
		};
		const project: CourseBuilderProject = { ...base, contentHash: contentHash(base) };
		this.mutate(() => this.projects.set(projectId, project));
		return clone(project);
	}

	updateProject(
		projectId: string,
		value: unknown,
		expectedRevision: number,
		updatedAt = new Date().toISOString(),
	): CourseBuilderProject {
		this.refresh();
		const current = this.requireProject(projectId);
		if (current.revision !== expectedRevision)
			throw new CourseBuilderError(
				"REVISION_CONFLICT",
				`Expected project revision ${expectedRevision}, actual ${current.revision}`,
			);
		const input = parseCourseBuilderProjectInput(value);
		if (input.courseId !== current.courseId)
			throw new CourseBuilderError("COURSE_ID_IMMUTABLE", "project.courseId cannot change");
		timestamp(updatedAt, "updatedAt");
		const base: Omit<CourseBuilderProject, "contentHash"> = {
			...input,
			projectId,
			revision: current.revision + 1,
			createdAt: current.createdAt,
			updatedAt,
		};
		const next: CourseBuilderProject = { ...base, contentHash: contentHash(base) };
		this.mutate(() => this.projects.set(projectId, next));
		return clone(next);
	}

	bindSession(sessionId: string, projectId: string, boundAt = new Date().toISOString()): SessionProjectBinding {
		this.refresh();
		const id = stringValue(sessionId, "sessionId", 512);
		this.requireProject(projectId);
		timestamp(boundAt, "boundAt");
		const current = this.bindings.get(id);
		if (current) {
			if (current.projectId !== projectId)
				throw new CourseBuilderError(
					"SESSION_REBIND_FORBIDDEN",
					"A Pi session cannot be silently rebound to another Course Builder project",
				);
			return clone(current);
		}
		const binding: SessionProjectBinding = { sessionId: id, projectId, boundAt };
		this.mutate(() => this.bindings.set(id, binding));
		return clone(binding);
	}

	listProjects(): CourseBuilderProject[] {
		this.refresh();
		return [...this.projects.values()]
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
			.map(clone);
	}

	getProject(projectId: string): CourseBuilderProject {
		this.refresh();
		return clone(this.requireProject(projectId));
	}

	getProjectForSession(sessionId: string): CourseBuilderProject | null {
		this.refresh();
		const binding = this.bindings.get(sessionId);
		return binding ? clone(this.requireProject(binding.projectId)) : null;
	}

	importMaterials(
		sessionId: string,
		values: readonly CourseBuilderMaterialInput[],
		expectedProjectRevision: number,
		createdAt = new Date().toISOString(),
	): CourseBuilderMaterial[] {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		if (project.revision !== expectedProjectRevision)
			throw new CourseBuilderError(
				"REVISION_CONFLICT",
				`Expected project revision ${expectedProjectRevision}, actual ${project.revision}`,
			);
		timestamp(createdAt, "createdAt");
		if (!Array.isArray(values) || values.length === 0 || values.length > 100)
			throw new CourseBuilderError("INVALID_INPUT", "Material batch must contain 1..100 files");
		const existing = this.projectMaterials(project.projectId);
		if (existing.length + values.length > MAX_MATERIALS_PER_PROJECT)
			throw new CourseBuilderError(
				"MATERIAL_LIMIT",
				`Project supports at most ${MAX_MATERIALS_PER_PROJECT} materials`,
			);
		const existingNames = new Set(existing.map((item) => item.name));
		const batchNames = new Set<string>();
		const prepared = values.map((value, index) => {
			const name = stringValue(value.name, `materials[${index}].name`, 512);
			if (!new Set(["pptx", "pdf", "tex", "markdown", "text", "asset"]).has(value.kind))
				throw new CourseBuilderError("INVALID_INPUT", `materials[${index}].kind is invalid`);
			if (!(value.sourceBytes instanceof Uint8Array))
				throw new CourseBuilderError("INVALID_INPUT", `materials[${index}].sourceBytes must be Uint8Array`);
			if (value.sourceBytes.byteLength > MAX_MATERIAL_INPUT_BYTES)
				throw new CourseBuilderError("MATERIAL_TOO_LARGE", `${name} exceeds ${MAX_MATERIAL_INPUT_BYTES} bytes`);
			if (typeof value.extractedText !== "string" || value.extractedText.length > MAX_MATERIAL_TEXT_CHARACTERS)
				throw new CourseBuilderError(
					"MATERIAL_TEXT_TOO_LARGE",
					`${name} exceeds ${MAX_MATERIAL_TEXT_CHARACTERS} extracted characters`,
				);
			if (existingNames.has(name) || batchNames.has(name))
				throw new CourseBuilderError(
					"DUPLICATE_MATERIAL",
					`Material ${name} already exists in the project or batch`,
				);
			batchNames.add(name);
			const sourceHash = `sha256:${sha256Hex(value.sourceBytes)}`;
			const extractedText = value.extractedText.normalize("NFC").replace(/\r\n?/gu, "\n");
			const textHash = `sha256:${sha256Hex(extractedText)}`;
			const identity = { projectId: project.projectId, name, sourceHash, textHash };
			return {
				materialId: deterministicId("course-builder-material", identity, 40),
				projectId: project.projectId,
				name,
				kind: value.kind,
				sourceHash,
				textHash,
				extractedText,
				metadata: jsonRecord(value.metadata, `materials[${index}].metadata`),
				createdAt,
			} satisfies CourseBuilderMaterial;
		});
		const { contentHash: _oldHash, ...currentPayload } = project;
		const updatedPayload: Omit<CourseBuilderProject, "contentHash"> = {
			...currentPayload,
			revision: project.revision + 1,
			updatedAt: createdAt,
		};
		const updatedProject: CourseBuilderProject = { ...updatedPayload, contentHash: contentHash(updatedPayload) };
		this.mutate(
			() => {
				for (const material of prepared) this.materials.set(material.materialId, material);
				this.projects.set(project.projectId, updatedProject);
			},
			undefined,
			prepared.map((material, index) => ({ materialId: material.materialId, bytes: values[index].sourceBytes })),
		);
		return prepared.map(clone);
	}

	saveMaterialAnalysis(sessionId: string, value: unknown, createdAt = new Date().toISOString()): MaterialAnalysis {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const parsed = parseMaterialAnalysis(value);
		timestamp(createdAt, "createdAt");
		const materialIds = this.projectMaterials(project.projectId)
			.map((item) => item.materialId)
			.sort();
		if (materialIds.length === 0)
			throw new CourseBuilderError("MATERIALS_REQUIRED", "Import course materials before saving an analysis");
		const base = { projectId: project.projectId, materialIds, ...parsed, createdAt };
		const analysis: MaterialAnalysis = { ...base, contentHash: contentHash(base) };
		this.mutate(() => this.materialAnalyses.set(project.projectId, analysis));
		return clone(analysis);
	}

	saveSemesterPlan(
		sessionId: string,
		value: unknown,
		expectedRevision: number,
		createdAt = new Date().toISOString(),
	): SemesterPlan {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const draft = parseSemesterPlanDraft(value);
		timestamp(createdAt, "createdAt");
		this.validateSemesterPlan(project, draft);
		const history = this.semesterPlans.get(project.projectId) ?? [];
		const current = currentByRevision(history);
		if ((current?.revision ?? 0) !== expectedRevision)
			throw new CourseBuilderError("REVISION_CONFLICT", "Draft changed; reload before saving");
		const base: Omit<SemesterPlan, "contentHash"> = {
			...draft,
			semesterPlanId: deterministicId("semester-plan", { projectId: project.projectId }, 40),
			projectRevision: project.revision,
			projectId: project.projectId,
			revision: (current?.revision ?? 0) + 1,
			status: "draft",
			review: null,
			createdAt: current?.createdAt ?? createdAt,
			updatedAt: createdAt,
		};
		const plan: SemesterPlan = { ...base, contentHash: contentHash(base) };
		this.mutate(() => this.semesterPlans.set(project.projectId, [...history, plan]));
		return clone(plan);
	}

	reviewSemesterPlan(
		sessionId: string,
		planId: string,
		expectedRevision: number,
		decision: ReviewDecision,
		note: string,
		reviewedAt = new Date().toISOString(),
	): SemesterPlan {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const history = this.semesterPlans.get(project.projectId) ?? [];
		const current = currentByRevision(history);
		if (!current || current.semesterPlanId !== planId)
			throw new CourseBuilderError("SEMESTER_PLAN_NOT_FOUND", "Current Semester Plan was not found");
		if (current.revision !== expectedRevision)
			throw new CourseBuilderError(
				"REVISION_CONFLICT",
				`Expected Semester Plan revision ${expectedRevision}, actual ${current.revision}`,
			);
		if (current.projectRevision !== project.revision)
			throw new CourseBuilderError("STALE_SEMESTER", "Project or materials changed; revise the Semester Plan");
		const review = this.teacherReview(decision, note, expectedRevision, current.contentHash, reviewedAt);
		const base: Omit<SemesterPlan, "contentHash"> = {
			...withoutHash(current),
			status: decision === "approve" ? "approved" : "changes-requested",
			review,
			updatedAt: reviewedAt,
		};
		const next: SemesterPlan = { ...base, contentHash: contentHash(base) };
		this.mutate(() =>
			this.semesterPlans.set(project.projectId, [
				...history.filter((item) => item.revision !== current.revision),
				next,
			]),
		);
		return clone(next);
	}

	saveLessonPlan(
		sessionId: string,
		value: unknown,
		expectedRevision: number,
		parentRevision: number,
		createdAt = new Date().toISOString(),
	): LessonPlan {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const semester = this.currentSemesterPlan(project.projectId);
		if (!semester || semester.status !== "approved")
			throw new CourseBuilderError(
				"SEMESTER_APPROVAL_REQUIRED",
				"Approve the current Semester Plan before creating Lesson Plans",
			);
		if (semester.projectRevision !== project.revision || semester.revision !== parentRevision)
			throw new CourseBuilderError("STALE_SEMESTER", "Semester Plan changed; reload before planning the lesson");
		const draft = parseLessonPlanDraft(value);
		timestamp(createdAt, "createdAt");
		const slot = semester.sessions.find((item) => item.week === draft.week && item.session === draft.session);
		if (!slot)
			throw new CourseBuilderError(
				"SEMESTER_SLOT_REQUIRED",
				"Lesson Plan does not correspond to a Semester Plan session",
			);
		const minutes = draft.segments.reduce((sum, segment) => sum + segment.minutes, 0);
		if (minutes > project.minutesPerSession)
			throw new CourseBuilderError(
				"LESSON_TIME_EXCEEDED",
				`Lesson segments total ${minutes} minutes, exceeding ${project.minutesPerSession}`,
			);
		this.assertMaterials(project.projectId, draft.materialIds);
		const lessonId = deterministicId(
			"lesson-plan",
			{ projectId: project.projectId, week: draft.week, session: draft.session },
			40,
		);
		const history = this.lessonPlans.get(lessonId) ?? [];
		const current = currentByRevision(history);
		if ((current?.revision ?? 0) !== expectedRevision)
			throw new CourseBuilderError("REVISION_CONFLICT", "Draft changed; reload before saving");
		const base: Omit<LessonPlan, "contentHash"> = {
			...draft,
			lessonPlanId: lessonId,
			projectId: project.projectId,
			semesterPlanId: semester.semesterPlanId,
			semesterPlanRevision: semester.revision,
			revision: (current?.revision ?? 0) + 1,
			status: "draft",
			review: null,
			createdAt: current?.createdAt ?? createdAt,
			updatedAt: createdAt,
		};
		const lesson: LessonPlan = { ...base, contentHash: contentHash(base) };
		this.mutate(() => this.lessonPlans.set(lessonId, [...history, lesson]));
		return clone(lesson);
	}

	reviewLessonPlan(
		sessionId: string,
		lessonPlanId: string,
		expectedRevision: number,
		decision: ReviewDecision,
		note: string,
		reviewedAt = new Date().toISOString(),
	): LessonPlan {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const history = this.lessonPlans.get(lessonPlanId) ?? [];
		const current = currentByRevision(history);
		if (!current || current.projectId !== project.projectId)
			throw new CourseBuilderError("LESSON_PLAN_NOT_FOUND", "Current Lesson Plan was not found");
		if (current.revision !== expectedRevision)
			throw new CourseBuilderError(
				"REVISION_CONFLICT",
				`Expected Lesson Plan revision ${expectedRevision}, actual ${current.revision}`,
			);
		this.assertCurrentLesson(project, current, false);
		const review = this.teacherReview(decision, note, expectedRevision, current.contentHash, reviewedAt);
		const base: Omit<LessonPlan, "contentHash"> = {
			...withoutHash(current),
			status: decision === "approve" ? "approved" : "changes-requested",
			review,
			updatedAt: reviewedAt,
		};
		const next: LessonPlan = { ...base, contentHash: contentHash(base) };
		this.mutate(() =>
			this.lessonPlans.set(lessonPlanId, [...history.filter((item) => item.revision !== current.revision), next]),
		);
		return clone(next);
	}

	saveBeamerDeck(
		sessionId: string,
		value: unknown,
		expectedRevision: number,
		parentRevision: number,
		createdAt = new Date().toISOString(),
	): BeamerDeck {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const draft = parseBeamerDeckDraft(value);
		const lesson = this.currentLessonPlan(draft.lessonPlanId);
		if (!lesson || lesson.projectId !== project.projectId)
			throw new CourseBuilderError("LESSON_PLAN_NOT_FOUND", "Deck Lesson Plan was not found in this project");
		if (lesson.status !== "approved")
			throw new CourseBuilderError(
				"LESSON_APPROVAL_REQUIRED",
				"Approve the current Lesson Plan before creating a Beamer deck",
			);
		this.assertCurrentLesson(project, lesson);
		if (lesson.revision !== parentRevision)
			throw new CourseBuilderError("STALE_LESSON", "Lesson Plan changed before deck submission");
		this.assertMaterials(project.projectId, draft.assetMaterialIds);
		timestamp(createdAt, "createdAt");
		const deckId = deterministicId(
			"beamer-deck",
			{ projectId: project.projectId, lessonPlanId: lesson.lessonPlanId },
			40,
		);
		const history = this.decks.get(deckId) ?? [];
		const current = currentByRevision(history);
		if ((current?.revision ?? 0) !== expectedRevision)
			throw new CourseBuilderError("REVISION_CONFLICT", "Draft changed; reload before saving");
		const sourceHash = `sha256:${sha256Hex(draft.source)}`;
		const base: Omit<BeamerDeck, "contentHash"> = {
			...draft,
			deckId,
			projectId: project.projectId,
			lessonPlanRevision: lesson.revision,
			revision: (current?.revision ?? 0) + 1,
			status: "draft",
			sourceHash,
			createdAt: current?.createdAt ?? createdAt,
			updatedAt: createdAt,
			acceptedAt: null,
			acceptedReceiptId: null,
		};
		const deck: BeamerDeck = { ...base, contentHash: contentHash(base) };
		this.mutate(() => this.decks.set(deckId, [...history, deck]));
		return clone(deck);
	}

	recordCompile(
		sessionId: string,
		receipt: BeamerCompileReceipt,
		artifact: BeamerCompiledArtifact | null,
		log: string,
	): BeamerCompileReceipt {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const deck = this.currentDeck(receipt.deckId);
		if (!deck || deck.projectId !== project.projectId)
			throw new CourseBuilderError("DECK_NOT_FOUND", "Compile receipt deck was not found");
		this.assertCurrentDeck(project, deck);
		if (receipt.deckRevision !== deck.revision || receipt.sourceHash !== deck.sourceHash)
			throw new CourseBuilderError(
				"STALE_COMPILE_RECEIPT",
				"Compile receipt does not match the current deck revision",
			);
		const { contentHash: _hash, ...payload } = receipt;
		assertHash(receipt, payload, "Compile receipt");
		if (receipt.projectId !== project.projectId || receipt.logHash !== `sha256:${sha256Hex(log)}`)
			throw new CourseBuilderError("COMPILE_ARTIFACT_MISMATCH", "Compile project or log hash differs");
		if (receipt.succeeded && (!artifact || receipt.exitCode !== 0 || !receipt.pdfHash))
			throw new CourseBuilderError("COMPILE_ARTIFACT_REQUIRED", "Successful compilation requires an actual PDF");
		if (
			artifact &&
			(artifact.pdfBytes.byteLength < 5 ||
				artifact.pdfBytes.byteLength > 64 * 1024 * 1024 ||
				Buffer.from(artifact.pdfBytes.subarray(0, 5)).toString() !== "%PDF-" ||
				receipt.pdfHash !== `sha256:${sha256Hex(artifact.pdfBytes)}`)
		)
			throw new CourseBuilderError("COMPILE_ARTIFACT_MISMATCH", "PDF bytes do not match the receipt");
		const prior = this.compileReceipts.get(receipt.receiptId);
		if (prior && stableStringify(prior) !== stableStringify(receipt))
			throw new CourseBuilderError("RECEIPT_CONFLICT", "Compile receipts are immutable");
		if (artifact && artifact.receiptId !== receipt.receiptId)
			throw new CourseBuilderError("COMPILE_ARTIFACT_MISMATCH", "Compiled PDF belongs to another receipt");
		const history = this.decks.get(deck.deckId) ?? [];
		const base: Omit<BeamerDeck, "contentHash"> = {
			...withoutHash(deck),
			status: deck.status === "accepted" ? "accepted" : receipt.succeeded ? "compiled" : "draft",
			updatedAt: receipt.createdAt,
		};
		const updated: BeamerDeck = { ...base, contentHash: contentHash(base) };
		this.mutate(
			() => {
				this.compileReceipts.set(receipt.receiptId, clone(receipt));
				this.decks.set(deck.deckId, [...history.filter((item) => item.revision !== deck.revision), updated]);
			},
			artifact ?? undefined,
			[],
			{ receiptId: receipt.receiptId, log },
		);
		return clone(receipt);
	}

	recordDeckReview(sessionId: string, review: DeckReview): DeckReview {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const deck = this.currentDeck(review.deckId);
		if (!deck || deck.projectId !== project.projectId)
			throw new CourseBuilderError("DECK_NOT_FOUND", "Deck review target was not found");
		this.assertCurrentDeck(project, deck);
		if (review.deckRevision !== deck.revision || review.sourceHash !== deck.sourceHash)
			throw new CourseBuilderError("STALE_DECK_REVIEW", "Review does not match the current deck revision");
		const { contentHash: _hash, ...payload } = review;
		assertHash(review, payload, "Deck review");
		if (review.projectId !== project.projectId)
			throw new CourseBuilderError("PROJECT_MISMATCH", "Review belongs to another project");
		const receipt = review.compileReceiptId ? this.compileReceipts.get(review.compileReceiptId) : null;
		if (
			review.status === "pass" &&
			(!receipt?.succeeded ||
				receipt.deckId !== deck.deckId ||
				receipt.deckRevision !== deck.revision ||
				receipt.sourceHash !== deck.sourceHash)
		)
			throw new CourseBuilderError("VALID_COMPILE_REQUIRED", "A passing review requires current compile evidence");
		const history = this.decks.get(deck.deckId) ?? [];
		const base: Omit<BeamerDeck, "contentHash"> = {
			...withoutHash(deck),
			status: deck.status === "accepted" ? "accepted" : review.status === "pass" ? "reviewed" : deck.status,
			updatedAt: review.createdAt,
		};
		const updated: BeamerDeck = { ...base, contentHash: contentHash(base) };
		this.mutate(() => {
			this.deckReviews.set(review.reviewId, clone(review));
			this.decks.set(deck.deckId, [...history.filter((item) => item.revision !== deck.revision), updated]);
		});
		return clone(review);
	}

	acceptDeck(
		sessionId: string,
		deckId: string,
		expectedRevision: number,
		compileReceiptId: string,
		reviewId: string,
		acceptedAt = new Date().toISOString(),
	): BeamerDeck {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const deck = this.currentDeck(deckId);
		if (!deck || deck.projectId !== project.projectId)
			throw new CourseBuilderError("DECK_NOT_FOUND", "Deck was not found");
		this.assertCurrentDeck(project, deck);
		if (deck.revision !== expectedRevision)
			throw new CourseBuilderError(
				"REVISION_CONFLICT",
				`Expected Deck revision ${expectedRevision}, actual ${deck.revision}`,
			);
		const receipt = this.compileReceipts.get(compileReceiptId);
		const review = this.deckReviews.get(reviewId);
		if (
			!receipt ||
			!receipt.succeeded ||
			receipt.deckId !== deckId ||
			receipt.deckRevision !== deck.revision ||
			receipt.sourceHash !== deck.sourceHash
		)
			throw new CourseBuilderError("VALID_COMPILE_REQUIRED", "A successful current compile receipt is required");
		if (
			!review ||
			review.status !== "pass" ||
			review.deckId !== deckId ||
			review.deckRevision !== deck.revision ||
			review.sourceHash !== deck.sourceHash ||
			review.compileReceiptId !== receipt.receiptId
		)
			throw new CourseBuilderError("VALID_REVIEW_REQUIRED", "A passing current deck review is required");
		timestamp(acceptedAt, "acceptedAt");
		const history = this.decks.get(deckId) ?? [];
		const base: Omit<BeamerDeck, "contentHash"> = {
			...withoutHash(deck),
			status: "accepted",
			acceptedAt,
			acceptedReceiptId: receipt.receiptId,
			updatedAt: acceptedAt,
		};
		const accepted: BeamerDeck = { ...base, contentHash: contentHash(base) };
		this.mutate(() =>
			this.decks.set(deckId, [...history.filter((item) => item.revision !== deck.revision), accepted]),
		);
		return clone(accepted);
	}

	createVisual(
		sessionId: string,
		lessonPlanId: string,
		specValue: unknown,
		learningPurpose: string,
		createdAt = new Date().toISOString(),
	): CourseBuilderVisual {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const lesson = this.currentLessonPlan(lessonPlanId);
		if (!lesson || lesson.projectId !== project.projectId)
			throw new CourseBuilderError("LESSON_PLAN_NOT_FOUND", "Visual Lesson Plan was not found");
		const spec = parseVisualizationSpec(specValue);
		if (spec.courseVersionId !== project.projectId)
			throw new CourseBuilderError(
				"VISUAL_PROJECT_MISMATCH",
				"Course Builder visual spec must use the projectId as its bounded owner id",
			);
		const purpose = stringValue(learningPurpose, "learningPurpose", 10_000);
		timestamp(createdAt, "createdAt");
		const artifact = this.visualHost.run(spec, createdAt);
		const validation = this.visualHost.validate(artifact.artifactId, createdAt);
		if (validation.status !== "pass")
			throw new CourseBuilderError(
				"VISUAL_VALIDATION_FAILED",
				validation.issues.map((item) => item.message).join("; "),
			);
		const published = this.visualHost.publish(artifact.artifactId);
		const base = {
			projectId: project.projectId,
			lessonPlanId,
			spec,
			artifact: published,
			learningPurpose: purpose,
			createdAt,
		};
		const identified = { visualId: deterministicId("course-builder-visual", base, 40), ...base };
		const visual: CourseBuilderVisual = { ...identified, contentHash: contentHash(identified) };
		this.mutate(() => this.visuals.set(visual.visualId, visual));
		return clone(visual);
	}

	getSnapshotForSession(sessionId: string): CourseBuilderSnapshot | null {
		this.refresh();
		const binding = this.bindings.get(sessionId);
		return binding ? this.snapshot(binding.projectId) : null;
	}

	getSnapshot(projectId: string): CourseBuilderSnapshot {
		this.refresh();
		return this.snapshot(projectId);
	}

	getCompiledPdf(sessionId: string, receiptId: string): Uint8Array {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const receipt = this.compileReceipts.get(receiptId);
		if (!receipt || receipt.projectId !== project.projectId)
			throw new CourseBuilderError("COMPILE_RECEIPT_NOT_FOUND", "Compile receipt was not found in this project");
		const row = this.database.prepare("SELECT bytes FROM course_builder_pdf WHERE receipt_id = ?").get(receiptId) as
			| { bytes?: Uint8Array }
			| undefined;
		if (!row?.bytes) throw new CourseBuilderError("COMPILED_PDF_NOT_FOUND", "Compiled PDF is unavailable");
		if (receipt.pdfHash !== `sha256:${sha256Hex(row.bytes)}`)
			throw new CourseBuilderError("CORRUPT_STATE", "Stored PDF failed its content hash");
		return new Uint8Array(row.bytes);
	}

	getMaterial(sessionId: string, materialId: string): CourseBuilderMaterial {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		this.assertMaterials(project.projectId, [materialId]);
		return clone(this.materials.get(materialId)!);
	}

	getMaterialBytes(sessionId: string, materialId: string): Uint8Array {
		const material = this.getMaterial(sessionId, materialId);
		const row = this.database
			.prepare("SELECT bytes FROM course_builder_source WHERE material_id = ?")
			.get(materialId) as { bytes: Uint8Array } | undefined;
		if (!row || material.sourceHash !== `sha256:${sha256Hex(row.bytes)}`)
			throw new CourseBuilderError("CORRUPT_STATE", "Stored material bytes failed integrity validation");
		return new Uint8Array(row.bytes);
	}

	getCompileLog(sessionId: string, receiptId: string): string {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const receipt = this.compileReceipts.get(receiptId);
		const row = this.database.prepare("SELECT value FROM course_builder_log WHERE receipt_id = ?").get(receiptId) as
			| { value: string }
			| undefined;
		if (!receipt || receipt.projectId !== project.projectId || !row)
			throw new CourseBuilderError("COMPILE_RECEIPT_NOT_FOUND", "Compile log unavailable in this project");
		if (receipt.logHash !== `sha256:${sha256Hex(row.value)}`)
			throw new CourseBuilderError("CORRUPT_STATE", "Stored compile log was modified");
		return row.value;
	}

	getDeckForCompile(
		sessionId: string,
		deckId: string,
	): { project: CourseBuilderProject; deck: BeamerDeck; assets: BeamerAsset[] } {
		this.refresh();
		const project = this.requireProjectForSession(sessionId);
		const deck = this.currentDeck(deckId);
		if (!deck || deck.projectId !== project.projectId)
			throw new CourseBuilderError("DECK_NOT_FOUND", "Deck unavailable");
		this.assertCurrentDeck(project, deck);
		const assets = deck.assetMaterialIds.map((id) => {
			const material = this.getMaterial(sessionId, id);
			const extension = /\.(png|jpe?g|pdf)$/iu.exec(material.name)?.[1]?.toLowerCase();
			if (!extension)
				throw new CourseBuilderError("UNSUPPORTED_ASSET", "Only PNG, JPEG and PDF can be compiled as assets");
			return {
				path: `assets/${id}.${extension}`,
				bytes: this.getMaterialBytes(sessionId, id),
				contentHash: material.sourceHash,
			};
		});
		return { project: clone(project), deck: clone(deck), assets };
	}

	private assertCurrentLesson(project: CourseBuilderProject, lesson: LessonPlan, requireApproved = true): void {
		const semester = this.currentSemesterPlan(project.projectId);
		if (
			!semester ||
			semester.status !== "approved" ||
			semester.projectRevision !== project.revision ||
			semester.revision !== lesson.semesterPlanRevision
		)
			throw new CourseBuilderError("STALE_SEMESTER", "Lesson is not based on the current approved Semester Plan");
		if (requireApproved && lesson.status !== "approved")
			throw new CourseBuilderError("LESSON_APPROVAL_REQUIRED", "Approve the current lesson first");
	}

	private assertCurrentDeck(project: CourseBuilderProject, deck: BeamerDeck): void {
		const lesson = this.currentLessonPlan(deck.lessonPlanId);
		if (!lesson || lesson.projectId !== project.projectId || lesson.revision !== deck.lessonPlanRevision)
			throw new CourseBuilderError("STALE_LESSON", "Deck is not based on the current Lesson Plan");
		this.assertCurrentLesson(project, lesson);
	}

	exportState(): CourseBuilderState {
		return {
			version: 1,
			projects: [...this.projects.values()]
				.sort((left, right) => left.projectId.localeCompare(right.projectId))
				.map(clone),
			bindings: [...this.bindings.values()]
				.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
				.map(clone),
			materials: [...this.materials.values()]
				.sort((left, right) => left.materialId.localeCompare(right.materialId))
				.map(clone),
			materialAnalyses: [...this.materialAnalyses.values()]
				.sort((left, right) => left.projectId.localeCompare(right.projectId))
				.map(clone),
			semesterPlans: [...this.semesterPlans.values()]
				.flat()
				.sort((left, right) => left.projectId.localeCompare(right.projectId) || left.revision - right.revision)
				.map(clone),
			lessonPlans: [...this.lessonPlans.values()]
				.flat()
				.sort(
					(left, right) => left.lessonPlanId.localeCompare(right.lessonPlanId) || left.revision - right.revision,
				)
				.map(clone),
			decks: [...this.decks.values()]
				.flat()
				.sort((left, right) => left.deckId.localeCompare(right.deckId) || left.revision - right.revision)
				.map(clone),
			compileReceipts: [...this.compileReceipts.values()]
				.sort((left, right) => left.receiptId.localeCompare(right.receiptId))
				.map(clone),
			deckReviews: [...this.deckReviews.values()]
				.sort((left, right) => left.reviewId.localeCompare(right.reviewId))
				.map(clone),
			visuals: [...this.visuals.values()]
				.sort((left, right) => left.visualId.localeCompare(right.visualId))
				.map(clone),
		};
	}

	private validateSemesterPlan(project: CourseBuilderProject, plan: SemesterPlanDraft): void {
		const capacity = project.weeks * project.sessionsPerWeek;
		if (plan.sessions.length !== capacity)
			throw new CourseBuilderError(
				"SEMESTER_CAPACITY_MISMATCH",
				`Semester Plan must explicitly contain ${capacity} session slots, including breaks or exams`,
			);
		const slots = new Set<string>();
		const goals = new Set<string>();
		for (const session of plan.sessions) {
			if (session.week > project.weeks || session.session > project.sessionsPerWeek)
				throw new CourseBuilderError(
					"SEMESTER_SLOT_OUT_OF_RANGE",
					`Week ${session.week}, session ${session.session} is outside the project calendar`,
				);
			const slot = `${session.week}:${session.session}`;
			if (slots.has(slot)) throw new CourseBuilderError("DUPLICATE_SEMESTER_SLOT", `Semester Plan repeats ${slot}`);
			slots.add(slot);
			this.assertMaterials(project.projectId, session.materialIds);
			for (const goal of session.courseGoalsCovered) goals.add(goal);
		}
		for (const goal of project.goals)
			if (!goals.has(goal))
				throw new CourseBuilderError("COURSE_GOAL_UNCOVERED", `Semester Plan does not cover project goal: ${goal}`);
	}

	private teacherReview(
		decision: ReviewDecision,
		note: string,
		targetRevision: number,
		targetHash: string,
		reviewedAt: string,
	): TeacherReview {
		if (decision !== "approve" && decision !== "request-changes")
			throw new CourseBuilderError("INVALID_REVIEW_DECISION", "Teacher review decision is invalid");
		return {
			decision,
			note: decision === "request-changes" ? stringValue(note, "review.note", 20_000) : note.trim().slice(0, 20_000),
			reviewedAt: timestamp(reviewedAt, "reviewedAt"),
			reviewer: "teacher-ui",
			targetRevision,
			targetHash,
		};
	}

	private snapshot(projectId: string): CourseBuilderSnapshot {
		const project = this.requireProject(projectId);
		const semesterPlan = this.currentSemesterPlan(projectId);
		const lessons = [...this.lessonPlans.values()]
			.map((items) => currentByRevision(items))
			.filter((item): item is LessonPlan => item !== null && item.projectId === projectId);
		const decks = [...this.decks.values()]
			.map((items) => currentByRevision(items))
			.filter((item): item is BeamerDeck => item !== null && item.projectId === projectId);
		return {
			project: clone(project),
			materials: this.projectMaterials(projectId).map(clone),
			materialAnalysis: clone(this.materialAnalyses.get(projectId) ?? null),
			semesterPlan: clone(semesterPlan),
			lessonPlans: lessons.sort((left, right) => left.week - right.week || left.session - right.session).map(clone),
			decks: decks.sort((left, right) => left.deckId.localeCompare(right.deckId)).map(clone),
			compileReceipts: [...this.compileReceipts.values()]
				.filter((item) => item.projectId === projectId)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.map(clone),
			deckReviews: [...this.deckReviews.values()]
				.filter((item) => item.projectId === projectId)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.map(clone),
			visuals: [...this.visuals.values()]
				.filter((item) => item.projectId === projectId)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.map(clone),
		};
	}

	private projectMaterials(projectId: string): CourseBuilderMaterial[] {
		return [...this.materials.values()]
			.filter((item) => item.projectId === projectId)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.name.localeCompare(right.name));
	}

	private assertMaterials(projectId: string, materialIds: readonly string[]): void {
		for (const materialId of materialIds) {
			const material = this.materials.get(materialId);
			if (!material || material.projectId !== projectId)
				throw new CourseBuilderError(
					"MATERIAL_NOT_FOUND",
					`Material ${materialId} is not available in this project`,
				);
		}
	}

	private currentSemesterPlan(projectId: string): SemesterPlan | null {
		return currentByRevision(this.semesterPlans.get(projectId) ?? []);
	}

	private currentLessonPlan(lessonPlanId: string): LessonPlan | null {
		return currentByRevision(this.lessonPlans.get(lessonPlanId) ?? []);
	}

	private currentDeck(deckId: string): BeamerDeck | null {
		return currentByRevision(this.decks.get(deckId) ?? []);
	}

	private requireProject(projectId: string): CourseBuilderProject {
		const project = this.projects.get(projectId);
		if (!project) throw new CourseBuilderError("PROJECT_NOT_FOUND", `Unknown Course Builder project ${projectId}`);
		return project;
	}

	private requireProjectForSession(sessionId: string): CourseBuilderProject {
		const binding = this.bindings.get(sessionId);
		if (!binding)
			throw new CourseBuilderError(
				"PROJECT_BINDING_REQUIRED",
				"Bind this Pi session to a Course Builder project first",
			);
		return this.requireProject(binding.projectId);
	}

	private mutate(
		change: () => void,
		artifact?: BeamerCompiledArtifact,
		sources: readonly { materialId: string; bytes: Uint8Array }[] = [],
		compileLog?: { receiptId: string; log: string },
	): void {
		const before = this.exportState();
		try {
			change();
			this.persist(artifact, sources, compileLog);
		} catch (error) {
			this.loadState(before);
			this.refresh();
			throw error;
		}
	}

	private persist(
		artifact?: BeamerCompiledArtifact,
		sources: readonly { materialId: string; bytes: Uint8Array }[] = [],
		compileLog?: { receiptId: string; log: string },
	): void {
		const json = stableStringify(this.exportState());
		if (Buffer.byteLength(json) > 128 * 1024 * 1024)
			throw new CourseBuilderError("STATE_LIMIT", "Course Builder state exceeds 128 MiB");
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.database.prepare("SELECT value FROM course_builder_state WHERE key = ?").get(STATE_KEY) as
				| { value: string }
				| undefined;
			if ((current?.value ?? null) !== this.persistedState)
				throw new CourseBuilderError("REVISION_CONFLICT", "Concurrent Course Builder writer detected; reload");
			for (const source of sources)
				this.database
					.prepare("INSERT INTO course_builder_source(material_id, bytes) VALUES(?, ?)")
					.run(source.materialId, source.bytes);
			if (compileLog)
				this.database
					.prepare(
						"INSERT INTO course_builder_log(receipt_id, value) VALUES(?, ?) ON CONFLICT(receipt_id) DO NOTHING",
					)
					.run(compileLog.receiptId, compileLog.log);
			this.database
				.prepare("INSERT INTO course_builder_audit(before_hash, after_hash, created_at) VALUES(?, ?, ?)")
				.run(
					this.persistedState ? contentHash(JSON.parse(this.persistedState)) : null,
					contentHash(JSON.parse(json)),
					new Date().toISOString(),
				);
			this.database
				.prepare(
					"INSERT INTO course_builder_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(STATE_KEY, json);
			if (artifact)
				this.database
					.prepare(
						"INSERT INTO course_builder_pdf(receipt_id, bytes) VALUES(?, ?) ON CONFLICT(receipt_id) DO NOTHING",
					)
					.run(artifact.receiptId, artifact.pdfBytes);
			this.database.exec("COMMIT");
			this.persistedState = json;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the original write failure.
			}
			throw error;
		}
	}

	private refresh(): void {
		const row = this.database.prepare("SELECT value FROM course_builder_state WHERE key = ?").get(STATE_KEY) as
			| { value: string }
			| undefined;
		if ((row?.value ?? null) !== this.persistedState) this.restore();
	}

	private restore(): void {
		const row = this.database.prepare("SELECT value FROM course_builder_state WHERE key = ?").get(STATE_KEY) as
			| { value?: string }
			| undefined;
		if (!row?.value) {
			if (this.persistedState !== null)
				throw new CourseBuilderError("CORRUPT_STATE", "Persistent Course Builder state disappeared");
			return;
		}
		let state: unknown;
		try {
			state = JSON.parse(row.value);
		} catch {
			throw new CourseBuilderError("CORRUPT_STATE", "Course Builder state is not valid JSON");
		}
		this.loadState(this.validateState(state));
		this.persistedState = row.value;
	}

	private validateState(value: unknown): CourseBuilderState {
		const state = requireRecord(value, "courseBuilderState");
		if (state.version !== 1)
			throw new CourseBuilderError("CORRUPT_STATE", "Course Builder state version is unsupported");
		for (const key of [
			"projects",
			"bindings",
			"materials",
			"materialAnalyses",
			"semesterPlans",
			"lessonPlans",
			"decks",
			"compileReceipts",
			"deckReviews",
			"visuals",
		]) {
			if (!Array.isArray(state[key]))
				throw new CourseBuilderError("CORRUPT_STATE", `Course Builder state ${key} must be an array`);
		}
		const result = state as unknown as CourseBuilderState;
		for (const project of result.projects) {
			const { contentHash: _hash, ...payload } = project;
			assertHash(project, payload, `Project ${project.projectId}`);
		}
		for (const material of result.materials) {
			if (`sha256:${sha256Hex(material.extractedText)}` !== material.textHash)
				throw new CourseBuilderError("CORRUPT_STATE", `Material ${material.materialId} has invalid text hash`);
		}
		for (const analysis of result.materialAnalyses) {
			const { contentHash: _hash, ...payload } = analysis;
			assertHash(analysis, payload, `Material analysis ${analysis.projectId}`);
		}
		for (const plan of result.semesterPlans) {
			const { contentHash: _hash, ...payload } = plan;
			assertHash(plan, payload, `Semester Plan ${plan.semesterPlanId}`);
		}
		for (const lesson of result.lessonPlans) {
			const { contentHash: _hash, ...payload } = lesson;
			assertHash(lesson, payload, `Lesson Plan ${lesson.lessonPlanId}`);
		}
		for (const deck of result.decks) {
			const { contentHash: _hash, ...payload } = deck;
			assertHash(deck, payload, `Deck ${deck.deckId}`);
			assertSafeBeamerSource(deck.source);
		}
		for (const receipt of result.compileReceipts) {
			const { contentHash: _hash, ...payload } = receipt;
			assertHash(receipt, payload, `Compile receipt ${receipt.receiptId}`);
		}
		for (const review of result.deckReviews) {
			const { contentHash: _hash, ...payload } = review;
			assertHash(review, payload, `Deck review ${review.reviewId}`);
		}
		for (const visual of result.visuals) {
			const { contentHash: _hash, ...payload } = visual;
			assertHash(visual, payload, `Visual ${visual.visualId}`);
		}
		const projects = new Map(result.projects.map((p) => [p.projectId, p]));
		if (projects.size !== result.projects.length)
			throw new CourseBuilderError("CORRUPT_STATE", "Duplicate project IDs");
		const materialMap = new Map(result.materials.map((m) => [m.materialId, m]));
		if (materialMap.size !== result.materials.length)
			throw new CourseBuilderError("CORRUPT_STATE", "Duplicate material IDs");
		for (const m of result.materials) {
			const row = this.database
				.prepare("SELECT bytes FROM course_builder_source WHERE material_id = ?")
				.get(m.materialId) as { bytes: Uint8Array } | undefined;
			if (!projects.has(m.projectId) || !row || `sha256:${sha256Hex(row.bytes)}` !== m.sourceHash)
				throw new CourseBuilderError("CORRUPT_STATE", "Material ownership or source bytes invalid");
		}
		const sessions = new Set<string>();
		for (const b of result.bindings) {
			if (sessions.has(b.sessionId) || !projects.has(b.projectId))
				throw new CourseBuilderError("CORRUPT_STATE", "Invalid project binding");
			sessions.add(b.sessionId);
		}
		const revisionKeys = new Set<string>();
		for (const collection of [result.semesterPlans, result.lessonPlans, result.decks]) {
			const revisions = new Map<string, number[]>();
			for (const item of collection) {
				const id =
					"deckId" in item ? item.deckId : "lessonPlanId" in item ? item.lessonPlanId : item.semesterPlanId;
				const key = `${id}:${item.revision}`;
				if (revisionKeys.has(key) || !projects.has(item.projectId))
					throw new CourseBuilderError("CORRUPT_STATE", "Duplicate or orphaned revision");
				revisionKeys.add(key);
				revisions.set(id, [...(revisions.get(id) ?? []), item.revision]);
				const materialIds =
					"assetMaterialIds" in item
						? item.assetMaterialIds
						: "materialIds" in item
							? item.materialIds
							: item.sessions.flatMap((slot) => slot.materialIds);
				if (materialIds.some((id) => materialMap.get(id)?.projectId !== item.projectId))
					throw new CourseBuilderError("CORRUPT_STATE", "Cross-project material reference");
			}
			for (const history of revisions.values())
				if (history.sort((a, b) => a - b).some((n, i) => n !== i + 1))
					throw new CourseBuilderError("CORRUPT_STATE", "Broken revision sequence");
		}
		for (const lesson of result.lessonPlans)
			if (
				!result.semesterPlans.some(
					(p) =>
						p.projectId === lesson.projectId &&
						p.semesterPlanId === lesson.semesterPlanId &&
						p.revision === lesson.semesterPlanRevision,
				)
			)
				throw new CourseBuilderError("CORRUPT_STATE", "Missing lesson parent");
		for (const deck of result.decks)
			if (
				!result.lessonPlans.some(
					(p) =>
						p.projectId === deck.projectId &&
						p.lessonPlanId === deck.lessonPlanId &&
						p.revision === deck.lessonPlanRevision,
				) ||
				deck.sourceHash !== `sha256:${sha256Hex(deck.source)}`
			)
				throw new CourseBuilderError("CORRUPT_STATE", "Missing deck parent or invalid source hash");
		for (const receipt of result.compileReceipts) {
			if (
				!result.decks.some(
					(d) =>
						d.projectId === receipt.projectId &&
						d.deckId === receipt.deckId &&
						d.revision === receipt.deckRevision &&
						d.sourceHash === receipt.sourceHash,
				)
			)
				throw new CourseBuilderError("CORRUPT_STATE", "Orphaned compile receipt");
			if (receipt.succeeded) {
				const row = this.database
					.prepare("SELECT bytes FROM course_builder_pdf WHERE receipt_id = ?")
					.get(receipt.receiptId) as { bytes: Uint8Array } | undefined;
				if (!row || !receipt.pdfHash || receipt.pdfHash !== `sha256:${sha256Hex(row.bytes)}`)
					throw new CourseBuilderError("CORRUPT_STATE", "Successful receipt has no matching PDF");
			}
		}

		return clone(result);
	}

	private loadState(state: CourseBuilderState): void {
		this.projects = new Map(state.projects.map((item) => [item.projectId, clone(item)]));
		this.bindings = new Map(state.bindings.map((item) => [item.sessionId, clone(item)]));
		this.materials = new Map(state.materials.map((item) => [item.materialId, clone(item)]));
		this.materialAnalyses = new Map(state.materialAnalyses.map((item) => [item.projectId, clone(item)]));
		this.semesterPlans = new Map();
		for (const item of state.semesterPlans)
			this.semesterPlans.set(item.projectId, [...(this.semesterPlans.get(item.projectId) ?? []), clone(item)]);
		this.lessonPlans = new Map();
		for (const item of state.lessonPlans)
			this.lessonPlans.set(item.lessonPlanId, [...(this.lessonPlans.get(item.lessonPlanId) ?? []), clone(item)]);
		this.decks = new Map();
		for (const item of state.decks)
			this.decks.set(item.deckId, [...(this.decks.get(item.deckId) ?? []), clone(item)]);
		this.compileReceipts = new Map(state.compileReceipts.map((item) => [item.receiptId, clone(item)]));
		this.deckReviews = new Map(state.deckReviews.map((item) => [item.reviewId, clone(item)]));
		this.visuals = new Map(state.visuals.map((item) => [item.visualId, clone(item)]));
	}
}
