import { execFileSync } from "node:child_process";
import test from "node:test";

const runtimeChecks = String.raw`
import assert from "node:assert/strict";
import {
  RUNTIME_JOURNAL_CUSTOM_TYPE,
  RuntimeSessionHost,
  RuntimeSessionHostError,
} from "./packages/pi-runtime-host/src/index.ts";

class FakeSessionStore {
  constructor(sessionId = "session_1") {
    this.sessionId = sessionId;
    this.entries = [];
  }

  getSessionId() {
    return this.sessionId;
  }

  getBranch() {
    return [...this.entries];
  }

  appendCustomEntry(customType, data) {
    const id = \`entry_\${this.entries.length + 1}\`;
    this.entries.push({
      type: "custom",
      id,
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      customType,
      data,
    });
    return id;
  }
}

const now = "2026-08-29T14:00:00.000Z";
const store = new FakeSessionStore();
const host = new RuntimeSessionHost(store);
const snapshotA = {
  version: 1,
  resourceSnapshotId: "snapshot_a",
  profileId: "student-learn",
  profileRevision: 1,
  courseVersionId: "course_a_v1",
  contentHash: "sha256:a",
  createdAt: now,
};
const bindingA = {
  version: 1,
  bindingId: "binding_a",
  sessionId: "session_1",
  courseVersionId: "course_a_v1",
  resourceSnapshotId: "snapshot_a",
  role: "student",
  createdAt: now,
  revision: 1,
};

assert.equal(host.recordResourceSnapshot(snapshotA, "snapshot:a"), "entry_1");
assert.equal(host.recordSessionBinding(bindingA, "binding:a"), "entry_2");
assert.equal(host.recordSessionBinding(bindingA, "binding:a"), "entry_2");
assert.equal(store.entries.length, 2, "exact idempotent replay must not append another Pi entry");

const pending = {
  version: 1,
  runId: "run_1",
  sessionBindingId: "binding_a",
  kind: "grounded-answer",
  status: "pending",
  sequence: 0,
  startedAt: now,
  updatedAt: now,
  revision: 1,
};
const running = {
  ...pending,
  status: "running",
  sequence: 1,
  revision: 2,
  updatedAt: "2026-08-29T14:00:01.000Z",
};
const succeeded = {
  ...running,
  status: "succeeded",
  sequence: 2,
  revision: 3,
  updatedAt: "2026-08-29T14:00:02.000Z",
};

host.recordWorkflowRun(pending, "run:1:0");
host.recordWorkflowRun(running, "run:1:1");
host.recordWorkflowRun(succeeded, "run:1:2");
assert.equal(host.recover().workflows.get("run_1")?.status, "succeeded");

assert.throws(
  () => host.recordWorkflowRun({
    ...succeeded,
    status: "running",
    sequence: 3,
    revision: 4,
    updatedAt: "2026-08-29T14:00:03.000Z",
  }, "run:1:3"),
  RuntimeSessionHostError,
  "terminal workflow cannot restart",
);

const snapshotB = {
  ...snapshotA,
  resourceSnapshotId: "snapshot_b",
  courseVersionId: "course_b_v1",
  contentHash: "sha256:b",
};
host.recordResourceSnapshot(snapshotB, "snapshot:b");
assert.throws(
  () => host.recordSessionBinding({
    ...bindingA,
    courseVersionId: "course_b_v1",
    resourceSnapshotId: "snapshot_b",
    revision: 2,
  }, "binding:b"),
  /course version cannot be rebound/i,
);
assert.throws(
  () => host.recordSessionBinding({ ...bindingA, role: "teacher", revision: 2 }, "binding:teacher"),
  /role cannot change/i,
);
assert.throws(
  () => host.recordResourceSnapshot({ ...snapshotA, contentHash: "sha256:other" }, "snapshot:other"),
  /already exists with other data/i,
);
assert.throws(
  () => host.recordResourceSnapshot({ ...snapshotA, resourceSnapshotId: "snapshot_new" }, "snapshot:a"),
  /idempotency key/i,
);

const wrongSessionHost = new RuntimeSessionHost(new FakeSessionStore("other_session"));
wrongSessionHost.recordResourceSnapshot(snapshotA, "snapshot:a");
assert.throws(() => wrongSessionHost.recordSessionBinding(bindingA, "binding:a"), /active Pi session/i);

const corruptStore = new FakeSessionStore();
corruptStore.entries.push({
  type: "custom",
  id: "bad_entry",
  customType: RUNTIME_JOURNAL_CUSTOM_TYPE,
  data: {
    version: 1,
    sequence: 2,
    idempotencyKey: "bad",
    entry: { version: 1, type: "learning-harness:resource-snapshot", data: snapshotA },
  },
});
assert.throws(() => new RuntimeSessionHost(corruptStore).recover(), /sequence mismatch/i);
`;

test("RuntimeSessionHost enforces binding, idempotency, recovery, and workflow invariants", () => {
	execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", runtimeChecks], {
		cwd: new URL("..", import.meta.url),
		stdio: "pipe",
	});
});
