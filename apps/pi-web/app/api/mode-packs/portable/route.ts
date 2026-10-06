import { NextResponse } from "next/server";
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { getGenericModePackStatus, getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { exportPortableModePackage, exportPortableModePackageFiles, importPortableModePackage, importPortableModePackageFiles } from "@/lib/portable-mode-pack-service";
import { readPortableModeBundle, writePortableModeBundle } from "@/lib/portable-mode-bundle";
import { portableModeTemporaryDirectory } from "@/lib/portable-mode-pack-registry";
import { PortableModeImportConflictError } from "@/lib/portable-mode-import-preflight";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

function field(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function deliverImportConflictToPi(sessionId: string, prompt: string): Promise<void> {
  const live = getRpcSession(sessionId);
  const session = live?.isAlive()
    ? live
    : await (async () => {
      const sessionFile = await resolveSessionPath(sessionId);
      if (!sessionFile) throw new Error(`Pi session not found: ${sessionId}`);
      return (await startRpcSession(sessionId, sessionFile, undefined)).session;
    })();
  // Pi acknowledges prompt admission without waiting for the agent's whole
  // repair turn. The import stays failed and the package remains unregistered.
  await session.send({ type: "prompt", message: prompt, streamingBehavior: "followUp" });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sessionId = field(url.searchParams.get("sessionId"), "sessionId");
    const modePackId = field(url.searchParams.get("modePackId"), "modePackId");
    const status = await getGenericModePackStatus(sessionId);
    if (url.searchParams.get("format") === "bundle") {
      const exported = await exportPortableModePackageFiles(modePackId, status.runtime.cwd);
      const destination = join(portableModeTemporaryDirectory(), `pi-own-${randomUUID()}.mode-pack.tar`);
      try { await writePortableModeBundle(exported.archive, exported.sources, destination); }
      catch (error) { if (existsSync(destination)) rmSync(destination); throw error; }
      finally { exported.cleanup(); }
      const stream = createReadStream(destination);
      stream.once("close", () => { if (existsSync(destination)) rmSync(destination); });
      return new Response(Readable.toWeb(stream) as ReadableStream, { headers: {
        "Content-Type": "application/vnd.pi-own.mode-pack+tar",
        "Content-Disposition": `attachment; filename="${(exported.archive.moduleId ?? modePackId).replace(/[^a-z0-9._-]/giu, "_")}.mode-pack.tar"`,
      } });
    }
    return NextResponse.json(await exportPortableModePackage(modePackId, status.runtime.cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  let sessionId: string | null = null;
  try {
    const binary = request.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/vnd.pi-own.mode-pack+tar";
    const url = new URL(request.url);
    const body = binary ? null : await request.json();
    sessionId = field(binary ? url.searchParams.get("sessionId") : body?.sessionId, "sessionId");
    const status = await getGenericModePackStatus(sessionId);
    let definition;
    if (binary) {
      if (!request.body) throw new Error("Portable Mode Package body is empty");
      const temporaryRoot = portableModeTemporaryDirectory();
      const stage = join(temporaryRoot, `pi-own-import-${randomUUID()}`);
      if (resolve(stage) === resolve(temporaryRoot) || !resolve(stage).startsWith(`${resolve(temporaryRoot)}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Portable import stage escaped temp directory");
      mkdirSync(stage, { recursive: false });
      try {
        let received = 0;
        const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          received += chunk.byteLength;
          callback(received > 2 * 1024 * 1024 * 1024 + 16 * 1024 * 1024 ? new Error("Portable Mode Package exceeds transfer limit") : null, chunk);
        } });
        const archive = await readPortableModeBundle(Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream).pipe(limit), stage);
        definition = await importPortableModePackageFiles(archive, stage, status.runtime.cwd,
          url.searchParams.get("expectedRevision") === null ? 0 : Number(url.searchParams.get("expectedRevision")),
          url.searchParams.get("newModePackId") === null ? undefined : field(url.searchParams.get("newModePackId"), "newModePackId"));
      } finally { rmSync(stage, { recursive: true, force: true }); }
    } else definition = await importPortableModePackage(
      body?.archive, status.runtime.cwd,
      body?.expectedRevision === undefined ? 0 : Number(body.expectedRevision),
      body?.newModePackId === undefined ? undefined : field(body.newModePackId, "newModePackId"));
    return NextResponse.json({ definition }, { status: 201 });
  } catch (error) {
    if (error instanceof PortableModeImportConflictError) {
      const agentPrompt = error.agentPrompt();
      let agentDelivery: "accepted" | "failed" = "failed";
      let agentDeliveryError: string | undefined;
      try {
        if (!sessionId) throw new Error("Import has no initiating Pi session");
        await deliverImportConflictToPi(sessionId, agentPrompt);
        agentDelivery = "accepted";
      } catch (deliveryError) {
        agentDeliveryError = deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
        console.error("[mode-pack] failed to deliver import preflight conflict to Pi", { sessionId, error: agentDeliveryError });
      }
      console.warn("[mode-pack] import preflight conflict", { sessionId, conflicts: error.conflicts, agentDelivery });
      return NextResponse.json({
        error: error.message,
        code: error.code,
        conflicts: error.conflicts,
        agentPrompt,
        agentDelivery,
        ...(agentDeliveryError ? { agentDeliveryError } : {}),
      }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[mode-pack] portable import failed", { sessionId, error: message });
    return NextResponse.json({ error: message }, { status: /conflict/iu.test(message) ? 409 : 400 });
  }
}
