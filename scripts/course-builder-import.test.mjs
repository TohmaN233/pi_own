import assert from "node:assert/strict";
import test from "node:test";
import { parseCourseBuilderFiles } from "../apps/pi-web/lib/course-builder-import.ts";

// A valid minimal PDF fixture; extraction is performed by the real pdftotext process.
function pdfFixture() {
  const stream = "BT /F1 12 Tf 72 720 Td (Course Builder import proof) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test("actual Course Builder web importer preserves UTF-8 source and metadata type", async () => {
  const content = "# 第一课\nExplain linearity.\n";
  const result = await parseCourseBuilderFiles([new File([content], "课件.md")]);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "markdown");
  assert.equal(result[0].extractedText, content);
  assert.equal(Buffer.from(result[0].sourceBytes).toString("utf8"), content);
});

test("actual importer rejects path traversal, invalid UTF-8, unsupported batches and forged images", async () => {
  for (const name of ["../notes.md", "sub/notes.md", "sub\\notes.md"]) {
    await assert.rejects(parseCourseBuilderFiles([new File(["test"], name)]), /Unsafe material filename/);
  }
  await assert.rejects(parseCourseBuilderFiles([new File([new Uint8Array([255, 254])], "bad.txt")]));
  await assert.rejects(parseCourseBuilderFiles([new File(["ok"], "notes.md"), new File(["bad"], "script.exe")]), /Unsupported file type/);
  await assert.rejects(parseCourseBuilderFiles([new File(["not an image"], "figure.png")]), /Invalid image asset/);
});

test("actual importer rejects over-budget files before reading their contents", async () => {
  let read = false;
  const file = { name: "too-large.txt", size: 64 * 1024 * 1024 + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } };
  await assert.rejects(parseCourseBuilderFiles([file]), /within 64 MiB/);
  assert.equal(read, false);
});

test("real PDF bytes pass through the web importer and pdftotext", { skip: process.env.PI_TEST_XELATEX !== "1" }, async () => {
  const bytes = pdfFixture();
  const result = await parseCourseBuilderFiles([new File([bytes], "lesson.pdf")]);
  assert.equal(result[0].kind, "pdf");
  assert.match(result[0].extractedText, /Course Builder import proof/);
  assert.deepEqual(Buffer.from(result[0].sourceBytes), bytes);
});
