import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const forgeAdvisory = "https://github.com/advisories/GHSA-86w9-cpqp-85rv";
const severities = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** Preserve the full report; only the documented, unfixable example advisory is reviewed. */
export function evaluateProductionAudit(report, lock) {
	if (report.auditReportVersion !== 2 || !report.vulnerabilities || report.error) {
		throw new Error(`Invalid npm audit report: ${JSON.stringify(report.error ?? report)}`);
	}
	const reviewed = new Set();
	const forge = report.vulnerabilities["node-forge"], gondolin = report.vulnerabilities["@earendil-works/gondolin"];
	const packages = lock.packages ?? {};
	const forgeConsumers = Object.entries(packages).filter(([, entry]) => entry.dependencies?.["node-forge"] || entry.optionalDependencies?.["node-forge"] || entry.peerDependencies?.["node-forge"]).map(([path]) => path);
	const gondolinConsumers = Object.entries(packages).filter(([, entry]) => entry.dependencies?.["@earendil-works/gondolin"] || entry.optionalDependencies?.["@earendil-works/gondolin"] || entry.peerDependencies?.["@earendil-works/gondolin"]).map(([path]) => path);
	if (packages["node_modules/node-forge"]?.version === "1.4.0"
		&& packages["node_modules/@earendil-works/gondolin"]?.version === "0.12.0"
		&& JSON.stringify(forgeConsumers) === JSON.stringify(["node_modules/@earendil-works/gondolin"])
		&& JSON.stringify(gondolinConsumers) === JSON.stringify(["packages/coding-agent/examples/extensions/gondolin"])
		&& forge?.name === "node-forge" && forge.isDirect === false && forge.fixAvailable === false
		&& forge.via?.length === 1 && forge.via[0].name === "node-forge" && forge.via[0].url === forgeAdvisory
		&& forge.severity === "high" && JSON.stringify(forge.nodes) === JSON.stringify(["node_modules/node-forge"])
		&& gondolin?.name === "@earendil-works/gondolin" && gondolin.severity === "high" && gondolin.fixAvailable === false
		&& JSON.stringify(gondolin.via) === JSON.stringify(["node-forge"])
		&& JSON.stringify(gondolin.nodes) === JSON.stringify(["node_modules/@earendil-works/gondolin"])) {
		reviewed.add("node-forge"); reviewed.add("@earendil-works/gondolin");
	}
	const failures = [];
	for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
		if (!(vulnerability.severity in severities) || !Array.isArray(vulnerability.via)) {
			throw new Error(`Malformed npm audit entry: ${name}`);
		}
		if (reviewed.has(name) || severities[vulnerability.severity] < severities.moderate) continue;
		failures.push(name);
	}
	return { reviewed: [...reviewed], failures };
}

export function auditProduction(cwd = process.cwd()) {
	const args = ["audit", "--omit=dev", "--audit-level=moderate", "--json"];
	const result = spawnSync(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm audit --omit=dev --audit-level=moderate --json"] : args, {
		cwd,
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.signal || ![0, 1].includes(result.status)) {
		throw new Error(`npm audit failed (${result.status ?? result.signal}): ${result.stderr || result.stdout}`);
	}
	const report = JSON.parse(result.stdout);
	const lock = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8"));
	const decision = evaluateProductionAudit(report, lock);
	mkdirSync(resolve(cwd, ".artifacts"), { recursive: true });
	writeFileSync(resolve(cwd, ".artifacts/npm-audit-production.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
	if (decision.reviewed.length) {
		console.warn(`Known upstream advisory without a published fix: ${forgeAdvisory}; ${decision.reviewed.join(", ")}. See docs/DEPENDENCY_AUDIT.md.`);
	}
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Production audit: ${decision.failures.length} blocking entries, ${decision.reviewed.length} reviewed upstream entries.\n\n${decision.reviewed.length ? `Known advisory: ${forgeAdvisory}. No published fix; limited to the documented Gondolin example dependency.\n` : ""}`);
	}
	if (decision.failures.length) throw new Error(`Production dependency audit failed: ${decision.failures.join(", ")}`);
	console.log("Production audit passed; complete findings remain in the report.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) auditProduction();
