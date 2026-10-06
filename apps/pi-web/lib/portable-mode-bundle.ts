import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { stableStringify } from "../../../packages/harness-core/src/index.ts";
import { parsePortableModePackage, portableModePackageAssetHash, type PortableModePackage } from "../../../packages/mode-pack-host/src/index.ts";
import { verifyStoredPortableFile } from "./portable-mode-pack-registry";

const MAX_BUNDLE_FILES = 100_000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;

/** Version 1 wire format: uncompressed TAR, metadata-only manifest first,
 * followed by exactly its declared local files. Large files stay streamed. */
export async function writePortableModeBundle(
  archive: PortableModePackage,
  sources: ReadonlyMap<string, { file: string } | { bytes: Buffer }>,
  destination: string,
): Promise<void> {
  const manifest = parsePortableModePackage(archive, { storedManifest: true });
  if (manifest.files.length > MAX_BUNDLE_FILES || manifest.files.reduce((total, file) => total + file.bytes, 0) > MAX_BUNDLE_BYTES) {
    throw new Error("Portable Mode Package exceeds bundle limits");
  }
  const pack = tar.pack();
  const output = pipeline(pack, createWriteStream(destination, { flags: "wx" }));
  try {
    const manifestBytes = Buffer.from(`${stableStringify(manifest)}\n`, "utf8");
    await new Promise<void>((done, fail) => pack.entry({ name: "manifest.json", size: manifestBytes.byteLength, mtime: new Date(0) }, manifestBytes, (error) => error ? fail(error) : done()));
    for (const file of manifest.files) {
      const source = sources.get(file.path);
      if (!source) throw new Error(`Portable Mode Package source is missing: ${file.path}`);
      if ("file" in source) {
        verifyStoredPortableFile(source.file, file.bytes, file.contentHash);
        await pipeline(createReadStream(source.file), pack.entry({ name: file.path, size: file.bytes, mtime: new Date(0) }));
      } else {
        if (source.bytes.byteLength !== file.bytes || portableModePackageAssetHash(source.bytes) !== file.contentHash) {
          throw new Error(`Portable Mode Package source is tampered: ${file.path}`);
        }
        await new Promise<void>((done, fail) => pack.entry({ name: file.path, size: file.bytes, mtime: new Date(0) }, source.bytes, (error) => error ? fail(error) : done()));
      }
    }
    pack.finalize();
    await output;
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error(String(error)));
    try { await output; } catch { /* preserve the original cause */ }
    throw error;
  }
}

/** Extract into a fresh private directory. The first entry must supply the
 * complete dependency graph, and no extra paths or link types are accepted. */
export async function readPortableModeBundle(input: NodeJS.ReadableStream, destination: string): Promise<PortableModePackage> {
  const extract = tar.extract();
  const manifestBox: { value: PortableModePackage | null } = { value: null };
  const seen = new Set<string>();
  let totalBytes = 0;
  extract.on("entry", (header, stream, next) => {
    void (async () => {
      if (header.type !== "file") throw new Error(`Portable Mode Package has unsupported TAR entry: ${header.name}`);
      if (!manifestBox.value) {
        if (header.name !== "manifest.json" || typeof header.size !== "number" || !Number.isSafeInteger(header.size) || header.size > 4 * 1024 * 1024) {
          throw new Error("Portable Mode Package must begin with a small manifest.json");
        }
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        manifestBox.value = parsePortableModePackage(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, { storedManifest: true });
        if (manifestBox.value.files.length > MAX_BUNDLE_FILES || manifestBox.value.files.reduce((sum, file) => sum + file.bytes, 0) > MAX_BUNDLE_BYTES) {
          throw new Error("Portable Mode Package exceeds bundle limits");
        }
        next();
        return;
      }
      const file = manifestBox.value.files.find((item) => item.path === header.name);
      if (!file || seen.has(header.name) || header.size !== file.bytes) throw new Error(`Portable Mode Package has unexpected file: ${header.name}`);
      seen.add(header.name);
      totalBytes += header.size;
      if (totalBytes > MAX_BUNDLE_BYTES) throw new Error("Portable Mode Package exceeds byte limit");
      const target = join(destination, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      await pipeline(stream, createWriteStream(target, { flags: "wx" }));
      verifyStoredPortableFile(target, file.bytes, file.contentHash);
      next();
    })().catch((error) => extract.destroy(error instanceof Error ? error : new Error(String(error))));
  });
  await pipeline(input, extract);
  if (!manifestBox.value || seen.size !== manifestBox.value.files.length) throw new Error("Portable Mode Package payload is incomplete");
  return manifestBox.value;
}
