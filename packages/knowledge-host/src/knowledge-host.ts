import { type CourseHost, CourseHostError } from "../../course-host/src/index.ts";
import {
	type AnswerDraft,
	type GroundingPacket,
	type GroundingSpan,
	HARNESS_CONTRACT_VERSION,
	type PublicationReceipt,
	parseAnswerDraft,
	type ResourceSnapshot,
	type SessionBinding,
	type SourceSpan,
	type ValidatorIssue,
	type ValidatorResult,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId, sha256Hex } from "../../harness-core/src/index.ts";

export class KnowledgeHostError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "KnowledgeHostError";
		this.code = code;
	}
}

interface IndexedSpan {
	span: SourceSpan;
	terms: string[];
	termCounts: Map<string, number>;
}

interface CourseIndex {
	courseVersionId: string;
	spans: IndexedSpan[];
	documentFrequency: Map<string, number>;
	averageLength: number;
}

export interface GroundingRequest {
	binding: SessionBinding;
	snapshot: ResourceSnapshot;
	query: string;
	maxHits?: number;
	maxCharacters?: number;
	createdAt?: string;
}

export interface DraftValidationContext {
	binding: SessionBinding;
	snapshot: ResourceSnapshot;
}

function tokenize(text: string): string[] {
	return (
		text
			.normalize("NFKC")
			.toLocaleLowerCase("und")
			.match(/[\p{L}\p{N}_]+/gu)
			?.filter((term) => term.length > 1) ?? []
	);
}

function buildIndex(spans: readonly SourceSpan[]): CourseIndex {
	const indexed: IndexedSpan[] = [];
	const documentFrequency = new Map<string, number>();
	let totalLength = 0;
	for (const span of spans) {
		const terms = tokenize(`${span.headingPath.join(" ")} ${span.text}`);
		const termCounts = new Map<string, number>();
		for (const term of terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
		for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		indexed.push({ span, terms, termCounts });
		totalLength += Math.max(1, terms.length);
	}
	return {
		courseVersionId: spans[0]?.courseVersionId ?? "",
		spans: indexed,
		documentFrequency,
		averageLength: indexed.length > 0 ? totalLength / indexed.length : 1,
	};
}

function bm25(index: CourseIndex, item: IndexedSpan, queryTerms: readonly string[]): number {
	const unique = [...new Set(queryTerms)];
	const n = index.spans.length;
	const k1 = 1.2;
	const b = 0.75;
	let score = 0;
	for (const term of unique) {
		const tf = item.termCounts.get(term) ?? 0;
		if (tf === 0) continue;
		const df = index.documentFrequency.get(term) ?? 0;
		const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
		const lengthNorm = 1 - b + b * (Math.max(1, item.terms.length) / index.averageLength);
		score += idf * ((tf * (k1 + 1)) / (tf + k1 * lengthNorm));
	}
	return score;
}

function assertTimestamp(value: string): void {
	if (!Number.isFinite(Date.parse(value)))
		throw new KnowledgeHostError("INVALID_TIMESTAMP", "Expected ISO-8601 timestamp");
}

function issue(code: string, message: string, path: string | null = null): ValidatorIssue {
	return { code, severity: "error", message, path };
}

function invalidDraftResult(error: unknown, checkedAt: string): ValidatorResult {
	return {
		version: HARNESS_CONTRACT_VERSION,
		validatorId: "grounded-publication-v1",
		status: "fail",
		subject: { kind: "answer-draft", id: "invalid-answer-draft", revision: 1 },
		checkedAt,
		issues: [issue("INVALID_DRAFT", error instanceof Error ? error.message : String(error))],
	};
}

export interface KnowledgeHostState {
	version: 1;
	packets: GroundingPacket[];
	publications: Array<{ draft: AnswerDraft; receipt: PublicationReceipt }>;
}

export class KnowledgeHost {
	private readonly courseHost: CourseHost;
	private readonly indexes = new Map<string, CourseIndex>();
	private readonly packets = new Map<string, GroundingPacket>();
	private readonly drafts = new Map<string, AnswerDraft>();
	private readonly receipts = new Map<string, PublicationReceipt>();

	constructor(courseHost: CourseHost) {
		this.courseHost = courseHost;
	}

	private draftKey(draftId: string, revision: number): string {
		return `${draftId}@${revision}`;
	}

	registerCourseVersion(courseVersionId: string): void {
		const version = this.courseHost.getVersion(courseVersionId);
		this.indexes.set(courseVersionId, buildIndex(version.spans));
	}

	search(request: GroundingRequest): GroundingPacket {
		const query = request.query.trim();
		if (!query) throw new KnowledgeHostError("EMPTY_QUERY", "Grounding query cannot be empty");
		const courseVersionId = request.binding.courseVersionId;
		if (!courseVersionId)
			throw new KnowledgeHostError("COURSE_REQUIRED", "Grounded search requires a course-bound session");
		this.courseHost.assertBoundAccess(request.binding, request.snapshot, courseVersionId);
		const index = this.indexes.get(courseVersionId);
		if (!index) throw new KnowledgeHostError("INDEX_NOT_READY", `Course version ${courseVersionId} is not indexed`);
		const maxHits = request.maxHits ?? 8;
		const maxCharacters = request.maxCharacters ?? 6000;
		if (!Number.isSafeInteger(maxHits) || maxHits < 1 || maxHits > 50)
			throw new KnowledgeHostError("INVALID_LIMIT", "maxHits must be 1..50");
		if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 200 || maxCharacters > 50000) {
			throw new KnowledgeHostError("INVALID_LIMIT", "maxCharacters must be 200..50000");
		}
		const queryTerms = tokenize(query);
		const ranked = index.spans
			.map((item) => ({ item, score: bm25(index, item, queryTerms) }))
			.filter((entry) => entry.score > 0)
			.sort(
				(left, right) => right.score - left.score || left.item.span.spanId.localeCompare(right.item.span.spanId),
			);
		const spans: GroundingSpan[] = [];
		let used = 0;
		for (const { item, score } of ranked) {
			if (spans.length >= maxHits) break;
			if (used + item.span.text.length > maxCharacters && spans.length > 0) continue;
			const matchedTerms = [...new Set(queryTerms.filter((term) => item.termCounts.has(term)))].sort();
			spans.push({
				spanId: item.span.spanId,
				materialId: item.span.materialId,
				startLine: item.span.startLine,
				endLine: item.span.endLine,
				text: item.span.text,
				textHash: item.span.textHash,
				score: Number(score.toFixed(8)),
				matchedTerms,
			});
			used += item.span.text.length;
		}
		const createdAt = request.createdAt ?? new Date().toISOString();
		assertTimestamp(createdAt);
		const identity = {
			sessionBindingId: request.binding.bindingId,
			resourceSnapshotId: request.snapshot.resourceSnapshotId,
			courseVersionId,
			query,
			queryHash: `sha256:${sha256Hex(query)}`,
			spans: spans.map((span) => ({ spanId: span.spanId, textHash: span.textHash, score: span.score })),
		};
		const packet: GroundingPacket = Object.freeze({
			version: HARNESS_CONTRACT_VERSION,
			packetId: deterministicId("grounding", identity, 32),
			sessionBindingId: request.binding.bindingId,
			resourceSnapshotId: request.snapshot.resourceSnapshotId,
			courseVersionId,
			query,
			queryHash: identity.queryHash,
			createdAt,
			spans,
			contentHash: contentHash(identity),
		});
		const existing = this.packets.get(packet.packetId);
		if (existing) {
			if (existing.contentHash !== packet.contentHash)
				throw new KnowledgeHostError("PACKET_COLLISION", "Grounding packet identity collision");
			return existing;
		}
		this.packets.set(packet.packetId, packet);
		return packet;
	}

	readSpan(context: DraftValidationContext, spanId: string): SourceSpan {
		const courseVersionId = context.binding.courseVersionId;
		if (!courseVersionId) throw new KnowledgeHostError("COURSE_REQUIRED", "Current session has no course");
		this.courseHost.assertBoundAccess(context.binding, context.snapshot, courseVersionId);
		return this.courseHost.readSpan(courseVersionId, spanId);
	}

	validateDraft(
		draftValue: unknown,
		context: DraftValidationContext,
		checkedAt = new Date().toISOString(),
	): ValidatorResult {
		assertTimestamp(checkedAt);
		let draft: AnswerDraft;
		try {
			draft = parseAnswerDraft(draftValue);
		} catch (error) {
			return invalidDraftResult(error, checkedAt);
		}
		const issues: ValidatorIssue[] = [];
		if (draft.claims.length === 0)
			issues.push(issue("CLAIMS_REQUIRED", "Answer draft must contain at least one claim", "claims"));
		const packet = this.packets.get(draft.packetId);
		if (!packet)
			issues.push(
				issue("UNKNOWN_PACKET", "Draft references a packet that was not issued by Knowledge Host", "packetId"),
			);
		const courseVersionId = context.binding.courseVersionId;
		try {
			if (!courseVersionId) throw new KnowledgeHostError("COURSE_REQUIRED", "Grounded answer requires a course");
			this.courseHost.assertBoundAccess(context.binding, context.snapshot, courseVersionId);
		} catch (error) {
			issues.push(issue("BINDING_MISMATCH", error instanceof Error ? error.message : String(error)));
		}
		if (draft.courseVersionId !== courseVersionId)
			issues.push(issue("COURSE_VERSION_MISMATCH", "Draft targets another course version", "courseVersionId"));
		if (packet) {
			if (packet.courseVersionId !== courseVersionId)
				issues.push(issue("PACKET_COURSE_MISMATCH", "Packet targets another course version", "packetId"));
			if (packet.sessionBindingId !== context.binding.bindingId)
				issues.push(issue("PACKET_SESSION_MISMATCH", "Packet belongs to another session binding", "packetId"));
			if (packet.resourceSnapshotId !== context.snapshot.resourceSnapshotId)
				issues.push(issue("PACKET_SNAPSHOT_MISMATCH", "Packet belongs to another resource snapshot", "packetId"));
		}
		const packetSpans = new Map(packet?.spans.map((span) => [span.spanId, span]) ?? []);
		const claimIds = new Set<string>();
		for (const [index, claim] of draft.claims.entries()) {
			const path = `claims[${index}]`;
			if (claimIds.has(claim.claimId))
				issues.push(issue("DUPLICATE_CLAIM_ID", "Claim IDs must be unique", `${path}.claimId`));
			claimIds.add(claim.claimId);
			if (claim.scope === "direct" && claim.citationSpanIds.length < 1)
				issues.push(issue("CITATION_REQUIRED", "Direct claims need a course citation", path));
			if (claim.scope === "synthesis" && claim.citationSpanIds.length < 2)
				issues.push(issue("MULTI_CITATION_REQUIRED", "Synthesis claims need at least two course citations", path));
			if (claim.scope === "derived" && (claim.citationSpanIds.length < 1 || !claim.reason?.trim())) {
				issues.push(
					issue("DERIVATION_REQUIRED", "Derived claims need source premises and a derivation reason", path),
				);
			}
			if (claim.scope === "computed" && !claim.reason?.trim())
				issues.push(issue("COMPUTATION_REASON_REQUIRED", "Computed claims need a computation description", path));
			if (claim.scope === "external") {
				if (context.snapshot.externalKnowledgePolicy === "deny")
					issues.push(issue("EXTERNAL_KNOWLEDGE_DENIED", "Active profile denies external knowledge", path));
				if (!claim.reason?.trim())
					issues.push(
						issue("EXTERNAL_REASON_REQUIRED", "External claims need a reason and source guidance", path),
					);
			}
			if (claim.scope === "insufficient" && !claim.reason?.trim())
				issues.push(
					issue("INSUFFICIENT_REASON_REQUIRED", "Insufficient-evidence claims need an explanation", path),
				);
			for (const spanId of new Set(claim.citationSpanIds)) {
				const cited = packetSpans.get(spanId);
				if (!cited) {
					issues.push(
						issue(
							"FORGED_CITATION",
							`Citation ${spanId} is not in the issued Grounding Packet`,
							`${path}.citationSpanIds`,
						),
					);
					continue;
				}
				try {
					const current = this.courseHost.readSpan(packet?.courseVersionId ?? "", spanId);
					if (current.textHash !== cited.textHash)
						issues.push(
							issue(
								"STALE_CITATION",
								`Citation ${spanId} no longer matches source content`,
								`${path}.citationSpanIds`,
							),
						);
				} catch (error) {
					const message = error instanceof CourseHostError ? error.message : String(error);
					issues.push(issue("INVALID_CITATION", message, `${path}.citationSpanIds`));
				}
			}
		}
		return {
			version: HARNESS_CONTRACT_VERSION,
			validatorId: "grounded-publication-v1",
			status: issues.length === 0 ? "pass" : "fail",
			subject: { kind: "answer-draft", id: draft.draftId, revision: draft.revision },
			checkedAt,
			issues,
		};
	}

	publishDraft(
		draftValue: unknown,
		context: DraftValidationContext,
		publishedAt = new Date().toISOString(),
	): PublicationReceipt {
		let draft: AnswerDraft;
		try {
			draft = parseAnswerDraft(draftValue);
		} catch (error) {
			throw new KnowledgeHostError("PUBLICATION_REJECTED", error instanceof Error ? error.message : String(error));
		}
		const existingDraft = this.drafts.get(this.draftKey(draft.draftId, draft.revision));
		if (existingDraft) {
			if (contentHash(existingDraft) !== contentHash(draft)) {
				throw new KnowledgeHostError(
					"DRAFT_REVISION_REUSE",
					`Draft ${draft.draftId}@${draft.revision} was already published with different content`,
				);
			}
			const existingReceipt = [...this.receipts.values()].find(
				(receipt) => receipt.draftId === draft.draftId && receipt.draftRevision === draft.revision,
			);
			if (!existingReceipt)
				throw new KnowledgeHostError(
					"CORRUPT_STATE",
					`Published draft ${draft.draftId}@${draft.revision} has no receipt`,
				);
			return existingReceipt;
		}
		const validation = this.validateDraft(draft, context, publishedAt);
		if (validation.status !== "pass") {
			throw new KnowledgeHostError("PUBLICATION_REJECTED", validation.issues.map((item) => item.message).join("; "));
		}
		const packet = this.packets.get(draft.packetId);
		if (!packet) throw new KnowledgeHostError("UNKNOWN_PACKET", "Grounding packet disappeared before publication");
		const identity = {
			draftId: draft.draftId,
			draftRevision: draft.revision,
			packetId: packet.packetId,
			courseVersionId: draft.courseVersionId,
			claims: draft.claims,
		};
		const receipt: PublicationReceipt = Object.freeze({
			receiptId: deterministicId("publication", identity, 32),
			draftId: draft.draftId,
			draftRevision: draft.revision,
			packetId: packet.packetId,
			courseVersionId: draft.courseVersionId,
			publishedAt,
			contentHash: contentHash(identity),
		});
		const existing = this.receipts.get(receipt.receiptId);
		if (existing) return existing;
		this.drafts.set(
			this.draftKey(draft.draftId, draft.revision),
			Object.freeze({
				...draft,
				claims: draft.claims.map((claim) => ({ ...claim, citationSpanIds: [...claim.citationSpanIds] })),
			}),
		);
		this.receipts.set(receipt.receiptId, receipt);
		return receipt;
	}

	getPacket(packetId: string): GroundingPacket | undefined {
		return this.packets.get(packetId);
	}

	exportState(): KnowledgeHostState {
		return {
			version: 1,
			packets: [...this.packets.values()].sort((left, right) => left.packetId.localeCompare(right.packetId)),
			publications: [...this.receipts.values()]
				.sort((left, right) => left.receiptId.localeCompare(right.receiptId))
				.map((receipt) => {
					const draft = this.drafts.get(this.draftKey(receipt.draftId, receipt.draftRevision));
					if (!draft)
						throw new KnowledgeHostError(
							"CORRUPT_STATE",
							`Missing draft ${receipt.draftId}@${receipt.draftRevision}`,
						);
					return { draft, receipt };
				}),
		};
	}

	restoreState(state: KnowledgeHostState): void {
		if (!state || state.version !== 1 || !Array.isArray(state.packets) || !Array.isArray(state.publications)) {
			throw new KnowledgeHostError("INVALID_STATE", "Invalid KnowledgeHost state");
		}
		if (this.packets.size || this.receipts.size || this.drafts.size)
			throw new KnowledgeHostError("STATE_NOT_EMPTY", "KnowledgeHost restore requires an empty host");
		const restoredPackets = new Map<string, GroundingPacket>();
		const restoredDrafts = new Map<string, AnswerDraft>();
		const restoredReceipts = new Map<string, PublicationReceipt>();
		for (const packet of state.packets) {
			this.courseHost.getVersion(packet.courseVersionId);
			if (`sha256:${sha256Hex(packet.query)}` !== packet.queryHash)
				throw new KnowledgeHostError("PACKET_HASH_MISMATCH", `Packet ${packet.packetId} has an invalid query hash`);
			for (const span of packet.spans) {
				const current = this.courseHost.readSpan(packet.courseVersionId, span.spanId);
				if (current.textHash !== span.textHash || current.text !== span.text)
					throw new KnowledgeHostError(
						"PACKET_SPAN_MISMATCH",
						`Packet ${packet.packetId} has stale span ${span.spanId}`,
					);
			}
			const identity = {
				sessionBindingId: packet.sessionBindingId,
				resourceSnapshotId: packet.resourceSnapshotId,
				courseVersionId: packet.courseVersionId,
				query: packet.query,
				queryHash: packet.queryHash,
				spans: packet.spans.map((span) => ({ spanId: span.spanId, textHash: span.textHash, score: span.score })),
			};
			if (
				contentHash(identity) !== packet.contentHash ||
				deterministicId("grounding", identity, 32) !== packet.packetId
			) {
				throw new KnowledgeHostError(
					"PACKET_INTEGRITY_FAILURE",
					`Packet ${packet.packetId} failed integrity validation`,
				);
			}
			if (restoredPackets.has(packet.packetId))
				throw new KnowledgeHostError(
					"PACKET_INTEGRITY_FAILURE",
					`Duplicate packet ${packet.packetId} in restored state`,
				);
			restoredPackets.set(
				packet.packetId,
				Object.freeze({
					...packet,
					spans: packet.spans.map((span) => ({ ...span, matchedTerms: [...span.matchedTerms] })),
				}),
			);
		}
		for (const publication of state.publications) {
			const draft = parseAnswerDraft(publication.draft);
			const receipt = publication.receipt;
			assertTimestamp(receipt.publishedAt);
			const packet = restoredPackets.get(draft.packetId);
			if (
				!packet ||
				receipt.packetId !== packet.packetId ||
				receipt.draftId !== draft.draftId ||
				receipt.draftRevision !== draft.revision ||
				receipt.courseVersionId !== draft.courseVersionId
			) {
				throw new KnowledgeHostError(
					"PUBLICATION_INTEGRITY_FAILURE",
					`Publication ${receipt.receiptId} has inconsistent references`,
				);
			}
			const identity = {
				draftId: draft.draftId,
				draftRevision: draft.revision,
				packetId: packet.packetId,
				courseVersionId: draft.courseVersionId,
				claims: draft.claims,
			};
			if (
				contentHash(identity) !== receipt.contentHash ||
				deterministicId("publication", identity, 32) !== receipt.receiptId
			) {
				throw new KnowledgeHostError(
					"PUBLICATION_INTEGRITY_FAILURE",
					`Publication ${receipt.receiptId} failed integrity validation`,
				);
			}
			const draftKey = this.draftKey(draft.draftId, draft.revision);
			const existingDraft = restoredDrafts.get(draftKey);
			if (existingDraft) {
				if (contentHash(existingDraft) !== contentHash(draft))
					throw new KnowledgeHostError(
						"DRAFT_REVISION_REUSE",
						`Draft ${draft.draftId}@${draft.revision} is reused with different content in restored state`,
					);
				throw new KnowledgeHostError(
					"PUBLICATION_INTEGRITY_FAILURE",
					`Duplicate publication for draft ${draft.draftId}@${draft.revision} in restored state`,
				);
			}
			if (restoredReceipts.has(receipt.receiptId))
				throw new KnowledgeHostError(
					"PUBLICATION_INTEGRITY_FAILURE",
					`Duplicate receipt ${receipt.receiptId} in restored state`,
				);
			restoredDrafts.set(
				draftKey,
				Object.freeze({
					...draft,
					claims: draft.claims.map((claim) => ({ ...claim, citationSpanIds: [...claim.citationSpanIds] })),
				}),
			);
			restoredReceipts.set(receipt.receiptId, Object.freeze({ ...receipt }));
		}
		for (const [packetId, packet] of restoredPackets) this.packets.set(packetId, packet);
		for (const [draftKey, draft] of restoredDrafts) this.drafts.set(draftKey, draft);
		for (const [receiptId, receipt] of restoredReceipts) this.receipts.set(receiptId, receipt);
	}

	replaceState(state: KnowledgeHostState): void {
		this.indexes.clear();
		this.packets.clear();
		this.drafts.clear();
		this.receipts.clear();
		this.restoreState(state);
		for (const courseVersionId of this.courseHost.listAllVersions().map((version) => version.courseVersionId)) {
			this.registerCourseVersion(courseVersionId);
		}
	}
}
