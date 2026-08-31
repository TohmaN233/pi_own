import { Readable } from "node:stream";
import JSZip, { type JSZipObject } from "jszip";
import type { CourseMaterialInput } from "../../../packages/harness-contracts/src/index.ts";

export const MAX_COURSE_FILES = 128;
export const MAX_COURSE_BYTES = 256 * 1024 * 1024;

export interface CourseImportLimits {
  maxFiles: number;
  maxBytes: number;
}

export class CourseImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseImportError";
  }
}

export class CourseImportLimitError extends CourseImportError {
  constructor(message: string) {
    super(message);
    this.name = "CourseImportLimitError";
  }
}

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".jsx",
  ".kt", ".m", ".php", ".py", ".r", ".rb", ".rs", ".sh", ".sql", ".swift", ".ts", ".tsx",
]);

interface MaterialDescriptor {
  name: string;
  kind: CourseMaterialInput["kind"];
  mediaType: string;
}

function extension(name: string): string {
  const match = /(?:^|\/)[^/]*(\.[^./]+)$/.exec(name.toLowerCase());
  return match?.[1] ?? "";
}

function describeMaterial(name: string): MaterialDescriptor | null {
  const ext = extension(name);
  if (ext === ".pdf") return { name, kind: "pdf", mediaType: "application/pdf" };
  if (ext === ".md" || ext === ".mdx") return { name, kind: "markdown", mediaType: "text/markdown" };
  if (ext === ".txt") return { name, kind: "text", mediaType: "text/plain" };
  if (ext === ".ipynb") return { name, kind: "notebook", mediaType: "application/x-ipynb+json" };
  if (CODE_EXTENSIONS.has(ext)) return { name, kind: "code", mediaType: "text/plain" };
  return null;
}

async function readZipEntry(entry: JSZipObject, remainingBytes: number): Promise<Uint8Array> {
  const stream = entry.nodeStream("nodebuffer") as Readable;
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on("data", (value: unknown) => {
      if (settled) return;
      if (!(value instanceof Uint8Array)) {
        fail(new CourseImportError(`ZIP entry ${entry.name} emitted invalid data`));
        return;
      }
      if (size + value.byteLength > remainingBytes) {
        fail(new CourseImportLimitError("Course import exceeds 256 MiB"));
        return;
      }
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
      size += chunk.byteLength;
    });
    stream.on("error", (error: Error) => {
      fail(new CourseImportError(`Failed to decompress ZIP entry ${entry.name}: ${error.message}`));
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(bytes);
    });
  });
}

export async function expandCourseUploads(
  files: readonly File[],
  limits: CourseImportLimits = { maxFiles: MAX_COURSE_FILES, maxBytes: MAX_COURSE_BYTES },
): Promise<CourseMaterialInput[]> {
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1) {
    throw new CourseImportError("maxFiles must be a positive integer");
  }
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
    throw new CourseImportError("maxBytes must be a positive integer");
  }

  const materials: CourseMaterialInput[] = [];
  let totalBytes = 0;

  const add = (descriptor: MaterialDescriptor, bytes: Uint8Array): void => {
    if (materials.length >= limits.maxFiles) {
      throw new CourseImportLimitError(`Course import exceeds ${limits.maxFiles} files`);
    }
    if (totalBytes + bytes.byteLength > limits.maxBytes) {
      throw new CourseImportLimitError(`Course import exceeds ${limits.maxBytes} bytes`);
    }
    totalBytes += bytes.byteLength;
    materials.push({ ...descriptor, content: bytes });
  };

  for (const file of files) {
    if (file.size > limits.maxBytes) {
      throw new CourseImportLimitError(`Course upload ${file.name} exceeds ${limits.maxBytes} bytes`);
    }
    if (extension(file.name) !== ".zip") {
      const descriptor = describeMaterial(file.name);
      if (!descriptor) continue;
      if (file.size > limits.maxBytes - totalBytes) {
        throw new CourseImportLimitError(`Course import exceeds ${limits.maxBytes} bytes`);
      }
      add(descriptor, new Uint8Array(await file.arrayBuffer()));
      continue;
    }

    let archive: JSZip;
    try {
      archive = await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      throw new CourseImportError(
        `Invalid ZIP archive ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of Object.values(archive.files).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.dir) continue;
      const descriptor = describeMaterial(entry.name);
      if (!descriptor) continue;
      if (materials.length >= limits.maxFiles) {
        throw new CourseImportLimitError(`Course import exceeds ${limits.maxFiles} files`);
      }
      add(descriptor, await readZipEntry(entry, limits.maxBytes - totalBytes));
    }
  }

  if (materials.length === 0) throw new CourseImportError("No supported course materials were selected");
  return materials;
}
