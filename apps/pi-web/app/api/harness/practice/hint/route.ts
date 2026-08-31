import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";
import { practiceError, practiceJson, PracticeRequestError, requirePracticeObject, requirePracticeString } from "@/lib/harness-practice";

export async function POST(request: Request) {
  try {
    const body = requirePracticeObject(await request.json());
    const sessionId = requirePracticeString(body, "sessionId");
    const instanceId = requirePracticeString(body, "instanceId");
    const level = body.level;
    if (typeof level !== "number" || !Number.isSafeInteger(level)) return practiceError(new PracticeRequestError("level must be an integer"), 400);
    const hint = getLearningHarness().requestCurrentPracticeHint(sessionId, instanceId, level);
    return practiceJson({ level, hint });
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof PracticeRequestError)) logHarnessOperationalError("practice hint", error);
    return practiceError(error, error instanceof SyntaxError || error instanceof PracticeRequestError ? 400 : harnessHttpStatus(error));
  }
}
