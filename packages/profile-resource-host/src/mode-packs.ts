import {
	HARNESS_CONTRACT_VERSION,
	type ModePackComponentPin,
	type ModePackComponentRef,
	type ModePackDefinition,
	type ModePackDraft,
	type ProfileDefinition,
	parseModePackDefinition,
	parseModePackDraft,
	type ResourceDescriptor,
	type ResourceKind,
	type ResourceSnapshot,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deepFreeze } from "../../harness-core/src/index.ts";
import { ProfileResolutionError, type ResourceCatalog, resolveProfileSnapshot } from "./profile-resource-host.ts";

export interface ModePackAvailability {
	selectable: boolean;
	missingRequiredResources: string[];
	missingOptionalResources: string[];
	identityMismatches: string[];
}

function componentResource(component: Pick<ModePackComponentRef, "type" | "id">): {
	kind: ResourceKind;
	id: string;
} {
	if (component.type === "plugin") return { kind: "extension", id: component.id };
	if (component.type === "workflow") return { kind: "prompt", id: `workflow:${component.id}` };
	return { kind: component.type, id: component.id };
}

function componentKey(component: Pick<ModePackComponentRef, "type" | "id">): string {
	return `${component.type}:${component.id}`;
}

function descriptor(component: ModePackComponentPin): ResourceDescriptor {
	const mapped = componentResource(component);
	return {
		kind: mapped.kind,
		id: mapped.id,
		version: component.version,
		contentHash: component.contentHash,
		required: component.required,
		enabled: component.enabled,
	};
}

export function compileModePackDraft(value: unknown, catalog: ResourceCatalog): ModePackDefinition {
	const draft = parseModePackDraft(value);
	const seen = new Set<string>();
	const components: ModePackComponentPin[] = [];
	for (const component of draft.components) {
		const key = componentKey(component);
		if (seen.has(key)) {
			throw new ProfileResolutionError("DUPLICATE_MODE_COMPONENT", `Duplicate Mode Pack component ${key}`);
		}
		seen.add(key);
		if (!component.enabled) continue;
		const mapped = componentResource(component);
		const installed = catalog.get(mapped.kind, mapped.id);
		if (!installed) {
			if (!component.required) continue;
			throw new ProfileResolutionError("MISSING_RESOURCE", `Required Mode Pack component ${key} is not installed`);
		}
		components.push({
			...component,
			version: installed.version,
			contentHash: installed.contentHash,
		});
	}
	const normalized = {
		...draft,
		tools: [...new Set(draft.tools)].sort(),
		components: components.sort((left, right) => componentKey(left).localeCompare(componentKey(right))),
		instructions: [...new Set(draft.instructions)],
	};
	return deepFreeze(
		parseModePackDefinition({
			...normalized,
			contentHash: contentHash(normalized),
		}),
	);
}

export function modePackToProfile(pack: ModePackDefinition): ProfileDefinition {
	return {
		version: HARNESS_CONTRACT_VERSION,
		profileId: pack.modePackId,
		revision: pack.revision,
		role: pack.role,
		mode: pack.runtimeMode,
		provider: pack.provider,
		model: pack.model,
		thinkingLevel: pack.thinkingLevel,
		externalKnowledgePolicy: pack.externalKnowledgePolicy,
		courseRequired: pack.courseRequired,
		tools: [...pack.tools],
		resources: pack.components.map(descriptor),
		instructions: [
			`Mode Pack: ${pack.title} (${pack.modePackId})`,
			`Mode Pack content hash: ${pack.contentHash}`,
			pack.systemPrompt.trim(),
			...pack.instructions,
		],
	};
}

export function resolveModePackSnapshot(options: {
	pack: ModePackDefinition;
	courseVersionId: string | null;
	catalog: ResourceCatalog;
	createdAt?: string;
}): ResourceSnapshot {
	return resolveProfileSnapshot({
		base: modePackToProfile(options.pack),
		courseVersionId: options.courseVersionId,
		catalog: options.catalog,
		...(options.createdAt ? { createdAt: options.createdAt } : {}),
	});
}

export function inspectModePackAvailability(pack: ModePackDefinition, catalog: ResourceCatalog): ModePackAvailability {
	const missingRequiredResources: string[] = [];
	const missingOptionalResources: string[] = [];
	const identityMismatches: string[] = [];
	for (const tool of pack.tools) {
		if (!catalog.get("tool", tool)) missingRequiredResources.push(`tool:${tool}`);
	}
	for (const component of pack.components) {
		if (!component.enabled) continue;
		const mapped = componentResource(component);
		const key = `${mapped.kind}:${mapped.id}`;
		const installed = catalog.get(mapped.kind, mapped.id);
		if (!installed) {
			(component.required ? missingRequiredResources : missingOptionalResources).push(key);
			continue;
		}
		if (installed.version !== component.version || installed.contentHash !== component.contentHash) {
			identityMismatches.push(key);
		}
	}
	return {
		selectable: missingRequiredResources.length === 0 && identityMismatches.length === 0,
		missingRequiredResources: missingRequiredResources.sort(),
		missingOptionalResources: missingOptionalResources.sort(),
		identityMismatches: identityMismatches.sort(),
	};
}

function component(type: ModePackComponentRef["type"], id: string, required = true): ModePackComponentRef {
	return { type, id, required, enabled: true };
}

const BASE = {
	version: HARNESS_CONTRACT_VERSION,
	revision: 1,
	provider: null,
	model: null,
	thinkingLevel: "high" as const,
	components: [component("plugin", "learning-harness")],
	instructions: [] as string[],
};

export const BUILTIN_MODE_PACK_DRAFTS: Readonly<Record<string, ModePackDraft>> = deepFreeze({
	"student-learn": {
		...BASE,
		modePackId: "student-learn",
		title: "Tutor",
		description: "以当前课程和可核验来源为边界的解释与学习模式。",
		category: "education",
		role: "student",
		runtimeMode: "student-learn",
		externalKnowledgePolicy: "explain-and-label",
		courseRequired: true,
		tools: [],
		components: [
			...BASE.components,
			component("prompt", "education.tutor"),
			component("workflow", "tutor"),
			component("skill", "education.lesson-blueprint", false),
			component("skill", "education.learning-to-learn", false),
			component("skill", "education.evidence-ledger", false),
			component("skill", "education.curriculum-continuity", false),
			component("skill", "education.learn-by-doing", false),
			component("skill", "shared.personal-skill-builder", false),
		],
		systemPrompt:
			"Teach the learner accurately and directly within the active course. Prefer understanding over ceremony.",
	},
	practice: {
		...BASE,
		modePackId: "practice",
		title: "Practice",
		description: "真实作答优先、提示分级且答案受 Capability 门保护的练习模式。",
		category: "education",
		role: "student",
		runtimeMode: "practice",
		externalKnowledgePolicy: "deny",
		courseRequired: true,
		tools: [],
		components: [
			...BASE.components,
			component("prompt", "education.practice"),
			component("workflow", "practice"),
			component("skill", "education.learning-to-learn", false),
		],
		systemPrompt: "Coach practice without pre-empting the learner's attempt or bypassing the Assessment Host.",
	},
	"teach-back": {
		...BASE,
		modePackId: "teach-back",
		title: "Teach-back",
		description: "让学习者先解释，再定位最小缺口、重述并迁移。",
		category: "education",
		role: "student",
		runtimeMode: "student-learn",
		externalKnowledgePolicy: "explain-and-label",
		courseRequired: true,
		tools: [],
		components: [
			...BASE.components,
			component("prompt", "education.teach-back"),
			component("workflow", "teach-back"),
			component("skill", "education.feynman-teach-back"),
			component("skill", "education.learning-to-learn", false),
		],
		systemPrompt:
			"Use the learner's explanation as the working object. Do not replace it with a lecture before diagnosing the smallest gap.",
	},
	"visual-lab": {
		...BASE,
		modePackId: "visual-lab",
		title: "Visual Lab",
		description: "预测、结构化规格、确定性计算与可视化解释。",
		category: "education",
		role: "student",
		runtimeMode: "visual-lab",
		externalKnowledgePolicy: "deny",
		courseRequired: true,
		tools: ["create_visual_spec", "get_course_context", "validate_visual_artifact"],
		components: [
			...BASE.components,
			component("workflow", "visual-lab"),
			component("skill", "education.visual-explanation"),
			component("skill", "education.learn-by-doing"),
		],
		systemPrompt:
			"Create only bounded structured visualization specifications and validated deterministic artifacts.",
	},
	"teacher-prep": {
		...BASE,
		modePackId: "teacher-prep",
		title: "Teacher Prep",
		description: "教学蓝图、事实核查和最小修订的教师侧工作模式。",
		category: "education",
		role: "teacher",
		runtimeMode: "teacher-prep",
		externalKnowledgePolicy: "allow",
		courseRequired: false,
		tools: ["find", "grep", "ls", "read"],
		components: [
			...BASE.components,
			component("prompt", "teacher.prep"),
			component("skill", "education.lesson-blueprint"),
			component("skill", "education.evidence-ledger"),
			component("skill", "shared.revision-discipline"),
		],
		systemPrompt: "Prepare and revise educational material without exposing teacher-only resources to students.",
	},
	coding: {
		...BASE,
		modePackId: "coding",
		title: "Coding",
		description: "面向真实仓库的检查、最小编辑、测试与差异核验。",
		category: "coding",
		role: "general",
		runtimeMode: "general",
		externalKnowledgePolicy: "allow",
		courseRequired: false,
		tools: ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"],
		components: [
			...BASE.components,
			component("prompt", "coding.core"),
			component("workflow", "coding"),
			component("skill", "shared.revision-discipline"),
		],
		systemPrompt:
			"Work against the actual repository, preserve local instructions, and verify every material code change.",
	},
	creative: {
		...BASE,
		modePackId: "creative",
		title: "Creative",
		description: "保留设定、文风和受众约束的创作与一致性修订模式。",
		category: "creative",
		role: "general",
		runtimeMode: "general",
		externalKnowledgePolicy: "allow",
		courseRequired: false,
		tools: ["edit", "find", "grep", "ls", "read", "write"],
		components: [
			...BASE.components,
			component("prompt", "creative.core"),
			component("workflow", "creative"),
			component("skill", "shared.revision-discipline"),
		],
		systemPrompt: "Create within the user's canon and constraints, then revise for intent and consistency.",
	},
	general: {
		...BASE,
		modePackId: "general",
		title: "General",
		description: "保留基础读取工具的通用 Pi 模式。",
		category: "general",
		role: "general",
		runtimeMode: "general",
		externalKnowledgePolicy: "allow",
		courseRequired: false,
		tools: ["find", "grep", "ls", "read"],
		components: [
			...BASE.components,
			component("prompt", "general.core"),
			component("skill", "shared.personal-skill-builder", false),
		],
		systemPrompt: "Follow the user's task using the active tools and explicit source-of-truth boundaries.",
	},
});

export function createBuiltinModePacks(catalog: ResourceCatalog): Readonly<Record<string, ModePackDefinition>> {
	return deepFreeze(
		Object.fromEntries(
			Object.entries(BUILTIN_MODE_PACK_DRAFTS).map(([id, draft]) => [id, compileModePackDraft(draft, catalog)]),
		),
	);
}
