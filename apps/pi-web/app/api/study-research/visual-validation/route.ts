import type { VisualValidationSpecification } from "../../../../../../packages/study-research-host/src/visual-validation.ts";
import { isStudyBrowserMutation } from "@/lib/study-user-action";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readStudyRequest, studyApiError, studyInteger, studyText } from "@/lib/study-api-request";
import {
	cancelVisualValidationFromUser,
	reconnectVisualValidationsFromUser,
	saveVisualValidationSpecificationFromUser,
	startVisualValidationFromUser,
	visualValidationState,
} from "@/lib/study-visual-validation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, name: string, minimum = 0, maximum = 1_000_000): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
		throw new Error(`Invalid ${name}`);
	return value;
}

function target(value: unknown) {
	const source = object(value, "Visual validation target");
	return {
		visualizationId: studyText(source.visualizationId, "visualizationId", 128),
		visualizationRevision: studyInteger(source.visualizationRevision, "visualizationRevision", 1),
		visualizationHash: studyText(source.visualizationHash, "visualizationHash", 80),
	};
}

/** Transport validation is intentionally shallow; the Harness owns the hostile-specification protocol checks. */
function specification(value: unknown): VisualValidationSpecification {
	const source = object(value, "Visual validation specification");
	if (source.version !== 1) throw new Error("Unsupported visual validation protocol");
	const oracle = object(source.oracle, "Visual validation oracle");
	if (oracle.kind !== "hand-calculation" && oracle.kind !== "independent-reference") throw new Error("Invalid visual validation oracle kind");
	if (!Array.isArray(source.assumptions) || !Array.isArray(source.cases) || !Array.isArray(oracle.sourceReferences))
		throw new Error("Visual validation specification arrays are required");
	const sourceReferences = oracle.sourceReferences.map((item) => {
		const reference = object(item, "Oracle source reference");
		return {
			sourceId: studyText(reference.sourceId, "oracle sourceId", 128),
			sourceHash: studyText(reference.sourceHash, "oracle sourceHash", 80),
			locator: studyText(reference.locator, "oracle locator", 4000),
		};
	});
	const cases = source.cases.map((item): VisualValidationSpecification["cases"][number] => {
		const entry = object(item, "Visual validation case");
		if (entry.category !== "ordinary" && entry.category !== "boundary" && entry.category !== "degenerate" && entry.category !== "interaction")
			throw new Error("Invalid visual validation case category");
		if (!entry.inputs || typeof entry.inputs !== "object" || Array.isArray(entry.inputs) || !Array.isArray(entry.expected))
			throw new Error("Visual validation case inputs and expected checks are required");
		return {
			id: studyText(entry.id, "case ID", 128),
			category: entry.category,
			description: studyText(entry.description, "case description", 4000),
			inputs: entry.inputs as Record<string, unknown>,
			expected: entry.expected.map((check) => {
				const expected = object(check, "Visual expected check");
				if (!Array.isArray(expected.path) || expected.path.length < 1 || expected.path.length > 16)
					throw new Error("Visual expected path is invalid");
				const path = expected.path.map((part) => {
					if (typeof part === "string") return studyText(part, "visual expected path segment", 128);
					return studyInteger(part, "visual expected path index", 0, 4095);
				});
				if (expected.value !== null && typeof expected.value !== "number" && typeof expected.value !== "string" && typeof expected.value !== "boolean")
					throw new Error("Visual expected value must be scalar JSON");
				return {
					path,
					value: expected.value,
					absoluteTolerance: finiteNumber(expected.absoluteTolerance, "absolute tolerance"),
					relativeTolerance: finiteNumber(expected.relativeTolerance, "relative tolerance"),
				};
			}),
		};
	});
	return {
		version: 1,
		targetHash: studyText(source.targetHash, "visualization target hash", 80),
		scope: studyText(source.scope, "validation scope", 6000),
		assumptions: source.assumptions.map((item) => studyText(item, "validation assumption", 4000)),
		oracle: {
			kind: oracle.kind,
			description: studyText(oracle.description, "oracle description", 6000),
			material: studyText(oracle.material, "oracle material", 131072),
			sourceReferences,
		},
		cases,
	};
}

function resources(value: unknown) {
	const source = object(value, "Visual validation resources");
	return {
		cpuMilliCores: studyInteger(source.cpuMilliCores, "cpuMilliCores", 1),
		memoryMiB: studyInteger(source.memoryMiB, "memoryMiB", 1),
		wallTimeMs: studyInteger(source.wallTimeMs, "wallTimeMs", 1),
		diskBytes: studyInteger(source.diskBytes, "diskBytes", 1),
	};
}

export async function GET(request: Request) {
	if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
	try {
		const query = new URL(request.url).searchParams;
		return Response.json(await visualValidationState({
			sessionId: studyText(query.get("sessionId"), "sessionId"),
			visualizationId: studyText(query.get("visualizationId"), "visualizationId", 128),
		}), { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return studyApiError(error);
	}
}

/** This is a browser-only control surface. Renderer messages and Agent tools cannot write canonical results. */
export async function POST(request: Request) {
	if (!isStudyBrowserMutation(request)) return Response.json({ error: "An explicit same-origin browser action is required" }, { status: 403 });
	try {
		const body = await readStudyRequest(request);
		const action = studyText(body.action, "action", 64);
		if (action === "reconnect") return Response.json(await reconnectVisualValidationsFromUser(studyText(body.sessionId, "sessionId")));
		if (action === "cancel") return Response.json(await cancelVisualValidationFromUser({
			sessionId: studyText(body.sessionId, "sessionId"),
			queueJobId: studyText(body.queueJobId, "queueJobId", 128),
		}));
		const shared = {
			sessionId: studyText(body.sessionId, "sessionId"),
			expectedPhaseRevision: studyInteger(body.expectedPhaseRevision, "expectedPhaseRevision", 1),
		};
		if (action === "save-specification") return Response.json(await saveVisualValidationSpecificationFromUser({
			...shared,
			specificationId: body.specificationId === undefined ? undefined : studyText(body.specificationId, "specificationId", 128),
			expectedSpecificationRevision: body.expectedSpecificationRevision === undefined ? undefined : studyInteger(body.expectedSpecificationRevision, "expectedSpecificationRevision", 1),
			target: target(body.target),
			specification: specification(body.specification),
		}));
		if (action === "start") return Response.json(await startVisualValidationFromUser({
			...shared,
			specificationId: studyText(body.specificationId, "specificationId", 128),
			expectedSpecificationRevision: studyInteger(body.expectedSpecificationRevision, "expectedSpecificationRevision", 1),
			requestId: studyText(body.requestId, "requestId", 80),
			resources: resources(body.resources),
		}));
		throw new Error("Unknown visual validation action");
	} catch (error) {
		return studyApiError(error);
	}
}
