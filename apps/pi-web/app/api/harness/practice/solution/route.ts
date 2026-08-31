import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";
import { practiceError, practiceJson, PracticeRequestError, requirePracticeObject, requirePracticeString } from "@/lib/harness-practice";

/** The only browser endpoint that can return private solution text. */
export async function POST(request: Request) {
  try {
    const body = requirePracticeObject(await request.json());
    const sessionId = requirePracticeString(body, "sessionId");
    const attemptId = requirePracticeString(body, "attemptId");
    return practiceJson({ solution: getLearningHarness().consumeCurrentPracticeSolution(sessionId, attemptId) });
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof PracticeRequestError)) logHarnessOperationalError("practice solution", error);
    return practiceError(error, error instanceof SyntaxError || error instanceof PracticeRequestError ? 400 : harnessHttpStatus(error));
  }
}
