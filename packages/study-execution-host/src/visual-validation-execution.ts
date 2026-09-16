import type { VisualCaseObservation } from "../../study-research-host/src/visual-validation.ts";

/** This delimiter is emitted only by the generated isolated Node subject. */
export const VISUAL_VALIDATION_OBSERVATION_MARKER = "PI_STUDY_VISUAL_OBSERVATION_V1:";
const MAX_RECEIPT_BYTES = 16 * 1024;

export interface FrozenVisualExecutionCase {
	caseId: string;
	inputHash: string;
	inputs: Record<string, unknown>;
}

export interface VisualValidationProgramInput {
	/** The saved visualization function body. Expected values and oracle material are deliberately absent. */
	targetCode: string;
	cases: readonly FrozenVisualExecutionCase[];
	outputKey: string;
	caseTimeoutMs: number;
}

/**
 * Produces a direct Node module for the existing native adapter. The user-provided function body
 * is compiled only inside the isolated Windows subject, with a fresh vm context per frozen case.
 */
export function buildVisualValidationProgram(input: VisualValidationProgramInput): string {
	if (!input.targetCode.trim() || input.targetCode.length > 131_072)
		throw new Error("Visual validation target code must contain 1–131072 characters");
	if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 100)
		throw new Error("Visual validation requires 1–100 frozen cases");
	if (!/^[A-Za-z0-9_-]{24,128}$/u.test(input.outputKey)) throw new Error("Visual validation output key is invalid");
	if (!Number.isSafeInteger(input.caseTimeoutMs) || input.caseTimeoutMs < 100 || input.caseTimeoutMs > 30_000)
		throw new Error("Visual validation case timeout must be 100–30000 ms");
	const cases = input.cases.map((entry) => ({
		caseId: entry.caseId,
		inputHash: entry.inputHash,
		inputs: entry.inputs,
	}));
	const encoded = JSON.stringify({
		targetCode: input.targetCode,
		cases,
		outputKey: input.outputKey,
		caseTimeoutMs: input.caseTimeoutMs,
	})
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026");
	return `import vm from "node:vm";
const marker = ${JSON.stringify(VISUAL_VALIDATION_OBSERVATION_MARKER)};
const payload = ${encoded};
const maxReceiptBytes = ${MAX_RECEIPT_BYTES};
const failure = (error) => String(error instanceof Error ? error.message : error).slice(0, 2000);
const raceTimeout = (promise, milliseconds) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("isolated visual case exceeded its execution limit")), milliseconds);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const observe = async (entry) => {
  try {
    const expression = "(async () => { \\"use strict\\"; const inputs = " + JSON.stringify(entry.inputs) + ";\\n" + payload.targetCode + "\\n})()";
    const value = new vm.Script(expression, { filename: "visual-subject.mjs" }).runInNewContext(Object.create(null), { timeout: payload.caseTimeoutMs });
    const sceneText = JSON.stringify(await raceTimeout(value, payload.caseTimeoutMs));
    if (typeof sceneText !== "string" || Buffer.byteLength(sceneText, "utf8") > 12 * 1024) throw new Error("isolated visual scene exceeds the validation observation bound");
    return { caseId: entry.caseId, inputHash: entry.inputHash, status: "returned", scene: JSON.parse(sceneText), error: null };
  } catch (error) {
    return { caseId: entry.caseId, inputHash: entry.inputHash, status: "failed", scene: null, error: failure(error) };
  }
};
const observations = [];
for (const entry of payload.cases) observations.push(await observe(entry));
let receipt = { version: 1, key: payload.outputKey, observations };
let text = JSON.stringify(receipt);
if (Buffer.byteLength(text, "utf8") > maxReceiptBytes) {
  receipt = { version: 1, key: payload.outputKey, observations: payload.cases.map((entry) => ({ caseId: entry.caseId, inputHash: entry.inputHash, status: "failed", scene: null, error: "isolated observations exceeded the bounded validation receipt" })) };
  text = JSON.stringify(receipt);
}
process.stdout.write(marker + text + "\\n");
`;
}

/** The Host accepts exactly one keyed receipt from the trusted adapter's captured stdout. */
export function readVisualValidationObservations(
	stdout: string | null,
	input: { outputKey: string; cases: readonly Pick<FrozenVisualExecutionCase, "caseId" | "inputHash">[] },
): VisualCaseObservation[] {
	if (typeof stdout !== "string") throw new Error("Isolated visual execution produced no stdout receipt");
	const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(VISUAL_VALIDATION_OBSERVATION_MARKER));
	if (lines.length !== 1) throw new Error("Isolated visual execution must produce exactly one validation receipt");
	const encoded = lines[0].slice(VISUAL_VALIDATION_OBSERVATION_MARKER.length);
	if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_RECEIPT_BYTES)
		throw new Error("Isolated visual validation receipt exceeds its bound");
	let receipt: unknown;
	try {
		receipt = JSON.parse(encoded);
	} catch {
		throw new Error("Isolated visual validation receipt is not JSON");
	}
	if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
		throw new Error("Isolated visual validation receipt is invalid");
	const value = receipt as Record<string, unknown>;
	if (value.version !== 1 || value.key !== input.outputKey || !Array.isArray(value.observations))
		throw new Error("Isolated visual validation receipt does not match its frozen run");
	if (value.observations.length > input.cases.length)
		throw new Error("Isolated visual validation receipt contains too many observations");
	const expected = new Map(input.cases.map((entry) => [entry.caseId, entry.inputHash]));
	const seen = new Set<string>();
	return value.observations.map((entry): VisualCaseObservation => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error("Isolated visual observation is invalid");
		const observed = entry as Record<string, unknown>;
		if (
			typeof observed.caseId !== "string" ||
			typeof observed.inputHash !== "string" ||
			seen.has(observed.caseId) ||
			expected.get(observed.caseId) !== observed.inputHash
		)
			throw new Error("Isolated visual observation does not match its frozen case input");
		if (observed.status !== "returned" && observed.status !== "failed" && observed.status !== "timed-out")
			throw new Error("Isolated visual observation has an invalid status");
		if (observed.error !== null && (typeof observed.error !== "string" || observed.error.length > 2000))
			throw new Error("Isolated visual observation has an invalid error");
		seen.add(observed.caseId);
		return {
			caseId: observed.caseId,
			inputHash: observed.inputHash,
			status: observed.status,
			scene: Object.hasOwn(observed, "scene") ? observed.scene : null,
			error: observed.error,
		};
	});
}
