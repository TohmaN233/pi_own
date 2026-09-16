import process from "node:process";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import {
	createNativeWindowsCellAdapters,
	createNativeWindowsNodeAdapter,
	currentDetachedCoordinatorProcessIdentity,
} from "../packages/study-execution-host/src/index.ts";

const usage = `Usage: node --import tsx scripts/study-execution-coordinator.mjs \\
	--database <absolute sqlite path> --run-root <absolute directory> \\
	--artifact-dir <absolute directory> [--coordinator-id <id>] \\
	[--interval-ms <100..60000>] [--watch] \\
	[--worker-launch-key <key> --worker-token <token> --worker-lease-ms <300..300000>]`;

function requiredArgument(values, name) {
	const value = values.get(name);
	if (!value) throw new Error(`${name} is required\n${usage}`);
	return value;
}

function parseArguments(argv) {
	const values = new Map();
	let watch = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--watch") {
			watch = true;
			continue;
		}
		if (!argument.startsWith("--") || values.has(argument)) throw new Error(`invalid argument ${argument}\n${usage}`);
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}\n${usage}`);
		values.set(argument, value);
		index += 1;
	}
	const databasePath = requiredArgument(values, "--database");
	const runRootDirectory = requiredArgument(values, "--run-root");
	const artifactDirectory = requiredArgument(values, "--artifact-dir");
	const intervalMs = values.has("--interval-ms") ? Number(values.get("--interval-ms")) : 1_000;
	if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
		throw new Error(`--interval-ms must be an integer from 100 through 60000\n${usage}`);
	}
	const workerLaunchKey = values.get("--worker-launch-key");
	const workerToken = values.get("--worker-token");
	const workerLeaseMs = values.has("--worker-lease-ms") ? Number(values.get("--worker-lease-ms")) : null;
	if ((workerLaunchKey || workerToken || workerLeaseMs !== null) && (!workerLaunchKey || !workerToken || workerLeaseMs === null)) {
		throw new Error(`worker fence arguments must be supplied together\n${usage}`);
	}
	if (workerLeaseMs !== null && (!Number.isSafeInteger(workerLeaseMs) || workerLeaseMs < 300 || workerLeaseMs > 300_000)) {
		throw new Error(`--worker-lease-ms must be an integer from 300 through 300000\n${usage}`);
	}
	return {
		databasePath,
		runRootDirectory,
		artifactDirectory,
		coordinatorId: values.get("--coordinator-id"),
		intervalMs,
		watch,
		workerIdentity:
			workerLaunchKey && workerToken && workerLeaseMs !== null
				? {
						launchKey: workerLaunchKey,
						workerToken,
						processId: process.pid,
						processCreationIdentity: currentDetachedCoordinatorProcessIdentity(),
						leaseDurationMs: workerLeaseMs,
					}
				: null,
	};
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reportError(error, fallback) {
	const code = typeof error?.code === "string" ? error.code : fallback;
	let detail = error instanceof Error ? error.stack ?? error.message : String(error);
	const tokenIndex = process.argv.indexOf("--worker-token");
	if (tokenIndex >= 0 && process.argv[tokenIndex + 1]) detail = detail.replaceAll(process.argv[tokenIndex + 1], "[redacted]");
	process.stderr.write(`${new Date().toISOString()} ${code}: ${detail.slice(0, 20000)}\n`);
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const harness = new LearningHarness({ databasePath: options.databasePath });
	try {
		const coordinator = harness.createStudyExecutionCoordinator({
		coordinatorId: options.coordinatorId,
		adapters: [
			createNativeWindowsNodeAdapter({ runRootDirectory: options.runRootDirectory, cpuRatePercent: 100 }),
			...createNativeWindowsCellAdapters({ runRootDirectory: options.runRootDirectory, cpuRatePercent: 100 }),
			],
			artifactDirectory: options.artifactDirectory,
		});
		if (options.workerIdentity) coordinator.activateDetachedWorker(options.workerIdentity);
		let fenceFailure = null;
		const heartbeat = options.workerIdentity
			? setInterval(() => {
					void Promise.resolve()
						.then(() => coordinator.heartbeatDetachedWorker(options.workerIdentity))
						.catch((error) => {
							fenceFailure = error;
						});
				}, Math.max(100, Math.floor(options.workerIdentity.leaseDurationMs / 3)))
			: null;
		try {
			do {
				if (fenceFailure) throw fenceFailure;
				try {
					const result = await coordinator.tick();
					if (!options.watch || result.claimedJobId !== null || result.reconciledJobIds.length > 0) {
						process.stdout.write(`${JSON.stringify({ observedAt: new Date().toISOString(), ...result })}\n`);
					}
				} catch (error) {
					if (!options.watch) throw error;
					reportError(error, "DETACHED_COORDINATOR_TICK_FAILED");
					if (options.workerIdentity) coordinator.recordDetachedWorkerFailure(options.workerIdentity, error);
				}
				if (options.watch) await delay(options.intervalMs);
			} while (options.watch);
		} finally {
			if (heartbeat) clearInterval(heartbeat);
		}
	} finally {
		harness.close();
	}
}

main().catch((error) => {
	reportError(error, "STUDY_COORDINATOR_FAILED");
	process.exitCode = 1;
});
