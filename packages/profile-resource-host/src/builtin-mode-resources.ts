import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModePackComponentType, ResourceKind } from "../../harness-contracts/src/index.ts";
import { contentHash, deepFreeze } from "../../harness-core/src/index.ts";

export interface BuiltinModeResource {
	kind: ResourceKind;
	id: string;
	version: string;
	contentHash: string;
	instructions: string[];
}

export interface ModePackComponentOption {
	type: Exclude<ModePackComponentType, "plugin" | "prompt" | "theme">;
	id: string;
	title: string;
	description: string;
	recommended: boolean;
}

function resource(kind: ResourceKind, id: string, instructions: readonly string[]): BuiltinModeResource {
	const normalized = [...instructions];
	return {
		kind,
		id,
		version: "1",
		contentHash: contentHash({ kind, id, version: "1", instructions: normalized }),
		instructions: normalized,
	};
}

const BUILTIN_SKILL_FOLDERS: Readonly<Record<string, string>> = Object.freeze({
	"education.lesson-blueprint": "lesson-blueprint",
	"education.learning-to-learn": "learning-to-learn",
	"education.feynman-teach-back": "feynman-teach-back",
	"education.evidence-ledger": "evidence-ledger",
	"education.curriculum-continuity": "curriculum-continuity",
	"shared.revision-discipline": "revision-discipline",
	"education.learn-by-doing": "learn-by-doing",
	"shared.personal-skill-builder": "personal-skill-builder",
	"education.visual-explanation": "visual-explanation",
	"teacher.course-planning-beamer": "course-planning-beamer",
});

export function localModeSkillsDirectory(): string {
	if (process.env.PI_SKILLS_DIR) {
		const configured = resolve(process.env.PI_SKILLS_DIR);
		if (!existsSync(configured)) throw new Error(`Configured Pi Skills directory is missing: ${configured}`);
		return configured;
	}
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const directory = [
		resolve(moduleDirectory, "../../../skills"),
		resolve(process.cwd(), "skills"),
		resolve(process.cwd(), "../../skills"),
	].find((candidate) => existsSync(resolve(candidate, "course-planning-beamer/SKILL.md")));
	if (!directory) throw new Error("Pi local Skills directory could not be located");
	return directory;
}

export function resolveBuiltinModeSkillPath(id: string): string {
	const folder = BUILTIN_SKILL_FOLDERS[id];
	if (!folder) throw new Error(`Unknown built-in Mode Pack Skill: ${id}`);
	const path = resolve(localModeSkillsDirectory(), folder, "SKILL.md");
	if (!existsSync(path)) throw new Error(`Required built-in Mode Pack Skill file is missing: ${folder}/SKILL.md`);
	return path;
}

function skillResource(id: string): BuiltinModeResource {
	const path = resolveBuiltinModeSkillPath(id);
	const text = readFileSync(path, "utf8");
	if (!text.trim()) throw new Error(`Required built-in Mode Pack Skill is empty: ${path}`);
	return resource("skill", id, [text]);
}

const TUTOR_PROMPT = [
	"Act as a focused tutor for the learner's current course. Answer the immediate question first, then add only the explanation, example, or check that advances understanding.",
	"Distinguish course evidence, derivation, computation, external knowledge, and insufficient support. Never disguise an unsupported conclusion as course material.",
	"Do not force a long lesson workflow onto a small factual question. Use a larger learning workflow only when the task actually benefits from it.",
];

const PRACTICE_PROMPT = [
	"Practice is attempt-first. Do not reveal the answer or complete the learner's work before a meaningful attempt has been recorded by the Assessment Host.",
	"Feedback should identify the smallest correctable issue, give one useful hint at a time, and preserve a retry path.",
];

const TEACH_BACK_PROMPT = [
	"Run a teach-back cycle around one bounded concept. The learner explains first; the tutor then locates one or two load-bearing gaps instead of replacing the whole explanation.",
	"Use short Socratic prompts, ask for a revised explanation, test one analogy boundary, and finish with transfer to a new case.",
];

const CODING_PROMPT = [
	"Work as a repository-aware coding agent. Inspect the actual code and local instructions before editing, make the smallest coherent change, run the narrowest relevant checks, and report observed results rather than assumed results.",
];

const CREATIVE_PROMPT = [
	"Work as a creative collaborator. Preserve the user's canon, voice, audience, and explicit constraints; separate invention from established facts; draft, check consistency, and revise without turning every request into a rigid template.",
];

const GENERAL_PROMPT = [
	"Use the active Mode Pack as task guidance while preserving the platform's security boundaries, tool allowlist, and source-of-truth rules.",
];

const TEACHER_PROMPT = [
	"Prepare learning material from explicit goals and evidence. Keep teacher-only drafts, private solutions, and publication actions outside student-visible resources.",
];

const TUTOR_WORKFLOW = [
	"Workflow tutor: orient to the learner's question and current evidence; explain at the requested depth; use one targeted check only when it adds value; record a learning event for substantial concept work.",
];

const PRACTICE_WORKFLOW = [
	"Workflow practice: issue or select an exercise; wait for a real learner attempt; evaluate it; provide feedback or one hint; invite retry; reveal a solution only through the durable capability gate.",
];

const TEACH_BACK_WORKFLOW = [
	"Workflow teach-back: bound the concept and audience; collect explanation v1; identify one or two gaps; ask targeted questions; collect explanation v2; remove unnecessary jargon; test analogy boundaries; transfer; record remaining uncertainty.",
];

const VISUAL_WORKFLOW = [
	"Workflow visual-lab: collect prediction; construct a structured visualization spec; compute and trace deterministically; render; validate current revision; publish; connect manipulation to a learner explanation and Timeline event.",
];

const CODING_WORKFLOW = [
	"Workflow coding: inspect instructions and target files; state the intended change; edit narrowly; run focused checks; inspect the diff; report files changed, checks run, and remaining uncertainty.",
];

const CREATIVE_WORKFLOW = [
	"Workflow creative: capture canon, audience, voice, and non-negotiable constraints; draft; run a consistency and intent review; revise only the defects found; preserve deliberate ambiguity.",
];

export const BUILTIN_MODE_RESOURCES: readonly BuiltinModeResource[] = deepFreeze([
	resource("prompt", "education.tutor", TUTOR_PROMPT),
	resource("prompt", "education.practice", PRACTICE_PROMPT),
	resource("prompt", "education.teach-back", TEACH_BACK_PROMPT),
	resource("prompt", "coding.core", CODING_PROMPT),
	resource("prompt", "creative.core", CREATIVE_PROMPT),
	resource("prompt", "general.core", GENERAL_PROMPT),
	resource("prompt", "teacher.prep", TEACHER_PROMPT),
	skillResource("education.lesson-blueprint"),
	skillResource("education.learning-to-learn"),
	skillResource("education.feynman-teach-back"),
	skillResource("education.evidence-ledger"),
	skillResource("education.curriculum-continuity"),
	skillResource("shared.revision-discipline"),
	skillResource("education.learn-by-doing"),
	skillResource("shared.personal-skill-builder"),
	skillResource("education.visual-explanation"),
	skillResource("teacher.course-planning-beamer"),
	resource("prompt", "workflow:tutor", TUTOR_WORKFLOW),
	resource("prompt", "workflow:practice", PRACTICE_WORKFLOW),
	resource("prompt", "workflow:teach-back", TEACH_BACK_WORKFLOW),
	resource("prompt", "workflow:visual-lab", VISUAL_WORKFLOW),
	resource("prompt", "workflow:coding", CODING_WORKFLOW),
	resource("prompt", "workflow:creative", CREATIVE_WORKFLOW),
]);

export const MODE_PACK_COMPONENT_OPTIONS: readonly ModePackComponentOption[] = deepFreeze([
	{
		type: "skill",
		id: "education.lesson-blueprint",
		title: "学习蓝图",
		description: "用目标、理解证据和先备条件组织较大的学习任务。",
		recommended: true,
	},
	{
		type: "skill",
		id: "education.learning-to-learn",
		title: "学会学习",
		description: "按需加入主动回忆、预测和自我解释。",
		recommended: true,
	},
	{
		type: "skill",
		id: "education.feynman-teach-back",
		title: "讲给我听",
		description: "先由学习者解释，再定位最小缺口并迁移检查。",
		recommended: false,
	},
	{
		type: "skill",
		id: "education.evidence-ledger",
		title: "证据核查",
		description: "对外部、时效或争议事实建立 claim-to-source 台账。",
		recommended: true,
	},
	{
		type: "skill",
		id: "education.curriculum-continuity",
		title: "课程连续性",
		description: "依据实际 Timeline 规划递进重访，而不是机械复习。",
		recommended: true,
	},
	{
		type: "skill",
		id: "shared.revision-discipline",
		title: "最小修订",
		description: "先读后改、局部写入、读回核验。",
		recommended: true,
	},
	{
		type: "skill",
		id: "education.learn-by-doing",
		title: "做中学",
		description: "明确操作、观察和结论，不为形式变化而乱换组件。",
		recommended: true,
	},
	{
		type: "skill",
		id: "shared.personal-skill-builder",
		title: "个人 Skill 提炼",
		description: "从代表性历史中提出可反驳的偏好假设，经用户确认后保存。",
		recommended: false,
	},
	{
		type: "skill",
		id: "education.visual-explanation",
		title: "教学可视化",
		description: "从预测、操作、观察和解释出发制作并核验可视化。",
		recommended: true,
	},
	{
		type: "workflow",
		id: "tutor",
		title: "Tutor workflow",
		description: "问题定向、解释、必要检查和学习事件记录。",
		recommended: true,
	},
	{
		type: "workflow",
		id: "practice",
		title: "Practice workflow",
		description: "等待真实作答、反馈、提示、重试和答案门。",
		recommended: false,
	},
	{
		type: "workflow",
		id: "teach-back",
		title: "Teach-back workflow",
		description: "解释 v1、缺口、解释 v2、类比边界和迁移。",
		recommended: false,
	},
]);
