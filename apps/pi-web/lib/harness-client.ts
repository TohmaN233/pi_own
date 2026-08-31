export interface HarnessCourseSummary {
  courseId: string;
  courseVersionId: string;
  revision: number;
  createdAt: string;
  materialCount: number;
  spanCount: number;
}

export interface HarnessSessionSummary {
  sessionId: string;
  bindingId: string;
  courseVersionId: string | null;
  resourceSnapshotId: string;
  profileId: string;
	bindingRevision: number;
	snapshot: {
		resourceSnapshotId: string;
		profileId: string;
		profileRevision: number;
		mode: string;
		role: string;
		courseVersionId: string | null;
		thinkingLevel: string;
		externalKnowledgePolicy: string;
		tools: string[];
		resources: Array<{ kind: string; id: string; version: string; contentHash: string; required: boolean; enabled: boolean }>;
		instructions: string[];
		createdAt: string;
		contentHash: string;
	};
	pendingTransition: { idempotencyKey: string; targetProfileId: string; snapshotId: string } | null;
	runtime: { live: boolean; verified: boolean; activeTools: string[]; expectedTools: string[]; diagnostic: string | null };
}

export interface HarnessAvailableProfile {
	profileId: string;
	title: string;
	description: string;
	category: string;
	source: "builtin" | "custom";
	runtimeMode: string;
	selectable: boolean;
	disabledReason: string | null;
	missingRequiredResources: string[];
	missingOptionalResources: string[];
	identityMismatches: string[];
}

export interface HarnessModePackComponentOption {
	type: "skill" | "workflow";
	id: string;
	title: string;
	description: string;
	recommended: boolean;
}

export interface HarnessModePackDraft {
	version: 1;
	modePackId: string;
	revision: number;
	title: string;
	description: string;
	category: "education" | "coding" | "creative" | "general";
	role: "student" | "teacher" | "general";
	runtimeMode: "general" | "student-learn" | "practice" | "visual-lab" | "teacher-prep";
	provider: string | null;
	model: string | null;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	externalKnowledgePolicy: "deny" | "explain-and-label" | "allow";
	courseRequired: boolean;
	tools: string[];
	components: Array<{
		type: "skill" | "plugin" | "prompt" | "workflow" | "theme";
		id: string;
		required: boolean;
		enabled: boolean;
	}>;
	systemPrompt: string;
	instructions: string[];
}

export interface HarnessStatus {
  ready: true;
  activeCourseVersionId: string | null;
  courses: HarnessCourseSummary[];
  session: HarnessSessionSummary | null;
	availableProfiles: HarnessAvailableProfile[];
	modePackComponents: HarnessModePackComponentOption[];
}

async function harnessRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Harness request failed: HTTP ${response.status}`);
  return body;
}

export function getHarnessStatus(sessionId?: string): Promise<HarnessStatus> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return harnessRequest<HarnessStatus>(`/api/harness/status${query}`);
}

export function switchHarnessProfile(
	sessionId: string,
	targetProfileId: string,
	expectedSnapshotId: string,
	idempotencyKey: string,
	modePackDraft?: HarnessModePackDraft,
): Promise<{ sessionId: string; profileId: string; resourceSnapshotId: string; bindingRevision: number }> {
	return harnessRequest("/api/harness/profile", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			sessionId,
			targetProfileId,
			expectedSnapshotId,
			idempotencyKey,
			...(modePackDraft ? { modePackDraft } : {}),
		}),
	});
}

export function selectHarnessCourse(courseVersionId: string): Promise<{ activeCourseVersionId: string }> {
  return harnessRequest("/api/harness/active-course", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseVersionId }),
  });
}

export function importHarnessCourse(courseId: string, files: readonly File[]): Promise<HarnessCourseSummary> {
  const form = new FormData();
  form.set("courseId", courseId);
  for (const file of files) form.append("files", file);
  return harnessRequest("/api/harness/courses", { method: "POST", body: form });
}

export interface HarnessSpan {
  spanId: string;
  materialId: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  text: string;
}

export interface HarnessTimelineEvent {
  eventId: string;
  courseVersionId: string;
  sessionBindingId: string;
  conceptId: string;
  kind: string;
  sequence: number;
  createdAt: string;
  payload: {
    type?: string;
    receiptId?: string;
    draftId?: string;
    packetId?: string;
    claimIds?: string[];
    citationSpanIds?: string[];
  };
}

export function searchHarnessCourse(sessionId: string, query: string): Promise<{ spans: HarnessSpan[] }> {
  return harnessRequest(
    `/api/harness/search?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}`,
  );
}

export function readHarnessSpan(sessionId: string, spanId: string): Promise<HarnessSpan> {
  return harnessRequest(
    `/api/harness/spans/${encodeURIComponent(spanId)}?sessionId=${encodeURIComponent(sessionId)}`,
  );
}

export function getHarnessTimeline(sessionId: string): Promise<{ events: HarnessTimelineEvent[] }> {
  return harnessRequest(`/api/harness/timeline?sessionId=${encodeURIComponent(sessionId)}`);
}

export interface HarnessPracticeExercise {
  exerciseId: string;
  prompt: string;
  conceptIds: string[];
  hintCount: number;
  unlockPolicy: "after-meaningful-attempt" | "after-correct-attempt" | "teacher-only";
  revision: number;
}

export interface HarnessPracticeInstance {
  instanceId: string;
  exerciseId: string;
  issuedAt: string;
}

export interface HarnessPracticeAttemptResult {
  attempt: {
    attemptId: string;
    instanceId: string;
    exerciseId: string;
    meaningful: boolean;
    submittedAt: string;
    revision: number;
  };
  evaluation: { evaluationId: string; correct: boolean; feedback: string; createdAt: string };
  solutionAvailable: boolean;
  event: { eventId: string; kind: string; createdAt: string };
}

/**
 * Keeps an idempotency key for the lifetime of one visible practice operation.
 *
 * A response can be lost after the server has committed it.  The caller therefore
 * owns the key and only clears it after observing a successful response.  These
 * keys deliberately stay in memory: reopening the UI is a new user operation.
 */
export class PracticeOperationKeys {
  private readonly startKeys = new Map<string, string>();
  private readonly attemptKeys = new Map<string, string>();

  constructor(private readonly createKey: () => string = () => crypto.randomUUID()) {}

  start(exerciseId: string): string {
    return this.getOrCreate(this.startKeys, exerciseId);
  }

  completeStart(exerciseId: string): void {
    this.startKeys.delete(exerciseId);
  }

  attempt(instanceId: string, answer: string): string {
    return this.getOrCreate(this.attemptKeys, `${instanceId}\u0000${answer.trim()}`);
  }

  completeAttempt(instanceId: string, answer: string): void {
    this.attemptKeys.delete(`${instanceId}\u0000${answer.trim()}`);
  }

  private getOrCreate(keys: Map<string, string>, operation: string): string {
    const existing = keys.get(operation);
    if (existing) return existing;
    const key = this.createKey();
    keys.set(operation, key);
    return key;
  }
}

export function getHarnessPractice(sessionId: string): Promise<{ exercises: HarnessPracticeExercise[] }> {
  return harnessRequest(`/api/harness/practice?sessionId=${encodeURIComponent(sessionId)}`);
}

export function startHarnessPractice(
  sessionId: string,
  exerciseId: string,
  idempotencyKey: string,
): Promise<{ instance: HarnessPracticeInstance; exercise: HarnessPracticeExercise }> {
  return harnessRequest("/api/harness/practice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, exerciseId, idempotencyKey }),
  });
}

export function requestHarnessPracticeHint(sessionId: string, instanceId: string, level: number): Promise<{ level: number; hint: string }> {
  return harnessRequest("/api/harness/practice/hint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, instanceId, level }),
  });
}

export function submitHarnessPracticeAttempt(
  sessionId: string,
  instanceId: string,
  answer: string,
  idempotencyKey: string,
): Promise<HarnessPracticeAttemptResult> {
  return harnessRequest("/api/harness/practice/attempt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, instanceId, answer, idempotencyKey }),
  });
}

export function revealHarnessPracticeSolution(sessionId: string, attemptId: string): Promise<{ solution: string }> {
  return harnessRequest("/api/harness/practice/solution", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, attemptId }),
  });
}
