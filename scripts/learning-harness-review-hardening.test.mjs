import { execFileSync } from "node:child_process";
import test from "node:test";

const hardeningChecks = String.raw`
import assert from "node:assert/strict";
import { AssessmentHost, AssessmentHostError, InMemorySolutionVault, createExercisePrivate } from "./packages/assessment-host/src/index.ts";
import { CourseHost } from "./packages/course-host/src/index.ts";
import { KnowledgeHost, KnowledgeHostError } from "./packages/knowledge-host/src/index.ts";

const now = "2026-08-29T14:00:00.000Z";
const courseHost = new CourseHost();
const course = await courseHost.publishVersion(
  "course_a",
  [{ name: "notes.txt", kind: "text", mediaType: "text/plain", content: "Vectors have magnitude and direction." }],
  { createdAt: now },
);
const snapshot = {
  version: 1,
  resourceSnapshotId: "snapshot_a",
  profileId: "student-learn",
  profileRevision: 1,
  role: "student",
  mode: "student-learn",
  courseVersionId: course.courseVersionId,
  provider: null,
  model: null,
  thinkingLevel: "high",
  externalKnowledgePolicy: "explain-and-label",
  tools: [],
  resources: [],
  instructions: [],
  createdAt: now,
  contentHash: "sha256:snapshot-a",
};
const binding = {
  version: 1,
  bindingId: "binding_a",
  sessionId: "session_a",
  courseVersionId: course.courseVersionId,
  resourceSnapshotId: snapshot.resourceSnapshotId,
  role: "student",
  createdAt: now,
  revision: 1,
};

const knowledge = new KnowledgeHost(courseHost);
knowledge.registerCourseVersion(course.courseVersionId);
const packet = knowledge.search({ binding, snapshot, query: "vectors magnitude", createdAt: now });
assert.ok(packet.spans.length > 0);
const directDraft = {
  version: 1,
  draftId: "draft_a",
  packetId: packet.packetId,
  courseVersionId: course.courseVersionId,
  claims: [{
    claimId: "claim_a",
    text: "Vectors have magnitude and direction.",
    scope: "direct",
    citationSpanIds: [packet.spans[0].spanId],
    reason: null,
  }],
  createdAt: now,
  revision: 1,
};
assert.equal(knowledge.validateDraft(directDraft, { binding, snapshot }, now).status, "pass");
const invalidScope = knowledge.validateDraft(
  { ...directDraft, claims: [{ ...directDraft.claims[0], scope: "untrusted-scope" }] },
  { binding, snapshot },
  now,
);
assert.equal(invalidScope.status, "fail");
assert.ok(invalidScope.issues.some((item) => item.code === "INVALID_DRAFT"));
const emptyClaims = knowledge.validateDraft({ ...directDraft, claims: [] }, { binding, snapshot }, now);
assert.equal(emptyClaims.status, "fail");
assert.ok(emptyClaims.issues.some((item) => item.code === "CLAIMS_REQUIRED"));
assert.throws(
  () => knowledge.publishDraft({ ...directDraft, claims: [{ ...directDraft.claims[0], scope: "untrusted-scope" }] }, { binding, snapshot }, now),
  KnowledgeHostError,
);
const repeatedPacket = knowledge.search({
  binding,
  snapshot,
  query: "vectors magnitude",
  createdAt: "2026-08-29T14:10:00.000Z",
});
assert.equal(repeatedPacket.createdAt, now);

const vault = new InMemorySolutionVault();
const assessment = new AssessmentHost(vault);
const exercisePublic = {
  exerciseId: "exercise_a",
  courseVersionId: course.courseVersionId,
  conceptIds: ["vectors"],
  prompt: "Name the capital of France.",
  hints: ["It is a major city on the Seine."],
  unlockPolicy: "after-meaningful-attempt",
  revision: 1,
};
const exercisePrivate = createExercisePrivate("exercise_a", "Paris", ["Paris"], "Exact city name.");
assessment.registerExercise(exercisePublic, exercisePrivate);
const instance = assessment.issueExercise("exercise_a", binding, snapshot, "issue:a", now);
const attempt = assessment.submitAttempt(instance.instanceId, "Paris", binding, "attempt:a", "2026-08-29T14:00:01.000Z");
const capability = assessment.requestSolutionUnlock(attempt.attemptId, binding, "unlock:a", "2026-08-29T14:00:02.000Z", 1000);
assert.throws(() => assessment.readSolution(capability.capabilityId, binding, "not-a-time"), (error) => error instanceof AssessmentHostError && error.code === "INVALID_TIMESTAMP");
assert.throws(() => assessment.readSolution(capability.capabilityId, binding, capability.expiresAt), (error) => error instanceof AssessmentHostError && error.code === "CAPABILITY_EXPIRED");
const publicState = structuredClone(assessment.exportPublicState());
const privateState = structuredClone(assessment.exportPrivateState());
const tamperedState = structuredClone(publicState);
tamperedState.capabilities[0].value.expiresAt = "2026-08-29T15:00:00.000Z";
const restoredVault = new InMemorySolutionVault();
const restored = new AssessmentHost(restoredVault);
restored.restorePrivateState(privateState);
assert.throws(() => restored.restorePublicState(tamperedState), (error) => error instanceof AssessmentHostError && error.code === "CAPABILITY_CORRUPT");
assert.equal(assessment.readSolution(capability.capabilityId, binding, "2026-08-29T14:00:02.500Z"), "Paris");
assert.throws(() => assessment.readSolution(capability.capabilityId, binding, "2026-08-29T14:00:02.600Z"), (error) => error instanceof AssessmentHostError && error.code === "CAPABILITY_CONSUMED");
`;

test("Learning Harness publication and solution gates fail closed", () => {
	execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", hardeningChecks], {
		cwd: new URL("..", import.meta.url),
		stdio: "pipe",
	});
});
