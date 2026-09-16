import type {
	ExplorationPlan,
	FormalPlan,
	KnowledgeChange,
	PlanKind,
	ResearchPlanDetail,
	RunManifest,
	SmokePlan,
	SourceVersionInput,
	StudyPhase,
	TaskKind,
	TaskStatus,
	TheoryPlan,
} from "./types.ts";

export class StudyResearchError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function requiredText(value: string, label: string, maximum = 20_000): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
		throw new StudyResearchError("INVALID_INPUT", `${label} must be a non-empty bounded string`);
	}
	return value.trim();
}

export function requiredHash(value: string, label: string): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
		throw new StudyResearchError("INVALID_HASH", `${label} must be a sha256 hash`);
	}
	return value;
}

export function requiredRevision(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new StudyResearchError("INVALID_REVISION", `${label} must be a positive integer`);
	}
	return value;
}

function requiredStringList(value: readonly string[], label: string, maximum = 200): string[] {
	if (!Array.isArray(value) || value.length > maximum) {
		throw new StudyResearchError("INVALID_INPUT", `${label} must be an array of at most ${maximum} strings`);
	}
	const entries = value.map((item, index) => requiredText(item, `${label}[${index}]`));
	if (new Set(entries).size !== entries.length) {
		throw new StudyResearchError("DUPLICATE_VALUE", `${label} must not contain duplicates`);
	}
	return entries;
}

function assertRelativePath(value: string, label: string): string {
	requiredText(value, label, 4_096);
	if (
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes(":") ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new StudyResearchError("INVALID_PATH", `${label} must be a canonical relative path`);
	}
	return value;
}

export function requiredJsonLocator(value: string, label: string): string {
	const locator = requiredText(value, label, 4_000);
	let parsed: unknown;
	try {
		parsed = JSON.parse(locator);
	} catch {
		throw new StudyResearchError("INVALID_LOCATOR", `${label} must be JSON`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new StudyResearchError("INVALID_LOCATOR", `${label} must encode an object`);
	}
	return locator;
}

export function assertPhase(value: StudyPhase): StudyPhase {
	if (value !== "study" && value !== "research") {
		throw new StudyResearchError("INVALID_PHASE", "phase must be study or research");
	}
	return value;
}

export function assertTaskKind(value: TaskKind): TaskKind {
	if (!["reading", "paper-map", "execution", "validation", "review", "explanation"].includes(value)) {
		throw new StudyResearchError("INVALID_TASK_KIND", "task kind is invalid");
	}
	return value;
}

export function assertTaskStatus(value: TaskStatus): TaskStatus {
	if (
		![
			"queued",
			"admitted",
			"launching",
			"running",
			"succeeded",
			"failed",
			"cancelled",
			"limit-reached",
			"reconciling",
			"needs-input",
		].includes(value)
	) {
		throw new StudyResearchError("INVALID_TASK_STATUS", "task status is invalid");
	}
	return value;
}

export function validateSourceInput(input: SourceVersionInput): SourceVersionInput {
	requiredText(input.sourceRoot, "source.sourceRoot", 8_192);
	assertRelativePath(input.relativePath, "source.relativePath");
	if (!["pdf", "tex", "docx", "text", "code", "asset"].includes(input.kind)) {
		throw new StudyResearchError("INVALID_SOURCE_KIND", "source.kind is invalid");
	}
	if (!["primary", "tex-include", "linked-pdf", "reference", "supplement", "code"].includes(input.sourceRole)) {
		throw new StudyResearchError("INVALID_SOURCE_ROLE", "source.sourceRole is invalid");
	}
	if (!Array.isArray(input.diagnostics) || input.diagnostics.length > 10_000) {
		throw new StudyResearchError("INVALID_DIAGNOSTICS", "source.diagnostics must be a bounded array");
	}
	for (const diagnostic of input.diagnostics) {
		if (!["info", "warning", "error"].includes(diagnostic.severity)) {
			throw new StudyResearchError("INVALID_DIAGNOSTIC", "diagnostic severity is invalid");
		}
		requiredText(diagnostic.code, "diagnostic.code", 256);
		requiredText(diagnostic.message, "diagnostic.message", 20_000);
		if (diagnostic.path !== null) assertRelativePath(diagnostic.path, "diagnostic.path");
		if (diagnostic.locator !== null) requiredJsonLocator(diagnostic.locator, "diagnostic.locator");
		if (typeof diagnostic.requiresPdfInspection !== "boolean") {
			throw new StudyResearchError("INVALID_DIAGNOSTIC", "diagnostic requiresPdfInspection must be boolean");
		}
	}
	requiredHash(input.contentHash, "source.contentHash");
	requiredText(input.parser, "source.parser", 256);
	if (!Array.isArray(input.chunks) || input.chunks.length > 10_000) {
		throw new StudyResearchError("INVALID_INPUT", "source.chunks must be a bounded array");
	}
	let lastOrdinal = 0;
	let totalCharacters = 0;
	for (const chunk of input.chunks) {
		if (!Number.isSafeInteger(chunk.ordinal) || chunk.ordinal !== lastOrdinal + 1) {
			throw new StudyResearchError("INVALID_CHUNK", "source chunks must have contiguous ordinals starting at one");
		}
		lastOrdinal = chunk.ordinal;
		requiredJsonLocator(chunk.locator, "chunk.locator");
		if (typeof chunk.text !== "string" || chunk.text.length > 200_000 || chunk.text.includes("\0")) {
			throw new StudyResearchError("INVALID_CHUNK", "chunk.text must be a bounded string without NUL");
		}
		totalCharacters += chunk.text.length;
		if (totalCharacters > 16_000_000) {
			throw new StudyResearchError("INPUT_TOO_LARGE", "source chunks exceed 16 million characters");
		}
	}
	return structuredClone(input);
}

function validateTheory(detail: TheoryPlan): TheoryPlan {
	return {
		question: requiredText(detail.question, "theory.question"),
		assumptions: requiredStringList(detail.assumptions, "theory.assumptions"),
		propositions: requiredStringList(detail.propositions, "theory.propositions"),
		proofSteps: requiredStringList(detail.proofSteps, "theory.proofSteps"),
		counterexamples: requiredStringList(detail.counterexamples, "theory.counterexamples"),
		openGaps: requiredStringList(detail.openGaps, "theory.openGaps"),
	};
}

function validateSmoke(detail: SmokePlan): SmokePlan {
	return {
		question: requiredText(detail.question, "smoke.question"),
		method: requiredText(detail.method, "smoke.method"),
		evaluation: requiredText(detail.evaluation, "smoke.evaluation"),
		allowedChanges: requiredStringList(detail.allowedChanges, "smoke.allowedChanges"),
	};
}

function validateFormal(detail: FormalPlan): FormalPlan {
	const primaryMetrics = requiredStringList(detail.primaryMetrics, "formal.primaryMetrics");
	if (primaryMetrics.length === 0) {
		throw new StudyResearchError("INVALID_FORMAL_PLAN", "formal plans require primary metrics");
	}
	return {
		question: requiredText(detail.question, "formal.question"),
		hypotheses: requiredStringList(detail.hypotheses, "formal.hypotheses"),
		datasetVersion: requiredText(detail.datasetVersion, "formal.datasetVersion"),
		splitProtocol: requiredText(detail.splitProtocol, "formal.splitProtocol"),
		primaryMetrics,
		method: requiredText(detail.method, "formal.method"),
		stoppingConditions: requiredStringList(detail.stoppingConditions, "formal.stoppingConditions"),
	};
}

function validateExploration(detail: ExplorationPlan): ExplorationPlan {
	return {
		question: requiredText(detail.question, "exploration.question"),
		direction: requiredText(detail.direction, "exploration.direction"),
		allowedChanges: requiredStringList(detail.allowedChanges, "exploration.allowedChanges"),
		stoppingConditions: requiredStringList(detail.stoppingConditions, "exploration.stoppingConditions"),
	};
}

export function validatePlanDetail(kind: PlanKind, detail: ResearchPlanDetail): ResearchPlanDetail {
	if (kind === "theory") return validateTheory(detail as TheoryPlan);
	if (kind === "smoke") return validateSmoke(detail as SmokePlan);
	if (kind === "formal") return validateFormal(detail as FormalPlan);
	if (kind === "exploration") return validateExploration(detail as ExplorationPlan);
	throw new StudyResearchError("INVALID_PLAN_KIND", "plan kind is invalid");
}

export function validateManifest(value: RunManifest): RunManifest {
	requiredHash(value.codeHash, "manifest.codeHash");
	requiredHash(value.parameterHash, "manifest.parameterHash");
	requiredHash(value.environmentHash, "manifest.environmentHash");
	if (!value.inputHashes || typeof value.inputHashes !== "object" || Array.isArray(value.inputHashes)) {
		throw new StudyResearchError("INVALID_MANIFEST", "manifest.inputHashes must be an object");
	}
	const inputHashes: Record<string, string> = {};
	for (const [path, hash] of Object.entries(value.inputHashes)) {
		assertRelativePath(path, "manifest input path");
		requiredHash(hash, `manifest hash for ${path}`);
		inputHashes[path] = hash;
	}
	return {
		codeHash: value.codeHash,
		parameterHash: value.parameterHash,
		inputHashes,
		environmentHash: value.environmentHash,
	};
}

export function validateKnowledgeChange(change: KnowledgeChange): KnowledgeChange {
	if (!Array.isArray(change.notes) || !Array.isArray(change.nodes) || !Array.isArray(change.relations)) {
		throw new StudyResearchError("INVALID_KNOWLEDGE_CHANGE", "knowledge change collections must be arrays");
	}
	for (const note of change.notes) {
		if (note.replaceNoteId !== undefined) requiredText(note.replaceNoteId, "note.replaceNoteId", 128);
		requiredText(note.author, "note.author", 16);
		if (note.author !== "user" && note.author !== "agent") {
			throw new StudyResearchError("INVALID_NOTE", "note author is invalid");
		}
		requiredText(note.body, "note.body", 200_000);
		if ((note.sourceId === null) !== (note.sourceHash === null)) {
			throw new StudyResearchError("INVALID_NOTE", "note source id and hash must be both present or both null");
		}
		if (note.sourceId) requiredText(note.sourceId, "note.sourceId", 128);
		if (note.sourceHash) requiredHash(note.sourceHash, "note.sourceHash");
		requiredStringList(note.nodeLocalKeys, "note.nodeLocalKeys", 1_000);
	}
	const localKeys = new Set<string>();
	for (const node of change.nodes) {
		if (typeof node.manuallyEdited !== "boolean")
			throw new StudyResearchError("INVALID_NODE", "node manuallyEdited must be boolean");
		if (node.replaceNodeId !== undefined) requiredText(node.replaceNodeId, "node.replaceNodeId", 128);
		requiredText(node.localKey, "node.localKey", 128);
		if (localKeys.has(node.localKey)) {
			throw new StudyResearchError("DUPLICATE_VALUE", "node.localKey must be unique");
		}
		localKeys.add(node.localKey);
		if (!["concept", "claim", "proof", "assumption", "implementation", "question"].includes(node.kind)) {
			throw new StudyResearchError("INVALID_NODE", "node kind is invalid");
		}
		requiredText(node.title, "node.title", 2_000);
		requiredText(node.statement, "node.statement", 200_000);
		requiredText(node.scope, "node.scope", 4_000);
		if ((node.sourceId === null) !== (node.sourceHash === null)) {
			throw new StudyResearchError("INVALID_NODE", "node source id and hash must be both present or both null");
		}
		if (node.sourceId) requiredText(node.sourceId, "node.sourceId", 128);
		if (node.sourceHash) requiredHash(node.sourceHash, "node.sourceHash");
	}
	for (const note of change.notes) {
		if (note.nodeLocalKeys.some((key: string) => !localKeys.has(key))) {
			throw new StudyResearchError("INVALID_NOTE", "note must reference a node local key in the change");
		}
	}
	for (const relation of change.relations) {
		requiredText(relation.fromNodeLocalKey, "relation.fromNodeLocalKey", 128);
		requiredText(relation.toNodeLocalKey, "relation.toNodeLocalKey", 128);
		if (!localKeys.has(relation.fromNodeLocalKey) || !localKeys.has(relation.toNodeLocalKey)) {
			throw new StudyResearchError("INVALID_RELATION", "relation must reference a node local key in the change");
		}
		if (!["prerequisite", "supports", "contradicts", "refers-to", "implements"].includes(relation.kind)) {
			throw new StudyResearchError("INVALID_RELATION", "relation kind is invalid");
		}
	}
	return structuredClone(change);
}
