import type { CourseVersion, ExercisePublic, StudentBundleManifest } from "../../harness-contracts/src/index.ts";
import { contentHash, deterministicId } from "../../harness-core/src/index.ts";

export class StudentBundleError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "StudentBundleError";
		this.code = code;
	}
}

const FORBIDDEN_KEYS = new Set([
	"solution",
	"solutions",
	"acceptedAnswers",
	"rubric",
	"private",
	"privateAsset",
	"solutionAsset",
	"vault",
	"teacherToken",
]);

function scan(value: unknown, path: string, seen: Set<object>): void {
	if (!value || typeof value !== "object") return;
	if (seen.has(value)) throw new StudentBundleError("CYCLIC_BUNDLE", `${path} is cyclic`);
	seen.add(value);
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) scan(item, `${path}[${index}]`, seen);
	} else {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (FORBIDDEN_KEYS.has(key)) throw new StudentBundleError("PRIVATE_ASSET_LEAK", `${path}.${key} is forbidden in a student bundle`);
			scan(child, `${path}.${key}`, seen);
		}
	}
	seen.delete(value);
}

export function verifyStudentBundle(value: unknown): void {
	scan(value, "$", new Set<object>());
	const serialized = JSON.stringify(value);
	if (/(?:teacher-studio|solution-capability-secret|PRIVATE_SOLUTION_ASSET)/iu.test(serialized)) {
		throw new StudentBundleError("PRIVATE_ASSET_LEAK", "Student bundle contains a forbidden private marker");
	}
}

export function createStudentBundleManifest(
	courseVersion: CourseVersion,
	publicExercises: readonly ExercisePublic[],
	profileIds: readonly string[],
): StudentBundleManifest {
	for (const exercise of publicExercises) {
		if (exercise.courseVersionId !== courseVersion.courseVersionId) {
			throw new StudentBundleError("COURSE_MISMATCH", `Exercise ${exercise.exerciseId} belongs to another course version`);
		}
	}
	const files = courseVersion.materials.map((material) => ({
		path: `materials/${material.materialId}.txt`,
		contentHash: material.contentHash,
	}));
	const identity = {
		courseVersionId: courseVersion.courseVersionId,
		profileIds: [...new Set(profileIds)].sort(),
		publicExercises: publicExercises.map((exercise) => ({
			exerciseId: exercise.exerciseId,
			revision: exercise.revision,
			courseVersionId: exercise.courseVersionId,
		})),
		files,
	};
	const manifest: StudentBundleManifest = {
		bundleId: deterministicId("student-bundle", identity, 32),
		courseVersionId: courseVersion.courseVersionId,
		profileIds: identity.profileIds,
		publicExercises: publicExercises.map((exercise) => ({ ...exercise, conceptIds: [...exercise.conceptIds], hints: [...exercise.hints] })),
		files,
		contentHash: contentHash(identity),
	};
	verifyStudentBundle(manifest);
	return Object.freeze(manifest);
}
