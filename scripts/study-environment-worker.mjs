import { join, isAbsolute } from "node:path";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { runStudyEnvironmentWorker } from "../apps/pi-web/lib/study-environment-worker-service.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--project-id" || args[2] !== "--worker-id" || !/^[A-Za-z0-9_-]{1,128}$/u.test(args[1]) || !/^[a-f0-9-]{36}$/u.test(args[3]))
    throw new Error("Usage: study-environment-worker --project-id <id> --worker-id <uuid>");
  const directory = process.env.PI_LEARNING_HARNESS_DIR;
  if (!directory || !isAbsolute(directory)) throw new Error("PI_LEARNING_HARNESS_DIR must identify the shared Harness directory");
	const pauseBeforeClaim = process.env.PI_STUDY_ENVIRONMENT_WORKER_TEST_PAUSE_BEFORE_CLAIM_MS;
	if (pauseBeforeClaim !== undefined && !/^[1-9][0-9]{0,3}$/u.test(pauseBeforeClaim))
		throw new Error("PI_STUDY_ENVIRONMENT_WORKER_TEST_PAUSE_BEFORE_CLAIM_MS must be 1 through 9999 milliseconds");
  const harness = new LearningHarness({ databasePath: join(directory, "learning-harness.sqlite") });
  try {
		if (pauseBeforeClaim !== undefined) await new Promise((ready) => setTimeout(ready, Number(pauseBeforeClaim)));
    const result = await runStudyEnvironmentWorker(harness, { projectId: args[1], workerId: args[3] });
    console.info("[study-environment] worker drained", result);
    if (result.failed || result.unknown || result.needsInput) process.exitCode = 1;
  } finally { harness.close(); }
}

main().catch((error) => { console.error("[study-environment] worker failed", error); process.exitCode = 1; });
