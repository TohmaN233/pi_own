import { stableStringify } from "./canonical.ts";

export interface RevisionedRecord {
	id: string;
	revision: number;
}

export class RevisionConflictError extends Error {
	readonly id: string;
	readonly expectedRevision: number | null;
	readonly actualRevision: number | null;

	constructor(id: string, expectedRevision: number | null, actualRevision: number | null) {
		super(`Revision conflict for ${id}: expected ${String(expectedRevision)}, actual ${String(actualRevision)}`);
		this.name = "RevisionConflictError";
		this.id = id;
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

interface IdempotentResult<T> {
	fingerprint: string;
	value: T;
}

export class RevisionStore<T extends RevisionedRecord> {
	private readonly records = new Map<string, T>();
	private readonly idempotency = new Map<string, IdempotentResult<T>>();

	get(id: string): T | undefined {
		return this.records.get(id);
	}

	list(): T[] {
		return [...this.records.values()];
	}

	commit(next: T, expectedRevision: number | null, idempotencyKey: string): T {
		if (!idempotencyKey) throw new TypeError("idempotencyKey is required");
		const fingerprint = stableStringify({ next, expectedRevision });
		const replay = this.idempotency.get(idempotencyKey);
		if (replay) {
			if (replay.fingerprint !== fingerprint) throw new Error(`Idempotency key ${idempotencyKey} was reused`);
			return replay.value;
		}

		const current = this.records.get(next.id);
		const actualRevision = current?.revision ?? null;
		if (actualRevision !== expectedRevision) throw new RevisionConflictError(next.id, expectedRevision, actualRevision);
		const requiredRevision = current ? current.revision + 1 : 1;
		if (next.revision !== requiredRevision) {
			throw new RevisionConflictError(next.id, requiredRevision, next.revision);
		}
		this.records.set(next.id, next);
		this.idempotency.set(idempotencyKey, { fingerprint, value: next });
		return next;
	}
}
