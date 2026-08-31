export interface GroundedMarkdownCitation {
	spanId: string;
	label?: string;
}

export interface GroundedMarkdownClaim {
	text: string;
	reason: string;
	scope: "source" | "derived" | "external" | "unsupported";
	citations: GroundedMarkdownCitation[];
}

/**
 * Canonical user-visible rendering for grounded claims.
 *
 * `reason` is deliberately rendered for every claim. It is part of the public
 * answer contract: source claims explain relevance, derived claims expose the
 * derivation, and external/unsupported claims explain the boundary. This
 * function accepts no private assessment payloads.
 */
export function groundedClaimsToMarkdown(claims: readonly GroundedMarkdownClaim[]): string {
	if (claims.length === 0) throw new Error("At least one grounded claim is required");
	return claims
		.map((claim) => {
			const citations = claim.citations
				.map((citation) => `[${citation.label?.trim() || citation.spanId}](harness-span:${encodeURIComponent(citation.spanId)})`)
				.join(" ");
			return [
				claim.text.trim(),
				`**理由：** ${claim.reason.trim()}`,
				citations ? `**依据：** ${citations}` : "",
				`**范围：** ${claim.scope}`,
			]
				.filter(Boolean)
				.join("\n\n");
		})
		.join("\n\n---\n\n");
}
