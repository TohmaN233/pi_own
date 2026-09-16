import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CourseBuilderHost } from "../../course-builder-host/src/index.ts";
import { contentHash, stableStringify } from "../../harness-core/src/index.ts";
import type { StudyResearchHost } from "./study-research-host.ts";
import type { Scope } from "./types.ts";
import {
	compareVisualObservations,
	type VisualCaseObservation,
	type VisualValidationSpecification,
	validateVisualSpecification,
} from "./visual-validation.ts";

export interface BrowserVisualObservation {
	caseId: string;
	inputHash: string;
	scene: { elements: Array<{ tag: string; attrs: Record<string, string>; text?: string }> };
}
export interface VisualInteractionReceipt {
	receiptId: string;
	projectId: string;
	visualizationId: string;
	revision: number;
	targetHash: string;
	runtimeHash: string;
	specificationHash: string;
	numericalTaskId: string;
	status: "passed" | "failed" | "inconclusive";
	observations: BrowserVisualObservation[];
	comparisons: ReturnType<typeof compareVisualObservations>["comparisons"];
	createdAt: string;
	contentHash: string;
}
export interface TeachingApproval {
	materialId: string;
	courseProjectId: string;
	copyHash: string;
	lessonPlanId: string;
	lessonRevision: number;
	lessonHash: string;
	userEventId: string;
	approvedAt: string;
}

/** Compare actual sanitized SVG DOM observations, separate from native scene arithmetic. */
export function compareBrowserVisualObservations(
	specification: VisualValidationSpecification,
	observations: BrowserVisualObservation[],
) {
	const originalSpecificationHash = validateVisualSpecification(specification);
	const browserSpecification = {
		...specification,
		cases: specification.cases.map((test) => ({
			...test,
			expected: test.expected.filter((expected) => expected.path[0] === "elements"),
		})),
	};
	if (browserSpecification.cases.some((test) => test.expected.length === 0))
		throw new Error(
			"Each browser case needs a visible SVG element assertion in addition to optional numerical metrics",
		);
	if (
		!Array.isArray(observations) ||
		observations.length > 100 ||
		Buffer.byteLength(JSON.stringify(observations)) > 768 * 1024
	)
		throw new Error("Browser observations exceed their bounded protocol");
	const observed = new Map(observations.map((item) => [item.caseId, item]));
	if (observed.size !== observations.length) throw new Error("Duplicate browser observation");
	const frozen: VisualCaseObservation[] = observations.map((item) => {
		const test = browserSpecification.cases.find((entry) => entry.id === item.caseId);
		if (!test || contentHash(test.inputs) !== item.inputHash)
			throw new Error("Browser case or input identity changed");
		if (!item.scene || !Array.isArray(item.scene.elements) || item.scene.elements.length > 4096)
			throw new Error("Invalid browser SVG observation");
		const scene = structuredClone(item.scene) as unknown as Record<string, unknown>;
		for (const expected of test.expected) {
			if (expected.path[0] !== "elements")
				throw new Error(
					"Browser checks must use visible SVG element paths; keep numerical metrics in native validation",
				);
			let parent: unknown = scene;
			for (const part of expected.path.slice(0, -1))
				parent =
					parent && typeof parent === "object" && Object.hasOwn(parent, part)
						? (parent as Record<string | number, unknown>)[part]
						: null;
			const last = expected.path.at(-1)!;
			if (parent && typeof parent === "object" && Object.hasOwn(parent, last)) {
				const record = parent as Record<string | number, unknown>,
					actual = record[last];
				if (
					typeof expected.value === "number" &&
					typeof actual === "string" &&
					actual.trim() &&
					Number.isFinite(Number(actual))
				)
					record[last] = Number(actual);
			}
		}
		return { caseId: item.caseId, inputHash: item.inputHash, status: "returned", scene, error: null };
	});
	const result = compareVisualObservations(browserSpecification, frozen);
	const distinctInputs = new Set(specification.cases.map((item) => contentHash(item.inputs))).size;
	const status: VisualInteractionReceipt["status"] =
		distinctInputs < 2
			? "inconclusive"
			: result.status === "passed"
				? "passed"
				: result.status === "failed"
					? "failed"
					: "inconclusive";
	return {
		...result,
		status,
		specificationHash: originalSpecificationHash,
		browserProjectionHash: result.specificationHash,
	};
}

/** Same Harness database; browser receipts never replace native validation or independent review. */
export class StudyTeachingHost {
	private readonly database: DatabaseSync;
	private readonly study: StudyResearchHost;
	private readonly courses: CourseBuilderHost;
	constructor(database: DatabaseSync, study: StudyResearchHost, courses: CourseBuilderHost) {
		this.database = database;
		this.study = study;
		this.courses = courses;
		database.exec(`CREATE TABLE IF NOT EXISTS pi_study_visual_interaction (receipt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_id TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pi_study_teaching_approval (material_id TEXT PRIMARY KEY, course_project_id TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL);`);
	}

	recordBrowserInteraction(
		scope: Scope,
		input: {
			visualizationId: string;
			revision: number;
			targetHash: string;
			runtimeHash: string;
			numericalTaskId: string;
			specification: VisualValidationSpecification;
			observations: BrowserVisualObservation[];
		},
	): VisualInteractionReceipt {
		const visual = this.study.getVisualizationDraft(scope, input.visualizationId);
		if (
			visual.revision !== input.revision ||
			visual.contentHash !== input.targetHash ||
			visual.environmentHash !== input.runtimeHash ||
			input.specification.targetHash !== visual.contentHash
		)
			throw new Error("Visualization or browser runtime changed before recording interaction");
		const compared = compareBrowserVisualObservations(input.specification, input.observations);
		const checks = this.study.listValidations(scope, {
			targetKind: "visualization",
			targetId: visual.visualizationId,
			targetRevision: visual.revision,
			targetHash: visual.contentHash,
		});
		if (!checks.some((check) => check.taskId === input.numericalTaskId && check.status === "passed"))
			throw new Error("A current native numerical check is required before recording browser interaction");
		const comparisons = JSON.parse(JSON.stringify(compared.comparisons)) as VisualInteractionReceipt["comparisons"];
		const raw = {
			receiptId: `visual-browser_${randomUUID()}`,
			projectId: scope.projectId,
			visualizationId: visual.visualizationId,
			revision: visual.revision,
			targetHash: visual.contentHash,
			runtimeHash: input.runtimeHash,
			specificationHash: compared.specificationHash,
			numericalTaskId: input.numericalTaskId,
			status: compared.status,
			observations: structuredClone(input.observations),
			comparisons,
			createdAt: new Date().toISOString(),
		};
		const receipt = { ...raw, contentHash: contentHash(raw) };
		this.database
			.prepare("INSERT INTO pi_study_visual_interaction VALUES (?,?,?,?,?)")
			.run(
				receipt.receiptId,
				scope.projectId,
				visual.visualizationId,
				stableStringify(receipt),
				contentHash(receipt),
			);
		return receipt;
	}

	visualGate(scope: Scope, visualizationId: string, runtimeHash: string) {
		const visual = this.study.getVisualizationDraft(scope, visualizationId);
		const target = {
			targetKind: "visualization" as const,
			targetId: visualizationId,
			targetRevision: visual.revision,
			targetHash: visual.contentHash,
		};
		const numerical = this.study.listValidations(scope, target),
			reviews = this.study.listIndependentReviews(scope, target);
		const rows = this.database
			.prepare(
				"SELECT payload,payload_hash AS hash FROM pi_study_visual_interaction WHERE project_id=? AND target_id=? ORDER BY rowid DESC",
			)
			.all(scope.projectId, visualizationId) as { payload: string; hash: string }[];
		const interactions = rows
			.map((row) => this.decode<VisualInteractionReceipt>(row))
			.filter(
				(item) =>
					item.targetHash === visual.contentHash &&
					item.revision === visual.revision &&
					item.runtimeHash === runtimeHash,
			);
		const reasons: string[] = [];
		if (runtimeHash !== visual.environmentHash) reasons.push("渲染器已更新，请保存新版草稿并重新验证。");
		if (!numerical.some((check) => check.status === "passed") || numerical.some((check) => check.status !== "passed"))
			reasons.push("当前版本数值检查尚未全部通过。");
		if (
			!interactions.length ||
			interactions[0].status !== "passed" ||
			!numerical.some((check) => check.taskId === interactions[0].numericalTaskId && check.status === "passed")
		)
			reasons.push("当前版本浏览器交互检查尚未通过。");
		if (!reviews.some((check) => check.status === "passed") || reviews.some((check) => check.status !== "passed"))
			reasons.push("当前版本独立审查尚未通过，或仍存在失败／未解决意见。");
		const evidenceHash = contentHash({ programmaticChecks: numerical, browserChecks: interactions });
		if (
			!reviews.some(
				(check) => check.status === "passed" && check.manifest.inputHashes.visualEvidence === evidenceHash,
			)
		)
			reasons.push("请独立审查当前这份数值与浏览器验证证据；旧检查结果不能沿用。");
		return {
			ready: reasons.length === 0,
			reasons,
			numerical,
			reviews,
			interactions,
			visualizationId,
			revision: visual.revision,
			targetHash: visual.contentHash,
		};
	}

	approveTeachingCopy(
		sessionId: string,
		input: Omit<TeachingApproval, "approvedAt" | "userEventId">,
		userEventId: string,
	): TeachingApproval {
		const snapshot = this.courses.getSnapshotForSession(sessionId);
		if (!snapshot || snapshot.project.projectId !== input.courseProjectId)
			throw new Error("Teaching copy is outside the bound course");
		const material = this.courses.getMaterial(sessionId, input.materialId);
		if (material.metadata.studyCopyHash !== input.copyHash || material.metadata.studyLessonId !== input.lessonPlanId)
			throw new Error("Teaching copy identity differs from its course material");
		const lesson = snapshot.lessonPlans.find((item) => item.lessonPlanId === input.lessonPlanId);
		if (
			!lesson ||
			lesson.revision !== input.lessonRevision ||
			lesson.contentHash !== input.lessonHash ||
			lesson.status !== "approved" ||
			snapshot.semesterPlan?.status !== "approved" ||
			lesson.semesterPlanId !== snapshot.semesterPlan.semesterPlanId ||
			lesson.semesterPlanRevision !== snapshot.semesterPlan.revision
		)
			throw new Error("Approve the exact current semester and lesson revision before formal teaching use");
		if (!userEventId.trim()) throw new Error("Explicit teacher confirmation is required");
		const value = { ...input, userEventId, approvedAt: new Date().toISOString() };
		this.database
			.prepare(
				"INSERT INTO pi_study_teaching_approval VALUES (?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET payload=excluded.payload,payload_hash=excluded.payload_hash",
			)
			.run(input.materialId, input.courseProjectId, stableStringify(value), contentHash(value));
		return value;
	}

	teachingApproval(sessionId: string, materialId: string): TeachingApproval | null {
		const material = this.courses.getMaterial(sessionId, materialId);
		const row = this.database
			.prepare(
				"SELECT payload,payload_hash AS hash FROM pi_study_teaching_approval WHERE material_id=? AND course_project_id=?",
			)
			.get(materialId, material.projectId) as { payload: string; hash: string } | undefined;
		return row ? this.decode<TeachingApproval>(row) : null;
	}

	private decode<T>(row: { payload: string; hash: string }): T {
		const value: unknown = JSON.parse(row.payload);
		if (contentHash(value) !== row.hash) throw new Error("Teaching ledger integrity mismatch");
		return value as T;
	}
}
