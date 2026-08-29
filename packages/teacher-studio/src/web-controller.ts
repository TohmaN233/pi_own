import type { CourseMaterialInput, ExercisePrivate, ExercisePublic } from "../../harness-contracts/src/index.ts";
import { TeacherStudio } from "./teacher-studio.ts";

export type TeacherWebAction = "create-draft" | "get-draft" | "add-material" | "add-exercise" | "publish";

export interface TeacherWebResponse {
	ok: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Teacher request input must be an object");
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function revision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("expectedRevision must be a positive integer");
	return value as number;
}

export class TeacherStudioWebController {
	private readonly studio: TeacherStudio;

	constructor(studio: TeacherStudio) {
		this.studio = studio;
	}

	async dispatch(actionValue: unknown, inputValue: unknown): Promise<TeacherWebResponse> {
		try {
			const action = string(actionValue, "action") as TeacherWebAction;
			const input = object(inputValue);
			if (action === "create-draft") return { ok: true, data: this.studio.createDraft(string(input.courseId, "courseId"), string(input.title, "title")) };
			if (action === "get-draft") return { ok: true, data: this.studio.getDraft(string(input.draftId, "draftId")) };
			if (action === "add-material") {
				return {
					ok: true,
					data: this.studio.addMaterial(
						string(input.draftId, "draftId"),
						object(input.material) as unknown as CourseMaterialInput,
						revision(input.expectedRevision),
					),
				};
			}
			if (action === "add-exercise") {
				return {
					ok: true,
					data: this.studio.addExercise(
						string(input.draftId, "draftId"),
						object(input.publicExercise) as unknown as ExercisePublic,
						object(input.privateExercise) as unknown as ExercisePrivate,
						revision(input.expectedRevision),
					),
				};
			}
			if (action === "publish") {
				if (!Array.isArray(input.profiles) || !input.profiles.every((value) => typeof value === "string")) throw new Error("profiles must be a string array");
				return {
					ok: true,
					data: await this.studio.publish(
						string(input.draftId, "draftId"),
						revision(input.expectedRevision),
						input.profiles as string[],
					),
				};
			}
			throw new Error(`Unsupported teacher action ${action}`);
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "TEACHER_ERROR";
			return { ok: false, error: { code, message: error instanceof Error ? error.message : "Teacher action failed" } };
		}
	}
}

export function createTeacherRouteHandler(
	controller: TeacherStudioWebController,
	authorizeTeacher: (request: Request) => boolean | Promise<boolean>,
) {
	return async (request: Request): Promise<Response> => {
		if (!(await authorizeTeacher(request))) return Response.json({ ok: false, error: { code: "TEACHER_REQUIRED", message: "Teacher authorization required" } }, { status: 403 });
		if (request.method !== "POST") return Response.json({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } }, { status: 405 });
		let body: unknown;
		try { body = await request.json(); } catch { return Response.json({ ok: false, error: { code: "INVALID_JSON", message: "Malformed JSON" } }, { status: 400 }); }
		const input = object(body);
		for (const key of Object.keys(input)) if (key !== "action" && key !== "input") return Response.json({ ok: false, error: { code: "UNKNOWN_FIELD", message: `Unknown field ${key}` } }, { status: 400 });
		const result = await controller.dispatch(input.action, input.input ?? {});
		return Response.json(result, { status: result.ok ? 200 : 400 });
	};
}
