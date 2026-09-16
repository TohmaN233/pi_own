import { isAbsolute } from "node:path";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { runStudyAgentWorker } from "../apps/pi-web/lib/study-agent-worker.ts";

const allowed = new Set(["--database", "--project", "--agent-dir"]);
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!allowed.has(key) || values.has(key) || !value || value.startsWith("--")) throw new Error("Invalid Study reading worker arguments");
  values.set(key, value);
}
if (values.size !== 3 || !isAbsolute(values.get("--database")) || !isAbsolute(values.get("--agent-dir")))
  throw new Error("Study worker requires --database <absolute path> --project <id> --agent-dir <absolute path>");
const harness = new LearningHarness({ databasePath: values.get("--database") });
try {
  console.info("[study-agent] worker started", { projectId: values.get("--project"), processId: process.pid });
  const result = await runStudyAgentWorker({ harness, projectId: values.get("--project"), agentDir: values.get("--agent-dir") });
  console.info("[study-agent] worker drained", result);
} finally { harness.close(); }
