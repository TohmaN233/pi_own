import { NextResponse } from "next/server";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { inheritHarnessSessionFileOrDiscard, reconcileHarnessSession } from "@/lib/harness-server";
import {
	assertModePackCommandAllowed,
	ensurePiModePackRuntime,
	forgetModePackSession,
	inheritModePackSessionFileOrDiscard,
} from "@/lib/mode-pack-pi-runtime";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

async function inheritHarnessReplacement(
	parentSessionManager: PiSessionManager,
	commandType: string,
	result: unknown,
): Promise<void> {
	if ((commandType !== "fork" && commandType !== "clone") || !isRecord(result)) return;
	if (result.cancelled !== false || typeof result.newSessionId !== "string") return;
	const childPath = await resolveSessionPath(result.newSessionId);
	if (!childPath) throw new Error(`Forked session ${result.newSessionId} has no persisted JSONL file`);
	const modeBinding = await inheritModePackSessionFileOrDiscard(
		parentSessionManager,
		result.newSessionId,
		childPath,
	);
	try {
		await inheritHarnessSessionFileOrDiscard(parentSessionManager, result.newSessionId, childPath);
	} catch (error) {
		if (modeBinding) forgetModePackSession(result.newSessionId);
		throw error;
	}
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	let commandType: string | undefined;
	let promptAccepted = false;

	try {
		const body = (await req.json()) as { type: string; [key: string]: unknown };
		commandType = typeof body.type === "string" ? body.type : undefined;
		const requestedToolNames = body.toolNames;
		if (
			requestedToolNames !== undefined &&
			(!Array.isArray(requestedToolNames) ||
				requestedToolNames.some((name) => typeof name !== "string"))
		) {
			throw new Error("toolNames must be an array of strings");
		}
		const toolNames = requestedToolNames as string[] | undefined;

		// Generic tool selection remains available only for unmanaged Pi sessions.
		const existing = getRpcSession(id);
		if (body.type === "set_tools") {
			const filePath = existing?.sessionFile || (await resolveSessionPath(id)) || undefined;
			if (!existing?.isAlive() && !filePath) {
				return NextResponse.json({ error: "Session not found" }, { status: 404 });
			}
			const manager = existing?.inner.sessionManager ?? PiSessionManager.open(filePath as string);
			assertModePackCommandAllowed(manager, body);
			const changed = await setRpcSessionTools(id, filePath, toolNames);
			reconcileHarnessSession(changed.session.inner.sessionManager);
			return NextResponse.json({
				success: true,
				data: { sessionId: changed.sessionId, recreated: changed.recreated },
			});
		}

		if (existing?.isAlive()) {
			const session = await ensurePiModePackRuntime(id, existing);
			reconcileHarnessSession(session.inner.sessionManager);
			assertModePackCommandAllowed(session.inner.sessionManager, body);
			const parentManager = session.inner.sessionManager;
			const result = await session.send(body);
			await inheritHarnessReplacement(parentManager, body.type, result);
			promptAccepted = body.type === "prompt";
			return NextResponse.json({ success: true, data: result });
		}

		const filePath = await resolveSessionPath(id);
		if (!filePath) {
			return NextResponse.json(
				{
					error: "Session not found",
					...(body.type === "prompt"
						? { code: "prompt_rejected", accepted: false }
						: {}),
				},
				{ status: 404 },
			);
		}

		const started = await startRpcSession(id, filePath, undefined, {
			...(toolNames !== undefined ? { toolNames } : {}),
		});
		const session = await ensurePiModePackRuntime(id, started.session);
		reconcileHarnessSession(session.inner.sessionManager);
		assertModePackCommandAllowed(session.inner.sessionManager, body);
		const parentManager = session.inner.sessionManager;
		const result = await session.send(body);
		await inheritHarnessReplacement(parentManager, body.type, result);
		promptAccepted = body.type === "prompt";

		return NextResponse.json({ success: true, data: result });
	} catch (error) {
		console.error("[pi-web] Harness-aware agent command failed", {
			sessionId: id,
			commandType,
			error,
		});
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : String(error),
				...(commandType === "prompt" && !promptAccepted
					? { code: "prompt_rejected", accepted: false }
					: {}),
			},
			{ status: 500 },
		);
	}
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	try {
		const existing = getRpcSession(id);
		if (!existing || !existing.isAlive()) {
			return NextResponse.json({ running: false });
		}
		const session = await ensurePiModePackRuntime(id, existing);
		reconcileHarnessSession(session.inner.sessionManager);
		const state = await session.send({ type: "get_state" });
		return NextResponse.json({ running: true, state });
	} catch (error) {
		console.error("[pi-web] failed to read Harness-aware agent state", {
			sessionId: id,
			error,
		});
		return NextResponse.json({ error: String(error) }, { status: 500 });
	}
}
