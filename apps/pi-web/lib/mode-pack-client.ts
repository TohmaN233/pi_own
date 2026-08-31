export interface ModePackReceiptSummary {
	modePackId: string;
	revision: number;
	contentHash: string;
	effectivePromptHash: string;
	loaded: {
		skills: string[];
		plugins: string[];
		packages: string[];
		tools: string[];
		workflows: string[];
	};
	verifiedAt: string;
}

export interface ActiveModePackBindingSummary {
	bindingId: string;
	sessionId: string;
	revision: number;
	parentSessionId: string | null;
	modePackId: string;
	modePackRevision: number;
	modePackContentHash: string;
	role: string;
	contextKind: string;
	contextBinding: string | null;
	receipt: ModePackReceiptSummary;
	createdAt: string;
	activatedAt: string;
}

export interface ModePackCatalogSummary {
	id: string;
	revision: number;
	title: string;
	description: string;
	contentHash: string;
	builtin: boolean;
	contextKind: string;
}

export interface ModePackSessionStatus {
	sessionId: string;
	managed: boolean;
	active: ActiveModePackBindingSummary | null;
	inferredModePackId: string | null;
	runtime: {
		live: boolean;
		verified: boolean;
		effectivePromptHash: string | null;
		activeTools: string[];
		diagnostic: string | null;
	};
	modePacks: ModePackCatalogSummary[];
}

export interface ModePackActivationResult {
	transition: "warm" | "hard";
	targetSessionId: string;
	bindingRevision: number;
	modePackId: string;
	modePackRevision: number;
	modePackContentHash: string;
	degradedOptional: string[];
	receipt: ModePackReceiptSummary;
}

interface ModePackErrorBody {
	error?: {
		code?: string;
		message?: string;
	};
}

async function modePackRequest<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = (await response.json()) as T & ModePackErrorBody;
	if (!response.ok || body.error) {
		const code = body.error?.code ? `${body.error.code}: ` : "";
		throw new Error(`${code}${body.error?.message ?? `Mode Pack request failed: HTTP ${response.status}`}`);
	}
	return body;
}

export function getModePackSessionStatus(sessionId: string): Promise<ModePackSessionStatus> {
	return modePackRequest(
		`/api/mode-packs/session?sessionId=${encodeURIComponent(sessionId)}`,
		{ cache: "no-store" },
	);
}

export function activateModePackForSession(input: {
	sessionId: string;
	modePackId: string;
	revision: number;
	expectedCurrentModeHash?: string;
}): Promise<ModePackActivationResult> {
	return modePackRequest("/api/mode-packs/session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
}
