import { getRpcSession, startRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

/** Use the installed portable plugin's read API; never guess its data directory. */
export async function inspectSessionWorkflow(sessionId: string, args: Record<string, unknown>): Promise<unknown> {
  let live = getRpcSession(sessionId);
  if (!live?.isAlive()) {
    const file = await resolveSessionPath(sessionId);
    if (!file) throw new Error("Conversation not found");
    live = (await startRpcSession(sessionId, file, undefined)).session;
  }
  const bus = (live.inner.resourceLoader as unknown as { eventBus: { emit(name: string, value: unknown): void } }).eventBus;
  await live.waitUntilReady();
  const readiness = { session_id: sessionId, ready: false };
  bus.emit("pi-caw:host-readiness", readiness);
  if (!readiness.ready) throw new Error("This conversation has no active pi-CAW plugin; enable it to inspect its Workflow");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Workflow inspection timed out; retry reading its saved execution")), 15000);
    try { bus.emit("pi-caw:host-command", { session_id: sessionId, operation: "inspect_run", args,
      resolve: (value: unknown) => { clearTimeout(timer); resolve(value); },
      reject: (error: unknown) => { clearTimeout(timer); reject(error); } }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}
