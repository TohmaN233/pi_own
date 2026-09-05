import { getLearningHarness } from "./harness-server";
import { courseBuilderView, runCourseBuilderCommand, type CourseBuilderCommand } from "../../../packages/course-builder-host/src/index.ts";

export function getCourseBuilderHost() { return getLearningHarness().courseBuilder; }
export function assertCourseBuilderSession(sessionId: string): void {
 if (!sessionId || getLearningHarness().findCurrentSession(sessionId)) throw new Error("Course Builder requires a non-student Pi session");
}
export function courseBuilderState(sessionId: string) {
 assertCourseBuilderSession(sessionId);
 return {projects:getCourseBuilderHost().listProjects(),snapshot:courseBuilderView(getCourseBuilderHost(),sessionId),compilerEnabled:process.env.PI_COURSE_BUILDER_TRUSTED_TEX==="1"};
}
export async function courseBuilderCommand(sessionId: string, command: CourseBuilderCommand, assertActive?:()=>void|Promise<void>) {
 assertCourseBuilderSession(sessionId);
 return runCourseBuilderCommand(getCourseBuilderHost(),sessionId,command,{trustedTex:process.env.PI_COURSE_BUILDER_TRUSTED_TEX==="1",assertActive});
}
