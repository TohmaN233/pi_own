import { isApiRequestAllowed } from "@/lib/request-security";
import { inspectSessionWorkflow } from "@/lib/native-workflow-inspector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  const query = new URL(request.url).searchParams;
  const sessionId = query.get("sessionId"), runId = query.get("runId");
  if (!sessionId || !/^[a-f0-9-]{36}$/i.test(sessionId) || !runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId))
    return Response.json({ error: "Invalid conversation or Run selection" }, { status: 400 });
  const args: Record<string, unknown> = { run_id: runId };
  for (const [parameter, field] of [["nodeId", "node_id"], ["attemptId", "attempt_id"]]) {
    const value = query.get(parameter);
    if (value !== null) {
      if (!value || value.length > 256) return Response.json({ error: `Invalid ${parameter}` }, { status: 400 });
      args[field] = value;
    }
  }
  for (const [parameter, field] of [["sessionIndex", "session_index"], ["before", "before"]]) {
    const value = query.get(parameter);
    if (value !== null) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return Response.json({ error: `Invalid ${parameter}` }, { status: 400 });
      args[field] = Number(value);
    }
  }
  try { return Response.json(await inspectSessionWorkflow(sessionId, args)); }
  catch (error) {
    console.error("[workflow-inspector] Read failed", { sessionId, runId, nodeId: args.node_id, error });
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
