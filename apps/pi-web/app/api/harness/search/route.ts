import { NextResponse } from "next/server";
import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const sessionId = params.get("sessionId");
    const query = params.get("q");
    if (!sessionId || !query) {
      return NextResponse.json({ error: "sessionId and q are required" }, { status: 400 });
    }
    const packet = getLearningHarness().searchCurrentCourse(sessionId, query);
    return NextResponse.json({
      packetId: packet.packetId,
      courseVersionId: packet.courseVersionId,
      spans: packet.spans,
    });
  } catch (error) {
    logHarnessOperationalError("course search", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: harnessHttpStatus(error) });
  }
}
