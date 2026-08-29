import type {
	CourseMaterialInput,
	CourseVersion,
	ExercisePrivate,
	ExercisePublic,
	StudentBundleManifest,
	TeacherCourseDraft,
} from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId, stableStringify } from "../../harness-core/src/index.ts";
import { AssessmentHost } from "../../assessment-host/src/index.ts";
import { CourseHost, type PublishCourseVersionOptions } from "../../course-host/src/index.ts";
import { createStudentBundleManifest } from "../../student-build/src/index.ts";

export class TeacherStudioError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "TeacherStudioError";
		this.code = code;
	}
}

export interface PublishedTeacherCourse {
	courseVersion: CourseVersion;
	exercises: ExercisePublic[];
	studentBundle: StudentBundleManifest;
}

export class TeacherStudio {
	private readonly courseHost: CourseHost;
	private readonly assessmentHost: AssessmentHost;
	private readonly drafts = new Map<string, TeacherCourseDraft>();

	constructor(courseHost: CourseHost, assessmentHost: AssessmentHost) {
		this.courseHost = courseHost;
		this.assessmentHost = assessmentHost;
	}

	createDraft(courseId: string, title: string): TeacherCourseDraft {
		if (!courseId || !title.trim()) throw new TeacherStudioError("INVALID_DRAFT", "courseId and title are required");
		const identity = { courseId, title: title.trim() };
		const draft: TeacherCourseDraft = {
			draftId: deterministicId("teacher-draft", identity, 32),
			courseId,
			title: title.trim(),
			materials: [],
			exercises: [],
			revision: 1,
		};
		const existing = this.drafts.get(draft.draftId);
		if (existing) return existing;
		this.drafts.set(draft.draftId, draft);
		return draft;
	}

	addMaterial(draftId: string, material: CourseMaterialInput, expectedRevision: number): TeacherCourseDraft {
		return this.updateDraft(draftId, expectedRevision, (draft) => {
			if (draft.materials.some((item) => item.name === material.name)) throw new TeacherStudioError("DUPLICATE_MATERIAL", `Material ${material.name} already exists`);
			return { ...draft, materials: [...draft.materials, material] };
		});
	}

	addExercise(
		draftId: string,
		publicExercise: ExercisePublic,
		privateExercise: ExercisePrivate,
		expectedRevision: number,
	): TeacherCourseDraft {
		if (publicExercise.exerciseId !== privateExercise.exerciseId) throw new TeacherStudioError("EXERCISE_ID_MISMATCH", "Public/private exercise IDs differ");
		return this.updateDraft(draftId, expectedRevision, (draft) => {
			if (draft.exercises.some((item) => item.public.exerciseId === publicExercise.exerciseId)) {
				throw new TeacherStudioError("DUPLICATE_EXERCISE", `Exercise ${publicExercise.exerciseId} already exists`);
			}
			return { ...draft, exercises: [...draft.exercises, { public: publicExercise, private: privateExercise }] };
		});
	}

	async publish(
		draftId: string,
		expectedRevision: number,
		profiles: readonly string[],
		options: PublishCourseVersionOptions = {},
	): Promise<PublishedTeacherCourse> {
		const draft = this.getDraft(draftId);
		if (draft.revision !== expectedRevision) throw new TeacherStudioError("REVISION_MISMATCH", `Expected draft revision ${expectedRevision}, actual ${draft.revision}`);
		if (draft.materials.length === 0) throw new TeacherStudioError("EMPTY_DRAFT", "Cannot publish a course without materials");
		const courseVersion = await this.courseHost.publishVersion(draft.courseId, draft.materials, options);
		const exercises = draft.exercises.map(({ public: publicExercise, private: privateExercise }) => {
			const rewritten: ExercisePublic = {
				...publicExercise,
				courseVersionId: courseVersion.courseVersionId,
				conceptIds: [...publicExercise.conceptIds],
				hints: [...publicExercise.hints],
			};
			this.assessmentHost.registerExercise(rewritten, privateExercise);
			return rewritten;
		});
		const studentBundle = createStudentBundleManifest(courseVersion, exercises, profiles);
		return { courseVersion, exercises, studentBundle };
	}

	getDraft(draftId: string): TeacherCourseDraft {
		const draft = this.drafts.get(draftId);
		if (!draft) throw new TeacherStudioError("UNKNOWN_DRAFT", `Unknown draft ${draftId}`);
		return draft;
	}

	exportDraftFingerprint(draftId: string): string {
		return contentHash(JSON.parse(stableStringify(this.getDraft(draftId))));
	}

	private updateDraft(
		draftId: string,
		expectedRevision: number,
		change: (draft: TeacherCourseDraft) => TeacherCourseDraft,
	): TeacherCourseDraft {
		const current = this.getDraft(draftId);
		if (current.revision !== expectedRevision) throw new TeacherStudioError("REVISION_MISMATCH", `Expected draft revision ${expectedRevision}, actual ${current.revision}`);
		const changed = change(current);
		const next: TeacherCourseDraft = { ...changed, draftId: current.draftId, courseId: current.courseId, revision: current.revision + 1 };
		this.drafts.set(draftId, next);
		return next;
	}
}

export interface TeacherPackageProvider {
	available: boolean;
	create(courseHost: CourseHost, assessmentHost: AssessmentHost): TeacherStudio;
}

export const TEACHER_PACKAGE_PROVIDER: TeacherPackageProvider = {
	available: true,
	create(courseHost, assessmentHost) {
		return new TeacherStudio(courseHost, assessmentHost);
	},
};
