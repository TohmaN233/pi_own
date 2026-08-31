import { mkdirSync } from "fs";
import { unlink } from "fs/promises";
import { join } from "path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  LearningHarness,
  type HarnessSession,
} from "../../../packages/learning-harness/src/index.ts";
import { MODE_PACK_COMPONENT_OPTIONS } from "../../../packages/profile-resource-host/src/index.ts";
import { invalidateSessionListCache, invalidateSessionPathCache } from "./session-reader";

export const HARNESS_COURSE_COOKIE = "pi-harness-course-version";

declare global {
  var __piLearningHarness: LearningHarness | undefined;
}

function databasePath(): string {
  const directory = process.env.PI_LEARNING_HARNESS_DIR || join(getAgentDir(), "learning-harness");
  mkdirSync(directory, { recursive: true });
  return join(directory, "learning-harness.sqlite");
}

export function getLearningHarness(): LearningHarness {
  if (!globalThis.__piLearningHarness) {
    globalThis.__piLearningHarness = new LearningHarness({ databasePath: databasePath() });
  }
  return globalThis.__piLearningHarness;
}

export function selectedCourseVersion(request: Request): string | null {
  const cookie = request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${HARNESS_COURSE_COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(HARNESS_COURSE_COOKIE.length + 1)) : null;
}

export function bindHarnessCourse(
  sessionManager: SessionManager,
  courseVersionId: string,
): HarnessSession {
  return getLearningHarness().openStudentSession({ sessionStore: sessionManager, courseVersionId });
}

export interface NewHarnessSessionHandle {
  readonly sessionFile: string;
	readonly inner: { sessionManager: SessionManager };
	activateHarnessProfile(snapshot: HarnessSession["snapshot"]): void;
  shutdown(): Promise<void>;
}

/** Rolls back a just-created Pi wrapper when course binding cannot become durable. */
export async function bindHarnessCourseOrDiscard(
  session: NewHarnessSessionHandle,
  sessionId: string,
  courseVersionId: string,
): Promise<HarnessSession> {
  try {
		const bound = bindHarnessCourse(session.inner.sessionManager, courseVersionId);
		session.activateHarnessProfile(bound.snapshot);
		return bound;
  } catch (error) {
    const sessionFile = session.inner.sessionManager.getSessionFile() ?? session.sessionFile;
    try {
      await session.shutdown();
    } catch (cleanupError) {
      console.error("[learning-harness] failed to shut down new session after binding failure", {
        sessionId,
        cleanupError,
      });
    }
    if (sessionFile) {
      try {
        await unlink(sessionFile);
      } catch (cleanupError) {
        console.error("[learning-harness] failed to discard new session after binding failure", {
          sessionId,
          sessionFile,
          cleanupError,
        });
      }
    }
    invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
    throw error;
  }
}

export function reconcileHarnessSession(sessionManager: SessionManager): HarnessSession | null {
  return getLearningHarness().reconcileRuntimeSession(sessionManager);
}

export function inheritHarnessSession(
  parentSessionManager: SessionManager,
  childSessionManager: SessionManager,
): HarnessSession | null {
  return getLearningHarness().inheritStudentSession({
    parentSessionStore: parentSessionManager,
    childSessionStore: childSessionManager,
  });
}

export function inheritHarnessSessionFile(
  parentSessionManager: SessionManager,
  childSessionFile: string,
): HarnessSession | null {
  const childSessionManager = SessionManager.open(childSessionFile);
  if (childSessionManager.getBranch().length !== 0) {
    return inheritHarnessSession(parentSessionManager, childSessionManager);
  }
  const parentSessionFile = parentSessionManager.getSessionFile();
  const childHeader = childSessionManager.getHeader();
  if (!parentSessionFile || !childHeader || childHeader.parentSession !== parentSessionFile) {
    throw new Error("Empty child session is not directly linked to the supplied parent JSONL");
  }
  return getLearningHarness().inheritVerifiedDirectEmptyStudentSession({
    parentSessionStore: parentSessionManager,
    childSessionStore: childSessionManager,
  });
}

/** Removes a just-created fork/clone when its durable Harness inheritance fails. */
export async function inheritHarnessSessionFileOrDiscard(
  parentSessionManager: SessionManager,
  childSessionId: string,
  childSessionFile: string,
): Promise<HarnessSession | null> {
  try {
    return inheritHarnessSessionFile(parentSessionManager, childSessionFile);
  } catch (error) {
    try {
      await unlink(childSessionFile);
    } catch (cleanupError) {
      console.error("[learning-harness] failed to discard forked session after inheritance failure", {
        childSessionId,
        childSessionFile,
        cleanupError,
      });
    }
    invalidateSessionPathCache(childSessionId);
    invalidateSessionListCache();
    throw error;
  }
}

export function courseSummary(courseVersionId: string) {
  const version = getLearningHarness().getCourseVersion(courseVersionId);
  return {
    courseId: version.courseId,
    courseVersionId: version.courseVersionId,
    revision: version.revision,
    createdAt: version.createdAt,
    materialCount: version.materials.length,
    spanCount: version.spans.length,
  };
}

export function listCourseSummaries() {
  return getLearningHarness().listCourses().map((version) => courseSummary(version.courseVersionId));
}

export function listModePackComponents() {
  return structuredClone(MODE_PACK_COMPONENT_OPTIONS);
}
