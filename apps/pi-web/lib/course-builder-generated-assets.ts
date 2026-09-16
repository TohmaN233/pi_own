import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { CourseBuilderError, type CourseBuilderHost, type CourseBuilderMaterial } from "../../../packages/course-builder-host/src/index.ts";
import type { JsonValue } from "../../../packages/harness-contracts/src/index.ts";

const MAX_GENERATED_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_GENERATED_SOURCE_BYTES = 8 * 1024 * 1024;
const GENERATED_ASSET_VERSION = 1;

export interface GeneratedCourseAssetSpec {
	path: string;
	lessonPlanId: string;
	sourcePath?: string;
	purpose: string;
}

export interface GeneratedAssetProvenance {
	assetPath: string;
	assetRelativePath: string;
	sourcePath: string | null;
	sourceRelativePath: string | null;
	sourceHash: string | null;
}

export interface ImportedCourseGeneratedAsset {
	projectId: string;
	lessonPlanId: string;
	materialId: string;
	beamerPath: string;
	extension: "png" | "jpg" | "pdf";
	sourceHash: string;
	provenance: GeneratedAssetProvenance;
	projectRevision: number;
	replay: boolean;
}

interface OwnedFile {
	path: string;
	size: number;
}

interface SourceRecord extends OwnedFile {
	relativePath: string;
	bytes: Uint8Array;
	hash: string;
}

interface CourseOutputRoot {
	cwd: string;
	parent: string;
	path: string;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim())
		throw new CourseBuilderError("INVALID_INPUT", `${label} must be a non-empty string`);
	const result = value.trim();
	if (result.length > maxLength) throw new CourseBuilderError("INPUT_TOO_LARGE", `${label} exceeds ${maxLength} characters`);
	return result;
}

function hashBytes(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function pathInside(root: string, candidate: string): boolean {
	const isValidRelative = (value: string): boolean =>
		value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
	const result = relative(root, candidate);
	if (isValidRelative(result)) return true;
	// realpath normally gives matching casing on Windows, but the fallback keeps the
	// boundary correct when a caller supplies a differently-cased absolute path.
	if (process.platform !== "win32") return false;
	return isValidRelative(relative(root.toLowerCase(), candidate.toLowerCase()));
}

function slashRelative(root: string, candidate: string): string {
	return relative(root, candidate).split(sep).join("/");
}

async function canonicalDirectory(path: string, label: string, code: string): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(path);
	} catch (error) {
		throw new CourseBuilderError(code, `${label} is unavailable: ${String(error)}`);
	}
	let details;
	try {
		details = await stat(canonical);
	} catch (error) {
		throw new CourseBuilderError(code, `${label} is unavailable: ${String(error)}`);
	}
	if (!details.isDirectory()) throw new CourseBuilderError(code, `${label} must be a directory`);
	return canonical;
}

async function outputRootFor(
	cwd: string,
	projectId: string,
): Promise<CourseOutputRoot> {
	const canonicalCwd = await canonicalDirectory(cwd, "Course cwd", "ASSET_CWD_UNAVAILABLE");
	const lexicalParent = resolve(canonicalCwd, ".pi", "course-builder");
	const parent = await canonicalDirectory(
		lexicalParent,
		"Course generated output parent",
		"ASSET_OUTPUT_DIRECTORY_UNAVAILABLE",
	);
	if (!pathInside(canonicalCwd, parent))
		throw new CourseBuilderError(
			"ASSET_PATH_ESCAPE",
			"Course generated output parent escaped the supplied course cwd",
		);

	const lexicalRoot = resolve(parent, projectId);
	const outputPath = await canonicalDirectory(
		lexicalRoot,
		"Course generated output directory",
		"ASSET_OUTPUT_DIRECTORY_UNAVAILABLE",
	);
	const expectedName = process.platform === "win32" ? projectId.toLowerCase() : projectId;
	const actualName = process.platform === "win32" ? basename(outputPath).toLowerCase() : basename(outputPath);
	if (!pathInside(parent, outputPath) || actualName !== expectedName)
		throw new CourseBuilderError(
			"ASSET_PATH_ESCAPE",
			"Course generated output directory does not belong to this Course Builder project",
		);
	return { cwd: canonicalCwd, parent, path: outputPath };
}

async function ownedFile(
	root: CourseOutputRoot,
	inputPath: string,
	label: string,
): Promise<OwnedFile> {
	const lexicalPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root.cwd, inputPath);
	let canonical: string;
	try {
		canonical = await realpath(lexicalPath);
	} catch (error) {
		throw new CourseBuilderError("ASSET_NOT_FOUND", `${label} is unavailable: ${String(error)}`);
	}
	if (!pathInside(root.path, canonical))
		throw new CourseBuilderError(
			"ASSET_PATH_ESCAPE",
			`${label} is outside this course's owned generated output directory`,
		);
	let details;
	try {
		details = await stat(canonical);
	} catch (error) {
		throw new CourseBuilderError("ASSET_NOT_FOUND", `${label} is unavailable: ${String(error)}`);
	}
	if (!details.isFile()) throw new CourseBuilderError("ASSET_NOT_FILE", `${label} must be a file`);
	if (!Number.isSafeInteger(details.size) || details.size < 0)
		throw new CourseBuilderError("ASSET_SIZE_INVALID", `${label} has an invalid size`);
	return { path: canonical, size: details.size };
}

async function readOwnedBytes(file: OwnedFile, label: string, maxBytes: number): Promise<Uint8Array> {
	if (file.size > maxBytes)
		throw new CourseBuilderError("ASSET_TOO_LARGE", `${label} exceeds the ${maxBytes} byte read budget`);
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(file.path));
	} catch (error) {
		throw new CourseBuilderError("ASSET_NOT_FOUND", `${label} could not be read: ${String(error)}`);
	}
	if (bytes.byteLength > maxBytes)
		throw new CourseBuilderError("ASSET_TOO_LARGE", `${label} exceeds the ${maxBytes} byte read budget`);
	return bytes;
}

function assetExtension(bytes: Uint8Array): "png" | "jpg" | "pdf" {
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.byteLength >= png.length && png.every((value, index) => bytes[index] === value)) return "png";
	if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (
		bytes.byteLength >= 5 &&
		bytes[0] === 0x25 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x44 &&
		bytes[3] === 0x46 &&
		bytes[4] === 0x2d
	)
		return "pdf";
	throw new CourseBuilderError(
		"UNSUPPORTED_ASSET",
		"Generated asset bytes are unsupported; expected a PNG, JPEG, or PDF file",
	);
}

function usefulStem(path: string): string {
	const original = basename(path, extname(path)).normalize("NFC");
	const sanitized = original
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/\.{2,}/gu, ".")
		.replace(/^[._-]+|[._-]+$/gu, "")
		.slice(0, 80);
	return sanitized || "asset";
}

function materialMatches(
	material: CourseBuilderMaterial,
	lessonPlanId: string,
	assetHash: string,
	source: SourceRecord | null,
): boolean {
	if (!(
		material.kind === "asset" &&
		material.sourceHash === assetHash &&
		material.metadata.storage === "generated" &&
		material.metadata.generatedAsset === true &&
		material.metadata.generatedAssetVersion === GENERATED_ASSET_VERSION &&
		material.metadata.lessonPlanId === lessonPlanId
	)) return false;
	// A caller without source provenance can safely replay an existing asset. If
	// provenance is supplied, it is part of the durable identity so changed
	// source code produces a new material instead of silently retaining old proof.
	const provenance = material.metadata.provenance;
	if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return source === null;
	const existingSourcePath = typeof provenance.sourcePath === "string" ? provenance.sourcePath : null;
	const existingSourceHash = typeof provenance.sourceHash === "string" ? provenance.sourceHash : null;
	return source === null || (existingSourcePath === source.path && existingSourceHash === source.hash);
}

function replayResult(
	material: CourseBuilderMaterial,
	projectId: string,
	lessonPlanId: string,
	assetExtensionValue: "png" | "jpg" | "pdf",
	projectRevision: number,
): ImportedCourseGeneratedAsset {
	const provenanceValue = material.metadata.provenance;
	const provenance =
		provenanceValue && typeof provenanceValue === "object" && !Array.isArray(provenanceValue)
			? provenanceValue as Partial<GeneratedAssetProvenance>
			: {};
	const sourcePath = typeof provenance.sourcePath === "string" ? provenance.sourcePath : null;
	const sourceRelativePath =
		typeof provenance.sourceRelativePath === "string" ? provenance.sourceRelativePath : null;
	const sourceHash = typeof provenance.sourceHash === "string" ? provenance.sourceHash : null;
	const assetPath =
		typeof provenance.assetPath === "string" ? provenance.assetPath : material.name;
	const assetRelativePath =
		typeof provenance.assetRelativePath === "string" ? provenance.assetRelativePath : material.name;
	const resultProvenance: GeneratedAssetProvenance = {
		assetPath,
		assetRelativePath,
		sourcePath,
		sourceRelativePath,
		sourceHash,
	};
	return {
		projectId,
		lessonPlanId,
		materialId: material.materialId,
		beamerPath: `assets/${material.materialId}.${assetExtensionValue}`,
		extension: assetExtensionValue,
		sourceHash: material.sourceHash,
		provenance: resultProvenance,
		projectRevision,
		replay: true,
	};
}

/**
 * Register one locally generated image/PDF in the current Course Builder project.
 *
 * The generated output directory is the only filesystem authority here. Source
 * code is read as bounded UTF-8 provenance and is never interpreted or executed.
 */
export async function importCourseGeneratedAsset(
	host: CourseBuilderHost,
	sessionId: string,
	cwd: string,
	spec: unknown,
	expectedProjectRevision: number,
	assertActive?: () => void | Promise<void>,
): Promise<ImportedCourseGeneratedAsset> {
	if (!host || typeof host.getProjectForSession !== "function" || typeof host.importMaterials !== "function")
		throw new CourseBuilderError("INVALID_INPUT", "A CourseBuilderHost is required");
	const currentSessionId = requiredString(sessionId, "sessionId", 512);
	const currentCwd = requiredString(cwd, "cwd", 32_768);
	if (!spec || typeof spec !== "object" || Array.isArray(spec))
		throw new CourseBuilderError("INVALID_INPUT", "spec must be an object");
	const input = spec as Record<string, unknown>;
	const assetInputPath = requiredString(input.path, "spec.path", 32_768);
	const lessonPlanId = requiredString(input.lessonPlanId, "spec.lessonPlanId", 512);
	const purpose = requiredString(input.purpose, "spec.purpose", 10_000);
	const sourceInputPath = input.sourcePath === undefined ? undefined : requiredString(input.sourcePath, "spec.sourcePath", 32_768);
	if (!Number.isSafeInteger(expectedProjectRevision) || expectedProjectRevision < 0)
		throw new CourseBuilderError("INVALID_INPUT", "expectedProjectRevision must be a non-negative integer");
	if (assertActive !== undefined && typeof assertActive !== "function")
		throw new CourseBuilderError("INVALID_INPUT", "assertActive must be a function");

	const project = host.getProjectForSession(currentSessionId);
	if (!project) throw new CourseBuilderError("PROJECT_BINDING_REQUIRED", "Course Builder project is unavailable for this session");
	if (host.getAgentAssignmentScope(currentSessionId) !== null)
		throw new CourseBuilderError(
			"MATERIAL_SCOPE_MISMATCH",
			"Generated course assets are unavailable while the Agent is scoped to an Assignment",
		);
	const outputRoot = await outputRootFor(currentCwd, project.projectId);
	const assetFile = await ownedFile(outputRoot, assetInputPath, "Generated asset");
	const assetBytes = await readOwnedBytes(assetFile, "Generated asset", MAX_GENERATED_ASSET_BYTES);
	const extension = assetExtension(assetBytes);
	const sourceFile = sourceInputPath === undefined
		? null
		: await ownedFile(outputRoot, sourceInputPath, "Generated source");
	let source: SourceRecord | null = null;
	if (sourceFile) {
		const sourceBytes = await readOwnedBytes(sourceFile, "Generated source", MAX_GENERATED_SOURCE_BYTES);
		let sourceText: string;
		try {
			sourceText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
		} catch (error) {
			throw new CourseBuilderError("INVALID_SOURCE", `Generated source must be valid UTF-8: ${String(error)}`);
		}
		if (sourceText.includes("\u0000"))
			throw new CourseBuilderError("INVALID_SOURCE", "Generated source contains binary NUL bytes");
		source = {
			...sourceFile,
			relativePath: slashRelative(outputRoot.path, sourceFile.path),
			bytes: sourceBytes,
			hash: hashBytes(sourceBytes),
		};
	}
	await assertActive?.();
	if (host.getAgentAssignmentScope(currentSessionId) !== null)
		throw new CourseBuilderError(
			"MATERIAL_SCOPE_MISMATCH",
			"Generated course assets are unavailable while the Agent is scoped to an Assignment",
		);

	const snapshot = host.getSnapshotForSession(currentSessionId);
	if (!snapshot || snapshot.project.projectId !== project.projectId)
		throw new CourseBuilderError("PROJECT_BINDING_REQUIRED", "Course Builder project changed while importing the generated asset");
	if (!snapshot.lessonPlans.some((lesson) => lesson.lessonPlanId === lessonPlanId && lesson.projectId === project.projectId))
		throw new CourseBuilderError("LESSON_PLAN_NOT_FOUND", "Lesson Plan is unavailable in this Course Builder project");
	const assetHash = hashBytes(assetBytes);
	const existing = snapshot.materials.find((material) => materialMatches(material, lessonPlanId, assetHash, source));
	if (existing) {
		const replay = replayResult(existing, project.projectId, lessonPlanId, extension, snapshot.project.revision);
		console.info("[course-builder] generated asset replayed", {
			projectId: project.projectId,
			sessionId: currentSessionId,
			lessonPlanId,
			materialId: replay.materialId,
			assetHash,
		});
		return replay;
	}

	const beforeCommitProject = host.getProjectForSession(currentSessionId);
	if (!beforeCommitProject || beforeCommitProject.projectId !== project.projectId)
		throw new CourseBuilderError("PROJECT_BINDING_REQUIRED", "Course Builder project changed before generated asset import");

	const assetRelativePath = slashRelative(outputRoot.path, assetFile.path);
	const provenance: GeneratedAssetProvenance = {
		assetPath: assetFile.path,
		assetRelativePath,
		sourcePath: source?.path ?? null,
		sourceRelativePath: source?.relativePath ?? null,
		sourceHash: source?.hash ?? null,
	};
	const metadataProvenance: Record<string, JsonValue> = {
		assetPath: provenance.assetPath,
		assetRelativePath: provenance.assetRelativePath,
		sourcePath: provenance.sourcePath,
		sourceRelativePath: provenance.sourceRelativePath,
		sourceHash: provenance.sourceHash,
	};
	const metadata: Record<string, JsonValue> = {
		storage: "generated",
		materialScope: "course",
		generatedAsset: true,
		generatedAssetVersion: GENERATED_ASSET_VERSION,
		lessonPlanId,
		purpose,
		assetPath: assetFile.path,
		assetRelativePath,
		sourcePath: source?.path ?? null,
		sourceRelativePath: source?.relativePath ?? null,
		sourceHash: source?.hash ?? null,
		provenance: metadataProvenance,
	};
	const lessonHash = hashBytes(new TextEncoder().encode(lessonPlanId)).slice("sha256:".length);
	const sourceHash = source?.hash.slice("sha256:".length) ?? "nosource";
	const sourcePathHash = source
		? hashBytes(new TextEncoder().encode(source.relativePath)).slice("sha256:".length)
		: "nosource";
	const name = `generated-${usefulStem(assetFile.path)}-${assetHash.slice("sha256:".length)}-${lessonHash}-${sourceHash}-${sourcePathHash}.${extension}`;
	const [material] = host.importMaterials(
		currentSessionId,
		[
			{
				name,
				kind: "asset",
				sourceBytes: assetBytes,
				extractedText: "",
				metadata,
			},
		],
		expectedProjectRevision,
	);
	if (!material) throw new CourseBuilderError("CORRUPT_STATE", "Course Builder did not return the imported generated asset");
	const projectRevision = host.getProject(project.projectId).revision;
	const result: ImportedCourseGeneratedAsset = {
		projectId: project.projectId,
		lessonPlanId,
		materialId: material.materialId,
		beamerPath: `assets/${material.materialId}.${extension}`,
		extension,
		sourceHash: material.sourceHash,
		provenance,
		projectRevision,
		replay: false,
	};
	console.info("[course-builder] generated asset imported", {
		projectId: project.projectId,
		sessionId: currentSessionId,
		lessonPlanId,
		materialId: result.materialId,
		assetHash: result.sourceHash,
		sourceHash: provenance.sourceHash,
		projectRevision,
	});
	return result;
}
