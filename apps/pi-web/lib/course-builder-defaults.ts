import type { CourseBuilderProjectInput } from "../../../packages/course-builder-host/src/types.ts";

/** Fresh editable defaults shared by the workspace and its executable regression. */
export function createDefaultCourseBuilderProject(): CourseBuilderProjectInput {
  return {courseId:"my-course",title:"我的课程",weeks:12,sessionsPerWeek:1,minutesPerSession:50,audience:"大学本科",language:"中文",goals:["解释核心概念并解决相应问题"],beamerProfile:{aspectRatio:"169",fontSize:11,theme:"default",author:"",institute:"",language:"中文",overlayPolicy:"allow",referencesPolicy:"optional",backupSlides:0,speakerNotes:false,preamble:null}};
}
