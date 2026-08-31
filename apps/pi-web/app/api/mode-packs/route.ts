import {
	customModePackTemplate,
	listModePackCatalog,
	previewModePack,
	publishCustomModePack,
	retireCustomModePack,
	validateCustomModePack,
} from "../../../lib/mode-pack-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 128 * 1024;

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
		const candidate = error as { code?: unknown; message?: unknown };
		return {
			code: typeof candidate.code === "string" ? candidate.code : "MODE_PACK_REQUEST_FAILED",
			message:
				typeof candidate.message === "string" && candidate.message.length <= 1_000
					? candidate.message
					: "The Mode Pack request was rejected.",
		};
	}
	return { code: "MODE_PACK_REQUEST_FAILED", message: "The Mode Pack request was rejected." };
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

async function boundedJson(request: Request): Promise<unknown> {
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
	try {
		return JSON.parse(raw);
	} catch {
		throw Object.assign(new Error("The request body is not valid JSON."), {
			code: "INVALID_JSON",
		});
	}
}

export async function GET(request: Request): Promise<Response> {
	try {
		const url = new URL(request.url);
		const parentId = url.searchParams.get("template") ?? "education-tutor";
		return json({
			modePacks: listModePackCatalog(false),
			template: customModePackTemplate(parentId),
		});
	} catch (error) {
		return json({ error: safeError(error) }, 400);
	}
}

export async function POST(request: Request): Promise<Response> {
	if (!sameOrigin(request)) {
		return json(
			{ error: { code: "CROSS_ORIGIN_REQUEST_REFUSED", message: "Cross-origin Mode Pack writes are refused." } },
			403,
		);
	}
	try {
		const body = await boundedJson(request);
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw Object.assign(new Error("The request body must be an object."), { code: "INVALID_REQUEST" });
		}
		const input = body as Record<string, unknown>;
		switch (input.operation) {
			case "validate":
				return json({ result: validateCustomModePack(input.definition) });
			case "preview":
				return json({ result: previewModePack(input.definition) });
			case "publish":
				return json({ result: publishCustomModePack(input.definition) }, 201);
			case "retire":
				if (typeof input.id !== "string") {
					throw Object.assign(new Error("retire requires an id."), { code: "MODE_PACK_ID_REQUIRED" });
				}
				return json({ result: retireCustomModePack(input.id) });
			default:
				throw Object.assign(new Error("Unknown Mode Pack operation."), { code: "UNKNOWN_OPERATION" });
		}
	} catch (error) {
		const safe = safeError(error);
		const status = safe.code === "REQUEST_BODY_TOO_LARGE" ? 413 : safe.code === "CROSS_ORIGIN_REQUEST_REFUSED" ? 403 : 400;
		return json({ error: safe }, status);
	}
}
