import { execFile } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegisteredStudyPdf } from "./study-source-preview";

export async function studyPdfPage(sessionId: string, sourceId: string, sourceHash: string, page: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 20_000) throw new Error("Invalid PDF page number");
  const bytes = await readRegisteredStudyPdf(sessionId, sourceId, sourceHash);
  const directory = await mkdtemp(join(tmpdir(), "pi-study-pdf-page-"));
  try {
    const input = join(directory, "source.pdf");
    const output = join(directory, "page");
    await writeFile(input, bytes);
    await new Promise<void>((resolve, reject) => {
      execFile(process.env.PI_PDFTOPPM_PATH || "pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "1800", "-png", input, output],
        { windowsHide: true, timeout: 20_000, maxBuffer: 512 * 1024, signal }, (error, _stdout, stderr) => {
          if (error) { reject(new Error(`PDF page rendering failed: ${error.message}; ${stderr.slice(-4000)}`)); return; }
          if (stderr.trim()) console.warn("[study-research] PDF rendering diagnostic", { sessionId, sourceId, page, detail: stderr.slice(-4000) });
          resolve();
        });
    });
    const image = await open(`${output}.png`, "r");
    try {
      const stat = await image.stat();
      if (!stat.isFile() || stat.size < 8 || stat.size > 8 * 1024 * 1024) throw new Error("PDF page image exceeds its size limit");
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const part = await image.read(data, offset, data.length - offset, offset);
        if (!part.bytesRead) throw new Error("PDF page image is truncated");
        offset += part.bytesRead;
      }
      if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PDF renderer did not return PNG");
      console.info("[study-research] PDF page rendered", { sessionId, sourceId, sourceHash, page, bytes: data.length });
      return { data: data.toString("base64"), mimeType: "image/png" as const, sourceId, sourceHash, page };
    } finally { await image.close(); }
  } finally {
    // The path comes solely from mkdtemp, never from the source or a model argument.
    await rm(directory, { recursive: true, force: true });
  }
}
