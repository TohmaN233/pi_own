import { CourseHostError } from "../../../packages/course-host/src/index.ts";
import { AssessmentHostError } from "../../../packages/assessment-host/src/index.ts";
import { KnowledgeHostError } from "../../../packages/knowledge-host/src/index.ts";
import { LearningHarnessError } from "../../../packages/learning-harness/src/index.ts";

const OPERATIONAL_COURSE_ERRORS = new Set([
  "PDF_EXTRACTOR_REQUIRED",
  "PDF_EXTRACTOR_CONFIG",
  "PDF_EXTRACTION_OPERATION_FAILED",
  "PDF_EXTRACTION_TIMEOUT",
  "PDF_SUBPROCESS_OUTPUT_TOO_LARGE",
  "MATERIAL_HASH_MISMATCH",
  "SPAN_MATERIAL_MISMATCH",
  "SPAN_HASH_MISMATCH",
  "SPAN_ID_MISMATCH",
  "COURSE_HASH_MISMATCH",
  "COURSE_ID_MISMATCH",
  "INVALID_STATE",
  "STATE_NOT_EMPTY",
]);

const OPERATIONAL_KNOWLEDGE_ERRORS = new Set([
  "CORRUPT_STATE",
  "INVALID_STATE",
  "STATE_NOT_EMPTY",
  "PACKET_COLLISION",
  "PACKET_HASH_MISMATCH",
]);

const OPERATIONAL_HARNESS_ERRORS = new Set([
  "PERSISTENCE_FAILURE",
  "CORRUPT_STATE",
  "SOURCE_MAPPING_MISSING",
  "SOURCE_HASH_MISMATCH",
]);

const NOT_FOUND_ASSESSMENT_ERRORS = new Set([
  "UNKNOWN_EXERCISE",
  "UNKNOWN_INSTANCE",
  "UNKNOWN_ATTEMPT",
  "CAPABILITY_INVALID",
]);

const FORBIDDEN_ASSESSMENT_ERRORS = new Set([
  "INSTANCE_BINDING_MISMATCH",
  "ATTEMPT_BINDING_MISMATCH",
  "CAPABILITY_SCOPE_MISMATCH",
  "SOLUTION_LOCKED",
  "ROLE_DENIED",
]);

const CONFLICT_ASSESSMENT_ERRORS = new Set([
  "CAPABILITY_CONSUMED",
  "IDEMPOTENCY_REUSE",
  "EXERCISE_REDEFINED",
  "PRIVATE_ASSET_REDEFINED",
]);

const OPERATIONAL_ASSESSMENT_ERRORS = new Set([
  "CAPABILITY_CORRUPT",
  "PRIVATE_ASSET_UNAVAILABLE",
  "PRIVATE_HASH_MISMATCH",
  "PRIVATE_SOLUTION_CONFLICT",
  "CORRUPT_INSTANCE",
  "CORRUPT_ATTEMPT",
  "CORRUPT_EVALUATION",
  "CORRUPT_CAPABILITY",
  "CORRUPT_IDEMPOTENCY",
  "INVALID_STATE",
  "STATE_NOT_EMPTY",
  "VAULT_NOT_EXPORTABLE",
  "VAULT_NOT_RESTORABLE",
]);

export function harnessHttpStatus(error: unknown): number {
  if (error instanceof CourseHostError) {
    if (OPERATIONAL_COURSE_ERRORS.has(error.code)) return 500;
    if (["PDF_INPUT_TOO_LARGE", "PDF_OUTPUT_TOO_LARGE", "PDF_TEXT_TOO_LARGE", "COURSE_TEXT_TOO_LARGE", "COURSE_SPAN_LIMIT"].includes(error.code)) return 413;
    return 400;
  }
  if (error instanceof KnowledgeHostError) return OPERATIONAL_KNOWLEDGE_ERRORS.has(error.code) ? 500 : 400;
  if (error instanceof AssessmentHostError) {
    if (NOT_FOUND_ASSESSMENT_ERRORS.has(error.code)) return 404;
    if (FORBIDDEN_ASSESSMENT_ERRORS.has(error.code)) return 403;
    if (CONFLICT_ASSESSMENT_ERRORS.has(error.code)) return 409;
    if (error.code === "CAPABILITY_EXPIRED") return 410;
    return OPERATIONAL_ASSESSMENT_ERRORS.has(error.code) ? 500 : 400;
  }
  if (error instanceof LearningHarnessError) {
    if (error.code === "UNKNOWN_SESSION") return 404;
    if (error.code === "COURSE_BINDING_MISMATCH") return 403;
		if (error.code === "PROFILE_UNAVAILABLE") return 409;
		if (["SNAPSHOT_CONFLICT", "PROFILE_TRANSITION_BUSY", "PROFILE_IDEMPOTENCY_REUSE"].includes(error.code)) return 409;
    return OPERATIONAL_HARNESS_ERRORS.has(error.code) ? 500 : 400;
  }
  return 500;
}

export function logHarnessOperationalError(operation: string, error: unknown): void {
  if (harnessHttpStatus(error) >= 500) {
    console.error(`[learning-harness] ${operation} failed`, error);
  }
}
