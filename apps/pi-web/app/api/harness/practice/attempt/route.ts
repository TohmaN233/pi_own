import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";
import {
  attemptDto,
  evaluationDto,
  practiceError,
  practiceEventDto,
  practiceJson,
  PracticeRequestError,
  requirePracticeObject,
  requirePracticeString,
} from "@/lib/harness-practice";

export async function POST(request: Request) {
  try {
    const body = requirePracticeObject(await request.json());
    const sessionId = requirePracticeString(body, "sessionId");
    const instanceId = requirePracticeString(body, "instanceId");
    const answer = requirePracticeString(body, "answer");
    const idempotencyKey = requirePracticeString(body, "idempotencyKey");
    const result = getLearningHarness().submitCurrentPracticeAttempt(sessionId, instanceId, answer, idempotencyKey);
    return practiceJson({
      attempt: attemptDto(result.attempt),
      evaluation: evaluationDto(result.evaluation),
      solutionAvailable: result.capability !== null,
      event: practiceEventDto(result.event),
    });
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof PracticeRequestError)) logHarnessOperationalError("practice attempt", error);
    return practiceError(error, error instanceof SyntaxError || error instanceof PracticeRequestError ? 400 : harnessHttpStatus(error));
  }
}
