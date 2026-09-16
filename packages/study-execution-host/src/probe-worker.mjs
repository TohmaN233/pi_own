import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [mode, artifactDirectory, token] = process.argv.slice(2);

if (!mode || !artifactDirectory || !token) {
	throw new Error("Probe worker requires mode, artifact directory, and token.");
}

if (mode === "launcher") {
	const worker = spawn(process.execPath, ["--max-old-space-size=32", process.argv[1], "worker", artifactDirectory, token], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	worker.once("error", (error) => {
		throw error;
	});
	worker.once("spawn", () => {
		worker.unref();
		process.stdout.write(`${JSON.stringify({ version: 1, token, workerPid: worker.pid })}\n`);
	});
} else if (mode === "worker") {
	const grandchild = spawn(process.execPath, ["--max-old-space-size=32", process.argv[1], "grandchild", artifactDirectory, token], {
		stdio: "ignore",
		windowsHide: true,
	});
	grandchild.once("error", (error) => {
		throw error;
	});
	grandchild.once("spawn", () => {
		const heartbeatPath = resolve(artifactDirectory, "heartbeat.txt");
		const heartbeat = () => writeFileSync(heartbeatPath, `${Date.now()}\n`, "utf8");
		heartbeat();
		writeFileSync(
			resolve(artifactDirectory, "ready.json"),
			`${JSON.stringify({ version: 1, token, workerPid: process.pid, grandchildPid: grandchild.pid })}\n`,
			"utf8",
		);
		setInterval(heartbeat, 50);
		setTimeout(() => process.exit(0), 5_000);
	});
} else if (mode === "grandchild") {
	setTimeout(() => process.exit(0), 5_000);
} else {
	throw new Error(`Unknown probe worker mode: ${mode}`);
}
