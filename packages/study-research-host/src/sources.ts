import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256Hex } from "../../harness-core/src/index.ts";
import { type SourceEntry, StudyError, text } from "./contracts.ts";

const OMIT = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".next",
	".venv",
	"venv",
	"__pycache__",
	".ssh",
	".aws",
	".gnupg",
	".pi",
	".agents",
	".npmrc",
	".pypirc",
]);
function excluded(name: string): boolean {
	return (
		OMIT.has(name.toLowerCase()) ||
		/^\.env(?:\.|$)/iu.test(name) ||
		/(?:^id_(?:rsa|ed25519)$|\.(?:pem|key|p12|pfx)$)/iu.test(name)
	);
}
/** Metadata-only indexing, not an eager prompt or file-body import. */
export async function scanStudyDirectory(
	directory: string,
): Promise<{ root: string; sources: SourceEntry[]; omitted: string[] }> {
	const root = await realpath(text(directory, "directory", 4096));
	if (!(await lstat(root)).isDirectory()) throw new StudyError("NOT_DIRECTORY", "Select a directory");
	const sources: SourceEntry[] = [];
	const omitted: string[] = [];
	let entries = 0;
	const visit = async (path: string, depth: number): Promise<void> => {
		if (depth > 16) throw new StudyError("DIRECTORY_BUDGET", "Directory is too deep; choose a smaller study folder");
		if ((await realpath(path)) !== path)
			throw new StudyError("PATH_ESCAPE", "A directory link changed during indexing");
		const children = [];
		const directoryHandle = await opendir(path);
		for await (const child of directoryHandle) {
			if (children.length + entries >= 5000)
				throw new StudyError("DIRECTORY_BUDGET", "Directory scan exceeds 5000 entries");
			children.push(child);
		}
		children.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of children) {
			if (++entries > 5000) throw new StudyError("DIRECTORY_BUDGET", "Directory scan exceeds 5000 entries");
			const full = join(path, child.name);
			const short = relative(root, full).replace(/\\/gu, "/");
			if (excluded(child.name) || child.isSymbolicLink()) {
				if (omitted.length < 100) omitted.push(short);
				continue;
			}
			if (child.isDirectory()) await visit(full, depth + 1);
			else if (child.isFile()) {
				const stat = await lstat(full);
				if (stat.isSymbolicLink()) continue;
				if (stat.size > 64 * 1024 * 1024) {
					if (omitted.length < 100) omitted.push(`${short} (over 64 MiB)`);
					continue;
				}
				if (sources.length >= 512)
					throw new StudyError("DIRECTORY_BUDGET", "More than 512 files; choose a smaller study folder");
				sources.push({
					id: `src_${sha256Hex(short).slice(0, 24)}`,
					path: short,
					size: stat.size,
					mtimeMs: Math.trunc(stat.mtimeMs),
				});
			}
		}
	};
	await visit(root, 0);
	return { root, sources, omitted };
}
/** Reads an opened, bounded regular file after confinement and symlink checks. */
export async function readStudyFile(root: string, source: SourceEntry): Promise<Uint8Array> {
	const resolvedRoot = await realpath(root);
	if (resolvedRoot !== root) throw new StudyError("ROOT_CHANGED", "Study root changed; reopen the project");
	const intended = resolve(root, source.path);
	const path = await realpath(intended);
	const rel = relative(root, path);
	if (
		isAbsolute(rel) ||
		rel === ".." ||
		rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		path !== intended
	)
		throw new StudyError("PATH_ESCAPE", "Linked source escaped its original path");
	const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
	try {
		const before = await file.stat();
		if (!before.isFile() || before.size !== source.size || Math.trunc(before.mtimeMs) !== source.mtimeMs)
			throw new StudyError("SOURCE_CHANGED", "Source changed; reindex to record a new version");
		if (before.size > 64 * 1024 * 1024) throw new StudyError("SOURCE_BUDGET", "Source exceeds 64 MiB");
		const bytes = Buffer.alloc(before.size + 1);
		let count = 0;
		while (count < bytes.length) {
			const chunk = await file.read(bytes, count, bytes.length - count, count);
			if (!chunk.bytesRead) break;
			count += chunk.bytesRead;
		}
		const after = await file.stat();
		if (
			count !== source.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ino !== before.ino
		)
			throw new StudyError("SOURCE_CHANGED", "Source changed while reading");
		return bytes.subarray(0, count);
	} finally {
		await file.close();
	}
}
