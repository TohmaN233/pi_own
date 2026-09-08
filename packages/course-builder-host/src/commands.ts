import { HARNESS_CONTRACT_VERSION } from "../../harness-contracts/src/index.ts";
import { compileBeamerDeck, reviewBeamerDeck } from "./beamer.ts";
import { CourseBuilderError, type CourseBuilderHost } from "./host.ts";
import { semesterPlanningIssue } from "./planning.ts";

export const COURSE_BUILDER_ACTIONS = [
	"state",
	"assignment_state",
	"read_material",
	"read_assignment_material",
	"read_deck",
	"read_compile_log",
	"read_attachment",
	"save_analysis",
	"save_assignment",
	"save_semester",
	"save_lesson",
	"save_checkpoint",
	"read_checkpoints",
	"save_deck",
	"patch_deck",
	"compile",
	"review_deck",
	"visual_templates",
	"visual",
] as const;
export interface CourseBuilderCommand {
	action: string;
	id?: string;
	assignmentId?: string;
	draft?: unknown;
	expectedRevision?: number;
	parentRevision?: number;
	offset?: number;
	limit?: number;
	purpose?: string;
	spec?: unknown;
}
function required(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 256)
		throw new CourseBuilderError("INVALID_ID", "A target id is required");
	return value;
}
function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new CourseBuilderError("REVISION_REQUIRED", "Supply the currently observed revision (0 for a new draft)");
	return value;
}
function excerpt(source: string, options: CourseBuilderCommand) {
	const offset = options.offset ?? 0,
		limit = options.limit ?? 6000;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000)
		throw new CourseBuilderError("INVALID_RANGE", "Use a nonnegative offset and a limit of 1..20000 characters");
	return {
		text: source.slice(offset, offset + limit),
		offset,
		nextOffset: offset + limit < source.length ? offset + limit : null,
		totalCharacters: source.length,
	};
}

export function courseBuilderVisualTemplates(projectId: string) {
	const base = {
		version: HARNESS_CONTRACT_VERSION,
		courseVersionId: projectId,
		seed: 0,
		revision: 1,
	};
	return {
		contract: {
			fields: ["version", "specId", "courseVersionId", "kind", "title", "seed", "revision", "payload"],
			courseVersionId: projectId,
			revision: "positive integer",
			note: "Payloads use exact fields. Extra fields and active or external content are rejected.",
		},
		kinds: [
			{
				kind: "function-plot",
				purpose: "Plot one polynomial from coefficients in ascending power order.",
				limits: { coefficients: "1..12 finite numbers", samples: "integer 16..1000", domain: "xMax > xMin" },
				example: {
					...base,
					specId: "polynomial-example",
					kind: "function-plot",
					title: "Polynomial",
					payload: { coefficients: [0, 1, 1], xMin: -3, xMax: 3, samples: 121 },
				},
			},
			{
				kind: "matrix-transform",
				purpose: "Compare source points with their image under one 2×2 matrix.",
				limits: { matrix: "exactly 2×2 finite numbers", points: "1..200 coordinate pairs" },
				example: {
					...base,
					specId: "matrix-example",
					kind: "matrix-transform",
					title: "Matrix transformation",
					payload: {
						matrix: [
							[1, 1],
							[0, 1],
						],
						points: [
							[0, 0],
							[1, 0],
							[1, 1],
							[0, 1],
						],
					},
				},
			},
			{
				kind: "algorithm-trace",
				purpose: "Show the recorded state changes of insertion sort or bubble sort.",
				limits: {
					algorithm: "insertion-sort or bubble-sort",
					values: "1..128 finite numbers",
					trace: "at most 5000 operations",
				},
				example: {
					...base,
					specId: "sorting-example",
					kind: "algorithm-trace",
					title: "Insertion sort",
					payload: { algorithm: "insertion-sort", values: [5, 2, 4, 1] },
				},
			},
			{
				kind: "graph-trace",
				purpose: "Trace breadth-first traversal from a declared start node.",
				limits: {
					adjacency: "1..200 declared nodes and at most 1000 directed edges",
					start: "must be a declared node",
				},
				example: {
					...base,
					specId: "graph-example",
					kind: "graph-trace",
					title: "Breadth-first traversal",
					payload: { start: "A", adjacency: { A: ["B", "C"], B: ["D"], C: [], D: [] } },
				},
			},
			{
				kind: "state-machine",
				purpose: "Trace a deterministic state machine over a fixed input sequence.",
				limits: {
					transitions: "at most 500 exact {from,input,to} entries",
					inputs: "at most 500 strings",
					completeness: "every visited state/input pair needs a transition",
				},
				example: {
					...base,
					specId: "state-example",
					kind: "state-machine",
					title: "State trace",
					payload: {
						initial: "locked",
						transitions: [
							{ from: "locked", input: "coin", to: "unlocked" },
							{ from: "unlocked", input: "push", to: "locked" },
						],
						inputs: ["coin", "push"],
					},
				},
			},
		],
	};
}
export function courseBuilderView(host: CourseBuilderHost, sessionId: string) {
	const s = host.getSnapshotForSession(sessionId);
	if (!s) return null;
	const materialView = ({ extractedText: _text, metadata, ...material }: (typeof s.materials)[number]) => ({
		...material,
		source:
			metadata.storage === "local-link"
				? {
						storage: "local-link" as const,
						sourceRoot: typeof metadata.sourceRoot === "string" ? metadata.sourceRoot : "",
						relativePath: typeof metadata.relativePath === "string" ? metadata.relativePath : material.name,
						sourceSize: typeof metadata.sourceSize === "number" ? metadata.sourceSize : null,
						readMode: "on-demand" as const,
					}
				: { storage: "copied" as const, readMode: "indexed" as const },
	});
	const materialById = new Map(s.materials.map((material) => [material.materialId, material]));
	return {
		...s,
		coverageCheckpoints: host.listCoverageCheckpoints(sessionId),
		planningStatus: {
			issue: s.semesterPlan ? semesterPlanningIssue(s.project, s.semesterPlan) : null,
			materialChangesRequireSemesterRevision: false,
		},
		materials: s.materials.filter((material) => material.metadata.materialScope !== "assignment").map(materialView),
		assignments: s.assignments.map((assignment) => ({
			...assignment,
			materials: assignment.materialIds.map((materialId) => {
				const material = materialById.get(materialId);
				if (!material) throw new CourseBuilderError("CORRUPT_STATE", "Assignment material is missing");
				return materialView(material);
			}),
		})),
		decks: s.decks.map(({ source: _source, ...d }) => d),
		visuals: s.visuals.map(({ artifact, spec: _spec, ...v }) => ({ ...v, artifactId: artifact.artifactId })),
	};
}

function courseBuilderCourseAgentView(host: CourseBuilderHost, sessionId: string) {
	const view = courseBuilderView(host, sessionId);
	if (!view) return null;
	const { assignments, ...course } = view;
	return {
		...course,
		assignmentSummary: {
			count: assignments.length,
			statuses: assignments.reduce<Record<string, number>>((counts, assignment) => {
				counts[assignment.status] = (counts[assignment.status] ?? 0) + 1;
				return counts;
			}, {}),
		},
	};
}
/** This is the entire model mutation surface. Approval/acceptance are intentionally absent. */
export async function runCourseBuilderCommand(
	host: CourseBuilderHost,
	sessionId: string,
	command: CourseBuilderCommand,
	options: {
		trustedTex?: boolean;
		assertActive?: () => void | Promise<void>;
		readLinkedMaterial?: (material: ReturnType<CourseBuilderHost["getMaterial"]>) => Promise<string>;
		readAttachment?: (id: string) => Promise<string>;
	} = {},
): Promise<unknown> {
	if (!COURSE_BUILDER_ACTIONS.some((a) => a === command.action))
		throw new CourseBuilderError("ACTION_FORBIDDEN", "This action is not available to the agent");
	await options.assertActive?.();
	const state = host.getSnapshotForSession(sessionId);
	if (command.action === "state") {
		if (!state) return null;
		const assignmentId = host.getAgentAssignmentScope(sessionId);
		if (assignmentId !== null)
			throw new CourseBuilderError(
				"MATERIAL_SCOPE_MISMATCH",
				`This Agent turn is scoped to Assignment ${assignmentId}; call assignment_state with that assignmentId`,
			);
		return courseBuilderCourseAgentView(host, sessionId);
	}
	if (!state)
		throw new CourseBuilderError(
			"PROJECT_BINDING_REQUIRED",
			"Create and bind a project in the Course Builder workspace first",
		);
	const activeAssignmentId = host.getAgentAssignmentScope(sessionId);
	if (command.action === "read_attachment") {
		if (!options.readAttachment)
			throw new CourseBuilderError("ATTACHMENT_READER_REQUIRED", "Chat attachment reader unavailable");
		const id = required(command.id);
		return { ...excerpt(await options.readAttachment(id), command), attachmentId: id, untrusted: true };
	}
	const assignmentAction = new Set(["assignment_state", "read_assignment_material", "save_assignment"]).has(
		command.action,
	);
	if (assignmentAction) {
		const requestedAssignmentId = required(command.assignmentId);
		if (activeAssignmentId !== requestedAssignmentId)
			throw new CourseBuilderError(
				"MATERIAL_SCOPE_MISMATCH",
				activeAssignmentId === null
					? "This Agent turn is scoped to the course planning chain, not an Assignment"
					: `This Agent turn is scoped to Assignment ${activeAssignmentId}, not ${requestedAssignmentId}`,
			);
	} else if (activeAssignmentId !== null) {
		throw new CourseBuilderError(
			"MATERIAL_SCOPE_MISMATCH",
			`This Agent turn is scoped to Assignment ${activeAssignmentId}; course planning actions are unavailable`,
		);
	}
	switch (command.action) {
		case "read_checkpoints":
			return {
				...excerpt(JSON.stringify(host.listCoverageCheckpoints(sessionId)), command),
				format: "json",
				untrusted: true,
			};
		case "save_checkpoint":
			return host.saveCoverageCheckpoint(sessionId, command.draft, revision(command.expectedRevision));
		case "assignment_state": {
			const assignmentId = required(command.assignmentId);
			const assignment = courseBuilderView(host, sessionId)?.assignments.find(
				(item) => item.assignmentId === assignmentId,
			);
			if (!assignment) throw new CourseBuilderError("ASSIGNMENT_NOT_FOUND", "Assignment is unavailable");
			return { project: { projectId: state.project.projectId, title: state.project.title }, assignment };
		}
		case "visual_templates":
			return courseBuilderVisualTemplates(state.project.projectId);
		case "read_material": {
			const m = host.getMaterial(sessionId, required(command.id));
			if (m.metadata.materialScope === "assignment")
				throw new CourseBuilderError(
					"MATERIAL_SCOPE_MISMATCH",
					"Use read_assignment_material with the owning assignmentId for Assignment materials",
				);
			const source =
				m.metadata.storage === "local-link"
					? await (options.readLinkedMaterial?.(m) ??
							Promise.reject(
								new CourseBuilderError("LINKED_READER_REQUIRED", "Local linked material reader is unavailable"),
							))
					: m.extractedText;
			return {
				...excerpt(source, command),
				materialId: m.materialId,
				sourceHash: m.sourceHash,
				untrusted: true,
			};
		}
		case "read_assignment_material": {
			const assignmentId = required(command.assignmentId);
			const assignment = host.getAssignment(sessionId, assignmentId);
			const m = host.getMaterial(sessionId, required(command.id));
			if (m.metadata.assignmentId !== assignmentId || !assignment.materialIds.includes(m.materialId))
				throw new CourseBuilderError(
					"MATERIAL_SCOPE_MISMATCH",
					"The requested material does not belong to this Assignment",
				);
			const source =
				m.metadata.storage === "local-link"
					? await (options.readLinkedMaterial?.(m) ??
							Promise.reject(
								new CourseBuilderError("LINKED_READER_REQUIRED", "Local linked material reader is unavailable"),
							))
					: m.extractedText;
			return {
				...excerpt(source, command),
				assignmentId,
				materialId: m.materialId,
				sourceHash: m.sourceHash,
				untrusted: true,
			};
		}
		case "read_deck": {
			const d = state.decks.find((d) => d.deckId === required(command.id));
			if (!d) throw new CourseBuilderError("DECK_NOT_FOUND", "No deck in this project");
			return { ...excerpt(d.source, command), deckId: d.deckId, revision: d.revision, sourceHash: d.sourceHash };
		}
		case "read_compile_log": {
			const receiptId = required(command.id);
			const log = host.getCompileLog(sessionId, receiptId);
			const receipt = state.compileReceipts.find((item) => item.receiptId === receiptId);
			if (!receipt)
				throw new CourseBuilderError("COMPILE_RECEIPT_NOT_FOUND", "Compile log unavailable in this project");
			return {
				...excerpt(log, command),
				receiptId,
				deckId: receipt.deckId,
				deckRevision: receipt.deckRevision,
				sourceHash: receipt.sourceHash,
				logHash: receipt.logHash,
				untrusted: true,
			};
		}
		case "save_analysis":
			return host.saveMaterialAnalysis(sessionId, command.draft);
		case "save_assignment":
			return host.saveAssignmentDraft(
				sessionId,
				required(command.assignmentId),
				command.draft,
				revision(command.expectedRevision),
			);
		case "save_semester":
			return host.saveSemesterPlan(sessionId, command.draft, revision(command.expectedRevision));
		case "save_lesson":
			return host.saveLessonPlan(
				sessionId,
				command.draft,
				revision(command.expectedRevision),
				revision(command.parentRevision),
			);
		case "save_deck": {
			const { source: _source, ...d } = host.saveBeamerDeck(
				sessionId,
				command.draft,
				revision(command.expectedRevision),
				revision(command.parentRevision),
			);
			return d;
		}
		case "patch_deck": {
			const deck = state.decks.find((item) => item.deckId === required(command.id));
			if (!deck) throw new CourseBuilderError("DECK_NOT_FOUND", "No deck in this project");
			if (deck.revision !== revision(command.expectedRevision))
				throw new CourseBuilderError("REVISION_CONFLICT", "Read the current deck before patching");
			const draft = command.draft as { edits?: unknown } | null;
			if (
				!draft ||
				Object.keys(draft).some((key) => key !== "edits") ||
				!Array.isArray(draft.edits) ||
				draft.edits.length < 1 ||
				draft.edits.length > 100
			)
				throw new CourseBuilderError(
					"INVALID_PATCH",
					"Supply draftJson: {edits:[{oldText,newText}]} with 1..100 exact replacements",
				);
			let source = deck.source;
			for (const raw of draft.edits) {
				const edit = raw as { oldText?: unknown; newText?: unknown } | null;
				if (
					!edit ||
					Object.keys(edit).some((key) => key !== "oldText" && key !== "newText") ||
					typeof edit.oldText !== "string" ||
					!edit.oldText ||
					typeof edit.newText !== "string"
				)
					throw new CourseBuilderError("INVALID_PATCH", "Each edit needs nonempty oldText and string newText");
				const index = source.indexOf(edit.oldText);
				if (index < 0 || source.indexOf(edit.oldText, index + 1) >= 0)
					throw new CourseBuilderError(
						"PATCH_MATCH_REQUIRED",
						"oldText must match exactly once; read_deck for more context. No changes saved.",
					);
				source = source.slice(0, index) + edit.newText + source.slice(index + edit.oldText.length);
			}
			const { source: _source, ...saved } = host.saveBeamerDeck(
				sessionId,
				{
					lessonPlanId: deck.lessonPlanId,
					title: deck.title,
					source,
					frameOutline: deck.frameOutline,
					assetMaterialIds: deck.assetMaterialIds,
				},
				deck.revision,
				revision(command.parentRevision),
			);
			return { ...saved, appliedEdits: draft.edits.length };
		}
		case "compile": {
			if (!options.trustedTex)
				throw new CourseBuilderError(
					"TEX_TRUST_REQUIRED",
					"Compiler disabled. The local owner must set PI_COURSE_BUILDER_TRUSTED_TEX=1 for trusted source. This is NOT an OS sandbox.",
				);
			const input = host.getDeckForCompile(sessionId, required(command.id));
			if (input.deck.revision !== revision(command.expectedRevision))
				throw new CourseBuilderError("REVISION_CONFLICT", "Deck changed before compilation");
			const result = await compileBeamerDeck(input);
			await options.assertActive?.();
			const receipt = host.recordCompile(sessionId, result.receipt, result.artifact, result.log);
			return {
				...receipt,
				logExcerpt: receipt.succeeded
					? null
					: {
							...excerpt(result.log, {
								action: "read_compile_log",
								offset: Math.max(0, result.log.length - 6000),
							}),
							untrusted: true,
						},
				nextAction: receipt.succeeded
					? "review_deck"
					: "Read diagnostics and read_compile_log with id=receiptId (offset/limit pagination), then read_deck, repair the source with patch_deck exact replacements and compile the new revision. An error without a line number still requires inspecting the log and source. A partial PDF is not success.",
			};
		}
		case "review_deck": {
			const input = host.getDeckForCompile(sessionId, required(command.id));
			const compileReceipt = state.compileReceipts
				.filter((r) => r.deckId === input.deck.deckId && r.deckRevision === input.deck.revision)
				.at(-1);
			return host.recordDeckReview(sessionId, reviewBeamerDeck({ ...input, compileReceipt }));
		}
		case "visual":
			return host.createVisual(
				sessionId,
				required(command.id),
				command.spec,
				typeof command.purpose === "string" ? command.purpose : "",
			);
	}
}
