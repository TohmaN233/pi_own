import { execFileSync } from "node:child_process";
import test from "node:test";

const contractChecks = String.raw`
import assert from "node:assert/strict";
import {
  HARNESS_CONTRACT_VERSION,
  HarnessContractError,
  parseHarnessJsonlEntry,
  parseHostCommand,
  parseResourceSnapshotRef,
  parseSessionBinding,
  parseValidatorResult,
  parseWorkflowRun,
} from "./packages/harness-contracts/src/index.ts";

const now = "2026-08-29T14:00:00.000Z";
const sessionBinding = {
  version: HARNESS_CONTRACT_VERSION,
  bindingId: "binding_course_a_session_1",
  sessionId: "session_1",
  courseVersionId: "course_a_v1",
  resourceSnapshotId: "snapshot_student_a_v1",
  role: "student",
  createdAt: now,
  revision: 1,
};
const snapshotRef = {
  version: HARNESS_CONTRACT_VERSION,
  resourceSnapshotId: "snapshot_student_a_v1",
  profileId: "student-learn",
  profileRevision: 1,
  courseVersionId: "course_a_v1",
  contentHash: "sha256:abc123",
  createdAt: now,
};
const workflowRun = {
  version: HARNESS_CONTRACT_VERSION,
  runId: "run_1",
  sessionBindingId: sessionBinding.bindingId,
  kind: "grounded-answer",
  status: "running",
  sequence: 0,
  startedAt: now,
  updatedAt: now,
  revision: 1,
};

assert.deepEqual(parseSessionBinding(sessionBinding), sessionBinding);
assert.deepEqual(parseResourceSnapshotRef(snapshotRef), snapshotRef);
assert.deepEqual(parseWorkflowRun(workflowRun), workflowRun);

const command = parseHostCommand({
  version: 1,
  commandId: "command_1",
  host: "course",
  kind: "bind-session",
  idempotencyKey: "course:session_1:course_a_v1",
  expectedRevision: 1,
  payload: { sessionId: "session_1", courseVersionId: "course_a_v1" },
});
assert.equal(command.host, "course");
assert.throws(() => parseHostCommand({ ...command, payload: { invalid: Number.NaN } }), HarnessContractError);
assert.throws(() => parseSessionBinding({ ...sessionBinding, injectedCourseVersionId: "course_b_v1" }), /unknown field/i);
assert.throws(() => parseSessionBinding({ ...sessionBinding, version: 2 }), /unsupported contract version/i);
assert.throws(() => parseSessionBinding({ ...sessionBinding, revision: 0 }), /positive safe integer/i);
assert.throws(() => parseWorkflowRun({ ...workflowRun, sequence: -1 }), /non-negative safe integer/i);

const pass = parseValidatorResult({
  version: 1,
  validatorId: "course-binding-validator/v1",
  status: "pass",
  subject: { kind: "session-binding", id: sessionBinding.bindingId, revision: 1 },
  checkedAt: now,
  issues: [],
});
assert.equal(pass.status, "pass");
assert.throws(
  () => parseValidatorResult({
    ...pass,
    status: "fail",
    issues: [{ code: "MISMATCH", severity: "warning", message: "not enough", path: null }],
  }),
  /fail result must contain at least one error issue/i,
);

const entry = parseHarnessJsonlEntry({ version: 1, type: "learning-harness:session-binding", data: sessionBinding });
assert.equal(entry.type, "learning-harness:session-binding");
assert.equal(entry.data.sessionId, "session_1");
assert.throws(
  () => parseHarnessJsonlEntry({ version: 1, type: "learning-harness:unknown", data: {} }),
  /unsupported harness entry type/i,
);
`;

test("Learning Harness V1 contracts parse valid objects and reject invalid boundaries", () => {
	execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", contractChecks], {
		cwd: new URL("..", import.meta.url),
		stdio: "pipe",
	});
});
