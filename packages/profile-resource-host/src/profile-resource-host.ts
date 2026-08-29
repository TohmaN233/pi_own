import {
	HARNESS_CONTRACT_VERSION,
	parseProfileDefinition,
	parseResourceSnapshot,
	type ProfileDefinition,
	type ProfileLayer,
	type ProfileMode,
	type ProfilePatch,
	type ResourceDescriptor,
	type ResourceKind,
	type ResourceSnapshot,
	type SnapshotDiff,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deepFreeze, deterministicId, stableStringify } from "../../harness-core/src/index.ts";

export class ProfileResolutionError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ProfileResolutionError";
		this.code = code;
	}
}

function resourceKey(resource: Pick<ResourceDescriptor, "kind" | "id">): string {
	return `${resource.kind}:${resource.id}`;
}

export interface ResourceCatalogEntry {
	kind: ResourceKind;
	id: string;
	version: string;
	contentHash: string;
}

export class ResourceCatalog {
	private readonly resources = new Map<string, ResourceCatalogEntry>();

	constructor(entries: readonly ResourceCatalogEntry[]) {
		for (const entry of entries) {
			const key = resourceKey(entry);
			if (this.resources.has(key)) throw new ProfileResolutionError("DUPLICATE_RESOURCE", `Duplicate resource ${key}`);
			this.resources.set(key, { ...entry });
		}
	}

	get(kind: ResourceKind, id: string): ResourceCatalogEntry | undefined {
		return this.resources.get(`${kind}:${id}`);
	}

	assertAvailable(resource: ResourceDescriptor): void {
		if (!resource.enabled) return;
		const installed = this.get(resource.kind, resource.id);
		if (!installed) {
			if (resource.required) throw new ProfileResolutionError("MISSING_RESOURCE", `Required resource ${resourceKey(resource)} is not installed`);
			return;
		}
		if (installed.version !== resource.version || installed.contentHash !== resource.contentHash) {
			throw new ProfileResolutionError(
				"RESOURCE_IDENTITY_MISMATCH",
				`Resource ${resourceKey(resource)} does not match pinned version/hash`,
			);
		}
	}
}

function mergeResources(base: readonly ResourceDescriptor[], patch: readonly ResourceDescriptor[] | undefined): ResourceDescriptor[] {
	const merged = new Map<string, ResourceDescriptor>();
	for (const resource of base) merged.set(resourceKey(resource), { ...resource });
	for (const resource of patch ?? []) merged.set(resourceKey(resource), { ...resource });
	return [...merged.values()].sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)));
}

function mergeProfilePatch(current: ProfileDefinition, patch: ProfilePatch): ProfileDefinition {
	return {
		...current,
		profileId: patch.profileId ?? current.profileId,
		role: patch.role ?? current.role,
		mode: patch.mode ?? current.mode,
		provider: patch.provider === undefined ? current.provider : patch.provider,
		model: patch.model === undefined ? current.model : patch.model,
		thinkingLevel: patch.thinkingLevel ?? current.thinkingLevel,
		externalKnowledgePolicy: patch.externalKnowledgePolicy ?? current.externalKnowledgePolicy,
		courseRequired: patch.courseRequired ?? current.courseRequired,
		tools: patch.tools ? [...new Set(patch.tools)].sort() : [...current.tools],
		resources: mergeResources(current.resources, patch.resources),
		instructions: patch.instructions
			? [...new Set([...current.instructions, ...patch.instructions])]
			: [...current.instructions],
	};
}

function assertModeRole(mode: ProfileMode, role: ResourceSnapshot["role"]): void {
	if (mode === "teacher-prep" && role !== "teacher") {
		throw new ProfileResolutionError("ROLE_MODE_MISMATCH", "teacher-prep requires teacher role");
	}
	if ((mode === "student-learn" || mode === "practice" || mode === "visual-lab") && role !== "student") {
		throw new ProfileResolutionError("ROLE_MODE_MISMATCH", `${mode} requires student role`);
	}
}

function assertStudentSafety(profile: ProfileDefinition): void {
	if (profile.role !== "student") return;
	const forbiddenTools = new Set(["bash", "powershell", "write", "edit"]);
	const forbidden = profile.tools.filter((tool) => forbiddenTools.has(tool));
	if (forbidden.length > 0) {
		throw new ProfileResolutionError("UNSAFE_STUDENT_TOOL", `Student profile enables forbidden tools: ${forbidden.join(", ")}`);
	}
	if (profile.mode === "practice" && profile.externalKnowledgePolicy !== "deny") {
		throw new ProfileResolutionError("UNSAFE_PRACTICE_POLICY", "Practice profile must deny external knowledge");
	}
}

function validateCatalog(profile: ProfileDefinition, catalog: ResourceCatalog): ResourceDescriptor[] {
	const effective: ResourceDescriptor[] = [];
	for (const resource of profile.resources) {
		catalog.assertAvailable(resource);
		if (!resource.enabled) continue;
		if (catalog.get(resource.kind, resource.id)) effective.push({ ...resource });
	}
	for (const tool of profile.tools) {
		if (!catalog.get("tool", tool)) throw new ProfileResolutionError("UNKNOWN_TOOL", `Unknown tool ${tool}`);
	}
	return effective;
}

export interface ResolveProfileOptions {
	base: unknown;
	layers?: readonly ProfileLayer[];
	courseVersionId: string | null;
	catalog: ResourceCatalog;
	createdAt?: string;
}

export function resolveProfileSnapshot(options: ResolveProfileOptions): ResourceSnapshot {
	let profile = parseProfileDefinition(options.base);
	const layers = [...(options.layers ?? [])].sort(
		(left, right) => left.priority - right.priority || left.layerId.localeCompare(right.layerId),
	);
	for (const layer of layers) profile = mergeProfilePatch(profile, layer.patch);
	profile = parseProfileDefinition(profile);
	assertModeRole(profile.mode, profile.role);
	assertStudentSafety(profile);
	if (profile.courseRequired && !options.courseVersionId) {
		throw new ProfileResolutionError("COURSE_REQUIRED", `Profile ${profile.profileId} requires a course version`);
	}
	const resources = validateCatalog(profile, options.catalog);
	const createdAt = options.createdAt ?? new Date().toISOString();
	if (!Number.isFinite(Date.parse(createdAt))) throw new ProfileResolutionError("INVALID_TIMESTAMP", "createdAt must be ISO-8601");
	const payload = {
		version: HARNESS_CONTRACT_VERSION,
		profileId: profile.profileId,
		profileRevision: profile.revision,
		role: profile.role,
		mode: profile.mode,
		courseVersionId: options.courseVersionId,
		provider: profile.provider,
		model: profile.model,
		thinkingLevel: profile.thinkingLevel,
		externalKnowledgePolicy: profile.externalKnowledgePolicy,
		tools: [...profile.tools].sort(),
		resources,
		instructions: [...profile.instructions],
	};
	const hash = contentHash(payload);
	const snapshot = parseResourceSnapshot({
		...payload,
		resourceSnapshotId: deterministicId("snapshot", payload),
		createdAt,
		contentHash: hash,
	});
	return deepFreeze(snapshot);
}

function comparable(snapshot: ResourceSnapshot): Record<string, unknown> {
	return {
		profileId: snapshot.profileId,
		profileRevision: snapshot.profileRevision,
		role: snapshot.role,
		mode: snapshot.mode,
		courseVersionId: snapshot.courseVersionId,
		provider: snapshot.provider,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		externalKnowledgePolicy: snapshot.externalKnowledgePolicy,
		tools: snapshot.tools,
		resources: snapshot.resources,
		instructions: snapshot.instructions,
	};
}

export function classifySnapshotSwitch(current: ResourceSnapshot | null, next: ResourceSnapshot): SnapshotDiff {
	if (!current) return { kind: "hard", changedFields: ["initial"], addedResources: next.resources.map(resourceKey), removedResources: [] };
	const changedFields: string[] = [];
	const left = comparable(current);
	const right = comparable(next);
	for (const key of Object.keys(left)) {
		if (stableStringify(left[key]) !== stableStringify(right[key])) changedFields.push(key);
	}
	const oldResources = new Map(current.resources.map((resource) => [resourceKey(resource), resource]));
	const newResources = new Map(next.resources.map((resource) => [resourceKey(resource), resource]));
	const addedResources = [...newResources.keys()].filter((key) => !oldResources.has(key)).sort();
	const removedResources = [...oldResources.keys()].filter((key) => !newResources.has(key)).sort();
	if (changedFields.length === 0) return { kind: "none", changedFields, addedResources, removedResources };
	if (changedFields.some((field) => field === "courseVersionId" || field === "role")) {
		return { kind: "hard", changedFields, addedResources, removedResources };
	}
	const resourceWarm = [...oldResources.keys(), ...newResources.keys()].some((key) => {
		const oldValue = oldResources.get(key);
		const newValue = newResources.get(key);
		if (stableStringify(oldValue ?? null) === stableStringify(newValue ?? null)) return false;
		return (oldValue ?? newValue)?.kind !== "tool";
	});
	if (resourceWarm || changedFields.includes("mode") || changedFields.includes("profileId")) {
		return { kind: "warm", changedFields, addedResources, removedResources };
	}
	return { kind: "hot", changedFields, addedResources, removedResources };
}

export interface SnapshotRuntimeAdapter<TCheckpoint = unknown> {
	capture(): Promise<TCheckpoint>;
	applyHot(snapshot: ResourceSnapshot): Promise<void>;
	reloadResources(snapshot: ResourceSnapshot): Promise<void>;
	replaceSession(snapshot: ResourceSnapshot): Promise<void>;
	verify(snapshot: ResourceSnapshot): Promise<boolean>;
	restore(checkpoint: TCheckpoint): Promise<void>;
}

export async function applySnapshotAtomically<TCheckpoint>(
	current: ResourceSnapshot | null,
	next: ResourceSnapshot,
	adapter: SnapshotRuntimeAdapter<TCheckpoint>,
): Promise<SnapshotDiff> {
	const diff = classifySnapshotSwitch(current, next);
	if (diff.kind === "none") return diff;
	const checkpoint = await adapter.capture();
	try {
		if (diff.kind === "hot") await adapter.applyHot(next);
		else if (diff.kind === "warm") await adapter.reloadResources(next);
		else await adapter.replaceSession(next);
		if (!(await adapter.verify(next))) throw new ProfileResolutionError("SNAPSHOT_VERIFY_FAILED", "Runtime did not apply the requested snapshot");
		return diff;
	} catch (error) {
		await adapter.restore(checkpoint);
		throw error;
	}
}

const TOOL_HASH = "sha256:built-in-tool";

export function createDefaultResourceCatalog(): ResourceCatalog {
	return new ResourceCatalog([
		...[
			"read",
			"grep",
			"find",
			"ls",
			"search_course_knowledge",
			"read_course_span",
			"get_course_context",
			"record_learning_event",
			"get_learning_progress",
			"issue_exercise",
			"submit_attempt",
			"request_hint",
			"request_solution_unlock",
			"read_exercise_solution",
			"create_visual_spec",
			"validate_visual_artifact",
		].map((id) => ({ kind: "tool" as const, id, version: "1", contentHash: TOOL_HASH })),
		{ kind: "skill", id: "grounded-teaching", version: "1", contentHash: "sha256:grounded-teaching-v1" },
		{ kind: "skill", id: "assessment-dialogue", version: "1", contentHash: "sha256:assessment-dialogue-v1" },
		{ kind: "skill", id: "visual-explanation", version: "1", contentHash: "sha256:visual-explanation-v1" },
		{ kind: "extension", id: "learning-harness", version: "1", contentHash: "sha256:learning-harness-v1" },
	]);
}

function descriptor(kind: ResourceKind, id: string, version: string, hash: string): ResourceDescriptor {
	return { kind, id, version, contentHash: hash, required: true, enabled: true };
}

export const BUILTIN_PROFILES: Readonly<Record<string, ProfileDefinition>> = deepFreeze({
	general: {
		version: 1,
		profileId: "general",
		revision: 1,
		role: "general",
		mode: "general",
		provider: null,
		model: null,
		thinkingLevel: "medium",
		externalKnowledgePolicy: "allow",
		courseRequired: false,
		tools: ["find", "grep", "ls", "read"],
		resources: [descriptor("extension", "learning-harness", "1", "sha256:learning-harness-v1")],
		instructions: ["Use the active resource snapshot as the authority for tools and knowledge scope."],
	},
	"student-learn": {
		version: 1,
		profileId: "student-learn",
		revision: 1,
		role: "student",
		mode: "student-learn",
		provider: null,
		model: null,
		thinkingLevel: "high",
		externalKnowledgePolicy: "explain-and-label",
		courseRequired: true,
		tools: [
			"get_course_context",
			"get_learning_progress",
			"read_course_span",
			"record_learning_event",
			"search_course_knowledge",
		],
		resources: [
			descriptor("extension", "learning-harness", "1", "sha256:learning-harness-v1"),
			descriptor("skill", "grounded-teaching", "1", "sha256:grounded-teaching-v1"),
		],
		instructions: ["Prefer current-course evidence; label every derived, computed, external, or insufficient claim."],
	},
	practice: {
		version: 1,
		profileId: "practice",
		revision: 1,
		role: "student",
		mode: "practice",
		provider: null,
		model: null,
		thinkingLevel: "high",
		externalKnowledgePolicy: "deny",
		courseRequired: true,
		tools: [
			"get_course_context",
			"issue_exercise",
			"read_exercise_solution",
			"request_hint",
			"request_solution_unlock",
			"submit_attempt",
		],
		resources: [
			descriptor("extension", "learning-harness", "1", "sha256:learning-harness-v1"),
			descriptor("skill", "assessment-dialogue", "1", "sha256:assessment-dialogue-v1"),
		],
		instructions: ["Do not reveal a solution before Assessment Host authorizes it after a meaningful attempt."],
	},
	"visual-lab": {
		version: 1,
		profileId: "visual-lab",
		revision: 1,
		role: "student",
		mode: "visual-lab",
		provider: null,
		model: null,
		thinkingLevel: "high",
		externalKnowledgePolicy: "deny",
		courseRequired: true,
		tools: ["create_visual_spec", "get_course_context", "validate_visual_artifact"],
		resources: [
			descriptor("extension", "learning-harness", "1", "sha256:learning-harness-v1"),
			descriptor("skill", "visual-explanation", "1", "sha256:visual-explanation-v1"),
		],
		instructions: ["Create only structured visualization specs; never emit executable arbitrary HTML or JavaScript."],
	},
	"teacher-prep": {
		version: 1,
		profileId: "teacher-prep",
		revision: 1,
		role: "teacher",
		mode: "teacher-prep",
		provider: null,
		model: null,
		thinkingLevel: "high",
		externalKnowledgePolicy: "allow",
		courseRequired: false,
		tools: ["find", "grep", "ls", "read"],
		resources: [descriptor("extension", "learning-harness", "1", "sha256:learning-harness-v1")],
		instructions: ["Teacher-only actions remain in the optional teacher package and must never enter student bundles."],
	},
});
