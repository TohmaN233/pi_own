import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const identity = JSON.parse(readFileSync(new URL("../docs/learning-harness-upstream-identity.json", import.meta.url), "utf8"));
const codingAgent = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitObjectHashes(paths) {
	return execFileSync("git", ["hash-object", "--stdin-paths"], {
		encoding: "utf8",
		input: `${paths.join("\n")}\n`,
		stdio: ["pipe", "pipe", "pipe"],
	}).trim().split(/\r?\n/);
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

test("frontend baseline is vendored at the frozen Pi Web identity", () => {
	assert.equal(identity.piWeb.plannedVersion, "0.8.11");
	assert.equal(identity.piWeb.plannedBaselineCommit, "28bab3c25f5f6770c9b0b745ebbfec1c27f7b948");
	assert.equal(identity.piWeb.integrated, true);
	assert.equal(identity.piWeb.vendoredPath, "apps/pi-web");
	const manifest = JSON.parse(readFileSync(join(root, identity.piWeb.manifest), "utf8"));
	assert.equal(manifest.commit, identity.piWeb.plannedBaselineCommit);
	assert.equal(manifest.tree, identity.piWeb.upstreamTree);
	assert.equal(manifest.files.length, 451);
	const modified = new Set(identity.piWeb.downstreamModifiedPaths);
	for (const path of modified) assert.ok(manifest.files.some((file) => file.path === path), `unknown downstream path: ${path}`);
	const relativePaths = manifest.files.map((file) => `${identity.piWeb.vendoredPath}/${file.path}`);
	const hashes = gitObjectHashes(relativePaths);
	assert.equal(hashes.length, manifest.files.length);
	for (const [index, file] of manifest.files.entries()) {
		const path = join(root, relativePaths[index]);
		assert.ok(existsSync(path), `missing vendored Pi Web file: ${file.path}`);
		if (modified.has(file.path)) continue;
		assert.equal(hashes[index], file.blob, `unexpected Pi Web upstream drift: ${file.path}`);
	}
});

test("architecture plan remains present at the frozen path", () => {
	const plan = readFileSync(new URL(`../${identity.plan}`, import.meta.url), "utf8");
	assert.match(plan, /^# Pi Learning Harness：详细架构与实施计划/m);
});
