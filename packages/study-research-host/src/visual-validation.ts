import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import { requiredHash, requiredText, StudyResearchError } from "./validation.ts";

export type VisualCaseCategory = "ordinary" | "boundary" | "degenerate" | "interaction";
export type VisualObservationValue = number | string | boolean | null;

/** Expected values are supplied before execution, independently of the visual's code. */
export interface VisualValidationCase {
	id: string;
	category: VisualCaseCategory;
	description: string;
	inputs: Record<string, unknown>;
	/** Paths into the returned scene, for example ["metrics", "coverage"] or ["elements", 0, "attrs", "cx"]. */
	expected: Array<{
		path: Array<string | number>;
		value: VisualObservationValue;
		absoluteTolerance: number;
		relativeTolerance: number;
	}>;
}

export interface VisualValidationSpecification {
	version: 1;
	targetHash: string;
	scope: string;
	assumptions: string[];
	oracle: {
		kind: "hand-calculation" | "independent-reference";
		description: string;
		/** A derivation or separately authored reference code. This protocol never executes it in the Host. */
		material: string;
		sourceReferences: Array<{ sourceId: string; sourceHash: string; locator: string }>;
	};
	cases: VisualValidationCase[];
}

export interface VisualCaseObservation {
	caseId: string;
	inputHash: string;
	/** Supplied only by a trusted adapter reading the isolated subject's actual output. */
	status: "returned" | "failed" | "timed-out";
	scene: unknown;
	error: string | null;
}

export interface VisualComparison {
	caseId: string;
	category: VisualCaseCategory;
	inputHash: string;
	status: "passed" | "failed" | "inconclusive";
	checks: Array<{
		path: Array<string | number>;
		expected: VisualObservationValue;
		actual: VisualObservationValue | undefined;
		absoluteTolerance: number;
		relativeTolerance: number;
		passed: boolean;
	}>;
	error: string | null;
}

const CATEGORIES: VisualCaseCategory[] = ["ordinary", "boundary", "degenerate", "interaction"];
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function plainJson(value: unknown, depth = 0): void {
	if (depth > 24)
		throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation JSON exceeds its nesting limit");
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		if (value.length > 4096)
			throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation JSON array exceeds its bound");
		for (const item of value) plainJson(item, depth + 1);
		return;
	}
	if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				typeof key !== "string" ||
				FORBIDDEN_KEYS.has(key) ||
				!descriptor ||
				!("value" in descriptor) ||
				!descriptor.enumerable
			)
				throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation JSON requires plain own properties");
			plainJson(descriptor.value, depth + 1);
		}
		return;
	}
	throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation values must be finite plain JSON");
}

export function validateVisualSpecification(specification: VisualValidationSpecification): string {
	plainJson(specification);
	if (specification.version !== 1)
		throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Unsupported validation protocol");
	requiredHash(specification.targetHash, "visual target hash");
	requiredText(specification.scope, "validation scope", 6000);
	if (!Array.isArray(specification.assumptions) || specification.assumptions.length > 100)
		throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation assumptions must be bounded");
	for (const assumption of specification.assumptions) requiredText(assumption, "assumption", 4000);
	if (!["hand-calculation", "independent-reference"].includes(specification.oracle.kind))
		throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "An independent expected-value source is required");
	requiredText(specification.oracle.description, "oracle description", 6000);
	requiredText(specification.oracle.material, "oracle material", 131072);
	if (!Array.isArray(specification.oracle.sourceReferences) || specification.oracle.sourceReferences.length > 100)
		throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Oracle source references must be bounded");
	for (const reference of specification.oracle.sourceReferences) {
		requiredText(reference.sourceId, "oracle source", 128);
		requiredHash(reference.sourceHash, "oracle source hash");
		requiredText(reference.locator, "oracle source locator", 4000);
	}
	if (!Array.isArray(specification.cases) || specification.cases.length < 1 || specification.cases.length > 100)
		throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation requires 1–100 bounded cases");
	const ids = new Set<string>();
	for (const entry of specification.cases) {
		const id = requiredText(entry.id, "case ID", 128);
		if (id !== entry.id || ids.has(id))
			throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation case IDs must be unique and canonical");
		ids.add(id);
		if (!CATEGORIES.includes(entry.category))
			throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Unknown validation case category");
		requiredText(entry.description, "case description", 4000);
		if (!entry.inputs || typeof entry.inputs !== "object" || Array.isArray(entry.inputs))
			throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Case inputs must be an object");
		if (!Array.isArray(entry.expected) || entry.expected.length < 1 || entry.expected.length > 100)
			throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Each case requires 1–100 independent assertions");
		const paths = new Set<string>();
		for (const expected of entry.expected) {
			if (
				!Array.isArray(expected.path) ||
				expected.path.length < 1 ||
				expected.path.length > 16 ||
				expected.path.some((part) =>
					typeof part === "number"
						? !Number.isSafeInteger(part) || part < 0 || part > 4095
						: typeof part !== "string" || !part || part.length > 128 || FORBIDDEN_KEYS.has(part),
				)
			)
				throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Invalid observed scene path");
			const path = stableStringify(expected.path);
			if (paths.has(path))
				throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Duplicate expected path in a case");
			paths.add(path);
			if (expected.value !== null && !["number", "string", "boolean"].includes(typeof expected.value))
				throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Expected values must be scalar JSON");
			if (
				![expected.absoluteTolerance, expected.relativeTolerance].every(
					(value) => Number.isFinite(value) && value >= 0 && value <= 1e6,
				)
			)
				throw new StudyResearchError(
					"VISUAL_VALIDATION_INVALID",
					"Tolerances must be finite, nonnegative and bounded",
				);
			if (
				typeof expected.value !== "number" &&
				(expected.absoluteTolerance !== 0 || expected.relativeTolerance !== 0)
			)
				throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Nonnumeric expectations require exact matching");
			if (
				typeof expected.value === "number" &&
				!Number.isFinite(expected.absoluteTolerance + expected.relativeTolerance * Math.abs(expected.value))
			)
				throw new StudyResearchError(
					"VISUAL_VALIDATION_INVALID",
					"Combined numerical tolerance must remain finite",
				);
		}
	}
	if (Buffer.byteLength(JSON.stringify(specification)) > 256 * 1024)
		throw new StudyResearchError("VISUAL_VALIDATION_INVALID", "Validation specification exceeds 256 KiB");
	return contentHash(specification);
}

/** Pure comparison, never execution. A renderer message cannot call this to mint a canonical Host check. */
export function compareVisualObservations(
	specification: VisualValidationSpecification,
	observations: readonly VisualCaseObservation[],
) {
	const specificationHash = validateVisualSpecification(specification);
	if (!Array.isArray(observations) || observations.length > specification.cases.length)
		throw new StudyResearchError("VISUAL_OBSERVATION_INVALID", "Unexpected validation observations");
	const byId = new Map<string, VisualCaseObservation>();
	for (const observation of observations) {
		if (!specification.cases.some((entry) => entry.id === observation.caseId) || byId.has(observation.caseId))
			throw new StudyResearchError("VISUAL_OBSERVATION_INVALID", "Unknown or duplicate observation ID");
		if (!["returned", "failed", "timed-out"].includes(observation.status))
			throw new StudyResearchError("VISUAL_OBSERVATION_INVALID", "Unknown observation status");
		byId.set(observation.caseId, observation);
	}
	const comparisons: VisualComparison[] = specification.cases.map((entry) => {
		const inputHash = contentHash(entry.inputs);
		const observation = byId.get(entry.id);
		const base = { caseId: entry.id, category: entry.category, inputHash };
		if (!observation)
			return {
				...base,
				status: "inconclusive",
				checks: [],
				error: "This case has no isolated execution observation",
			};
		if (observation.inputHash !== inputHash)
			throw new StudyResearchError("VISUAL_OBSERVATION_INVALID", "Observed inputs differ from the frozen case");
		if (observation.status !== "returned")
			return { ...base, status: "failed", checks: [], error: observation.error || observation.status };
		plainJson(observation.scene);
		if (Buffer.byteLength(JSON.stringify(observation.scene)) > 1024 * 1024)
			throw new StudyResearchError("VISUAL_OBSERVATION_INVALID", "Observed scene exceeds its bound");
		const checks = entry.expected.map((expected) => {
			let actual: unknown = observation.scene;
			for (const part of expected.path) {
				if (actual === null || typeof actual !== "object" || !Object.hasOwn(actual, part)) {
					actual = undefined;
					break;
				}
				actual = (actual as Record<string | number, unknown>)[part];
			}
			const scalar =
				actual === null || ["number", "string", "boolean"].includes(typeof actual)
					? (actual as VisualObservationValue)
					: undefined;
			const passed =
				typeof expected.value === "number" && typeof scalar === "number"
					? Math.abs(scalar - expected.value) <=
						expected.absoluteTolerance + expected.relativeTolerance * Math.abs(expected.value)
					: scalar === expected.value;
			return {
				path: expected.path,
				expected: expected.value,
				actual: scalar,
				absoluteTolerance: expected.absoluteTolerance,
				relativeTolerance: expected.relativeTolerance,
				passed,
			};
		});
		return { ...base, status: checks.every((check) => check.passed) ? "passed" : "failed", checks, error: null };
	});
	const missingCategories = CATEGORIES.filter(
		(category) => !specification.cases.some((entry) => entry.category === category),
	);
	const status = comparisons.some((comparison) => comparison.status === "failed")
		? "failed"
		: missingCategories.length > 0 || comparisons.some((comparison) => comparison.status === "inconclusive")
			? "inconclusive"
			: "passed";
	return {
		specificationHash,
		targetHash: specification.targetHash,
		scope: specification.scope,
		status,
		missingCategories,
		comparisons,
		qualification:
			"Passed means these declared numerical and scene assertions matched. Browser control behavior and independent academic review remain separate requirements.",
	};
}
