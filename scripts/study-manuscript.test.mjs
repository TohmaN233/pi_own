import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import JSZip from "../apps/pi-web/node_modules/jszip/lib/index.js";
import { ManuscriptPatchHost, patchDocxDocumentXml, StudyResearchHost } from "../packages/study-research-host/src/index.ts";

const hash = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const execFileAsync = promisify(execFile);
const artifactFixtures = join(process.cwd(), ".artifacts", "study-research", "manuscript-fixes", "fixtures");

async function docxAdapter(bytes, operations, date) {
	const source = await JSZip.loadAsync(bytes, { checkCRC32: true });
	const document = source.file("word/document.xml");
	if (!document) throw new Error("DOCX package has no word/document.xml");
	const changed = patchDocxDocumentXml(await document.async("string"), operations, date);
	const build = async (xml) => {
		const target = await JSZip.loadAsync(bytes, { checkCRC32: true });
		target.file("word/document.xml", xml, { binary: false, compression: "DEFLATE" });
		return target.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	};
	return { candidate: await build(changed.candidateXml), clean: await build(changed.cleanXml) };
}

async function makeDocx() {
	const zip = new JSZip();
	zip.file("[Content_Types].xml", [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
		'<Default Extension="xml" ContentType="application/xml"/>',
		'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
		'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
		'<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
		'</Types>',
	].join(""));
	zip.file("_rels/.rels", [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
		'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
		'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
		'</Relationships>',
	].join(""));
	zip.file("word/_rels/document.xml.rels", [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
		'</Relationships>',
	].join(""));
	zip.file("docProps/core.xml", [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
		'<dc:title>Study manuscript fixture</dc:title><dc:creator>Pi</dc:creator>',
		'<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-12T00:00:00Z</dcterms:created>',
		'<dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-12T00:00:00Z</dcterms:modified>',
		'</cp:coreProperties>',
	].join(""));
	zip.file("docProps/app.xml", [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office Word</Application></Properties>',
	].join(""));
	zip.file("word/styles.xml", [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
		'<w:docDefaults><w:rPrDefault><w:rPr/></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>',
		'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
		'</w:styles>',
	].join(""));
	zip.file("word/custom.xml", "<custom>unchanged</custom>");
	zip.file("word/document.xml", [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml" xmlns:w16du="http://schemas.microsoft.com/office/word/2023/wordml/word16du" xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/word16sdtdh" xmlns:w16sdtfl="http://schemas.microsoft.com/office/word/2024/word16sdtfl" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="w14 w15 w16se w16cid w16">',
		"<w:body>",
		"<w:p><w:pPr><w:pStyle w:val=\"Normal\"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Old</w:t></w:r></w:p>",
		"<w:p><w:pPr><w:pStyle w:val=\"Normal\"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>Anchor</w:t></w:r></w:p>",
		"<w:p><w:pPr><w:pStyle w:val=\"Normal\"/></w:pPr><w:r><w:t>Remove</w:t></w:r></w:p>",
		"<w:p><m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath></w:p>",
		"<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/><w:cols w:space=\"708\"/><w:docGrid w:linePitch=\"360\"/></w:sectPr>",
		"</w:body></w:document>",
	].join(""));
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function fixture(kind, bytes, storageRootOrOptions = null) {
	const options = typeof storageRootOrOptions === "string"
		? { storageRoot: storageRootOrOptions }
		: storageRootOrOptions ?? {};
	await mkdir(artifactFixtures, { recursive: true });
	const root = await mkdtemp(join(artifactFixtures, "study-manuscript-"));
	const file = join(root, kind === "tex" ? "main.tex" : "main.docx");
	await writeFile(file, bytes);
	await writeFile(join(root, "original." + (kind === "tex" ? "tex" : "docx")), bytes);
	const database = new DatabaseSync(":memory:");
	database.exec("CREATE TABLE pi_project_workspace (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE pi_project_member (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
	database.prepare("INSERT INTO pi_project_workspace VALUES (?, ?)").run("project", JSON.stringify({ id: "project" }));
	database.prepare("INSERT INTO pi_project_member VALUES (?, ?)").run("session", "project");
	const study = new StudyResearchHost(database);
	study.bindSession("project", "session", "research");
	const scope = { projectId: "project", sessionId: "session", expectedPhaseRevision: 1 };
	const source = study.registerSource(scope, {
		sourceRoot: root,
		relativePath: kind === "tex" ? "main.tex" : "main.docx",
		kind,
		sourceRole: "primary",
		contentHash: hash(bytes),
		parser: "fixture/v1",
		diagnostics: [],
		chunks: [{ ordinal: 1, locator: JSON.stringify({ fixture: true }), text: kind === "tex" ? new TextDecoder().decode(bytes) : "Old Anchor Remove" }],
	}, 0);
	const patches = new ManuscriptPatchHost(database, study, {
		storageRoot: options.storageRoot ?? join(root, "artifacts"),
		clock: options.clock,
		publicationHook: options.publicationHook,
	});
	patches.configureDocxAdapter(docxAdapter);
	return {
		root, file, bytes: new Uint8Array(bytes), database, study, scope, source, patches,
		async close() {
			database.close();
		},
	};
}

async function requestAndDraft(f) {
	const request = await f.patches.requestFromUser(f.scope, {
		sourceId: f.source.sourceId,
		sourceHash: f.source.contentHash,
		requestText: "Make the prose more cautious, add a transition, and remove the obsolete sentence.",
		expectedProjectRevision: 1,
	});
	return f.patches.draft(f.scope, {
		patchId: request.patchId,
		expectedPatchRevision: request.revision,
		operations: [
			{ kind: "replace", oldText: "Old", newText: "Cautious", reason: "Avoids an overclaim." },
			{ kind: "add", anchor: "Anchor", position: "after", text: " transition", reason: "Connects the argument." },
			{ kind: "delete", oldText: "Remove", reason: "Obsolete text." },
		],
	});
}

test("TeX candidate uses review colors, clean confirmation, source CAS and durable recovery", async () => {
	const original = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\nOld. Anchor. Remove. $x+y$\n\\end{document}\n");
	const f = await fixture("tex", original);
	try {
		const draft = await requestAndDraft(f);
		assert.equal(draft.status, "draft");
		assert.deepEqual(new Uint8Array(await readFile(f.file)), original, "draft never changes the manuscript");
		const candidate = await f.patches.readCandidate(f.scope, draft.patchId);
		const candidateText = new TextDecoder().decode(candidate.bytes);
		await writeFile(join(f.root, "candidate.tex"), candidate.bytes);
		assert.match(candidateText, /ManuscriptInserted/);
		assert.match(candidateText, /ManuscriptRewritten/);
		assert.match(candidateText, /ManuscriptDeleted/);
		assert.match(candidateText, /x\+y/, "unchanged TeX math remains intact");
		await writeFile(join(f.root, "candidate.tex"), candidate.bytes);
		await execFileAsync("xelatex", ["-interaction=nonstopmode", "-halt-on-error", "candidate.tex"], { cwd: f.root });

		const confirmed = await f.patches.confirmFromUser(f.scope, { patchId: draft.patchId, expectedPatchRevision: draft.revision });
		assert.equal(confirmed.status, "confirmed");
		const clean = new TextDecoder().decode(await readFile(f.file));
		await writeFile(join(f.root, "final.tex"), clean);
		assert.match(clean, /Cautious\. Anchor transition\./);
		assert.equal(clean.includes("Remove"), false);
		assert.equal(clean.includes("Manuscript"), false, "confirmed source has normal TeX, not review macros");

		const recovered = await f.patches.recoverFromUser(f.scope, { patchId: confirmed.patchId, expectedPatchRevision: confirmed.revision });
		assert.equal(recovered.status, "recovered");
		assert.deepEqual(new Uint8Array(await readFile(f.file)), original);
		await writeFile(join(f.root, "recovered.tex"), await readFile(f.file));

		const second = await requestAndDraft(f);
		await writeFile(f.file, "\\documentclass{article}\n\\begin{document}\nHuman edit\n\\end{document}\n");
		await assert.rejects(f.patches.confirmFromUser(f.scope, { patchId: second.patchId, expectedPatchRevision: second.revision }), /bytes changed|source changed/i);
		assert.match(new TextDecoder().decode(await readFile(f.file)), /Human edit/, "conflict never overwrites user bytes");
	} finally {
		await f.close();
	}
});

test("DOCX candidate preserves unrelated entries and OMML with portable explicit review colors", async () => {
	const original = await makeDocx();
	const f = await fixture("docx", original);
	try {
		const draft = await requestAndDraft(f);
		const candidate = await f.patches.readCandidate(f.scope, draft.patchId);
		await writeFile(join(f.root, "candidate.docx"), candidate.bytes);
		const candidateZip = await JSZip.loadAsync(candidate.bytes, { checkCRC32: true });
		const originalZip = await JSZip.loadAsync(original, { checkCRC32: true });
		assert.match(await originalZip.file("[Content_Types].xml").async("string"), /wordprocessingml\.document\.main/);
		assert.match(await originalZip.file("_rels/.rels").async("string"), /officeDocument/);
		assert.match(await originalZip.file("word/_rels/document.xml.rels").async("string"), /relationships\/styles/);
		const originalXml = await originalZip.file("word/document.xml").async("string");
		assert.match(originalXml, /xmlns:w="http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main"/);
		assert.match(originalXml, /<w:sectPr>/);
		assert.match(originalXml, /<m:oMath>/);
		const candidateXml = await candidateZip.file("word/document.xml").async("string");
		assert.equal(candidateXml.includes("<w:ins "), false, "candidate must not defer colors to Word's Track Changes settings");
		assert.equal(candidateXml.includes("<w:del "), false, "candidate deletions are explicit red strike-through runs");
		assert.match(candidateXml, /w:val="168146"/);
		assert.match(candidateXml, /w:val="266BD5"/);
		assert.match(candidateXml, /w:val="C00000"\/><w:strike\/>/);
		assert.match(candidateXml, /<m:oMath>/);
		for (const name of ["word/styles.xml", "word/custom.xml"]) {
			assert.deepEqual(await candidateZip.file(name).async("uint8array"), await originalZip.file(name).async("uint8array"), name + " is unchanged");
		}
		const confirmed = await f.patches.confirmFromUser(f.scope, { patchId: draft.patchId, expectedPatchRevision: draft.revision });
		const cleanZip = await JSZip.loadAsync(await readFile(f.file), { checkCRC32: true });
		await writeFile(join(f.root, "final.docx"), await readFile(f.file));
		const cleanXml = await cleanZip.file("word/document.xml").async("string");
		assert.equal(cleanXml.includes("<w:ins "), false);
		assert.equal(cleanXml.includes("<w:del "), false);
		assert.match(cleanXml, />Cautious</);
		assert.match(cleanXml, /<m:oMath>/);
		for (const name of ["word/styles.xml", "word/custom.xml"]) {
			assert.deepEqual(await cleanZip.file(name).async("uint8array"), await originalZip.file(name).async("uint8array"), name + " remains unchanged after confirmation");
		}
		const recovered = await f.patches.recoverFromUser(f.scope, { patchId: confirmed.patchId, expectedPatchRevision: confirmed.revision });
		assert.equal(recovered.status, "recovered");
		assert.deepEqual(new Uint8Array(await readFile(f.file)), original);
		await writeFile(join(f.root, "recovered.docx"), await readFile(f.file));
	} finally {
		await f.close();
	}
});

test("unsafe formula edits, interrupted writes and durable journal recovery fail visibly", async () => {
	const original = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\nOld. Anchor. Remove. $x+y$\n\\end{document}\n");
	const f = await fixture("tex", original);
	try {
		const request = await f.patches.requestFromUser(f.scope, {
			sourceId: f.source.sourceId, sourceHash: f.source.contentHash, requestText: "Change the equation.", expectedProjectRevision: 1,
		});
		await assert.rejects(f.patches.draft(f.scope, {
			patchId: request.patchId, expectedPatchRevision: request.revision,
			operations: [{ kind: "replace", oldText: "x+y", newText: "x+z", reason: "Formula change." }],
		}), /math/i);
		assert.equal(f.patches.get(f.scope, request.patchId).status, "requested");

		const draft = await requestAndDraft(f);
		const clean = "\\documentclass{article}\n\\begin{document}\nCautious. Anchor transition. . $x+y$\n\\end{document}\n";
		await writeFile(f.file, clean);
		const reconciled = await f.patches.reconcile(f.scope);
		assert.equal(reconciled.find((patch) => patch.patchId === draft.patchId).status, "confirmed", "source replacement before journal commit is reconciled");
		await writeFile(f.file, original);
		const rolledBack = await f.patches.reconcile(f.scope);
		assert.equal(rolledBack.find((patch) => patch.patchId === draft.patchId).status, "recovered", "recovery write before journal commit is reconciled");
	} finally {
		await f.close();
	}

	await mkdir(artifactFixtures, { recursive: true });
	const root = await mkdtemp(join(artifactFixtures, "study-manuscript-write-failure-"));
	try {
		const original = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\nOld\n\\end{document}\n");
		const blocked = join(root, "not-a-directory");
		await writeFile(blocked, "blocking file");
		const f = await fixture("tex", original, blocked);
		try {
			const request = await f.patches.requestFromUser(f.scope, {
				sourceId: f.source.sourceId, sourceHash: f.source.contentHash, requestText: "Revise the sentence.", expectedProjectRevision: 1,
			});
			await assert.rejects(f.patches.draft(f.scope, {
				patchId: request.patchId, expectedPatchRevision: request.revision,
				operations: [{ kind: "replace", oldText: "Old", newText: "New", reason: "Fixture." }],
			}));
			assert.equal(f.patches.get(f.scope, request.patchId).status, "failed", "artifact write failure stays durable and visible");
			assert.deepEqual(new Uint8Array(await readFile(f.file)), original);
		} finally {
			await f.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("TeX comment offsets and every supported math delimiter remain bounded", async () => {
	const original = new TextEncoder().encode([
		"\\documentclass{article}",
		"\\begin{document}",
		"Before % $commented$ \\(commented\\)",
		"Target.",
		"Inline \\(a+b\\).",
		"\\begin{alignat}{2} a &= b \\end{alignat}",
		"\\begin{flalign*} c &= d \\end{flalign*}",
		"\\end{document}",
		"",
	].join("\n"));
	const f = await fixture("tex", original);
	try {
		const request = await f.patches.requestFromUser(f.scope, {
			sourceId: f.source.sourceId,
			sourceHash: f.source.contentHash,
			requestText: "Change only prose after the comment.",
			expectedProjectRevision: 1,
		});
		const draft = await f.patches.draft(f.scope, {
			patchId: request.patchId,
			expectedPatchRevision: request.revision,
			operations: [{ kind: "replace", oldText: "Target", newText: "Revised target", reason: "Clarify prose." }],
		});
		assert.equal(draft.status, "draft");
		const candidate = new TextDecoder().decode((await f.patches.readCandidate(f.scope, draft.patchId)).bytes);
		assert.match(candidate, /Revised target/, "comment masking must retain the original source offsets");
		for (const oldText of ["a+b", "a &= b", "c &= d"]) {
			const next = await f.patches.requestFromUser(f.scope, {
				sourceId: f.source.sourceId,
				sourceHash: f.source.contentHash,
				requestText: "Attempt an unsafe formula edit.",
				expectedProjectRevision: 1,
			});
			await assert.rejects(
				f.patches.draft(f.scope, {
					patchId: next.patchId,
					expectedPatchRevision: next.revision,
					operations: [{ kind: "replace", oldText, newText: "changed", reason: "Fixture formula rejection." }],
				}),
				/math/i,
			);
		}
	} finally {
		await f.close();
	}
});

test("TeX inline dollar scanning counts the full preceding backslash run", async () => {
	const evenEscapes = new TextEncoder().encode([
		"\\documentclass{article}",
		"\\begin{document}",
		String.raw`Before \\$x$ Target.`,
		"\\end{document}",
		"",
	].join("\n"));
	const even = await fixture("tex", evenEscapes);
	try {
		const request = await even.patches.requestFromUser(even.scope, {
			sourceId: even.source.sourceId,
			sourceHash: even.source.contentHash,
			requestText: "Clarify the prose after the line break and inline formula.",
			expectedProjectRevision: 1,
		});
		const draft = await even.patches.draft(even.scope, {
			patchId: request.patchId,
			expectedPatchRevision: request.revision,
			operations: [{ kind: "replace", oldText: "Target", newText: "Revised target", reason: "Clarify prose." }],
		});
		assert.equal(draft.status, "draft", "two backslashes are a TeX line break, so the following dollar starts math");
		const unsafe = await even.patches.requestFromUser(even.scope, {
			sourceId: even.source.sourceId,
			sourceHash: even.source.contentHash,
			requestText: "Attempt an unsafe formula edit.",
			expectedProjectRevision: 1,
		});
		await assert.rejects(
			even.patches.draft(even.scope, {
				patchId: unsafe.patchId,
				expectedPatchRevision: unsafe.revision,
				operations: [{ kind: "replace", oldText: "x", newText: "z", reason: "Must be rejected." }],
			}),
			/math/i,
		);
	} finally {
		await even.close();
	}

	const oddEscapes = new TextEncoder().encode([
		"\\documentclass{article}",
		"\\begin{document}",
		String.raw`Before \$x\$ Target.`,
		"\\end{document}",
		"",
	].join("\n"));
	const odd = await fixture("tex", oddEscapes);
	try {
		const request = await odd.patches.requestFromUser(odd.scope, {
			sourceId: odd.source.sourceId,
			sourceHash: odd.source.contentHash,
			requestText: "Clarify literal dollar prose.",
			expectedProjectRevision: 1,
		});
		const draft = await odd.patches.draft(odd.scope, {
			patchId: request.patchId,
			expectedPatchRevision: request.revision,
			operations: [{ kind: "replace", oldText: "Target", newText: "Revised target", reason: "Clarify prose." }],
		});
		assert.equal(draft.status, "draft", "odd backslashes escape literal dollars");
	} finally {
		await odd.close();
	}
});

test("Word operations use the original baseline, preserve substring anchors, and reject tracked revisions", () => {
	const base = "<w:document xmlns:w=\"w\"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Before Anchor After</w:t></w:r></w:p></w:body></w:document>";
	const changed = patchDocxDocumentXml(base, [
		{ kind: "add", anchor: "Anchor", position: "after", text: " inserted", reason: "Test substring insertion." },
	], "2026-09-12T00:00:00.000Z");
	assert.match(changed.cleanXml, /Before Anchor<\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve"> inserted<\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve"> After/);
	assert.match(changed.candidateXml, /Before Anchor<\/w:t><\/w:r><w:r><w:rPr><w:color w:val="168146"\/><w:b\/><\/w:rPr><w:t xml:space="preserve"> inserted/);
	assert.equal(changed.candidateXml.includes("<w:ins "), false);
	assert.throws(
		() => patchDocxDocumentXml(base, [
			{ kind: "replace", oldText: "Before Anchor", newText: "First", reason: "Overlaps the anchor." },
			{ kind: "add", anchor: "Anchor", position: "after", text: " second", reason: "Overlaps replacement." },
		], "2026-09-12T00:00:00.000Z"),
		/overlap/i,
	);
	assert.throws(
		() => patchDocxDocumentXml("<w:document xmlns:w=\"w\"><w:body><w:ins w:id=\"1\"><w:r><w:t>Old</w:t></w:r></w:ins></w:body></w:document>", [
			{ kind: "replace", oldText: "Old", newText: "New", reason: "Would nest a revision." },
		], "2026-09-12T00:00:00.000Z"),
		/tracked revisions/i,
	);
	for (const propertyChange of ["pPrChange", "rPrChange", "tblPrChange", "trPrChange", "tcPrChange", "sectPrChange", "numPrChange", "tblGridChange", "cellIns", "cellDel", "cellMerge", "numberingChange", "customXmlInsRangeStart", "customXmlDelRangeEnd", "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd"]) {
		assert.throws(
			() => patchDocxDocumentXml(
				`<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Target</w:t></w:r></w:p><w:p><w:pPr><w:${propertyChange} w:id="7"/></w:pPr><w:r><w:t>Unrelated</w:t></w:r></w:p></w:body></w:document>`,
				[{ kind: "replace", oldText: "Target", newText: "Revised", reason: "Must reject the whole document." }],
				"2026-09-12T00:00:00.000Z",
			),
			/tracked revisions/i,
			`${propertyChange} anywhere in word/document.xml rejects a patch`,
		);
	}
	for (const conflictMarker of ["conflictIns", "conflictDel", "customXmlConflictInsRangeStart", "customXmlConflictInsRangeEnd", "customXmlConflictDelRangeStart", "customXmlConflictDelRangeEnd"]) {
		assert.throws(
			() => patchDocxDocumentXml(
				`<w:document xmlns:w="w" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:r><w:t>Target</w:t></w:r></w:p><w:p><w:r><w:t>Unrelated</w:t></w:r><w14:${conflictMarker} w14:id="7"/></w:p></w:body></w:document>`,
				[{ kind: "replace", oldText: "Target", newText: "Revised", reason: "Must reject the whole document." }],
				"2026-09-12T00:00:00.000Z",
			),
			/tracked revisions/i,
			`${conflictMarker} anywhere in word/document.xml rejects a patch`,
		);
	}
	const ordinaryW14Metadata = patchDocxDocumentXml(
		`<w:document xmlns:w="w" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:r><w:t>Target</w:t></w:r></w:p><w:p w14:paraId="00000001" w14:textId="00000002"><w:r><w:t>Unrelated</w:t></w:r></w:p></w:body></w:document>`,
		[{ kind: "replace", oldText: "Target", newText: "Revised", reason: "Ordinary w14 metadata is safe." }],
		"2026-09-12T00:00:00.000Z",
	);
	assert.match(ordinaryW14Metadata.cleanXml, /w14:paraId="00000001"/);
	assert.match(ordinaryW14Metadata.cleanXml, />Revised</);
	assert.throws(
		() => patchDocxDocumentXml("<w:document xmlns:w=\"w\"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p></w:body></w:document>", [
			{ kind: "replace", oldText: "Old", newText: "New", reason: "First mapping." },
			{ kind: "replace", oldText: "New", newText: "Final", reason: "Must not target generated text." },
		], "2026-09-12T00:00:00.000Z"),
		/not found/i,
	);
});

test("draft CAS, live preparation leases, and boundary publication preserve competing editor bytes", async () => {
	const original = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\nOld. Anchor. Remove.\n\\end{document}\n");
	const concurrent = await fixture("tex", original);
	try {
		const request = await concurrent.patches.requestFromUser(concurrent.scope, {
			sourceId: concurrent.source.sourceId,
			sourceHash: concurrent.source.contentHash,
			requestText: "Concurrent draft.",
			expectedProjectRevision: 1,
		});
		const input = {
			patchId: request.patchId,
			expectedPatchRevision: request.revision,
			operations: [{ kind: "replace", oldText: "Old", newText: "New", reason: "CAS fixture." }],
		};
		const outcomes = await Promise.allSettled([
			concurrent.patches.draft(concurrent.scope, input),
			concurrent.patches.draft(concurrent.scope, input),
		]);
		assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
		assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
	} finally {
		await concurrent.close();
	}

	const leased = await fixture("tex", original);
	try {
		const request = await leased.patches.requestFromUser(leased.scope, {
			sourceId: leased.source.sourceId,
			sourceHash: leased.source.contentHash,
			requestText: "Lease fixture.",
			expectedProjectRevision: 1,
		});
		const originalWrite = leased.patches.writeDurable.bind(leased.patches);
		let release;
		let started;
		const startedWrite = new Promise((resolve) => { started = resolve; });
		const releaseWrite = new Promise((resolve) => { release = resolve; });
		let writes = 0;
		leased.patches.writeDurable = async (...args) => {
			started();
			await releaseWrite;
			const result = await originalWrite(...args);
			writes++;
			if (writes === 2) await leased.patches.reconcile(leased.scope);
			return result;
		};
		const pending = leased.patches.draft(leased.scope, {
			patchId: request.patchId,
			expectedPatchRevision: request.revision,
			operations: [{ kind: "replace", oldText: "Old", newText: "New", reason: "Lease fixture." }],
		});
		await startedWrite;
		const observed = await leased.patches.reconcile(leased.scope);
		assert.equal(observed.find((patch) => patch.patchId === request.patchId).status, "preparing");
		release();
		assert.equal((await pending).status, "draft");
	} finally {
		await leased.close();
	}

	const interrupted = await fixture("tex", original);
	try {
		const draft = await requestAndDraft(interrupted);
		const claimPath = interrupted.file + "." + draft.patchId + ".manuscript-claim";
		linkSync(interrupted.file, claimPath);
		unlinkSync(interrupted.file);
		await interrupted.patches.reconcile(interrupted.scope);
		assert.deepEqual(new Uint8Array(await readFile(interrupted.file)), original);
	} finally {
		await interrupted.close();
	}

	const publishedWithClaim = await fixture("tex", original);
	try {
		const draft = await requestAndDraft(publishedWithClaim);
		const clean = "\\documentclass{article}\n\\begin{document}\nCautious. Anchor transition. .\n\\end{document}\n";
		const claimPath = publishedWithClaim.file + "." + draft.patchId + ".manuscript-claim";
		linkSync(publishedWithClaim.file, claimPath);
		unlinkSync(publishedWithClaim.file);
		await writeFile(publishedWithClaim.file, clean);
		const reconciled = await publishedWithClaim.patches.reconcile(publishedWithClaim.scope);
		const confirmed = reconciled.find((patch) => patch.patchId === draft.patchId);
		assert.equal(confirmed.status, "confirmed", "published clean bytes recover the missing confirmation journal");
		await assert.rejects(readFile(claimPath), /ENOENT/, "the owned claim is removed after verified publication recovery");
		const recovered = await publishedWithClaim.patches.recoverFromUser(publishedWithClaim.scope, {
			patchId: confirmed.patchId,
			expectedPatchRevision: confirmed.revision,
		});
		assert.equal(recovered.status, "recovered", "recovery can publish after an interrupted confirmation cleanup");
		assert.deepEqual(new Uint8Array(await readFile(publishedWithClaim.file)), original);
	} finally {
		await publishedWithClaim.close();
	}

	let mode = "none";
	let guarded;
	guarded = await fixture("tex", original, {
		publicationHook: ({ action, path }) => {
			if (mode === "external") writeFileSync(path, "Human editor bytes");
			if (mode === "phase") guarded.study.setPhase(guarded.scope, "study");
			if (mode === "recover-external" && action === "recover") writeFileSync(path, "Human recovery bytes");
		},
	});
	try {
		const draft = await requestAndDraft(guarded);
		mode = "external";
		await assert.rejects(
			guarded.patches.confirmFromUser(guarded.scope, { patchId: draft.patchId, expectedPatchRevision: draft.revision }),
			/external editor/i,
		);
		assert.equal(await readFile(guarded.file, "utf8"), "Human editor bytes");
		mode = "none";
		await writeFile(guarded.file, original);
		const confirmed = await guarded.patches.confirmFromUser(guarded.scope, { patchId: draft.patchId, expectedPatchRevision: draft.revision });
		mode = "recover-external";
		await assert.rejects(
			guarded.patches.recoverFromUser(guarded.scope, { patchId: confirmed.patchId, expectedPatchRevision: confirmed.revision }),
			/external editor/i,
		);
		assert.equal(await readFile(guarded.file, "utf8"), "Human recovery bytes");
		const reconciled = await guarded.patches.reconcile(guarded.scope);
		assert.equal(reconciled.find((patch) => patch.patchId === confirmed.patchId).status, "failed");
		assert.equal(await readFile(guarded.file, "utf8"), "Human recovery bytes");
	} finally {
		await guarded.close();
	}

	let phaseGuard;
	phaseGuard = await fixture("tex", original, {
		publicationHook: () => phaseGuard.study.setPhase(phaseGuard.scope, "study"),
	});
	try {
		const draft = await requestAndDraft(phaseGuard);
		await assert.rejects(
			phaseGuard.patches.confirmFromUser(phaseGuard.scope, { patchId: draft.patchId, expectedPatchRevision: draft.revision }),
			/phase changed/i,
		);
		assert.deepEqual(new Uint8Array(await readFile(phaseGuard.file)), original);
	} finally {
		await phaseGuard.close();
	}

	let claimHandleGuard;
	let heldSourceHandle;
	claimHandleGuard = await fixture("tex", original, {
		publicationHook: ({ boundary }) => {
			if (boundary !== "before-publish") return;
			ftruncateSync(heldSourceHandle, 0);
			writeFileSync(heldSourceHandle, "Human claim-handle bytes");
		},
	});
	try {
		const draft = await requestAndDraft(claimHandleGuard);
		heldSourceHandle = openSync(claimHandleGuard.file, "r+");
		await assert.rejects(
			claimHandleGuard.patches.confirmFromUser(claimHandleGuard.scope, { patchId: draft.patchId, expectedPatchRevision: draft.revision }),
			/changed while publication was pending/i,
		);
		assert.equal(await readFile(claimHandleGuard.file, "utf8"), "Human claim-handle bytes");
	} finally {
		if (heldSourceHandle !== undefined) closeSync(heldSourceHandle);
		await claimHandleGuard.close();
	}
});

test("request creation rechecks the Research phase after the asynchronous source read", async () => {
	const original = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\nOld\n\\end{document}\n");
	const f = await fixture("tex", original);
	try {
		const originalRead = f.patches.currentSourceBytes.bind(f.patches);
		f.patches.currentSourceBytes = async (...args) => {
			const source = await originalRead(...args);
			f.study.setPhase(f.scope, "study");
			return source;
		};
		await assert.rejects(
			f.patches.requestFromUser(f.scope, {
				sourceId: f.source.sourceId,
				sourceHash: f.source.contentHash,
				requestText: "Race the phase change after source read.",
				expectedProjectRevision: 1,
			}),
			/phase/i,
		);
		assert.equal(f.patches.list({ ...f.scope, expectedPhaseRevision: 2 }).length, 0, "the stale request was never inserted");
	} finally {
		await f.close();
	}
});

test("request creation rechecks the project revision after the asynchronous source read", async () => {
	const original = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\nOld\n\\end{document}\n");
	const f = await fixture("tex", original);
	try {
		const originalRead = f.patches.currentSourceBytes.bind(f.patches);
		f.patches.currentSourceBytes = async (...args) => {
			const source = await originalRead(...args);
			f.study.registerSource(f.scope, {
				sourceRoot: f.root,
				relativePath: "revision-race.tex",
				kind: "tex",
				sourceRole: "primary",
				contentHash: hash(original),
				parser: "fixture/v1",
				diagnostics: [],
				chunks: [{ ordinal: 1, locator: JSON.stringify({ fixture: "revision-race" }), text: new TextDecoder().decode(original) }],
			}, 1);
			return source;
		};
		await assert.rejects(
			f.patches.requestFromUser(f.scope, {
				sourceId: f.source.sourceId,
				sourceHash: f.source.contentHash,
				requestText: "Race the project revision after source read.",
				expectedProjectRevision: 1,
			}),
			/project changed/i,
		);
		assert.equal(f.patches.list(f.scope).length, 0, "the stale project request was never inserted");
	} finally {
		await f.close();
	}
});
