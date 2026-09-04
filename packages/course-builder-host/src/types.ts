import type { JsonValue, VisualArtifact, VisualizationSpec } from "../../harness-contracts/src/index.ts";

export type CourseBuilderMaterialKind = "pptx" | "pdf" | "tex" | "markdown" | "text";
export type ReviewDecision = "approve" | "request-changes";
export type DraftStatus = "draft" | "changes-requested" | "approved";

export interface BeamerProfile {
	aspectRatio: "169" | "43";
	fontSize: number;
	theme: string;
	author: string;
	institute: string;
	language: string;
	overlayPolicy: "allow" | "deny";
	referencesPolicy: "required" | "optional";
	backupSlides: number;
	speakerNotes: boolean;
	preamble: string | null;
}

export interface CourseBuilderProjectInput {
	courseId: string;
	title: string;
	weeks: number;
	sessionsPerWeek: number;
	minutesPerSession: number;
	audience: string;
	language: string;
	goals: string[];
	beamerProfile: BeamerProfile;
}

export interface CourseBuilderProject extends CourseBuilderProjectInput {
	projectId: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface CourseBuilderMaterialInput {
	name: string;
	kind: CourseBuilderMaterialKind;
	sourceBytes: Uint8Array;
	extractedText: string;
	metadata?: Record<string, JsonValue>;
}

export interface CourseBuilderMaterial {
	materialId: string;
	projectId: string;
	name: string;
	kind: CourseBuilderMaterialKind;
	sourceHash: string;
	textHash: string;
	extractedText: string;
	metadata: Record<string, JsonValue>;
	createdAt: string;
}

export interface SpiralRevisit {
	conceptId: string;
	progression:
		| "complexity"
		| "relationship"
		| "abstraction"
		| "formalization"
		| "representation"
		| "transfer"
		| "boundary";
	note: string;
}

export interface SemesterSessionDraft {
	week: number;
	session: number;
	title: string;
	objectives: string[];
	prerequisites: string[];
	topics: string[];
	materialIds: string[];
	activities: string[];
	understandingEvidence: string[];
	assessment: string | null;
	homework: string | null;
	courseGoalsCovered: string[];
	revisits: SpiralRevisit[];
	visualOpportunities: string[];
}

export interface SemesterPlanDraft {
	title: string;
	rationale: string;
	sessions: SemesterSessionDraft[];
}

export interface TeacherReview {
	decision: ReviewDecision;
	note: string;
	reviewedAt: string;
	reviewer: "teacher-ui";
	targetRevision: number;
	targetHash: string;
}

export interface SemesterPlan extends SemesterPlanDraft {
	semesterPlanId: string;
	projectId: string;
	revision: number;
	status: DraftStatus;
	review: TeacherReview | null;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface LessonSegment {
	minutes: number;
	title: string;
	teacherAction: string;
	learnerAction: string;
	checkForUnderstanding: string | null;
}

export interface LessonPlanDraft {
	week: number;
	session: number;
	title: string;
	objectives: string[];
	prerequisites: string[];
	misconceptions: string[];
	segments: LessonSegment[];
	examples: string[];
	exercises: string[];
	materialIds: string[];
	visualRequests: string[];
	notes: string[];
}

export interface LessonPlan extends LessonPlanDraft {
	lessonPlanId: string;
	projectId: string;
	semesterPlanId: string;
	semesterPlanRevision: number;
	revision: number;
	status: DraftStatus;
	review: TeacherReview | null;
	createdAt: string;
	updatedAt: string;
	contentHash: string;
}

export interface BeamerDeckDraft {
	lessonPlanId: string;
	title: string;
	source: string;
	frameOutline: string[];
	assetMaterialIds: string[];
}

export interface BeamerDeck extends BeamerDeckDraft {
	deckId: string;
	projectId: string;
	lessonPlanRevision: number;
	revision: number;
	status: "draft" | "compiled" | "reviewed" | "accepted";
	sourceHash: string;
	createdAt: string;
	updatedAt: string;
	acceptedAt: string | null;
	acceptedReceiptId: string | null;
	contentHash: string;
}

export interface CompileDiagnostic {
	code: string;
	severity: "critical" | "major" | "minor";
	message: string;
}

export interface BeamerCompileReceipt {
	receiptId: string;
	projectId: string;
	deckId: string;
	deckRevision: number;
	sourceHash: string;
	compiler: string;
	arguments: string[];
	succeeded: boolean;
	exitCode: number | null;
	pageCount: number | null;
	pdfHash: string | null;
	logHash: string;
	diagnostics: CompileDiagnostic[];
	createdAt: string;
	contentHash: string;
}

export interface DeckReviewIssue {
	code: string;
	severity: "critical" | "major" | "minor";
	message: string;
	location: string | null;
}

export interface DeckReview {
	reviewId: string;
	projectId: string;
	deckId: string;
	deckRevision: number;
	sourceHash: string;
	compileReceiptId: string | null;
	score: number;
	status: "pass" | "fail";
	issues: DeckReviewIssue[];
	createdAt: string;
	contentHash: string;
}

export interface CourseBuilderVisual {
	visualId: string;
	projectId: string;
	lessonPlanId: string;
	spec: VisualizationSpec;
	artifact: VisualArtifact;
	learningPurpose: string;
	createdAt: string;
	contentHash: string;
}

export interface SessionProjectBinding {
	sessionId: string;
	projectId: string;
	boundAt: string;
}

export interface CourseBuilderState {
	version: 1;
	projects: CourseBuilderProject[];
	bindings: SessionProjectBinding[];
	materials: CourseBuilderMaterial[];
	semesterPlans: SemesterPlan[];
	lessonPlans: LessonPlan[];
	decks: BeamerDeck[];
	compileReceipts: BeamerCompileReceipt[];
	deckReviews: DeckReview[];
	visuals: CourseBuilderVisual[];
}

export interface CourseBuilderSnapshot {
	project: CourseBuilderProject;
	materials: CourseBuilderMaterial[];
	semesterPlan: SemesterPlan | null;
	lessonPlans: LessonPlan[];
	decks: BeamerDeck[];
	compileReceipts: BeamerCompileReceipt[];
	deckReviews: DeckReview[];
	visuals: CourseBuilderVisual[];
}
