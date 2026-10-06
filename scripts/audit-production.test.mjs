import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProductionAudit } from "./audit-production.mjs";

function fixture() {
	return {
		report: {
			auditReportVersion: 2,
			vulnerabilities: {
				"node-forge": {
					name: "node-forge", severity: "high", isDirect: false, fixAvailable: false,
					nodes: ["node_modules/node-forge"], effects: ["@earendil-works/gondolin"],
					via: [{ name: "node-forge", url: "https://github.com/advisories/GHSA-86w9-cpqp-85rv", severity: "high" }],
				},
				"@earendil-works/gondolin": {
					name: "@earendil-works/gondolin", severity: "high", fixAvailable: false,
					nodes: ["node_modules/@earendil-works/gondolin"], via: ["node-forge"],
				},
			},
		},
		lock: { packages: {
			"node_modules/node-forge": { version: "1.4.0" },
			"node_modules/@earendil-works/gondolin": { version: "0.12.0", dependencies: { "node-forge": "^1.3.3" } },
			"packages/coding-agent/examples/extensions/gondolin": { dependencies: { "@earendil-works/gondolin": "0.12.0" } },
		} },
	};
}

test("the exact unfixable Gondolin advisory stays reported without blocking unrelated production checks", () => {
	const { report, lock } = fixture(), original = structuredClone(report);
	assert.deepEqual(evaluateProductionAudit(report, lock), { reviewed: ["node-forge", "@earendil-works/gondolin"], failures: [] });
	assert.deepEqual(report, original);
});

test("new advisories, available fixes, changed versions or consumers must not inherit the exception", () => {
	for (const change of [
		({ report }) => { report.vulnerabilities["node-forge"].via[0].url = "https://github.com/advisories/GHSA-new-advisory"; },
		({ report }) => { report.vulnerabilities["node-forge"].fixAvailable = true; },
		({ report }) => { report.vulnerabilities["node-forge"].via.push({ name: "node-forge", url: "https://github.com/advisories/GHSA-other", severity: "high" }); },
		({ lock }) => { lock.packages["node_modules/node-forge"].version = "1.4.1"; },
		({ lock }) => { lock.packages["node_modules/@earendil-works/gondolin"].version = "0.13.0"; },
		({ lock }) => { lock.packages["node_modules/other"] = { dependencies: { "node-forge": "1.4.0" } }; },
		({ lock }) => { lock.packages["apps/pi-web"] = { dependencies: { "@earendil-works/gondolin": "0.12.0" } }; },
		({ report }) => { report.vulnerabilities["@earendil-works/gondolin"].via.push("other"); },
	]) {
		const state = fixture(); change(state);
		assert.ok(evaluateProductionAudit(state.report, state.lock).failures.length > 0);
	}
});

test("fixable source-map findings still fail, and invalid registry reports fail visibly", () => {
	const { report, lock } = fixture();
	report.vulnerabilities["source-map-js"] = { severity: "high", via: [{ url: "https://github.com/advisories/GHSA-68fv-2mgg-jv7q" }], fixAvailable: true };
	assert.deepEqual(evaluateProductionAudit(report, lock).failures, ["source-map-js"]);
	assert.throws(() => evaluateProductionAudit({ error: { code: "EAUDIT" } }, lock), /Invalid npm audit/);
	assert.throws(() => evaluateProductionAudit({ auditReportVersion: 2, vulnerabilities: { bad: { severity: "unknown", via: [] } } }, lock), /Malformed/);
});
