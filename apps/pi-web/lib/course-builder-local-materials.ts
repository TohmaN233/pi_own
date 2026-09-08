import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { CourseBuilderMaterial, CourseBuilderMaterialInput } from "../../../packages/course-builder-host/src/index.ts";
import { courseBuilderKindForName, extractCourseBuilderMaterial } from "./course-builder-import.ts";

const MAX_LINKED_FILES = 512;
const MAX_ON_DEMAND_BYTES = 64 * 1024 * 1024;

export type CourseBuilderMaterialScope =
	| { kind: "course" }
	| { kind: "assignment"; assignmentId: string; assignmentTitle: string };

function portableRelativePath(root: string, filePath: string): string {
	return relative(root, filePath).split(sep).join("/");
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function collectFiles(root: string, directory: string, output: string[]): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const entryPath = resolve(directory, entry.name);
		if (entry.isDirectory()) await collectFiles(root, entryPath, output);
		else if (entry.isFile()) output.push(entryPath);
		if (output.length > MAX_LINKED_FILES) throw new Error(`一个课程项目最多链接 ${MAX_LINKED_FILES} 个资料文件。请选一个更具体的资料文件夹。`);
	}
}

export async function scanCourseBuilderDirectory(
	directory: string,
	scope: CourseBuilderMaterialScope = { kind: "course" },
): Promise<CourseBuilderMaterialInput[]> {
	if (!directory.trim()) throw new Error("资料文件夹路径不能为空。");
	if (scope.kind === "assignment" && !scope.assignmentId.trim()) throw new Error("Assignment id is required");
	const root = await realpath(directory);
	if (!(await stat(root)).isDirectory()) throw new Error("所选路径不是文件夹。");
	const paths: string[] = [];
	await collectFiles(root, root, paths);
	if (paths.length === 0) throw new Error("所选文件夹中没有资料文件。");
	return Promise.all(paths.map(async (sourcePath) => {
		const sourceStat = await stat(sourcePath);
		const relativePath = portableRelativePath(root, sourcePath);
		const marker = JSON.stringify({
			version: 1,
			storage: "local-link",
			root,
			relativePath,
			size: sourceStat.size,
			modifiedAtMs: Math.trunc(sourceStat.mtimeMs),
			materialScope: scope.kind,
			assignmentId: scope.kind === "assignment" ? scope.assignmentId : undefined,
		});
		return {
			name: relativePath || basename(sourcePath),
			kind: courseBuilderKindForName(sourcePath),
			sourceBytes: new TextEncoder().encode(marker),
			extractedText: "",
			metadata: {
				storage: "local-link",
				materialScope: scope.kind,
				...(scope.kind === "assignment"
					? { assignmentId: scope.assignmentId, assignmentTitle: scope.assignmentTitle }
					: {}),
				sourceRoot: root,
				sourcePath,
				relativePath,
				sourceSize: sourceStat.size,
				modifiedAtMs: Math.trunc(sourceStat.mtimeMs),
				readMode: "on-demand",
			},
		};
	}));
}

function linkedSource(material: CourseBuilderMaterialInput | CourseBuilderMaterial): { root: string; path: string; size: number; modifiedAtMs: number } {
	const metadata = material.metadata;
	if (metadata?.storage !== "local-link" || typeof metadata.sourceRoot !== "string" || typeof metadata.sourcePath !== "string" || typeof metadata.sourceSize !== "number" || typeof metadata.modifiedAtMs !== "number") {
		throw new Error(`Material ${material.name} is not a valid local link`);
	}
	return { root: metadata.sourceRoot, path: metadata.sourcePath, size: metadata.sourceSize, modifiedAtMs: metadata.modifiedAtMs };
}

export async function readLinkedCourseBuilderMaterial(material: CourseBuilderMaterialInput | CourseBuilderMaterial): Promise<string> {
	const source = linkedSource(material);
	const [root, filePath] = await Promise.all([realpath(source.root), realpath(source.path)]);
	if (!isInside(root, filePath)) throw new Error(`Linked material escaped its selected folder: ${material.name}`);
	const current = await stat(filePath);
	if (!current.isFile()) throw new Error(`Linked material is no longer a file: ${material.name}`);
	if (current.size !== source.size || Math.trunc(current.mtimeMs) !== source.modifiedAtMs) throw new Error(`Linked material changed on disk; relink the folder before using it: ${material.name}`);
	if (current.size > MAX_ON_DEMAND_BYTES) throw new Error(`Linked material exceeds the 64 MiB on-demand read budget: ${material.name}`);
	const bytes = new Uint8Array(await readFile(filePath));
	return (await extractCourseBuilderMaterial(bytes, material.name)).extractedText;
}
