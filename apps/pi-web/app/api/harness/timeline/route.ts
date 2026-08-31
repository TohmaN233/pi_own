import { NextResponse } from "next/server";
import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    return NextResponse.json({ events: getLearningHarness().getCurrentTimeline(sessionId) });
  } catch (error) {
    logHarnessOperationalError("timeline read", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: harnessHttpStatus(error) },
    );
  }
}
