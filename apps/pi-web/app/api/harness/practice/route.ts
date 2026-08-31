import { getLearningHarness } from "@/lib/harness-server";
import { harnessHttpStatus, logHarnessOperationalError } from "@/lib/harness-http";
import {
  exerciseDto,
  instanceDto,
  practiceError,
  practiceJson,
  PracticeRequestError,
  requirePracticeObject,
  requirePracticeString,
} from "@/lib/harness-practice";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) return practiceError(new Error("sessionId is required"), 400);
    return practiceJson({ exercises: getLearningHarness().listCurrentExercises(sessionId).map(exerciseDto) });
  } catch (error) {
    logHarnessOperationalError("practice list", error);
    return practiceError(error, harnessHttpStatus(error));
  }
}

export async function POST(request: Request) {
  try {
    const body = requirePracticeObject(await request.json());
    const sessionId = requirePracticeString(body, "sessionId");
    const exerciseId = requirePracticeString(body, "exerciseId");
    const idempotencyKey = requirePracticeString(body, "idempotencyKey");
    const harness = getLearningHarness();
    const instance = harness.startCurrentExercise(sessionId, exerciseId, idempotencyKey);
    return practiceJson({ instance: instanceDto(instance), exercise: exerciseDto(harness.getCurrentExercise(sessionId, exerciseId)) }, 201);
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof PracticeRequestError)) logHarnessOperationalError("practice start", error);
    return practiceError(error, error instanceof SyntaxError || error instanceof PracticeRequestError ? 400 : harnessHttpStatus(error));
  }
}
