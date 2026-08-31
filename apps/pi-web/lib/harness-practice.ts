import { NextResponse } from "next/server";
import type {
  AttemptEvaluation,
  ExerciseAttempt,
  ExerciseInstance,
  ExercisePublic,
  LearningEvent,
} from "../../../packages/harness-contracts/src/index.ts";

export interface PracticeExerciseDto {
  exerciseId: string;
  prompt: string;
  conceptIds: string[];
  hintCount: number;
  unlockPolicy: ExercisePublic["unlockPolicy"];
  revision: number;
}

export class PracticeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PracticeRequestError";
  }
}

export function practiceJson(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function practiceError(error: unknown, status: number): NextResponse {
  return practiceJson(
    { error: status >= 500 ? "Practice service unavailable" : error instanceof Error ? error.message : String(error) },
    status,
  );
}

export function requirePracticeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PracticeRequestError("Request body must be an object");
  return value as Record<string, unknown>;
}

export function requirePracticeString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new PracticeRequestError(`${key} is required`);
  return value.trim();
}

export function exerciseDto(exercise: ExercisePublic): PracticeExerciseDto {
  return {
    exerciseId: exercise.exerciseId,
    prompt: exercise.prompt,
    conceptIds: [...exercise.conceptIds],
    hintCount: exercise.hints.length,
    unlockPolicy: exercise.unlockPolicy,
    revision: exercise.revision,
  };
}

export function instanceDto(instance: ExerciseInstance) {
  return {
    instanceId: instance.instanceId,
    exerciseId: instance.exerciseId,
    issuedAt: instance.issuedAt,
  };
}

export function attemptDto(attempt: ExerciseAttempt) {
  return {
    attemptId: attempt.attemptId,
    instanceId: attempt.instanceId,
    exerciseId: attempt.exerciseId,
    meaningful: attempt.meaningful,
    submittedAt: attempt.submittedAt,
    revision: attempt.revision,
  };
}

export function evaluationDto(evaluation: AttemptEvaluation) {
  return {
    evaluationId: evaluation.evaluationId,
    correct: evaluation.correct,
    feedback: evaluation.feedback,
    createdAt: evaluation.createdAt,
  };
}

export function practiceEventDto(event: LearningEvent) {
  return {
    eventId: event.eventId,
    kind: event.kind,
    createdAt: event.createdAt,
  };
}
