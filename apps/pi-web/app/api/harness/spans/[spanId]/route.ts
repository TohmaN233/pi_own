import { NextResponse } from "next/server";
import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ spanId: string }> },
) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    const { spanId } = await params;
    return NextResponse.json(getLearningHarness().readCurrentCourseSpan(sessionId, spanId));
  } catch (error) {
    logHarnessOperationalError("course span", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: harnessHttpStatus(error) });
  }
}
