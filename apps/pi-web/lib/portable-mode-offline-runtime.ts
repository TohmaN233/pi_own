import { createReadStream, createWriteStream, lstatSync, mkdirSync, readlinkSync, readdirSync, symlinkSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";

const MAX_RUNTIME_FILES = 100_000;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024 * 1024;

function inside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}

function runtimeEntryPath(name: string): string {
  if (!name || name.includes("\\") || name.includes(":") || name.startsWith("/") || name.endsWith("/..")) {
    throw new Error(`Offline runtime has an unsafe entry path: ${name}`);
  }
  const parts = name.replace(/\/$/u, "").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\0-\x1f<>"|?*]/u.test(part))) {
    throw new Error(`Offline runtime has an unsafe entry path: ${name}`);
  }
  const canonical = parts.join("/");
  if (canonical !== "package.json" && canonical !== "package-lock.json" && canonical !== "node_modules" && !canonical.startsWith("node_modules/")) {
    throw new Error(`Offline runtime contains an unexpected entry: ${name}`);
  }
  return canonical;
}

/** Stream a verified npm installation into a deterministic gzip tar. The
 * caller owns the runtime marker and rechecks its tree hash on import. */
export async function packPortableOfflineRuntime(runtimeDirectory: string, destination: string): Promise<void> {
  const root = resolve(runtimeDirectory);
  const pack = tar.pack();
  const output = pipeline(pack, createGzip({ level: 6 }), createWriteStream(destination, { flags: "wx" }));
  let fileCount = 0;
  let totalBytes = 0;
  const add = async (fullPath: string): Promise<void> => {
    const name = relative(root, fullPath).replaceAll("\\", "/");
    runtimeEntryPath(name);
    const stat = lstatSync(fullPath);
    fileCount += 1;
    if (fileCount > MAX_RUNTIME_FILES) throw new Error("Offline runtime exceeds file-count limit");
    const base = { name, mtime: new Date(0), uid: 0, gid: 0, mode: stat.mode & 0o777 };
    if (stat.isDirectory()) {
      await new Promise<void>((done, fail) => pack.entry({ ...base, type: "directory" }, (error) => error ? fail(error) : done()));
      for (const child of readdirSync(fullPath).sort()) await add(join(fullPath, child));
    } else if (stat.isSymbolicLink()) {
      const linkname = readlinkSync(fullPath).replaceAll("\\", "/");
      if (isAbsolute(linkname) || !inside(join(root, "node_modules"), resolve(dirname(fullPath), linkname))) {
        throw new Error(`Offline runtime symlink escapes node_modules: ${name} -> ${linkname}`);
      }
      await new Promise<void>((done, fail) => pack.entry({ ...base, type: "symlink", linkname }, (error) => error ? fail(error) : done()));
    } else if (stat.isFile()) {
      totalBytes += stat.size;
      if (totalBytes > MAX_RUNTIME_BYTES) throw new Error("Offline runtime exceeds byte limit");
      await pipeline(createReadStream(fullPath), pack.entry({ ...base, type: "file", size: stat.size }));
    } else {
      throw new Error(`Offline runtime has a non-file entry: ${name}`);
    }
  };
  try {
    await add(join(root, "package.json"));
    await add(join(root, "package-lock.json"));
    await add(join(root, "node_modules"));
    pack.finalize();
    await output;
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error(String(error)));
    try { await output; } catch { /* original error is more useful */ }
    throw error;
  }
}

/** Extract only the declared npm tree into a fresh private stage. Every path,
 * type, size and symlink target is checked before the next tar entry proceeds. */
export async function unpackPortableOfflineRuntime(archivePath: string, stageDirectory: string): Promise<void> {
  const stage = resolve(stageDirectory);
  const extract = tar.extract();
  const seen = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;
  extract.on("entry", (header, stream, next) => {
    void (async () => {
      const name = runtimeEntryPath(header.name);
      const key = name.toLocaleLowerCase("en-US");
      if (seen.has(key)) throw new Error(`Offline runtime has a duplicate entry: ${name}`);
      seen.add(key);
      const destination = resolve(stage, ...name.split("/"));
      if (!inside(stage, destination)) throw new Error(`Offline runtime entry escapes stage: ${name}`);
      fileCount += 1;
      if (fileCount > MAX_RUNTIME_FILES) throw new Error("Offline runtime exceeds file-count limit");
      if (header.type === "directory") {
        mkdirSync(destination, { recursive: true });
        stream.resume();
        next();
      } else if (header.type === "file") {
        const size = header.size;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new Error(`Offline runtime has invalid file size: ${name}`);
        totalBytes += size;
        if (totalBytes > MAX_RUNTIME_BYTES) throw new Error("Offline runtime exceeds byte limit");
        mkdirSync(dirname(destination), { recursive: true });
        await pipeline(stream, createWriteStream(destination, { flags: "wx", mode: header.mode ?? 0o644 }));
        next();
      } else if (header.type === "symlink") {
        const linkname = header.linkname ?? "";
        if (process.platform === "win32" || !linkname || isAbsolute(linkname) || !inside(join(stage, "node_modules"), resolve(dirname(destination), linkname))) {
          throw new Error(`Offline runtime has an unsafe symlink: ${name} -> ${linkname}`);
        }
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(linkname, destination);
        stream.resume();
        next();
      } else {
        throw new Error(`Offline runtime has unsupported tar entry type: ${header.type}`);
      }
    })().catch((error) => extract.destroy(error instanceof Error ? error : new Error(String(error))));
  });
  await pipeline(createReadStream(archivePath), createGunzip(), extract);
  if (!seen.has("package.json") || !seen.has("package-lock.json") || !seen.has("node_modules")) {
    throw new Error("Offline runtime archive is incomplete");
  }
}
