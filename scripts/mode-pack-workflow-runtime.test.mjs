import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const check = String.raw`
import assert from "node:assert/strict";
import { ModeWorkflowRuntime } from "./apps/pi-web/lib/mode-pack-workflow-runtime.ts";

class FakeManager {
  leaf = null;
  getLeafId() { return this.leaf; }
}

function mount(runtime) {
  const handlers = new Map();
  runtime.extension.factory({ on(event, handler) { handlers.set(event, handler); } });
  return handlers;
}

const hash = "sha256:" + "a".repeat(64);
const manager = new FakeManager();
const teachBack = new ModeWorkflowRuntime({
  sessionId: "session-teach-back",
  courseVersionId: "course-v1",
  modePackContentHash: hash,
  bindingRevision: 1,
  kind: "teach-back",
  manager,
});
const teachHandlers = mount(teachBack);
const beforeTeach = teachHandlers.get("before_agent_start");
const endTeach = teachHandlers.get("message_end");

let result = beforeTeach({ prompt: "Start a teach-back cycle", systemPrompt: "base" });
assert.match(result.systemPrompt, /awaiting-initial-explanation/);
assert.equal(teachBack.current().learnerTurnIds.length, 0);
manager.leaf = "turn-explanation-1";
result = beforeTeach({ prompt: "A variable is a named unknown.", systemPrompt: "base" });
assert.match(result.systemPrompt, /diagnose-gaps/);
assert.equal(teachBack.current().payload.initialExplanation, "A variable is a named unknown.");
endTeach({ message: { role: "assistant", content: [{ type: "text", text: "Explain how the value can change while the name remains." }] } });
assert.equal(teachBack.current().state, "awaiting-revised-explanation");
manager.leaf = "turn-revision-2";
beforeTeach({ prompt: "The name refers to a value that may vary by assignment.", systemPrompt: "base" });
assert.equal(teachBack.current().state, "awaiting-transfer");
manager.leaf = "turn-transfer-3";
beforeTeach({ prompt: "In a loop, the same variable name receives successive values.", systemPrompt: "base" });
assert.equal(teachBack.current().state, "reflection");
endTeach({ message: { role: "assistant", content: [{ type: "text", text: "The explanation now separates name from current value." }] } });
assert.equal(teachBack.current().status, "completed");

const recovered = new ModeWorkflowRuntime({
  sessionId: "session-teach-back",
  courseVersionId: "course-v1",
  modePackContentHash: hash,
  bindingRevision: 1,
  kind: "teach-back",
  manager,
});
assert.equal(recovered.current().status, "completed");

const visualManager = new FakeManager();
const visual = new ModeWorkflowRuntime({
  sessionId: "session-visual",
  courseVersionId: "course-v1",
  modePackContentHash: hash,
  bindingRevision: 1,
  kind: "visual-lab",
  manager: visualManager,
});
const visualHandlers = mount(visual);
const beforeVisual = visualHandlers.get("before_agent_start");
beforeVisual({ prompt: "Start a matrix activity", systemPrompt: "base" });
visualManager.leaf = "turn-prediction-1";
beforeVisual({ prompt: "I predict the x coordinate doubles.", systemPrompt: "base" });
assert.equal(visual.current().state, "compute-and-verify");
visual.recordVerifiedVisual({ outputHash: "sha256:" + "b".repeat(64) });
assert.equal(visual.current().state, "awaiting-observation");
visualManager.leaf = "turn-observation-2";
beforeVisual({ prompt: "The x distance from the origin doubled.", systemPrompt: "base" });
assert.equal(visual.current().state, "awaiting-transfer");
visualManager.leaf = "turn-transfer-3";
beforeVisual({ prompt: "A diagonal matrix scales each axis independently.", systemPrompt: "base" });
assert.equal(visual.current().status, "completed");
`;

test("live education workflow runtime preserves learner-only gates and recovers state", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-own-workflow-runtime-"));
	try {
		execFileSync(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "--eval", check],
			{
				cwd: new URL("..", import.meta.url),
				env: { ...process.env, PI_LEARNING_HARNESS_DIR: root },
				stdio: "pipe",
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
