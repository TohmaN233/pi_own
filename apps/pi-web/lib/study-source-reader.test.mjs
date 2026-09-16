import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import JSZip from "jszip";

const {
	DEFAULT_STUDY_SOURCE_LIMITS,
	StudySourceLimitError,
	StudySourceReaderError,
	readStudySources,
} = await createJiti(import.meta.url).import("./study-source-reader.ts");

async function withRoot(callback) {
	const root = await mkdtemp(join(tmpdir(), "pi-study-source-reader-"));
	try {
		return await callback(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeText(path, text) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, text, "utf8");
}

function fakePdfExtractor(pageText = "page one\f\\frac{x}{y}\f") {
	return {
		extract: async (_bytes, name) => {
			assert.match(name, /\.pdf$/u);
			return pageText;
		},
	};
}

test("TeX source-first extraction preserves exact source, bounded includes, pages, and version uncertainty", async () => {
	await withRoot(async (root) => {
		const main = [String.raw`\documentclass{article}
\begin{document}
Main formula: $\frac{a}{b}$.
\input{sections/intro}
\include{sections/math}
\end{document}
`, ...Array.from({ length: 90 }, (_, index) => `bounded source line ${index + 1}\n`)].join("");
		await writeText(join(root, "main.tex"), main);
		await writeText(join(root, "sections", "intro.tex"), "Intro exact source with \\$x^2\\$.\n");
		await writeText(join(root, "sections", "math.tex"), "Math macro: \\newcommand{\\R}{\\mathbb{R}}\n");
		await writeFile(join(root, "main.pdf"), Uint8Array.of(0x25, 0x50, 0x44, 0x46));

		const manifest = await readStudySources(root, { entryPath: "main.tex", pdfExtractor: fakePdfExtractor() });
		assert.equal(manifest.mode, "source-first");
		assert.equal(manifest.kind, "tex");
		assert.equal(manifest.path, "main.tex");
		const mainChunks = manifest.chunks.filter((chunk) => chunk.path === "main.tex");
		assert.equal(mainChunks.map((chunk) => chunk.text).join(""), main);
		assert.ok(mainChunks.length > 1, "longer source is split into bounded line chunks");
		assert.ok(mainChunks.every((chunk) => chunk.text.length === 0 || new TextEncoder().encode(chunk.text).byteLength <= 16 * 1024));
		assert.ok(mainChunks.every((chunk) => chunk.location.endLine - chunk.location.startLine + 1 <= 80));
		assert.deepEqual(
			manifest.documents.map((document) => ({ kind: document.kind, role: document.role, path: document.path })),
			[
				{ kind: "tex", role: "primary", path: "main.tex" },
				{ kind: "tex", role: "tex-include", path: "sections/intro.tex" },
				{ kind: "tex", role: "tex-include", path: "sections/math.tex" },
				{ kind: "pdf", role: "linked-pdf", path: "main.pdf" },
			],
		);
		const pdfPages = manifest.chunks.filter((chunk) => chunk.kind === "pdf-page");
		assert.deepEqual(pdfPages.map((chunk) => chunk.location.page), [1, 2]);
		assert.ok(manifest.diagnostics.some((item) => item.code === "LINKED_PDF_VERSION_UNVERIFIED"));
		assert.ok(manifest.diagnostics.some((item) => item.code === "PDF_TEXT_MATH_UNVERIFIED" && item.requiresPdfInspection));
		assert.ok(manifest.dependencies.some((item) => item.path === "sections/intro.tex" && item.status === "included"));
		assert.equal(Object.isFrozen(manifest), true);
		assert.equal(Object.isFrozen(manifest.documents), true);
		assert.equal(Object.isFrozen(manifest.chunks[0]), true);
	});
});

test("TeX include cycle, lexical escape, missing target, and dynamic target remain explicit diagnostics", async () => {
	await withRoot(async (root) => {
		await writeText(join(root, "main.tex"), String.raw`\input{cycle}
\input{../outside}
\input{missing}
\input{\jobname}
`);
		await writeText(join(root, "cycle.tex"), String.raw`\input{main}
`);
		const manifest = await readStudySources(root, { entryPath: "main.tex" });
		const codes = manifest.diagnostics.map((item) => item.code);
		assert.ok(codes.includes("TEX_INCLUDE_CYCLE"));
		assert.ok(codes.includes("TEX_INCLUDE_OUTSIDE_ROOT"));
		assert.ok(codes.includes("TEX_INCLUDE_MISSING"));
		assert.ok(codes.includes("TEX_INCLUDE_INVALID_LITERAL"));
		assert.ok(manifest.dependencies.some((item) => item.status === "cycle"));
		assert.ok(manifest.dependencies.some((item) => item.status === "outside-root"));
		assert.ok(manifest.dependencies.some((item) => item.status === "invalid-literal"));
		const cycleDiagnostic = manifest.diagnostics.find((item) => item.code === "TEX_INCLUDE_CYCLE");
		assert.equal(cycleDiagnostic?.location?.kind, "tex-lines");
	});
});

test("TeX chunks split oversized UTF-8 lines without losing source or line locations", async () => {
	await withRoot(async (root) => {
		const source = `prefix ${"曲线".repeat(200)} suffix\nsecond line\n`;
		await writeText(join(root, "long-line.tex"), source);
		const manifest = await readStudySources(root, {
			entryPath: "long-line.tex",
			limits: { maxChunkBytes: 64, maxChunkLines: 80 },
		});
		assert.equal(manifest.chunks.map((chunk) => chunk.text).join(""), source);
		assert.ok(manifest.chunks.length > 1);
		assert.ok(manifest.chunks.every((chunk) => new TextEncoder().encode(chunk.text).byteLength <= 64));
		assert.ok(manifest.chunks.every((chunk) => chunk.location.endLine - chunk.location.startLine + 1 <= 80));
		assert.ok(manifest.chunks.some((chunk) => chunk.location.startLine === 1 && chunk.location.endLine === 1));
	});
});

test("PDF-only extraction keeps page locations and says math is unverified", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "paper.pdf"), Uint8Array.of(0x25, 0x50, 0x44, 0x46));
		const manifest = await readStudySources(root, { entryPath: "paper.pdf", pdfExtractor: fakePdfExtractor("first page\fsecond page") });
		assert.equal(manifest.mode, "pdf-only");
		assert.equal(manifest.documents.length, 1);
		assert.deepEqual(
			manifest.chunks.map((chunk) => ({ text: chunk.text, page: chunk.location.page, parser: chunk.provenance.parser })),
			[
				{ text: "first page", page: 1, parser: "pdftotext" },
				{ text: "second page", page: 2, parser: "pdftotext" },
			],
		);
		assert.equal(manifest.provenance.math, "unverified-text-layer");
		assert.ok(manifest.diagnostics.some((item) => item.code === "PDF_TEXT_MATH_UNVERIFIED" && item.requiresPdfInspection));
	});
});

test("DOCX preserves paragraph XML and exact OMML instead of flattening formulas", async () => {
	await withRoot(async (root) => {
		const paragraph = String.raw`<w:p><w:r><w:t>A &amp; B</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r><m:r><m:t>²</m:t></m:r></m:oMath></w:p>`;
		const xml = String.raw`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="urn:w" xmlns:m="urn:m"><w:body>${paragraph}<w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>`;
		const zip = new JSZip();
		zip.file("word/document.xml", xml);
		await writeFile(join(root, "paper.docx"), await zip.generateAsync({ type: "uint8array" }));
		const manifest = await readStudySources(root, { entryPath: "paper.docx" });
		const paragraphs = manifest.chunks.filter((chunk) => chunk.kind === "docx-paragraph");
		assert.equal(paragraphs.length, 2);
		assert.equal(paragraphs[0].text, "A & B");
		assert.equal(paragraphs[0].sourceXml, paragraph);
		assert.equal(paragraphs[0].math.length, 1);
		assert.equal(paragraphs[0].math[0].xml, "<m:oMath><m:r><m:t>x</m:t></m:r><m:r><m:t>²</m:t></m:r></m:oMath>");
		assert.deepEqual(paragraphs.map((chunk) => chunk.location.paragraph), [1, 2]);
		assert.ok(manifest.diagnostics.some((item) => item.code === "DOCX_OMML_PRESERVED"));
	});
});

test("DOCX archive and extracted entry bounds are enforced", async () => {
	await withRoot(async (root) => {
		const zip = new JSZip();
		zip.file("word/document.xml", "<w:document xmlns:w=\"urn:w\"><w:body><w:p><w:r><w:t>content</w:t></w:r></w:p></w:body></w:document>");
		zip.file("word/extra.xml", "extra");
		await writeFile(join(root, "paper.docx"), await zip.generateAsync({ type: "uint8array" }));
		await assert.rejects(
			readStudySources(root, { entryPath: "paper.docx", limits: { maxArchiveEntries: 1 } }),
			(error) => error instanceof StudySourceLimitError && error.code === "MAX_ARCHIVE_ENTRIES",
		);
		await assert.rejects(
			readStudySources(root, { entryPath: "paper.docx", limits: { maxFileBytes: 64 } }),
			(error) => error instanceof StudySourceLimitError && ["MAX_FILE_BYTES", "MAX_TOTAL_BYTES"].includes(error.code),
		);
	});
});

test("file count, depth, total input, output, and unknown encoding bounds fail explicitly", async () => {
	await withRoot(async (root) => {
		await writeText(join(root, "main.tex"), "\\input{deep/part}\n");
		await writeText(join(root, "deep", "part.tex"), "part\n");
		await assert.rejects(
			readStudySources(root, { entryPath: "main.tex", limits: { maxFiles: 1 } }),
			(error) => error instanceof StudySourceLimitError && error.code === "MAX_FILES",
		);
		const depthLimited = await readStudySources(root, { entryPath: "main.tex", limits: { maxDepth: 0 } });
		assert.ok(depthLimited.diagnostics.some((item) => item.code === "MAX_DEPTH"));
		await assert.rejects(
			readStudySources(root, { entryPath: "main.tex", limits: { maxTotalBytes: 1 } }),
			(error) => error instanceof StudySourceLimitError && error.code === "MAX_TOTAL_BYTES",
		);
		await assert.rejects(
			readStudySources(root, { entryPath: "main.tex", limits: { maxOutputBytes: 1 } }),
			(error) => error instanceof StudySourceLimitError && error.code === "MAX_OUTPUT_BYTES",
		);
	});

	await withRoot(async (root) => {
		await writeFile(join(root, "bad.tex"), Uint8Array.of(0xff, 0xfe, 0xfd));
		await assert.rejects(
			readStudySources(root, { entryPath: "bad.tex" }),
			(error) => error instanceof StudySourceReaderError && error.code === "UNKNOWN_ENCODING",
		);
	});
});

test("content hashes identify immutable snapshots and changed content gets a new identity", async () => {
	await withRoot(async (root) => {
		const sourcePath = join(root, "main.tex");
		await writeText(sourcePath, "first\n");
		const first = await readStudySources(root, { entryPath: "main.tex" });
		const firstHash = first.hash;
		await writeText(sourcePath, "second\n");
		const second = await readStudySources(root, { entryPath: "main.tex" });
		assert.notEqual(second.hash, firstHash);
		assert.equal(first.chunks.map((chunk) => chunk.text).join(""), "first\n");
		assert.equal(second.chunks.map((chunk) => chunk.text).join(""), "second\n");
		assert.equal(first.limits.maxFiles, DEFAULT_STUDY_SOURCE_LIMITS.maxFiles);
	});
});

test("legacy .doc is rejected and an explicit outside entry cannot escape root", async () => {
	await withRoot(async (root) => {
		await writeFile(join(root, "paper.doc"), "legacy");
		await assert.rejects(
			readStudySources(root, { entryPath: "paper.doc" }),
			(error) => error instanceof StudySourceReaderError && error.code === "LEGACY_DOC_UNSUPPORTED",
		);
		await assert.rejects(
			readStudySources(root, { entryPath: "../outside.tex" }),
			(error) => error instanceof StudySourceReaderError && error.code === "SOURCE_OUTSIDE_ROOT",
		);
	});
});

test("explicit real TeX and PDF inputs are read-only smoke evidence when configured", { timeout: 120_000 }, async (t) => {
	const smokeRoot = process.env.PI_STUDY_SOURCE_SMOKE_ROOT;
	if (!smokeRoot) {
		t.skip("PI_STUDY_SOURCE_SMOKE_ROOT is not configured");
		return;
	}
	const texPath = join(smokeRoot, "main.tex");
	const pdfPath = join(smokeRoot, "main.pdf");
	let texBytes;
	let pdfBytes;
	try {
		texBytes = await readFile(texPath);
		pdfBytes = await readFile(pdfPath);
	} catch {
		t.skip("configured smoke inputs are not available");
		return;
	}
	const before = { tex: texBytes.byteLength, pdf: pdfBytes.byteLength };
	const texManifest = await readStudySources(smokeRoot, { entryPath: "main.tex" });
	assert.equal(texManifest.kind, "tex");
	assert.equal(texManifest.path, "main.tex");
	assert.equal(texManifest.bytes, before.tex);
	assert.ok(texManifest.chunks.some((chunk) => chunk.location.kind === "tex-lines"));
	const pdfManifest = await readStudySources(smokeRoot, { entryPath: "main.pdf" });
	assert.equal(pdfManifest.mode, "pdf-only");
	assert.equal(pdfManifest.bytes, before.pdf);
	assert.ok(pdfManifest.chunks.some((chunk) => chunk.location.kind === "pdf-page"));
});
