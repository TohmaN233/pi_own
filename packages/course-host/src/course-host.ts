import {
	HARNESS_CONTRACT_VERSION,
	parseCourseMaterialInput,
	type CourseMaterial,
	type CourseMaterialInput,
	type CourseVersion,
	type JsonValue,
	type ResourceSnapshot,
	type SessionBinding,
	type SourceSpan,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deepFreeze, deterministicId, sha256Hex, stableStringify } from "../../harness-core/src/index.ts";

export class CourseHostError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CourseHostError";
		this.code = code;
	}
}

export interface PdfTextExtractor {
	extract(bytes: Uint8Array, name: string): string | Promise<string>;
}

export interface PublishCourseVersionOptions {
	createdAt?: string;
	pdfTextExtractor?: PdfTextExtractor;
	maxSpanCharacters?: number;
}

function normalizeText(text: string): string {
	if (text.includes("\u0000")) throw new CourseHostError("INVALID_TEXT", "Course material contains NUL bytes");
	return text
		.normalize("NFC")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[\t ]+$/g, ""))
		.join("\n")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

function decodeUtf8(bytes: Uint8Array, name: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new CourseHostError("INVALID_UTF8", `${name} is not valid UTF-8`);
	}
}

function notebookToText(raw: string, name: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CourseHostError("INVALID_NOTEBOOK", `${name} is not valid notebook JSON`);
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { cells?: unknown }).cells)) {
		throw new CourseHostError("INVALID_NOTEBOOK", `${name} has no cells array`);
	}
	const sections: string[] = [];
	for (const [index, cell] of ((parsed as { cells: unknown[] }).cells).entries()) {
		if (!cell || typeof cell !== "object") continue;
		const cellType = (cell as { cell_type?: unknown }).cell_type;
		const source = (cell as { source?: unknown }).source;
		if (cellType !== "markdown" && cellType !== "code") continue;
		const text = Array.isArray(source)
			? source.filter((item): item is string => typeof item === "string").join("")
			: typeof source === "string"
				? source
				: "";
		if (!text.trim()) continue;
		sections.push(`## Notebook ${cellType} cell ${index + 1}\n${text}`);
	}
	return sections.join("\n\n");
}

async function materialText(input: CourseMaterialInput, extractor?: PdfTextExtractor): Promise<string> {
	if (input.kind === "pdf") {
		if (!extractor) throw new CourseHostError("PDF_EXTRACTOR_REQUIRED", `PDF ${input.name} requires an explicit text extractor`);
		const bytes = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content;
		return normalizeText(await extractor.extract(bytes, input.name));
	}
	const raw = typeof input.content === "string" ? input.content : decodeUtf8(input.content, input.name);
	return normalizeText(input.kind === "notebook" ? notebookToText(raw, input.name) : raw);
}

function instructionLike(text: string): boolean {
	return /(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?|system\s+prompt|developer\s+message|you\s+are\s+chatgpt|<\|(?:system|assistant|developer)\|>|执行以下指令|忽略(?:之前|以上).*指令|系统提示词)/iu.test(text);
}

interface SpanDraft {
	ordinal: number;
	startLine: number;
	endLine: number;
	headingPath: string[];
	text: string;
}

function splitIntoSpans(text: string, kind: CourseMaterial["kind"], maxCharacters: number): SpanDraft[] {
	const lines = text.split("\n");
	const spans: SpanDraft[] = [];
	let headingPath: string[] = [];
	let currentLines: string[] = [];
	let currentStart = 1;
	let currentHeading: string[] = [];

	const flush = (endLine: number): void => {
		const spanText = currentLines.join("\n").trim();
		if (spanText) {
			spans.push({
				ordinal: spans.length,
				startLine: currentStart,
				endLine,
				headingPath: [...currentHeading],
				text: spanText,
			});
		}
		currentLines = [];
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const lineNumber = index + 1;
		if (kind === "markdown") {
			const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
			if (heading) {
				flush(lineNumber - 1);
				const level = heading[1]?.length ?? 1;
				headingPath = [...headingPath.slice(0, level - 1), heading[2] ?? ""];
				currentStart = lineNumber;
				currentHeading = [...headingPath];
				currentLines.push(line);
				continue;
			}
		}
		if (currentLines.length === 0) {
			currentStart = lineNumber;
			currentHeading = [...headingPath];
		}
		currentLines.push(line);
		const size = currentLines.reduce((sum, item) => sum + item.length + 1, 0);
		const codeBoundary = kind === "code" && currentLines.length >= 60;
		const paragraphBoundary = !line.trim() && size >= Math.min(240, maxCharacters / 3);
		if (size >= maxCharacters || codeBoundary || paragraphBoundary) flush(lineNumber);
	}
	flush(lines.length);
	return spans;
}

function assertCourseId(courseId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(courseId)) {
		throw new CourseHostError("INVALID_COURSE_ID", "courseId contains unsupported characters");
	}
}

function courseVersionIdentity(version: Pick<CourseVersion, "courseId" | "materials" | "spans">): Record<string, unknown> {
	return {
		courseId: version.courseId,
		materials: version.materials.map((material) => ({
			materialId: material.materialId,
			name: material.name,
			kind: material.kind,
			mediaType: material.mediaType,
			contentHash: material.contentHash,
			metadata: material.metadata,
		})),
		spans: version.spans.map((span) => ({
			materialId: span.materialId,
			ordinal: span.ordinal,
			startLine: span.startLine,
			endLine: span.endLine,
			headingPath: span.headingPath,
			textHash: span.textHash,
		})),
	};
}

function assertCourseVersionIntegrity(version: CourseVersion): void {
	assertCourseId(version.courseId);
	if (version.version !== HARNESS_CONTRACT_VERSION) throw new CourseHostError("UNSUPPORTED_VERSION", "Unsupported course contract version");
	if (!Number.isSafeInteger(version.revision) || version.revision < 1) throw new CourseHostError("INVALID_REVISION", "Course revision must be positive");
	if (!Number.isFinite(Date.parse(version.createdAt))) throw new CourseHostError("INVALID_TIMESTAMP", "Course createdAt must be ISO-8601");
	const materialById = new Map<string, CourseMaterial>();
	for (const material of version.materials) {
		if (materialById.has(material.materialId)) throw new CourseHostError("DUPLICATE_MATERIAL", `Duplicate material ${material.materialId}`);
		if (`sha256:${sha256Hex(material.normalizedText)}` !== material.contentHash) throw new CourseHostError("MATERIAL_HASH_MISMATCH", `Material ${material.materialId} failed integrity check`);
		materialById.set(material.materialId, material);
	}
	for (const span of version.spans) {
		const material = materialById.get(span.materialId);
		if (!material || material.contentHash !== span.materialHash) throw new CourseHostError("SPAN_MATERIAL_MISMATCH", `Span ${span.spanId} references an invalid material`);
		if (span.courseVersionId !== version.courseVersionId) throw new CourseHostError("SPAN_VERSION_MISMATCH", `Span ${span.spanId} references another course version`);
		const textHash = `sha256:${sha256Hex(span.text)}`;
		if (textHash !== span.textHash) throw new CourseHostError("SPAN_HASH_MISMATCH", `Span ${span.spanId} failed text integrity check`);
		const spanId = deterministicId("span", {
			materialHash: span.materialHash,
			ordinal: span.ordinal,
			startLine: span.startLine,
			endLine: span.endLine,
			textHash,
		});
		if (spanId !== span.spanId) throw new CourseHostError("SPAN_ID_MISMATCH", `Span ${span.spanId} has an invalid identity`);
	}
	const identity = courseVersionIdentity(version);
	if (contentHash(identity) !== version.contentHash) throw new CourseHostError("COURSE_HASH_MISMATCH", `Course version ${version.courseVersionId} failed integrity check`);
	if (deterministicId("course-version", identity, 32) !== version.courseVersionId) throw new CourseHostError("COURSE_ID_MISMATCH", `Course version ${version.courseVersionId} has an invalid identity`);
}

export interface CourseHostState {
	version: 1;
	versions: CourseVersion[];
}

export class CourseHost {
	private readonly versionsById = new Map<string, CourseVersion>();
	private readonly versionsByCourse = new Map<string, CourseVersion[]>();

	async publishVersion(
		courseId: string,
		materialValues: readonly unknown[],
		options: PublishCourseVersionOptions = {},
	): Promise<CourseVersion> {
		assertCourseId(courseId);
		if (materialValues.length === 0) throw new CourseHostError("EMPTY_COURSE", "A course version needs at least one material");
		const maxSpanCharacters = options.maxSpanCharacters ?? 1200;
		if (!Number.isSafeInteger(maxSpanCharacters) || maxSpanCharacters < 200 || maxSpanCharacters > 10000) {
			throw new CourseHostError("INVALID_SPAN_LIMIT", "maxSpanCharacters must be an integer from 200 to 10000");
		}
		const names = new Set<string>();
		const materials: CourseMaterial[] = [];
		const spanDrafts: Array<{ material: CourseMaterial; spans: SpanDraft[] }> = [];
		for (const value of materialValues) {
			const input = parseCourseMaterialInput(value);
			if (names.has(input.name)) throw new CourseHostError("DUPLICATE_MATERIAL", `Duplicate material name ${input.name}`);
			names.add(input.name);
			const normalizedText = await materialText(input, options.pdfTextExtractor);
			if (!normalizedText) throw new CourseHostError("EMPTY_MATERIAL", `${input.name} has no normalized text`);
			const materialHash = `sha256:${sha256Hex(normalizedText)}`;
			const material: CourseMaterial = {
				materialId: deterministicId("material", { courseId, name: input.name, kind: input.kind, materialHash }),
				name: input.name,
				kind: input.kind,
				mediaType: input.mediaType,
				contentHash: materialHash,
				normalizedText,
				metadata: { ...(input.metadata ?? {}) },
			};
			materials.push(material);
			spanDrafts.push({ material, spans: splitIntoSpans(normalizedText, input.kind, maxSpanCharacters) });
		}
		materials.sort((left, right) => left.name.localeCompare(right.name));
		spanDrafts.sort((left, right) => left.material.name.localeCompare(right.material.name));
		const versionIdentity = {
			courseId,
			materials: materials.map((material) => ({
				materialId: material.materialId,
				name: material.name,
				kind: material.kind,
				mediaType: material.mediaType,
				contentHash: material.contentHash,
				metadata: material.metadata,
			})),
			spans: spanDrafts.flatMap(({ material, spans }) =>
				spans.map((span) => ({
					materialId: material.materialId,
					ordinal: span.ordinal,
					startLine: span.startLine,
					endLine: span.endLine,
					headingPath: span.headingPath,
					textHash: `sha256:${sha256Hex(span.text)}`,
				})),
			),
		};
		const versionHash = contentHash(versionIdentity);
		const courseVersionId = deterministicId("course-version", versionIdentity, 32);
		const existing = this.versionsById.get(courseVersionId);
		if (existing) return existing;
		const previous = this.getLatest(courseId);
		const createdAt = options.createdAt ?? new Date().toISOString();
		if (!Number.isFinite(Date.parse(createdAt))) throw new CourseHostError("INVALID_TIMESTAMP", "createdAt must be ISO-8601");
		const spans: SourceSpan[] = spanDrafts.flatMap(({ material, spans: drafts }) =>
			drafts.map((span) => {
				const textHash = `sha256:${sha256Hex(span.text)}`;
				return {
					spanId: deterministicId("span", {
						materialHash: material.contentHash,
						ordinal: span.ordinal,
						startLine: span.startLine,
						endLine: span.endLine,
						textHash,
					}),
					courseVersionId,
					materialId: material.materialId,
					materialHash: material.contentHash,
					ordinal: span.ordinal,
					startLine: span.startLine,
					endLine: span.endLine,
					headingPath: [...span.headingPath],
					text: span.text,
					textHash,
					instructionLike: instructionLike(span.text),
				};
			}),
		);
		const version: CourseVersion = deepFreeze({
			version: HARNESS_CONTRACT_VERSION,
			courseId,
			courseVersionId,
			revision: previous ? previous.revision + 1 : 1,
			parentCourseVersionId: previous?.courseVersionId ?? null,
			contentHash: versionHash,
			createdAt,
			materials,
			spans,
		});
		this.versionsById.set(courseVersionId, version);
		const list = this.versionsByCourse.get(courseId) ?? [];
		list.push(version);
		this.versionsByCourse.set(courseId, list);
		return version;
	}

	getVersion(courseVersionId: string): CourseVersion {
		const version = this.versionsById.get(courseVersionId);
		if (!version) throw new CourseHostError("UNKNOWN_COURSE_VERSION", `Unknown course version ${courseVersionId}`);
		return version;
	}

	getLatest(courseId: string): CourseVersion | undefined {
		return this.versionsByCourse.get(courseId)?.at(-1);
	}

	listVersions(courseId: string): CourseVersion[] {
		return [...(this.versionsByCourse.get(courseId) ?? [])];
	}

	listCourseIds(): string[] {
		return [...this.versionsByCourse.keys()].sort();
	}

	listAllVersions(): CourseVersion[] {
		return this.listCourseIds().flatMap((courseId) => this.listVersions(courseId));
	}

	exportState(): CourseHostState {
		return { version: 1, versions: this.listAllVersions() };
	}

	restoreState(state: CourseHostState): void {
		if (!state || state.version !== 1 || !Array.isArray(state.versions)) throw new CourseHostError("INVALID_STATE", "Invalid CourseHost state");
		if (this.versionsById.size > 0) throw new CourseHostError("STATE_NOT_EMPTY", "CourseHost restore requires an empty host");
		for (const candidate of state.versions) {
			assertCourseVersionIntegrity(candidate);
			const previous = this.getLatest(candidate.courseId);
			const expectedRevision = previous ? previous.revision + 1 : 1;
			const expectedParent = previous?.courseVersionId ?? null;
			if (candidate.revision !== expectedRevision || candidate.parentCourseVersionId !== expectedParent) {
				throw new CourseHostError("VERSION_CHAIN_MISMATCH", `Course ${candidate.courseId} has a broken version chain`);
			}
			const restored = deepFreeze(JSON.parse(stableStringify(candidate)) as CourseVersion);
			this.versionsById.set(restored.courseVersionId, restored);
			const list = this.versionsByCourse.get(restored.courseId) ?? [];
			list.push(restored);
			this.versionsByCourse.set(restored.courseId, list);
		}
	}

	readSpan(courseVersionId: string, spanId: string): SourceSpan {
		const version = this.getVersion(courseVersionId);
		const span = version.spans.find((item) => item.spanId === spanId);
		if (!span) throw new CourseHostError("SPAN_SCOPE_MISMATCH", `Span ${spanId} is not in course version ${courseVersionId}`);
		return span;
	}

	assertBoundAccess(binding: SessionBinding, snapshot: ResourceSnapshot, courseVersionId: string): void {
		if (binding.courseVersionId !== courseVersionId) throw new CourseHostError("COURSE_BINDING_MISMATCH", "Session is bound to another course version");
		if (snapshot.courseVersionId !== courseVersionId) throw new CourseHostError("SNAPSHOT_BINDING_MISMATCH", "Snapshot is bound to another course version");
		if (binding.resourceSnapshotId !== snapshot.resourceSnapshotId) throw new CourseHostError("SNAPSHOT_BINDING_MISMATCH", "Binding references another snapshot");
	}

	exportManifest(courseVersionId: string): JsonValue {
		const version = this.getVersion(courseVersionId);
		return JSON.parse(stableStringify({
			version: version.version,
			courseId: version.courseId,
			courseVersionId: version.courseVersionId,
			revision: version.revision,
			parentCourseVersionId: version.parentCourseVersionId,
			contentHash: version.contentHash,
			createdAt: version.createdAt,
			materials: version.materials.map(({ normalizedText: _text, ...material }) => material),
			spans: version.spans.map(({ text: _text, ...span }) => span),
		})) as JsonValue;
	}
}

export class CourseSessionRegistry {
	private readonly byCourseVersion = new Map<string, string[]>();
	private readonly bindingBySession = new Map<string, SessionBinding>();

	register(binding: SessionBinding): void {
		if (!binding.courseVersionId) throw new CourseHostError("COURSE_REQUIRED", "Course session needs a course version");
		const existing = this.bindingBySession.get(binding.sessionId);
		if (existing && existing.courseVersionId !== binding.courseVersionId) {
			throw new CourseHostError("COURSE_REBIND_FORBIDDEN", "An existing session cannot move to another course version");
		}
		this.bindingBySession.set(binding.sessionId, binding);
		const sessions = this.byCourseVersion.get(binding.courseVersionId) ?? [];
		if (!sessions.includes(binding.sessionId)) sessions.push(binding.sessionId);
		this.byCourseVersion.set(binding.courseVersionId, sessions);
	}

	openOrCreate(courseVersionId: string, createSession: () => string): string {
		const existing = this.byCourseVersion.get(courseVersionId)?.at(-1);
		return existing ?? createSession();
	}

	getBinding(sessionId: string): SessionBinding | undefined {
		return this.bindingBySession.get(sessionId);
	}
}
