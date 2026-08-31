import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CourseHost, CourseHostError, PdftotextExtractor } from "../packages/course-host/src/index.ts";

test("PdftotextExtractor bounds subprocess input, time, output, and downstream course state", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-learning-pdf-limits-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const helperPath = join(root, "pdftotext-helper.mjs");
	writeFileSync(
		helperPath,
		`import { writeFile } from "node:fs/promises";
if (process.env.PDF_HELPER_MODE === "timeout") await new Promise((resolve) => setTimeout(resolve, 2_000));
if (process.env.PDF_HELPER_MODE === "stderr") process.stderr.write("x".repeat(2_000));
const text = process.env.PDF_HELPER_MODE === "large" ? "x".repeat(2_000) : "Extracted PDF lesson text.";
process.stdout.write(text);
`,
		"utf8",
	);
	const createExtractor = (mode, limits = {}) => new PdftotextExtractor({
		command: process.execPath,
		commandArguments: [helperPath],
		env: { ...process.env, PDF_HELPER_MODE: mode },
		maxInputBytes: 128,
		maxOutputBytes: 4_096,
		timeoutMs: 3_000,
		...limits,
	});

	await assert.rejects(
		createExtractor("normal", { maxInputBytes: 3 }).extract(new Uint8Array([1, 2, 3, 4]), "oversize.pdf"),
		(error) => error instanceof CourseHostError && error.code === "PDF_INPUT_TOO_LARGE",
	);
	await assert.rejects(
		createExtractor("large", { maxOutputBytes: 1_000 }).extract(new Uint8Array([1]), "large.pdf"),
		(error) => error instanceof CourseHostError && error.code === "PDF_OUTPUT_TOO_LARGE",
	);
	await assert.rejects(
		createExtractor("stderr", { maxSubprocessOutputBytes: 1_024 }).extract(new Uint8Array([1]), "noisy.pdf"),
		(error) => error instanceof CourseHostError && error.code === "PDF_SUBPROCESS_OUTPUT_TOO_LARGE",
	);
	await assert.rejects(
		createExtractor("timeout", { timeoutMs: 100 }).extract(new Uint8Array([1]), "slow.pdf"),
		(error) => error instanceof CourseHostError && error.code === "PDF_EXTRACTION_TIMEOUT",
	);
	assert.equal((await createExtractor("large").extract(new Uint8Array([1]), "large-text.pdf")).length, 2_000);
	await assert.rejects(
		new PdftotextExtractor("missing-pdftotext-command").extract(new Uint8Array([1]), "missing.pdf"),
		(error) => error instanceof CourseHostError && error.code === "PDF_EXTRACTION_OPERATION_FAILED",
	);

	const host = new CourseHost();
	await assert.rejects(
		host.publishVersion(
			"pdf-text-limit",
			[{ name: "lesson.pdf", kind: "pdf", mediaType: "application/pdf", content: new Uint8Array([1]) }],
			{ pdfTextExtractor: createExtractor("large"), maxPdfTextCharacters: 1_000 },
		),
		(error) => error instanceof CourseHostError && error.code === "PDF_TEXT_TOO_LARGE",
	);
	await assert.rejects(
		host.publishVersion(
			"course-text-limit",
			[{ name: "lesson.txt", kind: "text", mediaType: "text/plain", content: "x".repeat(1_001) }],
			{ maxCourseTextCharacters: 1_000 },
		),
		(error) => error instanceof CourseHostError && error.code === "COURSE_TEXT_TOO_LARGE",
	);
	await assert.rejects(
		host.publishVersion(
			"course-span-limit",
			[{ name: "lesson.txt", kind: "text", mediaType: "text/plain", content: `${"x".repeat(200)}\n${"x".repeat(200)}` }],
			{ maxSpanCharacters: 200, maxCourseSpans: 1 },
		),
		(error) => error instanceof CourseHostError && error.code === "COURSE_SPAN_LIMIT",
	);
});
