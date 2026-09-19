import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileStudyCellProgram } from "../packages/study-execution-host/src/cell-program.ts";
import { detectStudyPlatform } from "../packages/study-execution-host/src/platform.ts";

test("deterministic R/Python cell glue preserves literal parameters, input aliases, errors and actual graphics", { skip: process.platform !== "win32" }, (t) => {
	const directory = mkdtempSync(join(tmpdir(), "study-cell-program-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "input-0.csv"), "1,2,4\n");
	const parameters = { seed: 42, text: 'quote " ; system("not executable") \\ 中文', nested: [true, null, 3.5] };
	const platform = detectStudyPlatform(process.cwd());
	for (const language of ["python", "r"]) {
		const code = language === "python" ? 'print(parameters["seed"])\nprint(open(inputs["sample.csv"]).read().strip())\nprint(parameters["text"])' : 'print(parameters$seed)\nprint(readLines(inputs[["sample.csv"]]))\ncat(parameters$text)\nplot(1:3, c(1,2,4))';
		const input = { language, code, parameters, inputs: [{ name: "sample.csv", fileName: "input-0.csv" }] };
		const compiled = compileStudyCellProgram(input);
		assert.deepEqual(compiled, compileStudyCellProgram(input));
		const path = join(directory, compiled.fileName);
		writeFileSync(path, compiled.program);
		const executable = language === "r" ? platform.executables.rscript.executablePath : platform.executables.python.executablePath;
		assert.ok(executable, `${language} executable is required for this integration test`);
		const run = spawnSync(executable, [path], { cwd: directory, encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, R_COMPAT_PROGRAM: path } });
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /42/); assert.match(run.stdout, /1,2,4/); assert.match(run.stdout, /not executable/);
		if (language === "r") assert.equal(readFileSync(join(directory, "plot-001.png")).subarray(1, 4).toString(), "PNG");
		const broken = compileStudyCellProgram({ ...input, code: language === "r" ? 'stop("intentional failure")' : 'raise RuntimeError("intentional failure")' });
		writeFileSync(path, broken.program);
		const failed = spawnSync(executable, [path], { cwd: directory, encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, R_COMPAT_PROGRAM: path } });
		assert.notEqual(failed.status, 0); assert.match(failed.stderr, /intentional failure/);
	}
	assert.throws(() => compileStudyCellProgram({ language: "r", code: "1", parameters: { value: NaN }, inputs: [] }), /finite JSON/);
	assert.throws(() => compileStudyCellProgram({ language: "python", code: "1", parameters: {}, inputs: [{ name: "x", fileName: "../secret" }] }), /portable/);
});
