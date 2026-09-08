import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { extractCourseBuilderMaterial } from "./course-builder-import";
import mammoth from "mammoth";

export interface ChatAttachmentScope { sessionId: string | null; assignmentId: string | null; }
export async function saveChatAttachment(cwd: string, file: File, scope: ChatAttachmentScope) {
  if (!file.name || file.name.length > 200 || /[\\/:\x00-\x1f]/u.test(file.name) || file.name === "." || file.name === "..") throw new Error("Invalid attachment filename");
  if (file.size > 25 * 1024 * 1024) throw new Error("附件超过 25 MiB，请改用资料文件夹链接。");
  const root = await realpath(cwd);
  const parent = join(root, ".pi", "chat-attachments");
  // Verify existing ancestors before creating anything beneath them.
  for (const path of [join(root, ".pi"), parent]) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const rel = relative(root, await realpath(path));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Attachment directory escapes the project");
  }
  const id = randomUUID(), directory = join(parent, id);
  await mkdir(directory);
  await mkdir(join(directory, "original"));
  const bytes = Buffer.from(await file.arrayBuffer());
  const path = join(directory, "original", file.name), textPath = join(directory, "extracted.txt");
  await writeFile(path, bytes, { flag: "wx" });
  let extractionError: string | null = null;
  let extractedText = "";
  try { extractedText = file.name.toLowerCase().endsWith(".docx") ? (await mammoth.extractRawText({ buffer: bytes })).value : (await extractCourseBuilderMaterial(bytes, file.name)).extractedText; }
  catch (error) { extractionError = error instanceof Error ? error.message : String(error); }
  if (!extractionError) await writeFile(textPath, extractedText, { flag: "wx" });
  const metadata = { id, name: file.name, ...scope, sourceHash: createHash("sha256").update(bytes).digest("hex"), extractionError };
  await writeFile(join(directory, "attachment.json"), JSON.stringify(metadata), { flag: "wx" });
  return { ...metadata, path, textPath: extractionError ? null : textPath };
}

export async function readChatAttachment(cwd: string, id: string, scope: ChatAttachmentScope): Promise<string> {
  if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("Invalid attachment ID");
  const root = await realpath(cwd), directory = await realpath(join(root, ".pi", "chat-attachments", id));
  const rel = relative(root, directory);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Attachment directory escapes the project");
  const metadata = JSON.parse(await readFile(join(directory, "attachment.json"), "utf8"));
  if (metadata.id !== id || metadata.sessionId !== scope.sessionId || metadata.assignmentId !== scope.assignmentId) throw new Error("Attachment belongs to another conversation or Assignment");
  if (typeof metadata.name !== "string" || /[\\/:]/u.test(metadata.name)) throw new Error("Invalid attachment metadata");
  const sourcePath = await realpath(join(directory, "original", metadata.name));
  if (relative(directory, sourcePath) !== join("original", metadata.name)) throw new Error("Attachment source escaped its directory");
  const bytes = await readFile(sourcePath);
  if (createHash("sha256").update(bytes).digest("hex") !== metadata.sourceHash) throw new Error("Attachment content changed");
  if (metadata.extractionError) throw new Error(`附件解析失败：${metadata.extractionError}`);
  // Extract from verified original bytes, not a mutable sidecar.
  return metadata.name.toLowerCase().endsWith(".docx") ? (await mammoth.extractRawText({ buffer: bytes })).value : (await extractCourseBuilderMaterial(bytes, metadata.name)).extractedText;
}
