import { createHash } from "node:crypto";
import type { ModeResourceSet } from "../../profile-resource-host/src/mode-packs.ts";

export const EDUCATION_CONTRACT_VERSION = 1 as const;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_TEXT = 48_000;
const MAX_LIST = 128;

export interface EducationSkill {
	id: string;
	title: string;
	trigger: string;
	guidance: string;
	machineRule: string;
	defaultLoading: "required" | "optional" | "task-triggered";
}

export const EDUCATION_SKILLS: Readonly<Record<string, EducationSkill>> = Object.freeze({
	"grounded-tutor": {
		id: "grounded-tutor",
		title: "Grounded tutor",
		trigger: "Every course-bound Tutor answer",
		guidance: "Prefer the bound course, show derivations, and label external or unsupported boundaries.",
		machineRule: "Every published answer passes the existing grounding/publication receipt gate.",
		defaultLoading: "required",
	},
	"ubd-backward-design": {
		id: "ubd-backward-design",
		title: "Backward design",
		trigger: "Planning a lesson or course",
		guidance: "State transferable understanding and observable evidence before choosing activities.",
		machineRule: "A LessonBlueprint names an evidence task and a transfer check before publication.",
		defaultLoading: "task-triggered",
	},
	"teach-back-feynman": {
		id: "teach-back-feynman",
		title: "Teach-back",
		trigger: "The learner explicitly starts Teach-back",
		guidance: "The learner explains first; diagnose at most two load-bearing gaps; ask before telling; test transfer.",
		machineRule: "No diagnosis before a persisted learner explanation and no completion before revision plus transfer.",
		defaultLoading: "required",
	},
	"learning-to-learn": {
		id: "learning-to-learn",
		title: "Learning to learn",
		trigger: "Retrieval, prediction, self-explanation, or deliberate review supports the current concept",
		guidance: "Use one or two concrete learning actions, not a catalogue of study terminology.",
		machineRule: "Practice and visual workflows preserve attempt or prediction before feedback.",
		defaultLoading: "optional",
	},
	"curriculum-planner": {
		id: "curriculum-planner",
		title: "Curriculum planner",
		trigger: "A multi-lesson sequence is requested",
		guidance: "Plan progression, then read actual durable learning records before planning the next lesson.",
		machineRule: "Later lesson revisions reference persisted ConceptLearningRecord evidence.",
		defaultLoading: "task-triggered",
	},
	"spiral-curriculum": {
		id: "spiral-curriculum",
		title: "Spiral curriculum",
		trigger: "A concept is revisited",
		guidance: "Record what is retained and what structurally grows in relation, representation, boundary, or transfer.",
		machineRule: "A revisit with no structural growth is rejected as repetition.",
		defaultLoading: "task-triggered",
	},
	"fact-check": {
		id: "fact-check",
		title: "Fact check",
		trigger: "Exact, current, disputed, or professionally consequential claims",
		guidance: "Shortlist load-bearing claims and distinguish error from uncertainty.",
		machineRule: "Ledger status distinguishes contradicted, unsupported, and not-yet-verified.",
		defaultLoading: "task-triggered",
	},
	"deep-research-ledger": {
		id: "deep-research-ledger",
		title: "Research ledger",
		trigger: "External current facts determine the lesson",
		guidance: "Research first and ledger claim to source, span, and date before teaching it.",
		machineRule: "An external claim has a ledger entry or an explicit unsupported boundary.",
		defaultLoading: "task-triggered",
	},
	"surgical-editing": {
		id: "surgical-editing",
		title: "Surgical editing",
		trigger: "An existing lesson, plan, or artifact is being revised",
		guidance: "Read fresh, change the smallest field, read back, and preserve unrelated work.",
		machineRule: "A revision targets a known artifact revision and rejects stale overwrites.",
		defaultLoading: "task-triggered",
	},
	"learn-by-doing": {
		id: "learn-by-doing",
		title: "Learn by doing",
		trigger: "A mechanism can be predicted, manipulated, or traced",
		guidance: "Use prediction, verified interaction, observation, explanation, retry, and transfer.",
		machineRule: "Renderer reuse is allowed; completion requires learner observation and transfer evidence.",
		defaultLoading: "optional",
	},
	"personal-skill-builder": {
		id: "personal-skill-builder",
		title: "Personal skill builder",
		trigger: "The user asks to derive reusable preferences from durable history",
		guidance: "Form hypotheses from evidence, seek counterexamples, and ask the user to approve the result.",
		machineRule: "A custom Skill cannot publish without evidence ids and an approving user turn.",
		defaultLoading: "task-triggered",
	},
});

export const EDUCATION_SKILL_SETS: Readonly<Record<string, ModeResourceSet>> = Object.freeze({
	tutor: {
		required: ["grounded-tutor"],
		optional: ["ubd-backward-design", "learning-to-learn", "fact-check", "deep-research-ledger"],
	},
	practice: { required: ["learning-to-learn"], optional: ["learn-by-doing"] },
	"teach-back": { required: ["teach-back-feynman"], optional: ["learning-to-learn"] },
	"visual-lab": { required: ["learn-by-doing"], optional: ["learning-to-learn"] },
	planning: { required: ["ubd-backward-design", "curriculum-planner"], optional: ["spiral-curriculum"] },
});

export class EducationModeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "EducationModeError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], where: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new EducationModeError("UNKNOWN_FIELD", `${where}.${key}`);
	for (const key of required) if (!(key in value)) throw new EducationModeError("MISSING_FIELD", `${where}.${key}`);
}

function text(value: unknown, where: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > MAX_TEXT || value.includes("\0")) {
		throw new EducationModeError("INVALID_TEXT", where);
	}
	return value;
}

function id(value: unknown, where: string): string {
	const parsed = text(value, where);
	if (!IDENTIFIER.test(parsed)) throw new EducationModeError("INVALID_ID", where);
	return parsed;
}

function timestamp(value: unknown, where: string): string {
	const parsed = text(value, where);
	if (!Number.isFinite(Date.parse(parsed))) throw new EducationModeError("INVALID_TIMESTAMP", where);
	return parsed;
}

function stringList(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_LIST) throw new EducationModeError("INVALID_LIST", where);
	const parsed = value.map((entry, index) => text(entry, `${where}[${index}]`, true));
	if (new Set(parsed).size !== parsed.length) throw new EducationModeError("DUPLICATE_LIST_ITEM", where);
	return parsed;
}

export function educationHash(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export interface LessonBlueprint {
	version: typeof EDUCATION_CONTRACT_VERSION;
	blueprintId: string;
	revision: number;
	courseVersionId: string;
	conceptId: string;
	conceptBoundary: string;
	prerequisites: string[];
	allowedSourceSpanIds: string[];
	transferableUnderstanding: string;
	evidenceTask: string;
	explanationPlan: string[];
	examplePlan: string[];
	practicePlan: string[];
	transferCheck: string;
	researchLedgerIds: string[];
	provenance: { createdAt: string; parentHash?: string };
}

export function parseLessonBlueprint(value: unknown): LessonBlueprint {
	if (!isRecord(value)) throw new EducationModeError("INVALID_BLUEPRINT", "LessonBlueprint must be an object");
	const fields = [
		"version",
		"blueprintId",
		"revision",
		"courseVersionId",
		"conceptId",
		"conceptBoundary",
		"prerequisites",
		"allowedSourceSpanIds",
		"transferableUnderstanding",
		"evidenceTask",
		"explanationPlan",
		"examplePlan",
		"practicePlan",
		"transferCheck",
		"researchLedgerIds",
		"provenance",
	] as const;
	exactKeys(value, fields, fields, "blueprint");
	if (value.version !== EDUCATION_CONTRACT_VERSION) throw new EducationModeError("UNSUPPORTED_VERSION", "blueprint.version");
	if (!Number.isInteger(value.revision) || Number(value.revision) < 1) throw new EducationModeError("INVALID_REVISION", "blueprint.revision");
	if (!isRecord(value.provenance)) throw new EducationModeError("INVALID_PROVENANCE", "blueprint.provenance");
	exactKeys(value.provenance, ["createdAt", "parentHash"], ["createdAt"], "blueprint.provenance");
	if (value.provenance.parentHash !== undefined && (typeof value.provenance.parentHash !== "string" || !SHA256.test(value.provenance.parentHash))) {
		throw new EducationModeError("INVALID_HASH", "blueprint.provenance.parentHash");
	}
	return {
		version: EDUCATION_CONTRACT_VERSION,
		blueprintId: id(value.blueprintId, "blueprint.blueprintId"),
		revision: Number(value.revision),
		courseVersionId: id(value.courseVersionId, "blueprint.courseVersionId"),
		conceptId: id(value.conceptId, "blueprint.conceptId"),
		conceptBoundary: text(value.conceptBoundary, "blueprint.conceptBoundary"),
		prerequisites: stringList(value.prerequisites, "blueprint.prerequisites"),
		allowedSourceSpanIds: stringList(value.allowedSourceSpanIds, "blueprint.allowedSourceSpanIds"),
		transferableUnderstanding: text(value.transferableUnderstanding, "blueprint.transferableUnderstanding"),
		evidenceTask: text(value.evidenceTask, "blueprint.evidenceTask"),
		explanationPlan: stringList(value.explanationPlan, "blueprint.explanationPlan"),
		examplePlan: stringList(value.examplePlan, "blueprint.examplePlan"),
		practicePlan: stringList(value.practicePlan, "blueprint.practicePlan"),
		transferCheck: text(value.transferCheck, "blueprint.transferCheck"),
		researchLedgerIds: stringList(value.researchLedgerIds, "blueprint.researchLedgerIds"),
		provenance: {
			createdAt: timestamp(value.provenance.createdAt, "blueprint.provenance.createdAt"),
			...(value.provenance.parentHash ? { parentHash: value.provenance.parentHash as string } : {}),
		},
	};
}

export interface ConceptLearningRecord {
	version: typeof EDUCATION_CONTRACT_VERSION;
	courseVersionId: string;
	conceptId: string;
	sessionId: string;
	initialExplanation?: string;
	diagnosedGaps: string[];
	revisedExplanation?: string;
	transferEvidence?: string;
	retained: string[];
	added: string[];
	reorganized: string[];
	representationShift?: string;
	transferDistance?: string;
	boundaries: string[];
	nextTarget?: string;
	updatedAt: string;
}

export function validateSpiralRecord(record: ConceptLearningRecord): void {
	timestamp(record.updatedAt, "record.updatedAt");
	const growth =
		record.added.length +
		record.reorganized.length +
		record.boundaries.length +
		(record.representationShift ? 1 : 0) +
		(record.transferDistance ? 1 : 0);
	if (growth === 0) throw new EducationModeError("REPEATED_NOT_SPIRALED", record.conceptId);
}

export type EducationWorkflowKind =
	| "tutor"
	| "practice"
	| "teach-back"
	| "curriculum"
	| "spiral-revisit"
	| "fact-check"
	| "research"
	| "learn-by-doing"
	| "personal-skill"
	| "visual-lab";
export type EducationWorkflowStatus = "active" | "waiting-for-learner" | "completed" | "blocked";

export interface EducationWorkflowInstance {
	version: typeof EDUCATION_CONTRACT_VERSION;
	workflowId: string;
	kind: EducationWorkflowKind;
	courseVersionId: string;
	sessionId: string;
	modePackContentHash: string;
	state: string;
	status: EducationWorkflowStatus;
	revision: number;
	learnerTurnIds: string[];
	payload: Record<string, unknown>;
	updatedAt: string;
}

export function startEducationWorkflow(input: {
	workflowId: string;
	kind: EducationWorkflowKind;
	courseVersionId: string;
	sessionId: string;
	modePackContentHash: string;
	updatedAt?: string;
}): EducationWorkflowInstance {
	if (!SHA256.test(input.modePackContentHash)) throw new EducationModeError("INVALID_HASH", "modePackContentHash");
	const initialState =
		input.kind === "practice"
			? "awaiting-attempt"
			: input.kind === "teach-back"
				? "awaiting-initial-explanation"
				: input.kind === "learn-by-doing" || input.kind === "visual-lab"
					? "awaiting-prediction"
					: "ready";
	return {
		version: EDUCATION_CONTRACT_VERSION,
		workflowId: id(input.workflowId, "workflowId"),
		kind: input.kind,
		courseVersionId: id(input.courseVersionId, "courseVersionId"),
		sessionId: id(input.sessionId, "sessionId"),
		modePackContentHash: input.modePackContentHash,
		state: initialState,
		status: initialState.startsWith("awaiting-") ? "waiting-for-learner" : "active",
		revision: 1,
		learnerTurnIds: [],
		payload: {},
		updatedAt: timestamp(input.updatedAt ?? new Date().toISOString(), "updatedAt"),
	};
}

function requireLearnerTurn(instance: EducationWorkflowInstance, learnerTurnId: string | undefined): string {
	if (!learnerTurnId) throw new EducationModeError("LEARNER_TURN_REQUIRED", instance.state);
	const parsed = id(learnerTurnId, "learnerTurnId");
	if (instance.learnerTurnIds.includes(parsed)) throw new EducationModeError("LEARNER_TURN_REPLAY", parsed);
	return parsed;
}

function transition(
	instance: EducationWorkflowInstance,
	state: string,
	status: EducationWorkflowStatus,
	payload: Record<string, unknown>,
	learnerTurnId?: string,
	updatedAt = new Date().toISOString(),
): EducationWorkflowInstance {
	return {
		...instance,
		state,
		status,
		payload: { ...instance.payload, ...payload },
		learnerTurnIds: learnerTurnId ? [...instance.learnerTurnIds, learnerTurnId] : instance.learnerTurnIds,
		revision: instance.revision + 1,
		updatedAt: timestamp(updatedAt, "updatedAt"),
	};
}

export function advanceEducationWorkflow(
	instance: EducationWorkflowInstance,
	event: { type: string; learnerTurnId?: string; value?: unknown; updatedAt?: string },
): EducationWorkflowInstance {
	if (instance.status === "completed" || instance.status === "blocked") {
		throw new EducationModeError("TERMINAL_WORKFLOW", instance.workflowId);
	}
	const key = `${instance.kind}:${instance.state}:${event.type}`;
	switch (key) {
		case "practice:awaiting-attempt:learner-attempt": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "diagnose", "active", { attempt: event.value }, learnerTurnId, event.updatedAt);
		}
		case "practice:diagnose:feedback-issued":
			return transition(instance, "awaiting-retry-or-reveal", "waiting-for-learner", { feedback: event.value }, undefined, event.updatedAt);
		case "practice:awaiting-retry-or-reveal:learner-retry": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "diagnose", "active", { retry: event.value }, learnerTurnId, event.updatedAt);
		}
		case "practice:awaiting-retry-or-reveal:solution-capability-consumed": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "completed", "completed", { solutionRevealed: true }, learnerTurnId, event.updatedAt);
		}
		case "teach-back:awaiting-initial-explanation:learner-explanation": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "diagnose-gaps", "active", { initialExplanation: event.value }, learnerTurnId, event.updatedAt);
		}
		case "teach-back:diagnose-gaps:gaps-diagnosed": {
			const gaps = Array.isArray(event.value) ? event.value : [];
			if (gaps.length > 2) throw new EducationModeError("TOO_MANY_GAPS", "At most two load-bearing gaps");
			return transition(instance, "awaiting-revised-explanation", "waiting-for-learner", { gaps }, undefined, event.updatedAt);
		}
		case "teach-back:awaiting-revised-explanation:learner-revision": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "awaiting-transfer", "waiting-for-learner", { revisedExplanation: event.value }, learnerTurnId, event.updatedAt);
		}
		case "teach-back:awaiting-transfer:learner-transfer": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "reflection", "active", { transfer: event.value }, learnerTurnId, event.updatedAt);
		}
		case "teach-back:reflection:recorded":
			return transition(instance, "completed", "completed", { reflection: event.value }, undefined, event.updatedAt);
		case "learn-by-doing:awaiting-prediction:learner-prediction":
		case "visual-lab:awaiting-prediction:learner-prediction": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "compute-and-verify", "active", { prediction: event.value }, learnerTurnId, event.updatedAt);
		}
		case "learn-by-doing:compute-and-verify:verified-observation-requested":
		case "visual-lab:compute-and-verify:verified-observation-requested":
			return transition(instance, "awaiting-observation", "waiting-for-learner", { artifact: event.value }, undefined, event.updatedAt);
		case "learn-by-doing:awaiting-observation:learner-observation":
		case "visual-lab:awaiting-observation:learner-observation": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "awaiting-transfer", "waiting-for-learner", { observation: event.value }, learnerTurnId, event.updatedAt);
		}
		case "learn-by-doing:awaiting-transfer:learner-transfer":
		case "visual-lab:awaiting-transfer:learner-transfer": {
			const learnerTurnId = requireLearnerTurn(instance, event.learnerTurnId);
			return transition(instance, "completed", "completed", { transfer: event.value }, learnerTurnId, event.updatedAt);
		}
		default:
			throw new EducationModeError("INVALID_TRANSITION", key);
	}
}

export interface ResearchLedgerEntry {
	id: string;
	claim: string;
	sourceSpanId?: string;
	sourceName?: string;
	sourceDate?: string;
	status: "verified" | "contradicted" | "unsupported" | "not-yet-verified";
	note: string;
}

export function summarizeResearchLedger(entries: ResearchLedgerEntry[]): Record<ResearchLedgerEntry["status"], number> {
	return entries.reduce(
		(summary, entry) => {
			summary[entry.status] += 1;
			return summary;
		},
		{ verified: 0, contradicted: 0, unsupported: 0, "not-yet-verified": 0 },
	);
}

export interface PersonalSkillDraft {
	id: string;
	title: string;
	instructions: string;
	evidenceEventIds: string[];
	status: "draft" | "approved" | "rejected";
	approvedByUserTurnId?: string;
}

export function approvePersonalSkill(draft: PersonalSkillDraft, userTurnId: string): PersonalSkillDraft {
	const approvingTurn = id(userTurnId, "userTurnId");
	if (draft.status !== "draft") throw new EducationModeError("SKILL_NOT_DRAFT", draft.id);
	if (draft.evidenceEventIds.length === 0) throw new EducationModeError("SKILL_EVIDENCE_REQUIRED", draft.id);
	return { ...draft, status: "approved", approvedByUserTurnId: approvingTurn };
}

export type VisualActivityKind = "matrix-transform" | "algorithm-trace" | "function-plot" | "graph-trace" | "state-machine";

export interface VisualActivitySpec {
	version: typeof EDUCATION_CONTRACT_VERSION;
	kind: VisualActivityKind;
	seed: number;
	inputs: Record<string, unknown>;
	maxSteps: number;
}

export interface ComputationReceipt {
	version: typeof EDUCATION_CONTRACT_VERSION;
	specHash: string;
	runtimeVersion: string;
	seed: number;
	normalizedInputs: Record<string, unknown>;
	outputHash: string;
	traceHash: string;
	verified: boolean;
	errors: string[];
}

function rejectUnsafeVisualValue(value: unknown): void {
	if (typeof value === "number" && !Number.isFinite(value)) throw new EducationModeError("NON_FINITE_NUMBER", "visual.inputs");
	if (typeof value === "string" && /(?:https?:|file:|data:|javascript:|__proto__|constructor|prototype|eval\s*\(|import\s*\()/i.test(value)) {
		throw new EducationModeError("UNSAFE_VISUAL_SPEC", "visual.inputs");
	}
	if (Array.isArray(value)) value.forEach(rejectUnsafeVisualValue);
	else if (isRecord(value)) Object.values(value).forEach(rejectUnsafeVisualValue);
}

export function verifyVisualActivitySpec(spec: VisualActivitySpec): void {
	if (spec.version !== EDUCATION_CONTRACT_VERSION) throw new EducationModeError("UNSUPPORTED_VERSION", "visual.version");
	const kinds: VisualActivityKind[] = ["matrix-transform", "algorithm-trace", "function-plot", "graph-trace", "state-machine"];
	if (!kinds.includes(spec.kind)) throw new EducationModeError("UNKNOWN_VISUAL_KIND", String(spec.kind));
	if (!Number.isSafeInteger(spec.seed)) throw new EducationModeError("INVALID_SEED", String(spec.seed));
	if (!Number.isInteger(spec.maxSteps) || spec.maxSteps < 1 || spec.maxSteps > 10_000) {
		throw new EducationModeError("VISUAL_STEP_BUDGET", String(spec.maxSteps));
	}
	if (!isRecord(spec.inputs) || JSON.stringify(spec.inputs).length > 100_000) {
		throw new EducationModeError("VISUAL_INPUT_BUDGET", "visual.inputs");
	}
	rejectUnsafeVisualValue(spec.inputs);
}

export interface MatrixTransformResult {
	points: Array<[number, number]>;
}

export function computeMatrixTransform(spec: VisualActivitySpec): MatrixTransformResult {
	verifyVisualActivitySpec(spec);
	if (spec.kind !== "matrix-transform") throw new EducationModeError("VISUAL_KIND_MISMATCH", spec.kind);
	const matrix = spec.inputs.matrix;
	const points = spec.inputs.points;
	if (
		!Array.isArray(matrix) ||
		matrix.length !== 2 ||
		!matrix.every((row) => Array.isArray(row) && row.length === 2 && row.every((value) => typeof value === "number")) ||
		!Array.isArray(points) ||
		!points.every((point) => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === "number"))
	) {
		throw new EducationModeError("INVALID_MATRIX_INPUT", "visual.inputs");
	}
	const m = matrix as [[number, number], [number, number]];
	return {
		points: (points as Array<[number, number]>).map(([x, y]) => [m[0][0] * x + m[0][1] * y, m[1][0] * x + m[1][1] * y]),
	};
}

export interface AlgorithmTraceResult {
	states: number[][];
}

export function computeInsertionSortTrace(spec: VisualActivitySpec): AlgorithmTraceResult {
	verifyVisualActivitySpec(spec);
	if (spec.kind !== "algorithm-trace") throw new EducationModeError("VISUAL_KIND_MISMATCH", spec.kind);
	if (!Array.isArray(spec.inputs.values) || !spec.inputs.values.every((value) => Number.isFinite(value))) {
		throw new EducationModeError("INVALID_TRACE_INPUT", "visual.inputs.values");
	}
	const values = [...(spec.inputs.values as number[])];
	const states: number[][] = [[...values]];
	for (let index = 1; index < values.length; index += 1) {
		const current = values[index];
		let cursor = index - 1;
		while (cursor >= 0 && values[cursor] > current) {
			values[cursor + 1] = values[cursor];
			cursor -= 1;
			if (states.length >= spec.maxSteps) throw new EducationModeError("VISUAL_STEP_BUDGET", String(spec.maxSteps));
			states.push([...values]);
		}
		values[cursor + 1] = current;
		if (states.length >= spec.maxSteps) throw new EducationModeError("VISUAL_STEP_BUDGET", String(spec.maxSteps));
		states.push([...values]);
	}
	return { states };
}

export function createComputationReceipt(
	spec: VisualActivitySpec,
	result: unknown,
	runtimeVersion: string,
): ComputationReceipt {
	verifyVisualActivitySpec(spec);
	const resultHash = educationHash(result);
	return {
		version: EDUCATION_CONTRACT_VERSION,
		specHash: educationHash(spec),
		runtimeVersion: text(runtimeVersion, "runtimeVersion"),
		seed: spec.seed,
		normalizedInputs: structuredClone(spec.inputs),
		outputHash: resultHash,
		traceHash: resultHash,
		verified: true,
		errors: [],
	};
}

export function verifyComputationReceipt(spec: VisualActivitySpec, receipt: ComputationReceipt): void {
	verifyVisualActivitySpec(spec);
	if (
		receipt.specHash !== educationHash(spec) ||
		receipt.seed !== spec.seed ||
		!receipt.verified ||
		receipt.errors.length > 0 ||
		!SHA256.test(receipt.outputHash) ||
		!SHA256.test(receipt.traceHash)
	) {
		throw new EducationModeError("VISUAL_RECEIPT_REJECTED", spec.kind);
	}
}
