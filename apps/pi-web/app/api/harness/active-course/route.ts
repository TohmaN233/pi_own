import { NextResponse } from "next/server";
import { getLearningHarness, HARNESS_COURSE_COOKIE } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { courseVersionId?: unknown };
    if (typeof body.courseVersionId !== "string") {
      return NextResponse.json({ error: "courseVersionId is required" }, { status: 400 });
    }
    getLearningHarness().getCourseVersion(body.courseVersionId);
    const response = NextResponse.json({ activeCourseVersionId: body.courseVersionId });
    response.cookies.set(HARNESS_COURSE_COOKIE, body.courseVersionId, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    return response;
  } catch (error) {
    logHarnessOperationalError("active course", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: harnessHttpStatus(error) });
  }
}
