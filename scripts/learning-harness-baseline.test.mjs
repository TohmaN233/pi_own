import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const identity = JSON.parse(readFileSync(new URL("../docs/learning-harness-upstream-identity.json", import.meta.url), "utf8"));
const codingAgent = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));
const piWebPackage = JSON.parse(readFileSync(new URL("../apps/pi-web/package.json", import.meta.url), "utf8"));
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const frozenPiBaselineFingerprints = {
	"README.md": "ef6ed4ba084650320493c6bf566c2ee54f924b7e",
	"package.json": "e5316de862ec1f649c6e6bfc1d5dc69f9913c864",
	"tsconfig.base.json": "57e97d6e361d1473ceecc4ce65ea1a7ccb6d94bf",
	"packages/coding-agent/package.json": "8aa47351db845e14d68615a4250705faaf7bdcfb",
};

function git(...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitObjectHashes(paths) {
	if (paths.length === 0) return [];
	return execFileSync("git", ["hash-object", "--stdin-paths"], {
		cwd: root,
		encoding: "utf8",
		input: `${paths.join("\n")}\n`,
		stdio: ["pipe", "pipe", "pipe"],
	})
		.trim()
		.split(/\r?\n/);
}

function assertBaselineOverlay({ label, originalFingerprints, currentPrefix, changedFingerprints, removedPaths }) {
	const original = new Map(Object.entries(originalFingerprints));
	const changed = new Map(Object.entries(changedFingerprints));
	const removed = new Set(removedPaths);

	assert.equal(removed.size, removedPaths.length, `${label} removed paths must be unique`);
	for (const [path, currentFingerprint] of changed) {
		assert.ok(original.has(path), `${label} changed path is not present in its original manifest: ${path}`);
		assert.match(currentFingerprint, /^[0-9a-f]{40}$/, `${label} changed fingerprint is invalid: ${path}`);
		assert.notEqual(currentFingerprint, original.get(path), `${label} changed fingerprint must differ from upstream: ${path}`);
		assert.ok(!removed.has(path), `${label} path cannot be both changed and removed: ${path}`);
	}
	for (const path of removed) {
		assert.ok(original.has(path), `${label} removed path is not present in its original manifest: ${path}`);
	}

	const presentPaths = [];
	const expectedFingerprints = [];
	for (const [path, originalFingerprint] of original) {
		assert.match(originalFingerprint, /^[0-9a-f]{40}$/, `${label} original fingerprint is invalid: ${path}`);
		const relativePath = currentPrefix ? join(currentPrefix, path) : path;
		const absolutePath = join(root, relativePath);
		if (removed.has(path)) {
			assert.equal(existsSync(absolutePath), false, `${label} removed path still exists: ${path}`);
			continue;
		}
		assert.equal(existsSync(absolutePath), true, `${label} original path is missing without a removal record: ${path}`);
		presentPaths.push(relativePath);
		expectedFingerprints.push(changed.get(path) ?? originalFingerprint);
	}

	const actualFingerprints = gitObjectHashes(presentPaths);
	assert.equal(actualFingerprints.length, expectedFingerprints.length, `${label} fingerprint count mismatch`);
	for (const [index, expectedFingerprint] of expectedFingerprints.entries()) {
		assert.equal(actualFingerprints[index], expectedFingerprint, `${label} unexpected current bytes: ${presentPaths[index]}`);
	}
}

test("learning harness preserves its public PiOwn baseline and fingerprints downstream edits", () => {
	assert.equal(identity.version, 1);
	assert.equal(identity.repository, "TohmaN233/pi_own");
	assert.equal(identity.pi.upstream, "earendil-works/pi");
	assert.equal(identity.pi.baselineCommit, "853a80d26c90a14c1886f0ebb8ffaae133ca2185");
	assert.deepEqual(identity.pi.baselineFingerprints, frozenPiBaselineFingerprints);
	assert.deepEqual(identity.pi.baselineFingerprintSource, {
		repository: "TohmaN233/pi_own",
		commit: "7db59006c9f45c944dc548f3ac2e3c88d14ff526",
		tree: "0dcff84ed0c0b06b65f3846ba7e85047808ad14e",
	});
	assert.equal(identity.pi.upstreamTree, "51833874449fe8ec0b1381496592cc54d0a77e8f");
	assert.deepEqual(Object.keys(identity.pi.downstreamChangeNotes).sort(), Object.keys(identity.pi.downstreamChangedFingerprints).sort());
	for (const note of Object.values(identity.pi.downstreamChangeNotes)) {
		assert.ok(note.trim().length > 0, "each Pi downstream change needs provenance");
	}
	assertBaselineOverlay({
		label: "Pi root",
		originalFingerprints: identity.pi.baselineFingerprints,
		currentPrefix: "",
		changedFingerprints: identity.pi.downstreamChangedFingerprints,
		removedPaths: identity.pi.downstreamRemovedPaths,
	});
});

test("learning harness keeps the Pi coding-agent version at the frozen upstream version", () => {
	assert.equal(identity.pi.codingAgentVersion, "0.84.4");
	assert.equal(codingAgent.version, "0.84.4");
});

test("Pi Web overlay is explicit against its immutable public source manifest", () => {
	assert.equal(identity.piWeb.upstream, "agegr/pi-web");
	assert.equal(identity.piWeb.plannedVersion, "0.8.11");
	assert.equal(identity.piWeb.plannedBaselineCommit, "28bab3c25f5f6770c9b0b745ebbfec1c27f7b948");
	assert.equal(identity.piWeb.integrated, true);
	assert.equal(identity.piWeb.vendoredPath, "apps/pi-web");
	assert.equal(identity.piWeb.downstreamSdkVersion, "1.0.4");
	assert.equal(piWebPackage.version, identity.piWeb.plannedVersion);
	for (const packageName of [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	]) {
		assert.equal(piWebPackage.dependencies[packageName], "1.0.4", `${packageName} is a downstream SDK version`);
	}
	assert.ok(identity.piWeb.downstreamChangeSummary.trim().length > 0, "Pi Web downstream changes need provenance");

	const manifestPath = join(root, identity.piWeb.manifest);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.equal(identity.piWeb.manifest, "docs/pi-web-upstream-manifest.json");
	assert.equal(identity.piWeb.upstreamTree, "51cdc97801ea0f8316ee6fd19ab0adcc7a8b0204");
	assert.equal(identity.piWeb.manifestFingerprint, "d5b2b47980389f5932a9340dbf000ce46c797843");
	assert.equal(git("hash-object", "--", identity.piWeb.manifest), identity.piWeb.manifestFingerprint);
	assert.equal(manifest.version, 1);
	assert.equal(manifest.upstream, identity.piWeb.upstream);
	assert.equal(manifest.commit, identity.piWeb.plannedBaselineCommit);
	assert.equal(manifest.tree, identity.piWeb.upstreamTree);
	assert.equal(manifest.files.length, 451);

	const originalFingerprints = Object.fromEntries(manifest.files.map((file) => [file.path, file.blob]));
	assert.equal(Object.keys(originalFingerprints).length, manifest.files.length, "upstream manifest paths must be unique");
	assert.deepEqual(
		[...identity.piWeb.downstreamModifiedPaths].sort(),
		Object.keys(identity.piWeb.downstreamChangedFingerprints).sort(),
		"summary of modified paths must match the pinned downstream fingerprints",
	);
	assertBaselineOverlay({
		label: "Pi Web",
		originalFingerprints,
		currentPrefix: identity.piWeb.vendoredPath,
		changedFingerprints: identity.piWeb.downstreamChangedFingerprints,
		removedPaths: identity.piWeb.downstreamRemovedPaths,
	});
});

test("architecture plan remains present at the frozen path", () => {
	const plan = readFileSync(new URL(`../${identity.plan}`, import.meta.url), "utf8");
	assert.match(plan, /^# Pi Learning Harness：详细架构与实施计划/m);
});
