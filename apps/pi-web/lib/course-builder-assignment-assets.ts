import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getCourseBuilderHost, courseBuilderSessionCwd } from "./course-builder-service";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 500;
const EDITABLE = new Set([".tex", ".rmd", ".md", ".r", ".txt"]);
const VISIBLE = new Set([...EDITABLE, ".pdf", ".html"]);
const BUILD_AUXILIARY = new Set([".aux", ".log", ".out", ".toc", ".nav", ".snm", ".fls", ".fdb_latexmk"]);

export interface AssignmentAssetView {
	relativePath: string;
	name: string;
	extension: string;
	size: number;
	updatedAt: string;
	editable: boolean;
	preview: "tex" | "markdown" | "pdf" | "text";
	pdfRelativePath: string | null;
}

function pathInside(root: string, candidate: string): boolean {
	const value = relative(root, candidate);
	return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function assignmentStem(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

async function canonicalDirectory(path: string): Promise<string> {
	const canonical = await realpath(path);
	if (!(await stat(canonical)).isDirectory()) throw new Error("Assignment output location is not a directory");
	return canonical;
}

async function meaningfulFiles(path: string): Promise<number> {
	return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile() && VISIBLE.has(extname(entry.name).toLocaleLowerCase())).length;
}

/** Resolve only the Host-owned output directory for one Assignment. */
export async function assignmentOutputDirectory(sessionId: string, assignmentId: string): Promise<string> {
	const host = getCourseBuilderHost();
	const project = host.getProjectForSession(sessionId);
	if (!project) throw new Error("Open a course project first");
	const assignment = host.getAssignment(sessionId, assignmentId);
	const cwd = await canonicalDirectory(await courseBuilderSessionCwd(sessionId));
	const projectRootPath = join(cwd, ".pi", "course-builder", project.projectId);
	await mkdir(projectRootPath, { recursive: true });
	const projectRoot = await canonicalDirectory(projectRootPath);
	if (!pathInside(cwd, projectRoot)) throw new Error("Course output directory escaped the conversation workspace");
	const canonicalPath = join(projectRoot, "assignments", assignment.assignmentId);
	await mkdir(canonicalPath, { recursive: true });
	const canonical = await canonicalDirectory(canonicalPath);
	if (!pathInside(projectRoot, canonical)) throw new Error("Assignment output directory escaped its course project");
	if (await meaningfulFiles(canonical)) return canonical;

	// Before Assignment output paths were Host-assigned, the Agent commonly used
	// one top-level folder named after the Assignment. Keep those existing files
	// editable without guessing among multiple candidates.
	const wanted = assignmentStem(assignment.title);
	const candidates: string[] = [];
	for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "assignments" || assignmentStem(entry.name) !== wanted) continue;
		const candidate = await canonicalDirectory(join(projectRoot, entry.name));
		if (pathInside(projectRoot, candidate) && await meaningfulFiles(candidate)) candidates.push(candidate);
	}
	return candidates.length === 1 ? candidates[0] : canonical;
}

async function ownedAsset(sessionId: string, assignmentId: string, inputPath: string): Promise<{ root: string; path: string }> {
	if (!inputPath || isAbsolute(inputPath)) throw new Error("Assignment asset path must be relative");
	const root = await assignmentOutputDirectory(sessionId, assignmentId);
	const lexical = resolve(root, inputPath);
	if (!pathInside(root, lexical)) throw new Error("Assignment asset path escaped its output directory");
	const path = await realpath(lexical);
	if (!pathInside(root, path) || !(await stat(path)).isFile()) throw new Error("Assignment asset is unavailable");
	return { root, path };
}

export async function listAssignmentAssets(sessionId: string, assignmentId: string): Promise<{ root: string; assets: AssignmentAssetView[] }> {
	const root = await assignmentOutputDirectory(sessionId, assignmentId);
	const assets: AssignmentAssetView[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (assets.length >= MAX_FILES) throw new Error(`Assignment output contains more than ${MAX_FILES} visible files`);
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				const canonical = await canonicalDirectory(path);
				if (!pathInside(root, canonical)) throw new Error("Assignment output contains a directory link outside its root");
				await visit(canonical);
				continue;
			}
			if (!entry.isFile()) continue;
			const extension = extname(entry.name).toLocaleLowerCase();
			if (!VISIBLE.has(extension)) continue;
			const details = await stat(path);
			const relativePath = relative(root, path).split(sep).join("/");
			const pdfPath = extension === ".tex" ? join(dirname(path), `${basename(path, extname(path))}.pdf`) : null;
			let pdfRelativePath: string | null = null;
			if (pdfPath) {
				try { if ((await stat(pdfPath)).isFile()) pdfRelativePath = relative(root, pdfPath).split(sep).join("/"); } catch { /* no compiled PDF yet */ }
			}
			assets.push({
				relativePath,
				name: entry.name,
				extension,
				size: details.size,
				updatedAt: details.mtime.toISOString(),
				editable: EDITABLE.has(extension),
				preview: extension === ".tex" ? "tex" : extension === ".rmd" || extension === ".md" ? "markdown" : extension === ".pdf" ? "pdf" : "text",
				pdfRelativePath,
			});
		}
	};
	await visit(root);
	assets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.relativePath.localeCompare(right.relativePath));
	return { root, assets };
}

function sourceHash(source: string): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export async function readAssignmentSource(sessionId: string, assignmentId: string, relativePath: string) {
	const file = await ownedAsset(sessionId, assignmentId, relativePath);
	if (!EDITABLE.has(extname(file.path).toLocaleLowerCase())) throw new Error("Assignment asset is not an editable source file");
	const details = await stat(file.path);
	if (details.size > MAX_SOURCE_BYTES) throw new Error("Assignment source exceeds the 8 MiB edit limit");
	const source = await readFile(file.path, "utf8");
	if (source.includes("\u0000")) throw new Error("Assignment source is not UTF-8 text");
	return { source, sourceHash: sourceHash(source), relativePath, extension: extname(file.path).toLocaleLowerCase() };
}

export async function readAssignmentAssetBytes(sessionId: string, assignmentId: string, relativePath: string): Promise<Uint8Array> {
	const file = await ownedAsset(sessionId, assignmentId, relativePath);
	if (extname(file.path).toLocaleLowerCase() !== ".pdf") throw new Error("Assignment preview is not a PDF");
	const details = await stat(file.path);
	if (details.size > 64 * 1024 * 1024) throw new Error("Assignment asset exceeds the 64 MiB preview limit");
	return new Uint8Array(await readFile(file.path));
}

async function runXeLatex(sourcePath: string): Promise<{ succeeded: boolean; log: string; pdfPath: string | null }> {
	const temporary = await mkdtemp(join(tmpdir(), "pi-assignment-tex-"));
	try {
		const output = await new Promise<{ code: number | null; text: string }>((resolvePromise, reject) => {
			const child = spawn("xelatex", ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", `-output-directory=${temporary}`, basename(sourcePath)], { cwd: dirname(sourcePath), windowsHide: true });
			let text = "";
			const append = (chunk: Buffer) => { if (text.length < 2_000_000) text += chunk.toString("utf8"); };
			child.stdout.on("data", append); child.stderr.on("data", append);
			const timer = setTimeout(() => child.kill(), 60_000);
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("close", (code) => { clearTimeout(timer); resolvePromise({ code, text }); });
		});
		const compiled = join(temporary, `${basename(sourcePath, extname(sourcePath))}.pdf`);
		if (output.code !== 0) return { succeeded: false, log: output.text, pdfPath: null };
		const bytes = await readFile(compiled);
		if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("XeLaTeX reported success without a valid PDF");
		const destination = join(dirname(sourcePath), basename(compiled));
		const staged = `${destination}.pi-new`;
		await writeFile(staged, bytes);
		// rename() cannot replace an existing file reliably on Windows. Keep the
		// old PDF until compilation has succeeded, then overwrite it from staging.
		await copyFile(staged, destination);
		await rm(staged, { force: true });
		return { succeeded: true, log: output.text, pdfPath: destination };
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

export async function saveAssignmentSource(input: { sessionId: string; assignmentId: string; relativePath: string; source: string; expectedHash: string; compile: boolean }) {
	if (Buffer.byteLength(input.source, "utf8") > MAX_SOURCE_BYTES) throw new Error("Assignment source exceeds the 8 MiB edit limit");
	const current = await readAssignmentSource(input.sessionId, input.assignmentId, input.relativePath);
	if (current.sourceHash !== input.expectedHash) throw new Error("Assignment source changed on disk; reload before saving");
	const file = await ownedAsset(input.sessionId, input.assignmentId, input.relativePath);
	const staged = `${file.path}.pi-new`;
	await writeFile(staged, input.source, "utf8");
	await copyFile(staged, file.path);
	await rm(staged, { force: true });
	const savedHash = sourceHash(input.source);
	let compile: { succeeded: boolean; log: string; pdfRelativePath: string | null } | null = null;
	if (input.compile) {
		if (extname(file.path).toLocaleLowerCase() !== ".tex") throw new Error("Only TeX Assignment sources can be compiled");
		const result = await runXeLatex(file.path);
		compile = { succeeded: result.succeeded, log: result.log, pdfRelativePath: result.pdfPath ? relative(file.root, result.pdfPath).split(sep).join("/") : null };
	}
	return { sourceHash: savedHash, compile };
}

/** Remove compiler scratch files after approval; authored sources and current PDFs remain. */
export async function cleanupApprovedAssignmentAssets(sessionId: string, assignmentId: string): Promise<string[]> {
	const root = await assignmentOutputDirectory(sessionId, assignmentId);
	const removed: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				const canonical = await canonicalDirectory(path);
				if (!pathInside(root, canonical)) throw new Error("Assignment cleanup encountered a directory link outside its root");
				await visit(canonical);
				continue;
			}
			if (!entry.isFile()) continue;
			const lower = entry.name.toLocaleLowerCase();
			const extension = extname(lower);
			if (!BUILD_AUXILIARY.has(extension) && !lower.endsWith(".synctex.gz") && !lower.endsWith(".pi-new")) continue;
			if (!pathInside(root, path)) throw new Error("Assignment cleanup escaped its output directory");
			await rm(path, { force: true });
			removed.push(relative(root, path).split(sep).join("/"));
		}
	};
	await visit(root);
	return removed;
}
