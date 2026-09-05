import { compileBeamerDeck, reviewBeamerDeck } from "./beamer.ts";
import { CourseBuilderError, type CourseBuilderHost } from "./host.ts";

export const COURSE_BUILDER_ACTIONS = [
	"state",
	"read_material",
	"read_deck",
	"save_analysis",
	"save_semester",
	"save_lesson",
	"save_deck",
	"compile",
	"review_deck",
	"visual",
] as const;
export interface CourseBuilderCommand {
	action: string;
	id?: string;
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
export function courseBuilderView(host: CourseBuilderHost, sessionId: string) {
	const s = host.getSnapshotForSession(sessionId);
	if (!s) return null;
	return {
		...s,
		materials: s.materials.map(({ extractedText: _text, metadata: _metadata, ...m }) => m),
		decks: s.decks.map(({ source: _source, ...d }) => d),
		visuals: s.visuals.map(({ artifact, spec: _spec, ...v }) => ({ ...v, artifactId: artifact.artifactId })),
	};
}
/** This is the entire model mutation surface. Approval/acceptance are intentionally absent. */
export async function runCourseBuilderCommand(
	host: CourseBuilderHost,
	sessionId: string,
	command: CourseBuilderCommand,
	options: { trustedTex?: boolean; assertActive?: () => void | Promise<void> } = {},
): Promise<unknown> {
	if (!COURSE_BUILDER_ACTIONS.some((a) => a === command.action))
		throw new CourseBuilderError("ACTION_FORBIDDEN", "This action is not available to the agent");
	await options.assertActive?.();
	const state = host.getSnapshotForSession(sessionId);
	if (command.action === "state") return courseBuilderView(host, sessionId);
	if (!state)
		throw new CourseBuilderError(
			"PROJECT_BINDING_REQUIRED",
			"Create and bind a project in the Course Builder workspace first",
		);
	switch (command.action) {
		case "read_material": {
			const m = host.getMaterial(sessionId, required(command.id));
			return {
				...excerpt(m.extractedText, command),
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
		case "save_analysis":
			return host.saveMaterialAnalysis(sessionId, command.draft);
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
			return host.recordCompile(sessionId, result.receipt, result.artifact, result.log);
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
