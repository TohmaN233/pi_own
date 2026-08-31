import { createHash } from "node:crypto";

// The worker accepts data-only specs. It intentionally imports no filesystem,
// network, shell, VM, dynamic module, or code-evaluation APIs.
globalThis.fetch = undefined;
globalThis.WebSocket = undefined;
globalThis.EventSource = undefined;

const MAX_INPUT_BYTES = 100_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const ALLOWED_KINDS = new Set(["matrix-transform", "algorithm-trace"]);

function hash(value) {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function fail(code, message) {
	process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
	process.exitCode = 1;
}

function assertData(value) {
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("NON_FINITE_NUMBER");
	if (typeof value === "string" && /(?:https?:|file:|data:|javascript:|__proto__|constructor|prototype|eval\s*\(|import\s*\()/i.test(value)) {
		throw new Error("UNSAFE_VALUE");
	}
	if (Array.isArray(value)) value.forEach(assertData);
	else if (value && typeof value === "object") Object.values(value).forEach(assertData);
}

function matrixTransform(spec) {
	const { matrix, points } = spec.inputs;
	if (
		!Array.isArray(matrix) ||
		matrix.length !== 2 ||
		!matrix.every((row) => Array.isArray(row) && row.length === 2 && row.every(Number.isFinite)) ||
		!Array.isArray(points) ||
		!points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
	) {
		throw new Error("INVALID_MATRIX_INPUT");
	}
	return {
		points: points.map(([x, y]) => [matrix[0][0] * x + matrix[0][1] * y, matrix[1][0] * x + matrix[1][1] * y]),
	};
}

function insertionSortTrace(spec) {
	const source = spec.inputs.values;
	if (!Array.isArray(source) || !source.every(Number.isFinite)) throw new Error("INVALID_TRACE_INPUT");
	const values = [...source];
	const states = [[...values]];
	for (let index = 1; index < values.length; index += 1) {
		const current = values[index];
		let cursor = index - 1;
		while (cursor >= 0 && values[cursor] > current) {
			values[cursor + 1] = values[cursor];
			cursor -= 1;
			if (states.length >= spec.maxSteps) throw new Error("STEP_BUDGET_EXCEEDED");
			states.push([...values]);
		}
		values[cursor + 1] = current;
		if (states.length >= spec.maxSteps) throw new Error("STEP_BUDGET_EXCEEDED");
		states.push([...values]);
	}
	return { states };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
		fail("INPUT_BUDGET_EXCEEDED", "Visual worker input is too large");
		process.stdin.destroy();
	}
});
process.stdin.on("end", () => {
	if (process.exitCode) return;
	try {
		const spec = JSON.parse(input);
		if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("INVALID_SPEC");
		const keys = Object.keys(spec).sort();
		if (JSON.stringify(keys) !== JSON.stringify(["inputs", "kind", "maxSteps", "seed", "version"])) throw new Error("UNKNOWN_SPEC_FIELD");
		if (spec.version !== 1 || !ALLOWED_KINDS.has(spec.kind)) throw new Error("UNKNOWN_KIND");
		if (!Number.isSafeInteger(spec.seed) || !Number.isInteger(spec.maxSteps) || spec.maxSteps < 1 || spec.maxSteps > 10_000) {
			throw new Error("INVALID_BOUNDS");
		}
		assertData(spec.inputs);
		const result = spec.kind === "matrix-transform" ? matrixTransform(spec) : insertionSortTrace(spec);
		const response = {
			ok: true,
			result,
			receipt: {
				version: 1,
				specHash: hash(spec),
				runtimeVersion: "pi-own-visual-worker-v1",
				seed: spec.seed,
				normalizedInputs: spec.inputs,
				outputHash: hash(result),
				traceHash: hash(result),
				verified: true,
				errors: [],
			},
		};
		const output = JSON.stringify(response);
		if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new Error("OUTPUT_BUDGET_EXCEEDED");
		process.stdout.write(`${output}\n`);
	} catch (error) {
		fail(error instanceof Error ? error.message : "WORKER_ERROR", "Visual activity was rejected");
	}
});
