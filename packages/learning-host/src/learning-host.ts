import {
	type ConceptMastery,
	HARNESS_CONTRACT_VERSION,
	LEARNING_EVENT_KINDS,
	type LearningEvent,
	type LearningEventKind,
	type MasteryProjection,
	type SessionBinding,
} from "../../harness-contracts/src/index.ts";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";

export class LearningHostError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "LearningHostError";
		this.code = code;
	}
}

interface TimelineState {
	courseVersionId: string;
	events: LearningEvent[];
	idempotency: Map<string, string>;
}

export interface LearningHostState {
	version: 1;
	events: LearningEvent[];
}

const WEIGHTS: Readonly<Record<LearningEventKind, number>> = {
	introduced: 0.08,
	explained: 0.1,
	practiced: 0.12,
	"answered-correct": 0.22,
	"answered-incorrect": -0.08,
	reviewed: 0.1,
	reflection: 0.06,
	visualized: 0.08,
	"answer-published": 0,
};

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function validateEvent(event: LearningEvent): void {
	if (event.version !== HARNESS_CONTRACT_VERSION)
		throw new LearningHostError("UNSUPPORTED_VERSION", "Unsupported learning event version");
	if (!event.eventId || !event.timelineId || !event.courseVersionId || !event.sessionBindingId || !event.conceptId) {
		throw new LearningHostError("INVALID_EVENT", "Learning event identity fields are required");
	}
	if (!LEARNING_EVENT_KINDS.includes(event.kind))
		throw new LearningHostError("INVALID_EVENT", `Unknown learning event kind ${event.kind}`);
	if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
		throw new LearningHostError("INVALID_EVENT", "Learning event sequence must be positive");
	if (!Number.isFinite(Date.parse(event.createdAt)))
		throw new LearningHostError("INVALID_EVENT", "Learning event timestamp must be ISO-8601");
	if (!event.idempotencyKey) throw new LearningHostError("INVALID_EVENT", "Learning event idempotencyKey is required");
}

function emptyMastery(conceptId: string, at: string): ConceptMastery {
	return { conceptId, score: 0, exposures: 0, correct: 0, incorrect: 0, lastEventAt: at };
}

export class LearningHost {
	private readonly timelines = new Map<string, TimelineState>();

	record(event: LearningEvent, binding: SessionBinding): LearningEvent {
		validateEvent(event);
		if (binding.bindingId !== event.sessionBindingId)
			throw new LearningHostError("BINDING_MISMATCH", "Learning event targets another session binding");
		if (binding.courseVersionId !== event.courseVersionId)
			throw new LearningHostError("COURSE_MISMATCH", "Learning event targets another course version");
		let timeline = this.timelines.get(event.timelineId);
		if (!timeline) {
			timeline = { courseVersionId: event.courseVersionId, events: [], idempotency: new Map() };
			this.timelines.set(event.timelineId, timeline);
		}
		if (timeline.courseVersionId !== event.courseVersionId)
			throw new LearningHostError("COURSE_REBIND_FORBIDDEN", "Timeline cannot move to another course version");
		const fingerprint = stableStringify(event);
		const existingFingerprint = timeline.idempotency.get(event.idempotencyKey);
		if (existingFingerprint) {
			if (existingFingerprint !== fingerprint)
				throw new LearningHostError("IDEMPOTENCY_REUSE", "Learning event idempotency key was reused");
			return timeline.events.find((item) => item.idempotencyKey === event.idempotencyKey) as LearningEvent;
		}
		const expectedSequence = timeline.events.length + 1;
		if (event.sequence !== expectedSequence) {
			throw new LearningHostError(
				"SEQUENCE_MISMATCH",
				`Expected learning event sequence ${expectedSequence}, got ${event.sequence}`,
			);
		}
		if (timeline.events.some((item) => item.eventId === event.eventId))
			throw new LearningHostError("DUPLICATE_EVENT", `Duplicate learning event ID ${event.eventId}`);
		timeline.events.push(Object.freeze({ ...event }));
		timeline.idempotency.set(event.idempotencyKey, fingerprint);
		return event;
	}

	getEvents(timelineId: string): LearningEvent[] {
		return [...(this.timelines.get(timelineId)?.events ?? [])];
	}

	exportState(): LearningHostState {
		const events = [...this.timelines.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([, timeline]) => timeline.events);
		return { version: 1, events };
	}

	restoreState(state: LearningHostState): void {
		if (!state || state.version !== 1 || !Array.isArray(state.events))
			throw new LearningHostError("INVALID_STATE", "Invalid LearningHost state");
		if (this.timelines.size > 0)
			throw new LearningHostError("STATE_NOT_EMPTY", "LearningHost restore requires an empty host");
		for (const event of state.events) {
			const binding = {
				version: HARNESS_CONTRACT_VERSION,
				bindingId: event.sessionBindingId,
				sessionId: "restored-session",
				courseVersionId: event.courseVersionId,
				resourceSnapshotId: "restored-snapshot",
				role: "student" as const,
				createdAt: event.createdAt,
				revision: 1,
			};
			this.record(event, binding);
		}
	}

	replaceState(state: LearningHostState): void {
		this.timelines.clear();
		this.restoreState(state);
	}

	rebuildProjection(timelineId: string): MasteryProjection {
		const timeline = this.timelines.get(timelineId);
		if (!timeline) throw new LearningHostError("UNKNOWN_TIMELINE", `Unknown timeline ${timelineId}`);
		const concepts: Record<string, ConceptMastery> = {};
		for (const event of timeline.events) {
			if (event.kind === "answer-published") continue;
			const previous = concepts[event.conceptId] ?? emptyMastery(event.conceptId, event.createdAt);
			const next: ConceptMastery = {
				conceptId: event.conceptId,
				score: Number(clamp(previous.score + WEIGHTS[event.kind]).toFixed(6)),
				exposures: previous.exposures + 1,
				correct: previous.correct + (event.kind === "answered-correct" ? 1 : 0),
				incorrect: previous.incorrect + (event.kind === "answered-incorrect" ? 1 : 0),
				lastEventAt: event.createdAt,
			};
			concepts[event.conceptId] = next;
		}
		const identity = {
			timelineId,
			courseVersionId: timeline.courseVersionId,
			revision: timeline.events.length,
			concepts,
		};
		return Object.freeze({ ...identity, contentHash: contentHash(identity) });
	}

	suggestReviewItems(timelineId: string, limit = 5): ConceptMastery[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new LearningHostError("INVALID_LIMIT", "limit must be 1..100");
		const projection = this.rebuildProjection(timelineId);
		return Object.values(projection.concepts)
			.sort(
				(left, right) =>
					left.score - right.score ||
					left.lastEventAt.localeCompare(right.lastEventAt) ||
					left.conceptId.localeCompare(right.conceptId),
			)
			.slice(0, limit);
	}
}
