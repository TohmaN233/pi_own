import { NextResponse } from "next/server";
import { CourseHostError, PdftotextExtractor } from "../../../../../../packages/course-host/src/index.ts";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  CourseImportError,
  CourseImportLimitError,
  expandCourseUploads,
  MAX_COURSE_BYTES,
} from "@/lib/harness-course-import";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";
import { courseSummary, getLearningHarness } from "@/lib/harness-server";

export const runtime = "nodejs";
const MAX_COURSE_REQUEST_BYTES = MAX_COURSE_BYTES + 2 * 1024 * 1024;

export async function GET() {
  try {
    return NextResponse.json(getLearningHarness().listCourses().map((version) => courseSummary(version.courseVersionId)));
  } catch (error) {
    logHarnessOperationalError("course list", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: harnessHttpStatus(error) });
  }
}

export async function POST(request: Request) {
  try {
    const form = await parseFormDataWithinLimit(request, MAX_COURSE_REQUEST_BYTES);
    const courseId = form.get("courseId");
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    if (typeof courseId !== "string" || !courseId.trim()) {
      return NextResponse.json({ error: "courseId is required" }, { status: 400 });
    }
    const materials = await expandCourseUploads(files);
    const version = await getLearningHarness().publishCourseVersion(courseId.trim(), materials, {
      pdfTextExtractor: new PdftotextExtractor(process.env.PI_PDFTOTEXT_PATH || "pdftotext"),
    });
    return NextResponse.json(courseSummary(version.courseVersionId), { status: 201 });
  } catch (error) {
    logHarnessOperationalError("course import", error);
    const status = error instanceof RequestBodyTooLargeError || error instanceof CourseImportLimitError
      ? 413
      : error instanceof CourseHostError
        ? harnessHttpStatus(error)
        : error instanceof CourseImportError
          ? 400
          : harnessHttpStatus(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
