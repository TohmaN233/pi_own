import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { SourceVersion } from "../../../packages/study-research-host/src/types.ts";
import { isPathWithinRoots } from "./path-security";

/** Internal adapter only: callers must obtain this record from the scoped Host, never from request JSON. */
export async function readExactStudySourceBytes(source: Pick<SourceVersion, "sourceRoot" | "relativePath" | "contentHash">, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 256 * 1024 * 1024) throw new Error("Invalid source byte limit");
  const root = await realpath(source.sourceRoot);
  const file = await realpath(resolve(root, source.relativePath));
  if (!isPathWithinRoots(file, new Set([root]))) throw new Error("Source escapes its registered root");
  const handle = await open(file, "r");
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) throw new Error("Source exceeds its execution or preview byte limit");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Source changed while its bytes were being frozen");
    bytes = buffer.subarray(0, length);
  } finally { await handle.close(); }
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.contentHash) throw new Error("Source bytes changed since import; review the source update first");
  return bytes;
}
