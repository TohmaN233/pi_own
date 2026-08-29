import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const identity = JSON.parse(readFileSync(new URL("../docs/learning-harness-upstream-identity.json", import.meta.url), "utf8"));
const codingAgent = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("learning harness baseline matches frozen Pi source fingerprints", () => {
	assert.equal(identity.version, 1);
	assert.equal(identity.pi.upstream, "earendil-works/pi");
	assert.match(identity.pi.baselineCommit, /^[0-9a-f]{40}$/);
	for (const [path, expectedSha] of Object.entries(identity.pi.baselineFingerprints)) {
		assert.equal(git("hash-object", "--", path), expectedSha, `baseline drift: ${path}`);
	}
});

test("learning harness baseline records the current Pi coding-agent version", () => {
	assert.equal(codingAgent.version, identity.pi.codingAgentVersion);
});

test("frontend baseline is recorded but not falsely marked integrated", () => {
	assert.equal(identity.piWeb.plannedVersion, "0.8.11");
	assert.equal(identity.piWeb.plannedBaselineCommit, "28bab3c25f5f6770c9b0b745ebbfec1c27f7b948");
	assert.equal(identity.piWeb.integrated, false);
});

test("architecture plan remains present at the frozen path", () => {
	const plan = readFileSync(new URL(`../${identity.plan}`, import.meta.url), "utf8");
	assert.match(plan, /^# Pi Learning Harness：详细架构与实施计划/m);
});
