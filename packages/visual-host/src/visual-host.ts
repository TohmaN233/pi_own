import {
	HARNESS_CONTRACT_VERSION,
	parseVisualizationSpec,
	type JsonValue,
	type ValidatorIssue,
	type ValidatorResult,
	type VisualArtifact,
	type VisualizationSpec,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId, stableStringify } from "../../harness-core/src/index.ts";

export class VisualHostError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "VisualHostError";
		this.code = code;
	}
}

type ObjectValue = Record<string, unknown>;

interface RenderResult {
	data: JsonValue;
	trace: JsonValue;
	summary: string;
	body: string;
}

function objectValue(value: unknown, path: string): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new VisualHostError("INVALID_SPEC", `${path} must be an object`);
	return value as ObjectValue;
}

function exactKeys(value: ObjectValue, keys: readonly string[], path: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new VisualHostError("INVALID_SPEC", `${path}.${key} is not allowed`);
	for (const key of keys) if (!(key in value)) throw new VisualHostError("INVALID_SPEC", `${path}.${key} is required`);
}

function numberValue(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new VisualHostError("INVALID_SPEC", `${path} must be finite`);
	return value;
}

function stringValue(value: unknown, path: string): string {
	if (typeof value !== "string" || !value) throw new VisualHostError("INVALID_SPEC", `${path} must be a non-empty string`);
	if (/https?:\/\//iu.test(value) || /<\/?script|javascript:/iu.test(value)) throw new VisualHostError("ACTIVE_CONTENT_DENIED", `${path} contains active or external content`);
	return value;
}

function integerValue(value: unknown, path: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new VisualHostError("INVALID_SPEC", `${path} must be an integer from ${min} to ${max}`);
	}
	return value as number;
}

function numericArray(value: unknown, path: string, minLength: number, maxLength: number): number[] {
	if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
		throw new VisualHostError("INVALID_SPEC", `${path} must have ${minLength}..${maxLength} values`);
	}
	return value.map((item, index) => numberValue(item, `${path}[${index}]`));
}

function pair(value: unknown, path: string): [number, number] {
	const values = numericArray(value, path, 2, 2);
	return [values[0] as number, values[1] as number];
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function jsonForHtml(value: JsonValue): string {
	return escapeHtml(JSON.stringify(value, null, 2));
}

function stageHtml(spec: VisualizationSpec, result: RenderResult): string {
	const title = escapeHtml(spec.title);
	const summary = escapeHtml(result.summary);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>${title}</title>
<style>
:root{font-family:system-ui,sans-serif;color-scheme:light dark}body{max-width:1100px;margin:auto;padding:24px;line-height:1.5}main{display:grid;gap:18px}.stage{border:1px solid currentColor;border-radius:12px;padding:16px;overflow:auto}svg{width:100%;height:auto;min-height:320px}.summary{font-size:1.05rem}.trace{white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.85rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid currentColor;padding:6px;text-align:left}details{border:1px solid currentColor;border-radius:8px;padding:10px}
</style>
</head>
<body>
<main data-visual-spec="${escapeHtml(spec.specId)}" data-revision="${spec.revision}">
<header><h1>${title}</h1><p class="summary">${summary}</p></header>
<section class="stage" aria-label="Visualization">${result.body}</section>
<details><summary>Deterministic trace</summary><pre class="trace">${jsonForHtml(result.trace)}</pre></details>
<details><summary>Data table</summary><pre class="trace">${jsonForHtml(result.data)}</pre></details>
</main>
</body>
</html>`;
}

function renderFunctionPlot(payload: unknown): RenderResult {
	const value = objectValue(payload, "payload");
	exactKeys(value, ["coefficients", "xMin", "xMax", "samples"], "payload");
	const coefficients = numericArray(value.coefficients, "payload.coefficients", 1, 12);
	const xMin = numberValue(value.xMin, "payload.xMin");
	const xMax = numberValue(value.xMax, "payload.xMax");
	const samples = integerValue(value.samples, "payload.samples", 16, 1000);
	if (!(xMax > xMin)) throw new VisualHostError("INVALID_SPEC", "xMax must be greater than xMin");
	const points: Array<{ x: number; y: number }> = [];
	for (let index = 0; index < samples; index++) {
		const x = xMin + ((xMax - xMin) * index) / (samples - 1);
		let y = 0;
		for (let power = coefficients.length - 1; power >= 0; power--) y = y * x + (coefficients[power] ?? 0);
		points.push({ x: Number(x.toFixed(8)), y: Number(y.toFixed(8)) });
	}
	const ys = points.map((point) => point.y);
	const yMin = Math.min(...ys);
	const yMax = Math.max(...ys);
	const yRange = yMax === yMin ? 1 : yMax - yMin;
	const path = points
		.map((point, index) => {
			const px = ((point.x - xMin) / (xMax - xMin)) * 900 + 50;
			const py = 350 - ((point.y - yMin) / yRange) * 300;
			return `${index === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)}`;
		})
		.join(" ");
	const body = `<svg viewBox="0 0 1000 400" role="img" aria-label="Polynomial function plot"><rect x="50" y="50" width="900" height="300" fill="none" stroke="currentColor"/><path d="${path}" fill="none" stroke="currentColor" stroke-width="3"/></svg>`;
	return {
		data: { coefficients, domain: [xMin, xMax], range: [yMin, yMax], points },
		trace: points.map((point, index) => ({ step: index, ...point })),
		summary: `Polynomial with ${coefficients.length} coefficients sampled at ${samples} deterministic points.`,
		body,
	};
}

function renderMatrixTransform(payload: unknown): RenderResult {
	const value = objectValue(payload, "payload");
	exactKeys(value, ["matrix", "points"], "payload");
	if (!Array.isArray(value.matrix) || value.matrix.length !== 2) throw new VisualHostError("INVALID_SPEC", "payload.matrix must be 2x2");
	const row0 = pair(value.matrix[0], "payload.matrix[0]");
	const row1 = pair(value.matrix[1], "payload.matrix[1]");
	if (!Array.isArray(value.points) || value.points.length < 1 || value.points.length > 200) throw new VisualHostError("INVALID_SPEC", "payload.points must have 1..200 points");
	const points = value.points.map((item, index) => pair(item, `payload.points[${index}]`));
	const transformed = points.map(([x, y]) => [row0[0] * x + row0[1] * y, row1[0] * x + row1[1] * y] as [number, number]);
	const all = [...points, ...transformed];
	const extent = Math.max(1, ...all.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]));
	const drawPoints = (items: [number, number][], radius: number): string => items
		.map(([x, y]) => `<circle cx="${(500 + (x / extent) * 420).toFixed(2)}" cy="${(250 - (y / extent) * 210).toFixed(2)}" r="${radius}" fill="currentColor"/>`)
		.join("");
	const body = `<svg viewBox="0 0 1000 500" role="img" aria-label="Matrix transformation"><line x1="50" y1="250" x2="950" y2="250" stroke="currentColor"/><line x1="500" y1="30" x2="500" y2="470" stroke="currentColor"/>${drawPoints(points, 7)}${drawPoints(transformed, 3)}</svg>`;
	return {
		data: { matrix: [row0, row1], source: points, transformed },
		trace: points.map((point, index) => ({ step: index, source: point, result: transformed[index] as JsonValue })),
		summary: `Applied a fixed 2×2 matrix to ${points.length} points. Large markers are source points; small markers are transformed points.`,
		body,
	};
}

function renderAlgorithmTrace(payload: unknown): RenderResult {
	const value = objectValue(payload, "payload");
	exactKeys(value, ["algorithm", "values"], "payload");
	const algorithm = stringValue(value.algorithm, "payload.algorithm");
	if (algorithm !== "insertion-sort" && algorithm !== "bubble-sort") throw new VisualHostError("INVALID_SPEC", "Supported algorithms are insertion-sort and bubble-sort");
	const values = numericArray(value.values, "payload.values", 1, 128);
	const state = [...values];
	const trace: JsonValue[] = [{ step: 0, action: "initial", values: [...state] }];
	let step = 1;
	if (algorithm === "insertion-sort") {
		for (let index = 1; index < state.length; index++) {
			const key = state[index] as number;
			let cursor = index - 1;
			while (cursor >= 0 && (state[cursor] as number) > key) {
				state[cursor + 1] = state[cursor] as number;
				trace.push({ step: step++, action: "shift", from: cursor, to: cursor + 1, values: [...state] });
				cursor--;
			}
			state[cursor + 1] = key;
			trace.push({ step: step++, action: "insert", index: cursor + 1, value: key, values: [...state] });
		}
	} else {
		for (let end = state.length - 1; end > 0; end--) {
			for (let index = 0; index < end; index++) {
				if ((state[index] as number) > (state[index + 1] as number)) {
					[state[index], state[index + 1]] = [state[index + 1] as number, state[index] as number];
					trace.push({ step: step++, action: "swap", left: index, right: index + 1, values: [...state] });
				}
				if (trace.length > 5000) throw new VisualHostError("TRACE_LIMIT", "Algorithm trace exceeded 5000 steps");
			}
		}
	}
	const rows = trace.slice(0, 100).map((entry) => `<tr><td>${escapeHtml(String((entry as { step?: unknown }).step))}</td><td><code>${escapeHtml(JSON.stringify(entry))}</code></td></tr>`).join("");
	return {
		data: { algorithm, input: values, output: state },
		trace,
		summary: `${algorithm} completed in ${trace.length - 1} recorded operations.`,
		body: `<table><thead><tr><th>Step</th><th>State transition</th></tr></thead><tbody>${rows}</tbody></table>`,
	};
}

function renderGraphTrace(payload: unknown): RenderResult {
	const value = objectValue(payload, "payload");
	exactKeys(value, ["start", "adjacency"], "payload");
	const start = stringValue(value.start, "payload.start");
	const adjacencyValue = objectValue(value.adjacency, "payload.adjacency");
	const nodes = Object.keys(adjacencyValue).sort();
	if (nodes.length < 1 || nodes.length > 200) throw new VisualHostError("INVALID_SPEC", "Graph must have 1..200 nodes");
	const adjacency: Record<string, string[]> = {};
	let edgeCount = 0;
	for (const node of nodes) {
		stringValue(node, "payload.adjacency key");
		const raw = adjacencyValue[node];
		if (!Array.isArray(raw)) throw new VisualHostError("INVALID_SPEC", `payload.adjacency.${node} must be an array`);
		const neighbors = raw.map((item, index) => stringValue(item, `payload.adjacency.${node}[${index}]`)).sort();
		adjacency[node] = [...new Set(neighbors)];
		edgeCount += adjacency[node]?.length ?? 0;
	}
	if (!nodes.includes(start)) throw new VisualHostError("INVALID_SPEC", "Start node is not in adjacency map");
	if (edgeCount > 1000) throw new VisualHostError("TRACE_LIMIT", "Graph has more than 1000 directed edges");
	for (const neighbors of Object.values(adjacency)) for (const neighbor of neighbors) if (!nodes.includes(neighbor)) throw new VisualHostError("INVALID_SPEC", `Neighbor ${neighbor} is not declared`);
	const visited = new Set<string>([start]);
	const queue = [start];
	const order: string[] = [];
	const trace: JsonValue[] = [];
	while (queue.length > 0) {
		const node = queue.shift() as string;
		order.push(node);
		for (const neighbor of adjacency[node] ?? []) {
			if (!visited.has(neighbor)) {
				visited.add(neighbor);
				queue.push(neighbor);
			}
		}
		trace.push({ step: trace.length, visit: node, queue: [...queue], visited: [...visited].sort() });
	}
	const body = `<ol>${order.map((node) => `<li>${escapeHtml(node)}</li>`).join("")}</ol>`;
	return { data: { start, adjacency, order }, trace, summary: `Breadth-first traversal visited ${order.length} of ${nodes.length} nodes.`, body };
}

function renderStateMachine(payload: unknown): RenderResult {
	const value = objectValue(payload, "payload");
	exactKeys(value, ["initial", "transitions", "inputs"], "payload");
	const initial = stringValue(value.initial, "payload.initial");
	if (!Array.isArray(value.transitions) || value.transitions.length > 500) throw new VisualHostError("INVALID_SPEC", "transitions must be an array of at most 500 entries");
	const transitions = value.transitions.map((item, index) => {
		const transition = objectValue(item, `payload.transitions[${index}]`);
		exactKeys(transition, ["from", "input", "to"], `payload.transitions[${index}]`);
		return {
			from: stringValue(transition.from, `payload.transitions[${index}].from`),
			input: stringValue(transition.input, `payload.transitions[${index}].input`),
			to: stringValue(transition.to, `payload.transitions[${index}].to`),
		};
	});
	if (!Array.isArray(value.inputs) || value.inputs.length > 500) throw new VisualHostError("INVALID_SPEC", "inputs must be an array of at most 500 entries");
	const inputs = value.inputs.map((item, index) => stringValue(item, `payload.inputs[${index}]`));
	const table = new Map(transitions.map((transition) => [`${transition.from}\0${transition.input}`, transition.to]));
	let state = initial;
	const trace: JsonValue[] = [{ step: 0, state, input: null }];
	for (const input of inputs) {
		const key = `${state}\0${input}`;
		const next = table.get(key);
		if (!next) throw new VisualHostError("MISSING_TRANSITION", `No transition from ${state} on ${input}`);
		state = next;
		trace.push({ step: trace.length, state, input });
	}
	const body = `<table><thead><tr><th>Step</th><th>Input</th><th>State</th></tr></thead><tbody>${trace.map((entry) => `<tr><td>${escapeHtml(String((entry as { step: number }).step))}</td><td>${escapeHtml(String((entry as { input: unknown }).input ?? "—"))}</td><td>${escapeHtml(String((entry as { state: string }).state))}</td></tr>`).join("")}</tbody></table>`;
	return { data: { initial, transitions, inputs, final: state }, trace, summary: `Processed ${inputs.length} inputs and ended in state ${state}.`, body };
}

function render(spec: VisualizationSpec): RenderResult {
	if (stableStringify(spec.payload).length > 200000) throw new VisualHostError("SPEC_SIZE_LIMIT", "Visualization payload exceeds 200 KB");
	if (spec.kind === "function-plot") return renderFunctionPlot(spec.payload);
	if (spec.kind === "matrix-transform") return renderMatrixTransform(spec.payload);
	if (spec.kind === "algorithm-trace") return renderAlgorithmTrace(spec.payload);
	if (spec.kind === "graph-trace") return renderGraphTrace(spec.payload);
	return renderStateMachine(spec.payload);
}

function validatorIssue(code: string, message: string, path: string | null = null): ValidatorIssue {
	return { code, severity: "error", message, path };
}

export interface VisualHostState {
	version: 1;
	specs: VisualizationSpec[];
	artifacts: VisualArtifact[];
	validators: ValidatorResult[];
}

export class VisualHost {
	private readonly specs = new Map<string, VisualizationSpec>();
	private readonly artifacts = new Map<string, VisualArtifact>();
	private readonly validators = new Map<string, ValidatorResult>();

	run(value: unknown, createdAt = new Date().toISOString()): VisualArtifact {
		const spec = parseVisualizationSpec(value);
		if (!Number.isFinite(Date.parse(createdAt))) throw new VisualHostError("INVALID_TIMESTAMP", "createdAt must be ISO-8601");
		const existingSpec = this.specs.get(spec.specId);
		if (existingSpec && (existingSpec.revision !== spec.revision || stableStringify(existingSpec) !== stableStringify(spec))) {
			throw new VisualHostError("SPEC_REDEFINED", `Visualization spec ${spec.specId} was redefined`);
		}
		const result = render(spec);
		const dataHash = contentHash(result.data);
		const traceHash = contentHash(result.trace);
		const identity = {
			specId: spec.specId,
			specRevision: spec.revision,
			courseVersionId: spec.courseVersionId,
			kind: spec.kind,
			seed: spec.seed,
			dataHash,
			traceHash,
			rendererVersion: 1,
		};
		const html = stageHtml(spec, result);
		const artifact: VisualArtifact = Object.freeze({
			artifactId: deterministicId("visual-artifact", identity, 40),
			specId: spec.specId,
			specRevision: spec.revision,
			courseVersionId: spec.courseVersionId,
			kind: spec.kind,
			data: result.data,
			trace: result.trace,
			html,
			dataHash,
			traceHash,
			contentHash: contentHash({ ...identity, html }),
			createdAt,
			revision: 1,
		});
		const existing = this.artifacts.get(artifact.artifactId);
		if (existing && existing.contentHash !== artifact.contentHash) throw new VisualHostError("ARTIFACT_COLLISION", "Visual artifact identity collision");
		this.specs.set(spec.specId, Object.freeze(spec));
		this.artifacts.set(artifact.artifactId, artifact);
		return artifact;
	}

	validate(artifactId: string, checkedAt = new Date().toISOString()): ValidatorResult {
		const artifact = this.getArtifact(artifactId);
		const spec = this.specs.get(artifact.specId);
		const issues: ValidatorIssue[] = [];
		if (!spec || spec.revision !== artifact.specRevision) issues.push(validatorIssue("STALE_SPEC", "Artifact is not bound to the current spec revision"));
		if (contentHash(artifact.data) !== artifact.dataHash) issues.push(validatorIssue("DATA_HASH_MISMATCH", "Artifact data hash is invalid", "data"));
		if (contentHash(artifact.trace) !== artifact.traceHash) issues.push(validatorIssue("TRACE_HASH_MISMATCH", "Artifact trace hash is invalid", "trace"));
		if (!artifact.html.includes("Content-Security-Policy")) issues.push(validatorIssue("CSP_REQUIRED", "Visual HTML needs a CSP"));
		if (/<script\b|javascript:|https?:\/\//iu.test(artifact.html)) issues.push(validatorIssue("ACTIVE_CONTENT_DENIED", "Visual HTML contains script or external URL"));
		if (!artifact.html.includes("Deterministic trace") || !artifact.html.includes("Data table")) issues.push(validatorIssue("ACCESSIBILITY_SUMMARY_REQUIRED", "Visual HTML needs trace and data summaries"));
		const result: ValidatorResult = {
			version: HARNESS_CONTRACT_VERSION,
			validatorId: "visual-artifact-v1",
			status: issues.length === 0 ? "pass" : "fail",
			subject: { kind: "visual-artifact", id: artifact.artifactId, revision: artifact.revision },
			checkedAt,
			issues,
		};
		this.validators.set(artifactId, result);
		return result;
	}

	publish(artifactId: string): VisualArtifact {
		const artifact = this.getArtifact(artifactId);
		const validation = this.validators.get(artifactId);
		if (!validation || validation.status !== "pass" || validation.subject.revision !== artifact.revision) {
			throw new VisualHostError("VALIDATION_REQUIRED", "Current visual artifact revision has not passed validation");
		}
		return artifact;
	}

	getArtifact(artifactId: string): VisualArtifact {
		const artifact = this.artifacts.get(artifactId);
		if (!artifact) throw new VisualHostError("UNKNOWN_ARTIFACT", `Unknown visual artifact ${artifactId}`);
		return artifact;
	}

	listArtifacts(courseVersionId?: string): VisualArtifact[] {
		return [...this.artifacts.values()]
			.filter((artifact) => !courseVersionId || artifact.courseVersionId === courseVersionId)
			.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
	}

	exportState(): VisualHostState {
		return {
			version: 1,
			specs: [...this.specs.values()].sort((left, right) => left.specId.localeCompare(right.specId)),
			artifacts: this.listArtifacts(),
			validators: [...this.validators.values()].sort((left, right) => left.subject.id.localeCompare(right.subject.id)),
		};
	}

	restoreState(state: VisualHostState): void {
		if (!state || state.version !== 1 || !Array.isArray(state.specs) || !Array.isArray(state.artifacts) || !Array.isArray(state.validators)) {
			throw new VisualHostError("INVALID_STATE", "Invalid VisualHost state");
		}
		if (this.specs.size || this.artifacts.size || this.validators.size) throw new VisualHostError("STATE_NOT_EMPTY", "VisualHost restore requires an empty host");
		const artifactBySpec = new Map(state.artifacts.map((artifact) => [artifact.specId, artifact]));
		for (const spec of state.specs) {
			const expectedArtifact = artifactBySpec.get(spec.specId);
			if (!expectedArtifact) throw new VisualHostError("CORRUPT_STATE", `Missing artifact for spec ${spec.specId}`);
			const restored = this.run(spec, expectedArtifact.createdAt);
			if (stableStringify(restored) !== stableStringify(expectedArtifact)) {
				throw new VisualHostError("ARTIFACT_INTEGRITY_FAILURE", `Artifact ${expectedArtifact.artifactId} cannot be reproduced`);
			}
		}
		if (this.artifacts.size !== state.artifacts.length) throw new VisualHostError("CORRUPT_STATE", "Visual artifact set is inconsistent");
		for (const validator of state.validators) {
			const restored = this.validate(validator.subject.id, validator.checkedAt);
			if (stableStringify(restored) !== stableStringify(validator)) {
				throw new VisualHostError("VALIDATOR_INTEGRITY_FAILURE", `Validator for ${validator.subject.id} cannot be reproduced`);
			}
		}
	}
}
