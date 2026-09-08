import type { CourseBuilderProjectInput } from "../../../packages/course-builder-host/src/types.ts";
import { createDefaultCourseBuilderProject } from "./course-builder-defaults";

export type CourseBuilderEntryState = "ready" | "dormant" | "student";

export interface TeacherProfile {
	author: string;
	institute: string;
	language: string;
	aspectRatio: "169" | "43";
	fontSize: number;
}

export interface CourseBuilderSetup {
	courseId: string;
	title: string;
	weeks: number;
	sessionsPerWeek: number;
	minutesPerSession: number;
	audience: string;
	language: string;
	goalsText: string;
	author: string;
	institute: string;
	aspectRatio: "169" | "43";
	fontSize: number;
	theme: string;
	overlayPolicy: "allow" | "deny";
	referencesPolicy: "required" | "optional";
	backupSlides: number;
	speakerNotes: boolean;
	preamble: string;
}

const DEFAULT_TEACHER_PROFILE: TeacherProfile = {
	author: "",
	institute: "",
	language: "中文",
	aspectRatio: "169",
	fontSize: 11,
};

export function classifyCourseBuilderEntry(status: { kind: "learning" | "generic"; live: boolean }): CourseBuilderEntryState {
	if (status.kind === "learning") return "student";
	return status.live ? "ready" : "dormant";
}

export function isCourseBuilderSnapshotDrift(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /^Mode Pack resource identity changed:/u.test(message);
}

export function parseTeacherProfile(serialized: string | null): TeacherProfile {
	if (!serialized) return { ...DEFAULT_TEACHER_PROFILE };
	try {
		const value = JSON.parse(serialized) as Record<string, unknown>;
		if (
			typeof value.author !== "string"
			|| typeof value.institute !== "string"
			|| typeof value.language !== "string"
			|| (value.aspectRatio !== "169" && value.aspectRatio !== "43")
			|| !Number.isInteger(value.fontSize)
			|| (value.fontSize as number) < 8
			|| (value.fontSize as number) > 14
		) throw new Error("Teacher profile has invalid fields");
		return {
			author: value.author,
			institute: value.institute,
			language: value.language,
			aspectRatio: value.aspectRatio,
			fontSize: value.fontSize as number,
		};
	} catch (error) {
		console.warn("[course-builder] invalid local teacher profile; using defaults", error instanceof Error ? error.message : String(error));
		return { ...DEFAULT_TEACHER_PROFILE };
	}
}

export function teacherProfileFromSetup(setup: CourseBuilderSetup): TeacherProfile {
	return {
		author: setup.author.trim(),
		institute: setup.institute.trim(),
		language: setup.language.trim(),
		aspectRatio: setup.aspectRatio,
		fontSize: setup.fontSize,
	};
}

export function createCourseBuilderSetup(profileOverrides: Partial<TeacherProfile> = {}): CourseBuilderSetup {
	const project = createDefaultCourseBuilderProject();
	const profile = { ...DEFAULT_TEACHER_PROFILE, ...profileOverrides };
	return {
		courseId: project.courseId,
		title: project.title,
		weeks: project.weeks,
		sessionsPerWeek: project.sessionsPerWeek,
		minutesPerSession: project.minutesPerSession,
		audience: project.audience,
		language: profile.language,
		goalsText: project.goals.join("\n"),
		author: profile.author,
		institute: profile.institute,
		aspectRatio: profile.aspectRatio,
		fontSize: profile.fontSize,
		theme: project.beamerProfile.theme,
		overlayPolicy: project.beamerProfile.overlayPolicy,
		referencesPolicy: project.beamerProfile.referencesPolicy,
		backupSlides: project.beamerProfile.backupSlides,
		speakerNotes: project.beamerProfile.speakerNotes,
		preamble: project.beamerProfile.preamble ?? "",
	};
}

export function setupFromCourseProject(project: CourseBuilderProjectInput): CourseBuilderSetup {
	return {
		...project.beamerProfile,
		courseId: project.courseId,
		title: project.title,
		weeks: project.weeks,
		sessionsPerWeek: project.sessionsPerWeek,
		minutesPerSession: project.minutesPerSession,
		audience: project.audience,
		language: project.language,
		goalsText: project.goals.join("\n"),
		preamble: project.beamerProfile.preamble ?? "",
	};
}

function integerInRange(value: number, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label}必须是 ${minimum}–${maximum} 之间的整数。`);
	}
	return value;
}

function required(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`请填写${label}。`);
	return trimmed;
}

export function projectFromCourseSetup(setup: CourseBuilderSetup): CourseBuilderProjectInput {
	const courseId = normalizeCourseId(required(setup.courseId, "课程 ID"));
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(courseId)) {
		throw new Error("课程 ID 只能使用英文字母、数字、点、下划线和短横线，并且必须以字母或数字开头。");
	}
	const goals = setup.goalsText.split(/\r?\n/u).map((goal) => goal.trim()).filter(Boolean);
	if (goals.length === 0) throw new Error("请至少填写一个课程目标，每行一个。");
	return {
		courseId,
		title: required(setup.title, "课程名称"),
		weeks: integerInRange(setup.weeks, "教学周数", 1, 60),
		sessionsPerWeek: integerInRange(setup.sessionsPerWeek, "每周课次", 1, 14),
		minutesPerSession: integerInRange(setup.minutesPerSession, "每课时长", 10, 360),
		audience: required(setup.audience, "学生阶段与基础"),
		language: required(setup.language, "授课语言"),
		goals: [...new Set(goals)],
		beamerProfile: {
			aspectRatio: setup.aspectRatio,
			fontSize: integerInRange(setup.fontSize, "课件字号", 8, 14),
			theme: required(setup.theme, "Beamer 主题"),
			author: setup.author.trim(),
			institute: setup.institute.trim(),
			language: required(setup.language, "课件语言"),
			overlayPolicy: setup.overlayPolicy,
			referencesPolicy: setup.referencesPolicy,
			backupSlides: integerInRange(setup.backupSlides, "备用页数量", 0, 20),
			speakerNotes: setup.speakerNotes,
			preamble: setup.preamble.trim() || null,
		},
	};
}

export function normalizeCourseId(value: string): string {
	return value.trim().replace(/[\s/\\]+/gu, "-");
}

/** Drafts can be incomplete, but must have the known form field types. */
export function parseCourseSetupDraft(serialized: string): CourseBuilderSetup {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("课程草稿必须是字段对象。");
	const record = value as Record<string, unknown>;
	const defaults = createCourseBuilderSetup();
	for (const [key, sample] of Object.entries(defaults)) {
		if (typeof record[key] !== typeof sample) throw new Error(`课程草稿字段无效：${key}`);
	}
	return Object.fromEntries(Object.keys(defaults).map((key) => [key, record[key]])) as unknown as CourseBuilderSetup;
}
