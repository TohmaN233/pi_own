import {
	activatePiModePack,
	getPiModePackStatus,
} from "@/lib/mode-pack-pi-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function safeError(error: unknown): { code: string; message: string } {
	if (error && typeof error === "object") {
		const value = error as { code?: unknown; message?: unknown };
		return {
			code: typeof value.code === "string" ? value.code : "MODE_SESSION_REQUEST_FAILED",
			message:
				typeof value.message === "string" && value.message.length <= 1_000
					? value.message
					: "The Mode Pack session request was rejected.",
		};
	}
	return {
		code: "MODE_SESSION_REQUEST_FAILED",
		message: "The Mode Pack session request was rejected.",
	};
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (!origin) return true;
	const host = request.headers.get("host");
	if (!host) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

async function boundedObject(request: Request): Promise<Record<string, unknown>> {
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/json")) {
		throw Object.assign(new Error("Content-Type must be application/json."), {
			code: "JSON_CONTENT_TYPE_REQUIRED",
		});
	}
	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		throw Object.assign(new Error("The Mode Pack request body is too large."), {
			code: "REQUEST_BODY_TOO_LARGE",
		});
	}
	const raw = await request.text();
	if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
		throw Object.assign(new Error("The Mode Pack request body is too large."), {
			code: "REQUEST_BODY_TOO_LARGE",
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw Object.assign(new Error("The request body is not valid JSON."), {
			code: "INVALID_JSON",
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw Object.assign(new Error("The request body must be an object."), {
			code: "INVALID_REQUEST",
		});
	}
	return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw Object.assign(new Error(`${field} is required.`), {
			code: "MODE_SESSION_FIELD_REQUIRED",
		});
	}
	return value;
}

export async function GET(request: Request): Promise<Response> {
	try {
		const sessionId = requiredString(
			new URL(request.url).searchParams.get("sessionId"),
			"sessionId",
		);
		return json(await getPiModePackStatus(sessionId));
	} catch (error) {
		return json({ error: safeError(error) }, 400);
	}
}

export async function POST(request: Request): Promise<Response> {
	if (!sameOrigin(request)) {
		return json(
			{
				error: {
					code: "CROSS_ORIGIN_REQUEST_REFUSED",
					message: "Cross-origin Mode Pack activation is refused.",
				},
			},
			403,
		);
	}
	try {
		const body = await boundedObject(request);
		const sessionId = requiredString(body.sessionId, "sessionId");
		const modePackId = requiredString(body.modePackId, "modePackId");
		let revision: number | undefined;
		if (body.revision !== undefined) {
			if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) {
				throw Object.assign(new Error("revision must be a positive integer."), {
					code: "INVALID_MODE_PACK_REVISION",
				});
			}
			revision = Number(body.revision);
		}
		const expectedCurrentModeHash =
			body.expectedCurrentModeHash === undefined
				? undefined
				: requiredString(body.expectedCurrentModeHash, "expectedCurrentModeHash");
		const contextBinding =
			body.contextBinding === undefined || body.contextBinding === null
				? body.contextBinding
				: requiredString(body.contextBinding, "contextBinding");
		const result = await activatePiModePack({
			sessionId,
			modePackId,
			...(revision !== undefined ? { revision } : {}),
			...(expectedCurrentModeHash ? { expectedCurrentModeHash } : {}),
			...(contextBinding !== undefined ? { contextBinding } : {}),
		});
		if (result.bindingRevision === undefined) {
			throw Object.assign(new Error("Mode Pack activation committed without a binding revision."), {
				code: "MODE_BINDING_REVISION_MISSING",
			});
		}
		return json({
			transition: result.transition,
			targetSessionId: result.targetSessionId,
			bindingRevision: result.bindingRevision,
			modePackId: result.resolved.definition.id,
			modePackRevision: result.resolved.definition.revision,
			modePackContentHash: result.resolved.contentHash,
			degradedOptional: result.resolved.degradedOptional,
			receipt: result.receipt,
		});
	} catch (error) {
		const safe = safeError(error);
		const status =
			safe.code === "REQUEST_BODY_TOO_LARGE"
				? 413
				: safe.code === "CROSS_ORIGIN_REQUEST_REFUSED"
					? 403
					: safe.code === "MODE_SESSION_BUSY" || safe.code === "MODE_TRANSITION_BUSY"
						? 409
						: 400;
		return json({ error: safe }, status);
	}
}
