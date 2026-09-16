import { open, realpath } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { sha256Hex } from "../../../packages/harness-core/src/index.ts";
import type { SourceVersionInput } from "../../../packages/study-research-host/src/index.ts";
import { MAX_EXECUTION_INPUT_BYTES } from "../../../packages/study-execution-host/src/execution-payloads.ts";
import { isPathWithinRoots } from "./path-security";

/** Trusted user selection adapter. Models receive registered identities, never arbitrary paths. */
export async function readStudySupplement(rootPath: string, entryPath: string): Promise<SourceVersionInput> {
  const sourceRoot = await realpath(rootPath), file = await realpath(resolve(sourceRoot, entryPath));
  if (!isPathWithinRoots(file, new Set([sourceRoot])) || file === sourceRoot) throw new Error("Supplement escapes its selected root");
  const relativePath = relative(sourceRoot, file).replaceAll("\\", "/");
  const extension = extname(file).toLowerCase();
  if ([".tex", ".docx", ".doc", ".pdf"].includes(extension)) throw new Error("Use the paper import for TeX, Word and PDF");
  const handle = await open(file, "r");
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_EXECUTION_INPUT_BYTES) throw new Error("Supplement must be a regular file of at most 16 MiB");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino) throw new Error("Supplement changed while reading");
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  const kind = [".r", ".py", ".m", ".js", ".ts"].includes(extension) ? "code" : [".csv", ".tsv", ".txt", ".json", ".md", ".yaml", ".yml"].includes(extension) ? "text" : "asset";
  const chunks: Array<SourceVersionInput["chunks"][number]> = [];
  if (kind === "asset") chunks.push({ ordinal: 1, locator: JSON.stringify({ kind: "binary-file", path: relativePath }), text: `Binary input ${relativePath}: ${bytes.length} bytes. Contents have not been interpreted; bind this registered version to a code cell to read it.` });
  else {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let offset = 0, line = 1;
    do {
      // Avoid splitting a Unicode surrogate pair while keeping each excerpt bounded.
      let end = Math.min(text.length, offset + 8000);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
      const part = text.slice(offset, end), count = (part.match(/\n/gu) ?? []).length;
      chunks.push({ ordinal: chunks.length + 1, locator: JSON.stringify({ kind: "source-lines", path: relativePath, startLine: line, endLine: line + count, startOffset: offset, endOffset: end }), text: part || "[Empty source file]" });
      line += count; offset = end;
    } while (offset < text.length);
  }
  return { sourceRoot, relativePath, kind, sourceRole: kind === "code" ? "code" : "supplement", contentHash: `sha256:${sha256Hex(bytes)}`, parser: kind === "asset" ? "binary-identity:v1" : "utf8-source:v1", diagnostics: [], chunks };
}
