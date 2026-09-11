import { contentHash } from "../../harness-core/src/index.ts";

export class StudyError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "StudyError";
		this.code = code;
	}
}

export function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new StudyError("INVALID_INPUT", `${label} must be an object`);
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record))
		if (!keys.includes(key)) throw new StudyError("INVALID_INPUT", `Unknown ${label} field: ${key}`);
	return record;
}
export function text(value: unknown, label: string, maximum = 20000, empty = false): string {
	if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()) || value.includes("\0"))
		throw new StudyError("INVALID_INPUT", `Invalid ${label}`);
	return value;
}
export function integer(value: unknown, label: string, minimum = 0, maximum = 1000000): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new StudyError("INVALID_INPUT", `Invalid ${label}`);
	return value;
}
export function identifier(value: unknown, label = "id"): string {
	const id = text(value, label, 128);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(id)) throw new StudyError("INVALID_INPUT", `Invalid ${label}`);
	return id;
}
export function list(value: unknown, label: string, maximum = 128): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new StudyError("INVALID_INPUT", `Invalid ${label}`);
	return value;
}
export function strings(value: unknown, label: string, maximum = 64): string[] {
	return list(value, label, maximum).map((entry) => text(entry, label, 4000));
}
export function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T))
		throw new StudyError("INVALID_INPUT", `Invalid ${label}`);
	return value as T;
}

export interface SourceEntry {
	id: string;
	path: string;
	size: number;
	mtimeMs: number;
}
export interface StudyProject {
	id: string;
	title: string;
	root: string;
	revision: number;
	manifestVersion: number;
	manifestHash: string;
	sources: SourceEntry[];
}
export interface SourceAnchor {
	sourceId: string;
	sourceHash: string;
	startLine: number;
	endLine: number;
	quote: string;
}
export interface StudyNode {
	id: string;
	kind: "background" | "notation" | "definition" | "contribution" | "proof" | "implementation" | "example";
	epistemicStatus: "unchecked" | "argument-given" | "gap" | "candidate-error";
	title: string;
	dependsOn: string[];
	explanation: string;
	whyNeeded: string;
	checks: string[];
	sources: SourceAnchor[];
	openQuestions: string[];
}
export interface StudyRoadmap {
	scope: string;
	story: string;
	contribution: string;
	uncertainties: string[];
	nodes: StudyNode[];
}
export interface StudyNote {
	author: "user" | "agent";
	nodeId: string | null;
	anchor: SourceAnchor | null;
	body: string;
}
export interface ResearchProposal {
	title: string;
	nodeIds: string[];
	hypothesis: string;
	whyUseful: string;
	alternatives: string[];
	risks: string[];
	requiredEvidence: string[];
	noveltyStatus: "not-established" | "search-needed";
	sources: SourceAnchor[];
}
export interface ExperimentPlan {
	title: string;
	purpose: "study" | "research";
	proposalId: string | null;
	hypothesis: string;
	baseline: string;
	ablations: string[];
	metric: string;
	dataSplit: string;
	seeds: number[];
	successCriterion: string;
	failureInterpretation: string;
	language: "python" | "javascript";
	code: string;
	timeoutSeconds: number;
}
export interface StudyDocument<T> {
	id: string;
	revision: number;
	manifestVersion: number;
	roadmapRevision: number;
	proposalRevision: number | null;
	data: T;
	hash: string;
	createdAt: string;
}
export interface CodeRun {
	id: string;
	experimentId: string;
	experimentRevision: number;
	planHash: string;
	codeHash: string;
	status: "started" | "succeeded" | "failed" | "timed-out" | "output-limit" | "aborted";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	startedAt: string;
	finishedAt: string | null;
}
export type DocumentKind = "roadmap" | "note" | "proposal" | "experiment";

export function parseManifest(value: unknown): SourceEntry[] {
	const ids = new Set<string>();
	const paths = new Set<string>();
	return list(value, "manifest", 512).map((entry) => {
		const row = object(entry, ["id", "path", "size", "mtimeMs"], "source");
		const id = identifier(row.id);
		const path = text(row.path, "source path", 1024);
		if (
			path.startsWith("/") ||
			path.includes("\\") ||
			path.split("/").some((part) => !part || part === "." || part === "..") ||
			/^[a-z]:/iu.test(path)
		)
			throw new StudyError("PATH_ESCAPE", "Source path must be relative and normalized");
		if (ids.has(id) || paths.has(path)) throw new StudyError("DUPLICATE_SOURCE", "Duplicate source identity or path");
		ids.add(id);
		paths.add(path);
		return {
			id,
			path,
			size: integer(row.size, "source size", 0, 64 * 1024 * 1024),
			mtimeMs: integer(row.mtimeMs, "mtimeMs", 0, Number.MAX_SAFE_INTEGER),
		};
	});
}
export function parseAnchor(value: unknown): SourceAnchor {
	const row = object(value, ["sourceId", "sourceHash", "startLine", "endLine", "quote"], "anchor");
	const sourceHash = text(row.sourceHash, "sourceHash", 64);
	if (!/^[a-f0-9]{64}$/u.test(sourceHash)) throw new StudyError("INVALID_HASH", "Expected source SHA-256");
	const startLine = integer(row.startLine, "startLine", 1);
	const endLine = integer(row.endLine, "endLine", startLine, startLine + 200);
	return { sourceId: identifier(row.sourceId), sourceHash, startLine, endLine, quote: text(row.quote, "quote", 2000) };
}
export function parseRoadmap(value: unknown): StudyRoadmap {
	const row = object(value, ["scope", "story", "contribution", "uncertainties", "nodes"], "roadmap");
	const nodes = list(row.nodes, "nodes", 120).map((entry) => {
		const item = object(
			entry,
			[
				"id",
				"kind",
				"title",
				"dependsOn",
				"explanation",
				"whyNeeded",
				"checks",
				"sources",
				"openQuestions",
				"epistemicStatus",
			],
			"study node",
		);
		const node: StudyNode = {
			epistemicStatus:
				item.epistemicStatus === undefined
					? "unchecked"
					: choice(
							item.epistemicStatus,
							["unchecked", "argument-given", "gap", "candidate-error"],
							"epistemicStatus",
						),
			id: identifier(item.id),
			kind: choice(
				item.kind,
				["background", "notation", "definition", "contribution", "proof", "implementation", "example"],
				"node kind",
			),
			title: text(item.title, "title", 300),
			dependsOn: list(item.dependsOn, "dependsOn").map((id) => identifier(id)),
			explanation: text(item.explanation, "explanation"),
			whyNeeded: text(item.whyNeeded, "whyNeeded", 4000),
			checks: strings(item.checks, "checks", 12),
			sources: list(item.sources, "sources", 24).map(parseAnchor),
			openQuestions: strings(item.openQuestions, "openQuestions", 24),
		};
		if (!node.checks.length) throw new StudyError("INCOMPLETE_ROADMAP", "Each node needs an understanding check");
		if (["contribution", "proof", "implementation"].includes(node.kind) && !node.sources.length)
			throw new StudyError("MISSING_EVIDENCE", `${node.kind} nodes need source anchors`);
		return node;
	});
	if (!nodes.length) throw new StudyError("INCOMPLETE_ROADMAP", "Roadmap needs at least one study node");
	const byId = new Map(nodes.map((node) => [node.id, node]));
	if (byId.size !== nodes.length) throw new StudyError("DUPLICATE_NODE", "Duplicate node id");
	const visiting = new Set<string>();
	const done = new Set<string>();
	const visit = (id: string) => {
		if (done.has(id)) return;
		if (visiting.has(id)) throw new StudyError("DEPENDENCY_CYCLE", "Prerequisite cycle");
		const node = byId.get(id);
		if (!node) throw new StudyError("UNKNOWN_NODE", `Unknown prerequisite ${id}`);
		visiting.add(id);
		for (const parent of node.dependsOn) visit(parent);
		visiting.delete(id);
		done.add(id);
	};
	for (const node of nodes) visit(node.id);
	return {
		scope: text(row.scope, "scope", 4000),
		story: text(row.story, "story"),
		contribution: text(row.contribution, "contribution"),
		uncertainties: strings(row.uncertainties, "uncertainties"),
		nodes,
	};
}
export function parseProposal(value: unknown): ResearchProposal {
	const row = object(
		value,
		[
			"title",
			"nodeIds",
			"hypothesis",
			"whyUseful",
			"alternatives",
			"risks",
			"requiredEvidence",
			"noveltyStatus",
			"sources",
		],
		"proposal",
	);
	const proposal: ResearchProposal = {
		title: text(row.title, "title", 300),
		nodeIds: list(row.nodeIds, "nodeIds").map((id) => identifier(id)),
		hypothesis: text(row.hypothesis, "hypothesis"),
		whyUseful: text(row.whyUseful, "whyUseful"),
		alternatives: strings(row.alternatives, "alternatives"),
		risks: strings(row.risks, "risks"),
		requiredEvidence: strings(row.requiredEvidence, "requiredEvidence"),
		noveltyStatus: choice(row.noveltyStatus, ["not-established", "search-needed"], "noveltyStatus"),
		sources: list(row.sources, "sources", 24).map(parseAnchor),
	};
	if (!proposal.nodeIds.length || !proposal.alternatives.length || !proposal.requiredEvidence.length)
		throw new StudyError("INCOMPLETE_PROPOSAL", "Proposal requires a roadmap gap, alternatives and evidence");
	return proposal;
}
export function parseExperiment(value: unknown): ExperimentPlan {
	const row = object(
		value,
		[
			"title",
			"purpose",
			"proposalId",
			"hypothesis",
			"baseline",
			"ablations",
			"metric",
			"dataSplit",
			"seeds",
			"successCriterion",
			"failureInterpretation",
			"language",
			"code",
			"timeoutSeconds",
		],
		"experiment",
	);
	const plan: ExperimentPlan = {
		title: text(row.title, "title", 300),
		purpose: choice(row.purpose, ["study", "research"], "purpose"),
		proposalId: row.proposalId === null ? null : identifier(row.proposalId),
		hypothesis: text(row.hypothesis, "hypothesis"),
		baseline: text(row.baseline, "baseline"),
		ablations: strings(row.ablations, "ablations"),
		metric: text(row.metric, "metric", 4000),
		dataSplit: text(row.dataSplit, "dataSplit", 4000),
		seeds: list(row.seeds, "seeds", 32).map((seed) => integer(seed, "seed", 0, 2147483647)),
		successCriterion: text(row.successCriterion, "successCriterion"),
		failureInterpretation: text(row.failureInterpretation, "failureInterpretation"),
		language: choice(row.language, ["python", "javascript"], "language"),
		code: text(row.code, "code", 64000),
		timeoutSeconds: integer(row.timeoutSeconds, "timeoutSeconds", 1, 30),
	};
	if (plan.purpose === "research" && !plan.proposalId)
		throw new StudyError("MISSING_PROPOSAL", "Research experiments require a current proposal");
	return plan;
}
export function documentHash(value: Omit<StudyDocument<unknown>, "hash">): string {
	return contentHash(value);
}
