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
import { isBuiltinModeSkillDeleted } from "./builtin-mode-resources.ts";
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
		...(component.delivery ? { delivery: component.delivery } : {}),
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
			...(component.delivery ? { delivery: component.delivery } : {}),
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
		...(pack.packageContentHash ? { packageContentHash: pack.packageContentHash } : {}),
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
		modePackSystemPromptDefaultHash: contentHash({ systemPrompt: options.pack.systemPrompt.trim() }),
		...(options.pack.systemPromptMode ? { modePackSystemPromptMode: options.pack.systemPromptMode } : {}),
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
		if (!installed || installed.available === false) {
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

function component(
	type: ModePackComponentRef["type"],
	id: string,
	required = true,
	delivery?: ModePackComponentRef["delivery"],
	enabled = true,
): ModePackComponentRef {
	return { type, id, required, enabled, ...(delivery ? { delivery } : {}) };
}

const BASE = {
	version: HARNESS_CONTRACT_VERSION,
	revision: 3,
	provider: null,
	model: null,
	thinkingLevel: "high" as const,
	components: [component("plugin", "learning-harness")],
	instructions: [] as string[],
	systemPromptMode: "replace" as const,
};
export const LEARNER_WORKFLOW_CONTROL_PROMPT =
	"Use /caw to open Workbench and caw route to inspect enabled Ready Workflow metadata. All installed Workflows are selectable; modes supply editable saved defaults. Keep the immediate question and required public source excerpts bounded. Do not copy whole chat history or the Skill library. Domain tools require their own qualified task and source bindings; enabling a Workflow does not grant missing tools or private resources. Existing assessment answer gates and teacher-private resource restrictions remain authoritative.";
const LEARNER_WORKFLOW_BASE = {
	...BASE,
	revision: 4,
	instructions: [LEARNER_WORKFLOW_CONTROL_PROMPT],
};

export const BUILTIN_MODE_PACK_DRAFTS: Readonly<Record<string, ModePackDraft>> = deepFreeze({
	"student-learn": {
		...LEARNER_WORKFLOW_BASE,
		modePackId: "student-learn",
		title: "Tutor",
		description: "以当前课程和可核验来源为边界的解释与学习模式。",
		category: "education",
		role: "student",
		runtimeMode: "student-learn",
		externalKnowledgePolicy: "explain-and-label",
		courseRequired: true,
		tools: ["codemode"],
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
			"You are the learner's tutor for the active course. Use the current question, course goals, prerequisite knowledge and recorded learning history to choose the next helpful explanation. Answer directly, then connect the concept to a concrete example and only the checks that improve understanding. Distinguish course evidence, derivation and labelled external knowledge. Use the Host's source and publication tools; never present an unsupported claim as course material. Embed a small number of useful actions such as prediction, self-explanation or retrieval. Do not force beginners to explain concepts they have not learned, turn a short question into a questionnaire, or expose teacher-only solutions. Record meaningful progress and remaining gaps rather than claiming understanding without learner evidence.",
	},
	practice: {
		...LEARNER_WORKFLOW_BASE,
		modePackId: "practice",
		title: "Practice",
		description: "真实作答优先、提示分级且答案受 Capability 门保护的练习模式。",
		category: "education",
		role: "student",
		runtimeMode: "practice",
		externalKnowledgePolicy: "deny",
		courseRequired: true,
		tools: ["codemode"],
		components: [
			...BASE.components,
			component("prompt", "education.practice"),
			component("workflow", "practice"),
			component("skill", "education.learning-to-learn", false),
		],
		systemPrompt:
			"You are a practice coach for the active course. Let the learner attempt the task before giving an answer. Use the Assessment Host's recorded attempt, hint levels and solution capabilities as the authority. Diagnose the smallest correctable gap, give one targeted hint and invite a retry. Explain errors without doing all the learner's work. Adapt difficulty to actual evidence of understanding and finish with a nearby transfer task when useful. Never bypass the answer gate or expose teacher-only resources.",
	},
	"teach-back": {
		...LEARNER_WORKFLOW_BASE,
		modePackId: "teach-back",
		title: "Teach-back",
		description: "让学习者先解释，再定位最小缺口、重述并迁移。",
		category: "education",
		role: "student",
		runtimeMode: "student-learn",
		externalKnowledgePolicy: "explain-and-label",
		courseRequired: true,
		tools: ["codemode"],
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
		...LEARNER_WORKFLOW_BASE,
		modePackId: "visual-lab",
		title: "Visual Lab",
		description: "预测、结构化规格、确定性计算与可视化解释。",
		category: "education",
		role: "student",
		runtimeMode: "visual-lab",
		externalKnowledgePolicy: "deny",
		courseRequired: true,
		tools: ["codemode", "create_visual_spec", "get_course_context", "validate_visual_artifact"],
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
		tools: ["codemode", "find", "grep", "ls", "read"],
		components: [
			...BASE.components,
			component("prompt", "teacher.prep"),
			component("skill", "education.lesson-blueprint", true, "native-skill"),
			component("skill", "education.learning-to-learn", true, "native-skill"),
			component("skill", "education.curriculum-continuity", true, "native-skill"),
			component("skill", "education.evidence-ledger", true, "native-skill"),
			component("skill", "shared.revision-discipline", true, "native-skill"),
			component("skill", "education.learn-by-doing", true, "native-skill"),
			component("skill", "education.visual-explanation", true, "native-skill"),
			component("skill", "education.feynman-teach-back", false, "native-skill"),
		],
		systemPrompt: "Prepare and revise educational material without exposing teacher-only resources to students.",
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
		tools: ["codemode", "edit", "find", "grep", "ls", "read", "write"],
		components: [
			...BASE.components,
			component("prompt", "creative.core"),
			component("workflow", "creative"),
			component("skill", "shared.revision-discipline", true, "native-skill"),
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
		tools: ["codemode", "find", "grep", "ls", "read"],
		components: [
			...BASE.components,
			component("prompt", "general.core"),
			component("skill", "shared.personal-skill-builder", false, "native-skill"),
		],
		systemPrompt: "Follow the user's task using the active tools and explicit source-of-truth boundaries.",
	},
});

export function createBuiltinModePacks(catalog: ResourceCatalog): Readonly<Record<string, ModePackDefinition>> {
	const entries: Array<[string, ModePackDefinition]> = [];
	for (const [id, draft] of Object.entries(BUILTIN_MODE_PACK_DRAFTS)) {
		entries.push([
			id,
			compileModePackDraft(
				{
					...draft,
					components: draft.components.filter(
						(item) => item.type !== "skill" || !isBuiltinModeSkillDeleted(item.id),
					),
				},
				catalog,
			),
		]);
	}
	return deepFreeze(Object.fromEntries(entries));
}
