import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getGenericModePackStatus, initializeModePackProjectCapability } from "@/lib/rpc-manager";
import { initializeSpecKit, inspectSpecKit } from "@/lib/code-mode-spec-kit";
import { isApiRequestAllowed } from "@/lib/request-security";
import { activePortableModePackageForSnapshot } from "@/lib/portable-mode-pack-registry";
export const dynamic = "force-dynamic";
function sessionId(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new Error("sessionId is required"); return value.trim(); }
async function capabilitySession(id: string) { const status = await getGenericModePackStatus(id); const snapshot = status.runtime.binding?.snapshot; const archive = snapshot?.packageContentHash ? activePortableModePackageForSnapshot(snapshot) : null; if (!snapshot || !archive?.projectCapabilities.includes("spec-kit")) throw new Error("Spec Kit is not enabled by the active Mode Pack"); return { status, snapshot }; }
export async function GET(request: Request) {
  try {
    const { status, snapshot } = await capabilitySession(sessionId(new URL(request.url).searchParams.get("sessionId")));
    return NextResponse.json({ ...inspectSpecKit(status.runtime.cwd), snapshotId: snapshot.resourceSnapshotId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const body = await request.json();
    const id = sessionId(body?.sessionId);
    const expectedSnapshotId = sessionId(body?.expectedSnapshotId);
    const result = await initializeModePackProjectCapability({
      sessionId: id,
      expectedSnapshotId,
      idempotencyKey: `spec-kit:${randomUUID()}`,
      capability: "spec-kit",
      initialize: initializeSpecKit,
    });
    return NextResponse.json({
      ...result.initialized,
      snapshotId: result.activation.binding.snapshot.resourceSnapshotId,
      runtime: result.activation.runtime,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
